"""Exact-attempt read-only CI producer using maintained collect-ci.py primitives.

No dispatch/push/publication. Original selection is fsynced before returning;
lost responses rediscover that selection locally, never a replacement attempt.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys

P = pathlib.Path
HERE = P(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('maintained_ci', HERE / 'release-ci-primitives.py')
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


def need(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_ref(ref, maximum=128 * 1024**2):
    path = P(ref['path'])
    need(path.is_absolute() and path.resolve(strict=True) == path and not any(p.is_symlink() for p in (path, *path.parents)), 'ci-reference-redirected')
    raw = path.read_bytes()
    need(len(raw) <= maximum and sha(raw) == ref['sha256'], 'ci-reference-changed')
    return raw


def store(path, raw):
    if path.exists():
        need(not path.is_symlink() and path.read_bytes() == raw, 'ci-retained-output-conflict')
    else:
        with path.open('xb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    return {'path': str(path), 'sha256': sha(raw)}


def credential(tools):
    for name in ('git', 'python'):
        read_ref(tools[name])
    path = P(tools['gitExecPath'])
    need(path.is_absolute() and path.resolve(strict=True) == path and path.is_dir(), 'ci-git-exec-path-changed')
    env = dict(os.environ, GIT_EXEC_PATH=str(path), GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
    completed = subprocess.run([tools['git']['path'], 'credential', 'fill'], input=b'protocol=https\nhost=github.com\n\n',
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, env=env)
    need(completed.returncode == 0 and len(completed.stdout) <= 65536, 'ci-credentials-unavailable')
    values = dict(line.split('=', 1) for line in completed.stdout.decode().splitlines() if '=' in line)
    need(values.get('password'), 'ci-credentials-unavailable')
    return values['password']


def outcome(state, reason, external=None, output=None, receipt=None):
    return dict(state=state, reason=reason, externalId=external, output=output, receipt=receipt)


def running_failure(jobs):
    """Keep an unfinished workflow from hiding an already failed child."""
    failed = None
    failures = {'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'}
    for job in jobs:
        need(isinstance(job, dict) and type(job.get('id')) is int and job['id'] > 0
             and isinstance(job.get('name'), str) and len(job['name']) <= 500, 'ci-job-invalid')
        need(isinstance(job.get('status'), str) and len(job['status']) <= 40
             and (job.get('conclusion') is None or isinstance(job['conclusion'], str)
                  and len(job['conclusion']) <= 40), 'ci-job-invalid')
        steps = job.get('steps', [])
        need(isinstance(steps, list) and len(steps) <= 100, 'ci-step-list-invalid')
        for step in steps:
            need(isinstance(step, dict) and isinstance(step.get('name'), str)
                 and len(step['name']) <= 500, 'ci-step-invalid')
            need(isinstance(step.get('status'), str) and len(step['status']) <= 40
                 and (step.get('conclusion') is None or isinstance(step['conclusion'], str)
                      and len(step['conclusion']) <= 40), 'ci-step-invalid')
            if failed is None and step.get('conclusion') in failures:
                failed = ('canonical-ci-step-failed', {
                    'job': {k: job.get(k) for k in ('id', 'name', 'status', 'conclusion')},
                    'step': {k: step.get(k) for k in ('name', 'status', 'conclusion')}})
        if failed is None and job.get('conclusion') in failures:
            failed = ('canonical-ci-job-failed', {
                'job': {k: job.get(k) for k in ('id', 'name', 'status', 'conclusion')}})
    return failed


def collect(request, token_provider=credential):
    need(set(request) == {'format', 'key', 'version', 'source', 'tools', 'externalId', 'outputDirectory', 'helperHashes'}, 'ci-request-fields')
    need(request['format'] == 1 and re.fullmatch('[0-9a-f-]{36}', request['key']), 'ci-request-identity')
    for name in ('release-delivery-ci.py', 'release-ci-primitives.py'):
        need(sha((HERE / name).read_bytes()) == request['helperHashes'][name], 'ci-helper-changed')
    source = request['source']; repo = source['repository'].split('/')[-1]
    need(repo in C.REPOSITORIES and source['repository'] == 'HatimTheDream/' + repo and source['branch'] == 'main'
         and re.fullmatch('[0-9a-f]{40}', source['commit']), 'ci-source-identity')
    root = P(request['outputDirectory'])
    need(root.is_absolute() and root.resolve(strict=True) == root and root.name == 'ci-' + request['key']
         and not any(p.is_symlink() for p in (root, *root.parents)), 'ci-output-scope')
    binding = {k: v for k, v in request.items() if k != 'externalId'}
    store(root / 'request.json', (json.dumps(binding, sort_keys=True) + '\n').encode())
    selected_path = root / 'selection.json'
    selected = None
    if selected_path.exists():
        need(not selected_path.is_symlink() and selected_path.stat().st_size <= 4096, 'ci-selection-corrupt')
        selected = json.loads(selected_path.read_bytes())
        need(set(selected) == {'id', 'attempt'} and type(selected['id']) is int and selected['id'] > 0
             and type(selected['attempt']) is int and selected['attempt'] > 0, 'ci-selection-corrupt')
    if request['externalId']:
        need(selected and request['externalId'] == f"{selected['id']}:{selected['attempt']}", 'ci-run-attempt-changed')
    elif selected:
        return outcome('running', 'canonical-ci-original-run-captured', f"{selected['id']}:{selected['attempt']}")
    token = token_provider(request['tools'])
    prefix = '/repos/' + source['repository']
    if selected:
        status, run = C.api(prefix + f"/actions/runs/{selected['id']}/attempts/{selected['attempt']}", token)
        need(status == 200, 'ci-response-unavailable')
    else:
        status, value = C.api(prefix + '/actions/runs?head_sha=' + source['commit'] + '&event=push&per_page=100', token)
        need(status == 200 and isinstance(value.get('workflow_runs'), list) and value.get('total_count', 101) <= 100, 'ci-run-list-incomplete')
        runs = [run for run in value['workflow_runs'] if run.get('name') == C.WORKFLOWS[repo]]
        need(len(runs) <= 1, 'ci-run-ambiguous')
        if not runs:
            return outcome('running', 'exact-ci-run-not-visible')
        run = runs[0]
    need(run.get('head_sha') == source['commit'] and run.get('name') == C.WORKFLOWS[repo] and run.get('event') == 'push'
         and run.get('head_branch') == source['branch'] and run.get('repository', {}).get('full_name') == source['repository']
         and type(run.get('id')) is int and run['id'] > 0 and type(run.get('run_attempt')) is int and run['run_attempt'] > 0, 'ci-run-identity-mismatch')
    current = {'id': run['id'], 'attempt': run['run_attempt']}
    external = f"{run['id']}:{run['run_attempt']}"
    if not selected:
        store(selected_path, (json.dumps(current, sort_keys=True) + '\n').encode())
        return outcome('running', 'canonical-ci-original-run-captured', external)
    need(selected == current, 'ci-run-attempt-changed')
    if run['status'] == 'completed' and run['conclusion'] != 'success':
        return outcome('failed', 'canonical-ci-failed', external, {'runId': run['id'], 'runAttempt': run['run_attempt'], 'conclusion': run['conclusion']})
    status, jobs = C.api(prefix + f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100", token)
    need(status == 200 and isinstance(jobs, dict) and isinstance(jobs.get('jobs'), list)
         and type(jobs.get('total_count')) is int and jobs['total_count'] == len(jobs['jobs']) <= 100, 'ci-job-list-incomplete')
    if run['status'] != 'completed':
        failed = running_failure(jobs['jobs'])
        if failed:
            reason, detail = failed
            return outcome('failed', reason, external, {'runId': run['id'], 'runAttempt': run['run_attempt'], **detail})
        return outcome('running', 'canonical-ci-running', external)
    quality = [job for job in jobs['jobs'] if job.get('name') == 'quality']
    need(len(quality) == 1, 'ci-quality-job-ambiguous')
    release_jobs = [job for job in jobs['jobs'] if job.get('name') == 'release']
    need(len(release_jobs) == 1 and all(type(j.get('id')) is int and j['id'] > 0
         and j.get('status') == 'completed' and j.get('conclusion') == 'success' for j in jobs['jobs']), 'ci-release-job-incomplete')
    job = quality[0]
    need(type(job.get('id')) is int and job['id'] > 0 and job.get('status') == 'completed' and job.get('conclusion') == 'success'
         and len(job.get('steps', [])) <= 100, 'ci-quality-job-invalid')
    for name in ('Run npm run quality', 'Verify Linux update recovery'):
        need(any(step.get('name') == name and step.get('conclusion') == 'success' for step in job['steps']), 'ci-required-step-missing')
    log_path = root / 'quality.log'
    raw = log_path.read_bytes() if log_path.exists() else C.log_bytes(prefix, job['id'], token)
    need(0 < len(raw) <= C.MAX_LOG, 'ci-log-invalid')
    log = store(log_path, raw)
    # The maintained main-push workflow creates the release after quality.
    # Its success alone cannot certify an existing tag: github-release.mjs may
    # return early for one, so independently resolve both exact identities.
    tag = ('nova-v' if repo == 'Nova-Dream' else 'v') + request['version']
    status, release = C.api(prefix + '/releases/tags/' + tag, token)
    need(status == 200 and type(release.get('id')) is int and release['id'] > 0
         and release.get('tag_name') == tag and release.get('target_commitish') == source['commit']
         and release.get('draft') is False and release.get('prerelease') is False, 'ci-source-release-changed')
    status, gitref = C.api(prefix + '/git/ref/tags/' + tag, token)
    need(status == 200 and gitref.get('object', {}).get('type') == 'commit'
         and gitref['object'].get('sha') == source['commit'], 'ci-source-tag-changed')
    release_identity = {'id': release['id'], 'tag': tag, 'sourceCommit': source['commit'], 'repository': source['repository'],
                        'targetCommitish': release['target_commitish'], 'draft': False, 'prerelease': False, 'tagObjectType': 'commit'}
    release_job = {k: release_jobs[0][k] for k in ('id', 'name', 'status', 'conclusion')}
    receipt = {'format': 1, 'readOnly': True, 'sourceVersion': request['version'], 'repositories': [{'repository': repo, 'sha': source['commit'], 'runs': [{
        'id': run['id'], 'runAttempt': run['run_attempt'], 'name': run['name'], 'status': run['status'], 'conclusion': run['conclusion'], 'jobs': [{
            'id': job['id'], 'name': job['name'], 'status': job['status'], 'conclusion': job['conclusion'], 'logFile': log_path.name, 'logSha256': log['sha256'],
            'steps': [{k: step.get(k) for k in ('name', 'status', 'conclusion')} for step in job['steps']]}, release_job]}], 'release': release_identity}]}
    saved = store(root / 'ci.json', (json.dumps(receipt, sort_keys=True) + '\n').encode())
    return outcome('completed', 'canonical-ci-passed', external, {'receipt': saved, 'log': log, 'sourceCommit': source['commit'],
                   'repository': source['repository'], 'runId': run['id'], 'runAttempt': run['run_attempt'], 'release': release_identity}, saved)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=P, required=True)
    parser.add_argument('--request-sha256', required=True)
    args = parser.parse_args()
    try:
        raw = args.request.read_bytes()
        need(len(raw) <= 65536 and re.fullmatch('[a-f0-9]{64}', args.request_sha256) and sha(raw) == args.request_sha256, 'ci-request-changed')
        result = collect(json.loads(raw))
        need(args.request.read_bytes() == raw, 'ci-request-changed')
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[a-z][a-z0-9-]{0,99}', str(error)) else 'ci-response-unavailable'
        result = outcome('uncertain' if reason in ('ci-response-unavailable', 'ci-credentials-unavailable') else 'failed', reason)
    print(json.dumps(result))
    sys.exit(2 if result['state'] in ('failed', 'uncertain') else 0)
