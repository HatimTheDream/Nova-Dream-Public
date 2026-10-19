"""Bounded private CI handoff after read-only quality; never signs or installs.

The release job builds its own exact-source candidate. A durable per-run intent
permits one publication attempt; an existing intent permits readback only.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

REPOSITORY = 'HatimTheDream/Nova-Dream'
WORKFLOW = '.github/workflows/nova-release.yml'
WORKFLOW_NAME = 'Nova Dream quality and release history'
MAX_ZIP = 16 * 1024**2
MAX_CONTROL = 64 * 1024
FILES = {'app.tgz': MAX_ZIP, 'app.tgz.metadata.json': 1024**2, 'ci-source.json': 1024**2}
QUALITY_STEPS = ('Run npm run quality', 'Verify Linux update recovery')
PRODUCER_STEPS = ('Build the exact delivery candidate', 'Retain the canonical hosted build',
                  'Record this numbered Nova Dream update')
PUBLISH_STEP = 'Publish the verified application archive'


def need(value, reason):
    if not value:
        raise RuntimeError(reason)


def sha(value): return hashlib.sha256(value).hexdigest()
def encoded(value): return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
def positive(value): return type(value) is int and value > 0


def read(path, maximum):
    path = Path(path)
    need(path.is_absolute() and path.resolve(strict=True) == path, 'canonical-input-required')
    for parent in (path, *path.parents):
        need(not parent.is_symlink(), 'input-symlink-refused')
    before = path.stat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum,
         'bounded-ordinary-input-required')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno()); value = stream.read(maximum + 1); closed = os.fstat(stream.fileno())
    after = path.stat()
    stable = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    common = lambda s: (s.st_dev, s.st_ino, stat.S_IFMT(s.st_mode), s.st_nlink, s.st_size, s.st_mtime_ns)
    need(stable(before) == stable(after) and stable(opened) == stable(closed)
         and common(before) == common(opened) and len(value) == before.st_size, 'input-changed-during-read')
    return value


def candidate_files(directory):
    directory = Path(directory)
    need(directory.is_absolute() and directory.resolve(strict=True) == directory and directory.is_dir()
         and not directory.is_symlink(), 'canonical-candidate-directory-required')
    need({p.name for p in directory.iterdir()} == set(FILES), 'exact-three-candidate-files-required')
    values = {name: read(directory / name, limit) for name, limit in FILES.items()}
    need(sum(map(len, values.values())) <= MAX_ZIP - 4096, 'candidate-storage-budget-exceeded')
    metadata = json.loads(values['app.tgz.metadata.json']); receipt = json.loads(values['ci-source.json'])
    need(metadata.get('archiveBytes') == len(values['app.tgz'])
         and metadata.get('archiveSha256') == sha(values['app.tgz'])
         and receipt.get('application') == metadata, 'candidate-content-binding-changed')
    return values, metadata, receipt


def build_zip(values, destination):
    need(set(values) == set(FILES), 'exact-three-candidate-files-required')
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name in sorted(FILES):
            need(0 < len(values[name]) <= FILES[name], 'candidate-member-size-bound')
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3; info.external_attr = (stat.S_IFREG | 0o600) << 16
            archive.writestr(info, values[name])
    raw = read(destination, MAX_ZIP)
    return {'bytes': len(raw), 'sha256': sha(raw)}


def environment(env):
    need(env.get('GITHUB_REPOSITORY') == REPOSITORY and env.get('GITHUB_EVENT_NAME') == 'push'
         and env.get('GITHUB_REF') == 'refs/heads/main' and env.get('GITHUB_JOB') == 'release'
         and env.get('GITHUB_WORKFLOW') == WORKFLOW_NAME
         and env.get('GITHUB_WORKFLOW_REF') == REPOSITORY + '/' + WORKFLOW + '@refs/heads/main',
         'trusted-main-release-job-required')
    commit = env.get('GITHUB_SHA', '')
    need(re.fullmatch('[a-f0-9]{40}', commit), 'exact-source-commit-required')
    integers = {}
    for name in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_REPOSITORY_ID'):
        value = env.get(name, ''); need(re.fullmatch('[1-9][0-9]*', value), 'positive-ci-identity-required')
        integers[name] = int(value)
    return {'commit': commit, 'runId': integers['GITHUB_RUN_ID'], 'attempt': integers['GITHUB_RUN_ATTEMPT'],
            'repositoryId': integers['GITHUB_REPOSITORY_ID']}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError('api-redirect-refused')


def api(path, token, timeout=45):
    prefix = '/repos/' + REPOSITORY
    need(path == prefix or path.startswith(prefix + '/'), 'fixed-private-api-route-required')
    request = urllib.request.Request('https://api.github.com' + path, headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nova-CI-Release-Handoff'})
    need(type(timeout) in (int, float) and 0 < timeout <= 45, 'bounded-api-timeout-required')
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
        raw = response.read(4 * 1024**2 + 1)
        need(response.status == 200 and len(raw) <= 4 * 1024**2, 'bounded-api-response-required')
        return json.loads(raw)


class ProvenancePending(RuntimeError):
    """Only known producer-step propagation may defer a read-only admission."""
    binding = None


def successful_steps(job, names, pending=False):
    steps = job.get('steps', [])
    need(isinstance(steps, list) and len(steps) <= 100, 'bounded-job-steps-required')
    waiting = None
    for name in names:
        selected = [step for step in steps if step.get('name') == name]
        if pending and not selected:
            waiting = 'producer-step-not-visible:' + name
            continue
        if pending and len(selected) == 1 and selected[0].get('status') in ('queued', 'pending', 'in_progress') \
                and selected[0].get('conclusion') is None:
            waiting = 'producer-step-not-settled:' + name
            continue
        need(len(selected) == 1 and selected[0].get('status') == 'completed'
             and selected[0].get('conclusion') == 'success', 'required-producing-step-not-successful:' + name)
    if waiting:
        raise ProvenancePending(waiting)


def context(identity, get, observe=False):
    prefix = '/repos/' + REPOSITORY
    repository = get(prefix)
    need(repository.get('id') == identity['repositoryId'] and repository.get('full_name') == REPOSITORY
         and repository.get('private') is True, 'private-repository-identity-changed')
    run = get(prefix + '/actions/runs/' + str(identity['runId']) + '/attempts/' + str(identity['attempt']))
    need(run.get('id') == identity['runId'] and run.get('run_attempt') == identity['attempt']
         and run.get('head_sha') == identity['commit'] and run.get('event') == 'push'
         and run.get('head_branch') == 'main' and run.get('name') == WORKFLOW_NAME
         and run.get('repository', {}).get('id') == identity['repositoryId']
         and run.get('head_repository', {}).get('id') == identity['repositoryId']
         and positive(run.get('workflow_id')) and run.get('status') in (('in_progress', 'completed') if observe else ('in_progress',))
         and (observe or run.get('conclusion') is None),
         'exact-producing-run-required')
    workflow = get(prefix + '/actions/workflows/' + str(run['workflow_id']))
    need(workflow.get('id') == run['workflow_id'] and workflow.get('path') == WORKFLOW
         and workflow.get('name') == WORKFLOW_NAME, 'exact-workflow-required')
    jobs = get(prefix + '/actions/runs/' + str(identity['runId']) + '/attempts/' + str(identity['attempt']) + '/jobs?per_page=100')
    need(isinstance(jobs.get('jobs'), list) and jobs.get('total_count') == len(jobs['jobs']) <= 100,
         'complete-job-enumeration-required')
    quality = [j for j in jobs['jobs'] if j.get('name') == 'quality']
    producer = [j for j in jobs['jobs'] if j.get('name') == 'release']
    need(len(quality) == len(producer) == 1 and len(jobs['jobs']) == 2, 'exact-quality-and-producer-jobs-required')
    quality, producer = quality[0], producer[0]
    for job in (quality, producer):
        need(positive(job.get('id')) and job.get('run_id') == identity['runId']
             and job.get('head_sha') == identity['commit'], 'job-source-or-run-changed')
    need(quality['id'] != producer['id'] and quality.get('status') == 'completed'
         and quality.get('conclusion') == 'success', 'successful-independent-quality-prerequisite-required')
    need(producer.get('status') in (('in_progress', 'completed') if observe else ('in_progress',))
         and (observe or producer.get('conclusion') is None),
         'actual-producing-release-job-required')
    facts = (repository, run, quality, producer)
    successful_steps(quality, QUALITY_STEPS)
    try:
        publishing = [s for s in producer['steps'] if s.get('name') == PUBLISH_STEP]
        publish_pending = not observe and (not publishing or len(publishing) == 1
                          and publishing[0].get('status') in ('queued', 'pending')
                          and publishing[0].get('conclusion') is None)
        if not publish_pending:
            need(len(publishing) == 1 and (observe or publishing[0].get('status') == 'in_progress'
                                         and publishing[0].get('conclusion') is None), 'actual-publishing-step-required')
        successful_steps(producer, PRODUCER_STEPS, pending=not observe)
        if publish_pending:
            raise ProvenancePending('publishing-step-not-visible-or-started')
    except ProvenancePending as pending:
        pending.binding = provenance_binding(facts)
        raise
    return facts


def provenance_binding(facts):
    repository, run, quality, producer = facts
    return (repository['id'], run['id'], run['run_attempt'], run['workflow_id'], run['head_sha'],
            quality['id'], producer['id'])


def write_attempt(identity, observe):
    need(observe or identity['attempt'] == 1, 'later-run-attempt-is-observation-only')


def wait_context(identity, get, observe=False, *, clock=time.monotonic, sleep=time.sleep):
    """At most 30 seconds of GET-only readiness; effects are never retried."""
    deadline = clock() + 30
    pinned = None
    # The supported CI producer is Linux. The alarm also bounds a stalled
    # response body; fake-clock local tests exercise the same deadline logic.
    armed = clock is time.monotonic and hasattr(signal, 'setitimer')
    previous = None
    if armed:
        need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'existing-worker-alarm-refused')
        previous = signal.getsignal(signal.SIGALRM)
        def expired(_signal, _frame): raise RuntimeError('producer-provenance-read-deadline')
        signal.signal(signal.SIGALRM, expired); signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - clock()))
    def bounded_get(path):
        remaining = deadline - clock(); need(remaining > 0, 'producer-provenance-read-deadline')
        return get(path, timeout=min(5, remaining))
    try:
        while True:
            try:
                facts = context(identity, bounded_get, observe)
                need(clock() <= deadline, 'producer-provenance-read-deadline')
                need(pinned is None or pinned == provenance_binding(facts), 'producer-provenance-changed-while-waiting')
                return facts
            except ProvenancePending as pending:
                need(not observe and pending.binding is not None, 'pending-provenance-cannot-be-observed-as-complete')
                need(pinned is None or pinned == pending.binding, 'producer-provenance-changed-while-waiting')
                pinned = pending.binding
                remaining = deadline - clock(); need(remaining > 0, 'producer-provenance-read-deadline')
                sleep(min(2, remaining))
    finally:
        if armed:
            signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)


def release_identity(version, identity, get):
    need(isinstance(version, str) and re.fullmatch('[0-9]+\\.[0-9]+\\.[0-9]+', version), 'exact-release-version-required')
    tag = 'nova-v' + version; prefix = '/repos/' + REPOSITORY
    release = get(prefix + '/releases/tags/' + tag)
    need(positive(release.get('id')) and release.get('tag_name') == tag
         and release.get('target_commitish') == identity['commit'] and release.get('draft') is False
         and release.get('prerelease') is False, 'exact-source-release-required')
    ref = get(prefix + '/git/ref/tags/' + tag)
    need(ref.get('object', {}).get('type') == 'commit' and ref['object'].get('sha') == identity['commit'],
         'source-tag-changed')
    assets = get(prefix + '/releases/' + str(release['id']) + '/assets?per_page=100')
    need(isinstance(assets, list) and len(assets) < 100, 'complete-release-asset-enumeration-required')
    return release, assets


def transport(identity, facts, release, version, hashes, archive, receipt_sha):
    repository, run, quality, producer = facts
    return {'format': 1, 'kind': 'private-ci-release-artifact',
            'repository': {'id': repository['id'], 'fullName': REPOSITORY, 'private': True},
            'sourceCommit': identity['commit'], 'version': version,
            'run': {'id': identity['runId'], 'attempt': identity['attempt'], 'workflowId': run['workflow_id'],
                    'workflowPath': WORKFLOW, 'event': 'push', 'branch': 'main'},
            'qualityJob': {'id': quality['id'], 'name': 'quality'},
            'producerJob': {'id': producer['id'], 'name': 'release'},
            'producer': {'path': 'scripts/publish-ci-release-artifact.py', **hashes},
            'release': {'id': release['id'], 'tag': release['tag_name'], 'targetCommitish': release['target_commitish']},
            'archive': archive, 'ciSourceSha256': receipt_sha,
            'buildOrigin': 'same-run-release-job', 'deliveryQualification': False}


def asset_metadata(asset, spec):
    need(positive(asset.get('id')) and asset.get('name') == spec['name']
         and asset.get('size') == spec['bytes'] and asset.get('state') == 'uploaded'
         and asset.get('digest') == 'sha256:' + spec['sha256']
         and asset.get('uploader', {}).get('login') == 'github-actions[bot]'
         and asset['uploader'].get('type') == 'Bot', 'exact-complete-actions-published-asset-required')


def bounded_namespace(assets, names):
    selected = [a for a in assets if isinstance(a.get('name'), str) and a['name'].startswith('nova-ci-')]
    need(len(selected) <= 3 and len({a['name'] for a in selected}) == len(selected)
         and all(a['name'] in names and type(a.get('size')) is int and a['size'] >= 0 for a in selected)
         and sum(a['size'] for a in selected) <= MAX_ZIP + 2 * MAX_CONTROL,
         'one-bounded-candidate-transport-per-source-release-required')
    return {a['name']: a for a in selected}


def publish_once(specs, intent, refresh, upload, download, observe=False):
    """An existing remote reservation can only be reconciled, never extended."""
    names = {s['name'] for s in [intent, *specs]}
    current = bounded_namespace(refresh(), names); identities = {}
    if current:
        need(intent['name'] in current, 'unreserved-existing-assets-refused')
        asset_metadata(current[intent['name']], intent); download(current[intent['name']], intent)
        need(set(current) == names, 'reserved-publication-incomplete-observe-only')
        for spec in specs:
            asset_metadata(current[spec['name']], spec); download(current[spec['name']], spec)
        identities = {name: row['id'] for name, row in current.items()}
    else:
        need(not observe, 'observation-cannot-create-publication')
        published = set()
        for spec in [intent, *specs]:
            fresh = bounded_namespace(refresh(), names)
            need(set(fresh) == published, 'publication-changed-before-post')
            for previous in [intent, *specs]:
                if previous['name'] in fresh: asset_metadata(fresh[previous['name']], previous)
            # Each callback is invoked once. Exceptions propagate; there is no retry.
            row = upload(spec); asset_metadata(row, spec); published.add(spec['name']); identities[spec['name']] = row['id']
    final = bounded_namespace(refresh(), names)
    need(set(final) == names, 'complete-final-publication-required')
    for spec in [intent, *specs]:
        asset_metadata(final[spec['name']], spec)
        need(final[spec['name']]['id'] == identities[spec['name']], 'published-asset-id-changed')
    return {name: value['id'] for name, value in final.items()}


def git_bytes(root, commit, relative):
    args = ['git', '-C', str(root)]
    raw = subprocess.check_output([*args, 'show', commit + ':' + relative], timeout=30)
    need(raw == read(root / relative, 2 * 1024**2), 'working-source-differs-from-commit:' + relative)
    return raw


def main(args):
    app = Path(__file__).resolve().parent.parent
    values, metadata, receipt = candidate_files(args.directory.absolute())
    if args.check_only:
        print(json.dumps({'kind': 'bounded-candidate-files', 'files': len(values), 'bytes': sum(map(len, values.values())), 'maximumZipBytes': MAX_ZIP})); return
    identity = environment(os.environ); write_attempt(identity, args.observe); root = app.parent
    need(sys.platform == 'linux' and hasattr(signal, 'setitimer'), 'qualified-linux-publisher-required')
    need(subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True, timeout=30).strip() == identity['commit'],
         'exact-checkout-required')
    subprocess.run(['git', '-C', str(root), 'diff', '--quiet', 'HEAD', '--', 'edition3', WORKFLOW], timeout=30, check=True)
    sources = {name: git_bytes(root, identity['commit'], 'edition3/' + name) for name in
               ('scripts/publish-ci-release-artifact.py', 'scripts/retain-ci-candidate.py',
                'scripts/release-full-publication-primitives.py', 'scripts/update-app-archive.py',
                'scripts/candidate.mjs', 'package.json', 'package-lock.json')}
    workflow = git_bytes(root, identity['commit'], WORKFLOW)
    package = json.loads(sources['package.json'])
    need(metadata.get('version') == package['version'] and metadata.get('buildVersion') == package['edition3']['buildVersion']
         and metadata.get('packageLockSha256') == sha(sources['package-lock.json']), 'candidate-package-lock-version-changed')
    need(receipt.get('format') == 1 and receipt.get('kind') == 'canonical-ci-built-candidate'
         and receipt.get('sourceCommit') == identity['commit'] and receipt.get('repository') == REPOSITORY
         and receipt.get('runId') == str(identity['runId']) and receipt.get('runAttempt') == str(identity['attempt'])
         and receipt.get('toolchain') == {'nodeVersion': '22.23.2', 'platform': 'linux', 'arch': 'x64'}
         and receipt.get('rebuilt') is False and receipt.get('deliveryQualification') is False
         and receipt.get('packagerSha256') == sha(sources['scripts/update-app-archive.py'])
         and receipt.get('candidateVerifierSha256') == sha(sources['scripts/candidate.mjs']), 'exact-canonical-build-receipt-required')
    definition = importlib.util.spec_from_file_location('ci_publication_primitives', app / 'scripts/release-full-publication-primitives.py')
    primitives = importlib.util.module_from_spec(definition); definition.loader.exec_module(primitives)
    token = os.environ.get('GH_TOKEN'); need(isinstance(token, str) and token, 'publisher-token-required')
    get = lambda path, timeout=45: api(path, token, timeout)
    facts = wait_context(identity, get, args.observe)
    release, _ = release_identity(package['version'], identity, get)
    out = Path(os.environ['RUNNER_TEMP']).resolve(strict=True) / 'nova-ci-publication'
    out.mkdir(mode=0o700)
    stem = 'nova-ci-' + identity['commit'] + '-run-' + str(identity['runId'])
    name = stem + '-attempt-' + str(identity['attempt'])
    archive_path = out / (name + '.zip'); archive = {'name': archive_path.name, **build_zip(values, archive_path)}
    hashes = {'sha256': sha(sources['scripts/publish-ci-release-artifact.py']),
              'retainerSha256': sha(sources['scripts/retain-ci-candidate.py']), 'workflowSha256': sha(workflow),
              'primitivesSha256': sha(sources['scripts/release-full-publication-primitives.py'])}
    value = transport(identity, facts, release, package['version'], hashes, archive, sha(values['ci-source.json']))
    transport_path = out / (name + '.transport.json'); transport_raw = encoded(value)
    need(len(transport_raw) <= MAX_CONTROL, 'transport-receipt-size-bound'); primitives.save(transport_path, transport_raw)
    specs = [{'path': str(archive_path), **archive}, {'path': str(transport_path), 'name': transport_path.name,
              'bytes': len(transport_raw), 'sha256': sha(transport_raw)}]
    intent_path = out / (stem + '.intent.json')
    intent_value = {'format': 1, 'kind': 'private-ci-release-publication-intent', 'sourceCommit': identity['commit'],
                    'runId': identity['runId'], 'runAttempt': identity['attempt'], 'releaseId': release['id'],
                    'assets': [{k: s[k] for k in ('name', 'bytes', 'sha256')} for s in specs], 'automaticRetry': False}
    intent_raw = encoded(intent_value); need(len(intent_raw) <= MAX_CONTROL, 'intent-size-bound'); primitives.save(intent_path, intent_raw)
    intent = {'name': intent_path.name, 'path': str(intent_path), 'bytes': len(intent_raw), 'sha256': sha(intent_raw)}
    counter = 0
    def fresh_assets():
        current, assets = release_identity(package['version'], identity, get)
        need(current['id'] == release['id'], 'source-release-replaced')
        return assets
    def target():
        nonlocal counter
        counter += 1; path = out / ('readback-' + str(counter)); path.mkdir(mode=0o700); return path
    def download(asset, spec):
        return primitives.download_verified(token, asset, spec, target())
    def upload(spec):
        current_facts = wait_context(identity, get, False)
        need(provenance_binding(current_facts) == provenance_binding(facts), 'producer-provenance-changed-before-post')
        current = bounded_namespace(fresh_assets(), {s['name'] for s in [intent, *specs]})
        need(spec['name'] not in current, 'asset-appeared-before-post')
        result = primitives.upload_verified(None, token, identity, release, target(), spec['name'],
                                            spec['path'], spec['bytes'], spec['sha256'])
        matches = [a for a in fresh_assets() if a.get('id') == result['id']]
        need(len(matches) == 1, 'uploaded-asset-not-reconciled')
        return matches[0]
    try:
        assets = publish_once(specs, intent, fresh_assets, upload, download, args.observe)
        primitives.save(out / 'publication-verified.json', {'format': 1, 'transport': value, 'assets': assets,
                         'authenticatedDownloadVerified': True, 'observedOnly': args.observe, 'deliveryQualification': False})
        print(json.dumps({'kind': 'private-ci-release-handoff-complete', 'sourceCommit': identity['commit'],
                          'runId': identity['runId'], 'runAttempt': identity['attempt'], 'assets': assets,
                          'archiveSha256': archive['sha256'], 'transportSha256': sha(transport_raw),
                          'deliveryQualification': False}))
    except Exception as error:
        primitives.save(out / 'publication-uncertain.json', {'format': 1, 'errorType': type(error).__name__,
                         'automaticRetry': False, 'observeOnlyRequired': True})
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--observe', action='store_true')
    arguments = parser.parse_args()
    try:
        main(arguments)
    except Exception as error:
        print(json.dumps({'kind': 'private-ci-release-handoff-refused', 'errorType': type(error).__name__,
                          'reason': str(error) if isinstance(error, RuntimeError) else 'bounded-publication-failure',
                          'automaticRetry': False}), file=sys.stderr)
        sys.exit(1)
