"""Read-only exact-source GitHub quality evidence. No dispatch, push or release writes."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[2]
REPOSITORIES = ('Nova-Dream', 'Nova-Dream-Public')
WORKFLOWS = {'Nova-Dream': 'Nova Dream quality and release history', 'Nova-Dream-Public': 'Application quality'}
MAX_JSON = 4 * 1024**2
MAX_LOG = 32 * 1024**2


class NoApiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('GitHub API redirect refused.')


class CaptureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def source_input(path):
    raw = path.read_bytes()
    assert len(raw) <= 4096, 'Commit input is too large.'
    value = json.loads(raw)
    assert set(value) == {'format', 'version', 'sourceCommits'} and value['format'] == 1
    assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value['version'])
    assert set(value['sourceCommits']) == set(REPOSITORIES)
    assert all(isinstance(sha, str) and re.fullmatch(r'[a-f0-9]{40}', sha) for sha in value['sourceCommits'].values()), 'Actual frozen source commits are required.'
    return value, hashlib.sha256(raw).hexdigest()


def headers(token):
    return {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nova-Release-Verification'}


def api(path, token):
    assert any(path.startswith('/repos/HatimTheDream/' + repo + '/') for repo in REPOSITORIES)
    assert not urllib.parse.urlsplit(path).scheme and not urllib.parse.urlsplit(path).netloc
    request = urllib.request.Request('https://api.github.com' + path, headers=headers(token), method='GET')
    try:
        with urllib.request.build_opener(NoApiRedirect()).open(request, timeout=45) as response:
            raw = response.read(MAX_JSON + 1)
            assert len(raw) <= MAX_JSON, 'GitHub JSON response exceeded its bound.'
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as error:
        return error.code, {'error': 'GitHub API rejected the read-only request.'}


def log_bytes(prefix, job, token):
    request = urllib.request.Request('https://api.github.com' + prefix + '/actions/jobs/' + str(job) + '/logs', headers=headers(token), method='GET')
    try:
        with urllib.request.build_opener(CaptureRedirect()).open(request, timeout=30):
            raise RuntimeError('Expected the exact GitHub log delivery redirect.')
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise RuntimeError('GitHub job log unavailable.') from None
        location = error.headers['Location']
    parsed = urllib.parse.urlsplit(location)
    assert parsed.scheme == 'https' and not parsed.username and not parsed.password and not parsed.fragment and parsed.port in (None, 443)
    assert parsed.hostname and (parsed.hostname.endswith('.blob.core.windows.net') or parsed.hostname.endswith('.actions.githubusercontent.com'))
    # This separate request has no API headers. Do not persist the signed URL.
    with urllib.request.build_opener(NoApiRedirect()).open(location, timeout=45) as response:
        assert response.status == 200
        raw = response.read(MAX_LOG + 1)
        assert 0 < len(raw) <= MAX_LOG, 'GitHub job log exceeded its bound.'
    return raw


def collect(mode, commit_file):
    inputs, input_hash = source_input(commit_file)
    spec = importlib.util.spec_from_file_location('github_credentials', WORKSPACE / 'output/nova-github-backup-current1155/github-account-check.py')
    gh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gh)
    token = gh.credential()
    records = []
    for repo in REPOSITORIES:
        sha, version = inputs['sourceCommits'][repo], inputs['version']
        prefix = '/repos/HatimTheDream/' + repo
        status, data = api(prefix + '/actions/runs?head_sha=' + sha + '&event=push&per_page=30', token)
        assert status == 200 and isinstance(data['workflow_runs'], list) and len(data['workflow_runs']) <= 30
        runs = [run for run in data['workflow_runs'] if run['name'] == WORKFLOWS[repo]]
        assert len(runs) <= 1, 'Multiple exact quality runs need explicit review.'
        record = {'repository': repo, 'sha': sha, 'runs': []}
        for run in runs:
            assert run['head_sha'] == sha and run['event'] == 'push'
            assert type(run['id']) is int and run['id'] > 0 and type(run['run_attempt']) is int and run['run_attempt'] > 0
            item = {key: run[key] for key in ('id', 'name', 'status', 'conclusion', 'html_url', 'run_attempt')}
            status, jobs = api(prefix + '/actions/runs/' + str(run['id']) + '/jobs?per_page=100', token)
            assert status == 200 and jobs['total_count'] == len(jobs['jobs']) <= 100
            item['jobs'] = []
            for job in jobs['jobs']:
                assert type(job['id']) is int and job['id'] > 0 and len(job['steps']) <= 100
                entry = {key: job[key] for key in ('id', 'name', 'status', 'conclusion', 'html_url')}
                entry['steps'] = [{key: step.get(key) for key in ('number', 'name', 'status', 'conclusion')} for step in job['steps']]
                if mode == 'logs' and job['status'] == 'completed' and job['conclusion'] not in ('skipped', 'cancelled'):
                    path = ROOT / ('ci-' + version + '-' + repo + '-' + str(job['id']) + '-attempt' + str(run['run_attempt']) + '.log')
                    if not path.exists():
                        raw = log_bytes(prefix, job['id'], token)
                        with path.open('xb') as output:
                            output.write(raw)
                    assert path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= MAX_LOG
                    entry.update(logFile=path.name, logSha256=hashlib.sha256(path.read_bytes()).hexdigest())
                item['jobs'].append(entry)
            record['runs'].append(item)
        tag = ('nova-v' if repo == 'Nova-Dream' else 'v') + version
        status, release = api(prefix + '/releases/tags/' + tag, token)
        assert status in (200, 404)
        record['release'] = {'tag': tag, 'httpStatus': status}
        if status == 200:
            record['release'].update({key: release[key] for key in ('id', 'tag_name', 'target_commitish', 'draft', 'prerelease', 'published_at', 'html_url')})
        status, ref = api(prefix + '/git/ref/tags/' + tag, token)
        assert status in (200, 404)
        record['tag'] = {'name': tag, 'httpStatus': status}
        if status == 200:
            record['tag'].update(objectType=ref['object']['type'], objectSha=ref['object']['sha'])
            record['tag']['matchesExactCommit'] = ref['object']['type'] == 'commit' and ref['object']['sha'] == sha
        records.append(record)
    assert source_input(commit_file) == (inputs, input_hash), 'Commit input changed during observation.'
    result = {'format': 1, 'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sourceVersion': inputs['version'], 'readOnly': True, 'commitsInputSha256': input_hash, 'repositories': records}
    raw = (json.dumps(result, indent=2) + '\n').encode()
    receipt = ROOT / ('ci-status-' + str(time.time_ns()) + '.json')
    with receipt.open('xb') as output:
        output.write(raw)
    # Keep immutable observations; this familiar filename is only the current view.
    pending = ROOT / (receipt.stem + '.pending')
    with pending.open('xb') as output:
        output.write(raw)
    pending.replace(ROOT / 'ci-status.json')
    print(json.dumps({'receiptPath': str(receipt), 'receiptSha256': hashlib.sha256(raw).hexdigest(), 'result': result}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('status', 'logs'))
    parser.add_argument('--commits', type=pathlib.Path, required=True)
    args = parser.parse_args()
    collect(args.mode, args.commits.resolve(strict=True))
