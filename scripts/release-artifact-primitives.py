"""Read-only exact-run CI artifact collection; no build, publish or host mutation.

Requires frozen local source and explicit successful GitHub run/attempt inputs.
Leaves any partial exclusive output in place; never resumes or overwrites it.
"""
import argparse
import ast
import datetime
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile
import time
import types
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[2]
MAXIMUM = 128 * 1024 ** 2
MAX_ZIP = MAXIMUM + 4 * 1024 ** 2
REPOS = {
    'Nova-Dream': ('mascot-live-private', 'edition3', '.github/workflows/nova-release.yml', 'Nova Dream quality and release history'),
    'Nova-Dream-Public': ('mascot-live-public', '', '.github/workflows/quality.yml', 'Application quality'),
}
REQUIRED_STEPS = ('Run npm run quality', 'Verify Linux update recovery',
                  'Retain the canonical hosted build', 'Upload the verified application archive')
FILES = {'app.tgz': MAXIMUM, 'app.tgz.metadata.json': 1024 ** 2, 'ci-source.json': 1024 ** 2}
PRIVATE_ZIP_MAXIMUM = 16 * 1024 ** 2
PRIVATE_TRANSPORT_MAXIMUM = 64 * 1024
PRIVATE_PRODUCER = 'scripts/publish-ci-release-artifact.py'
PRIVATE_PRIMITIVES = 'scripts/release-full-publication-primitives.py'
PRIVATE_PRODUCER_STEPS = ('Build the exact delivery candidate', 'Retain the canonical hosted build',
                          'Record this numbered Nova Dream update', 'Publish the verified application archive')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def hex_digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value)


def positive(value):
    return type(value) is int and 0 < value <= 9007199254740991


def read_json(path, limit=1024 ** 2):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit,
            'Expected a bounded ordinary JSON input.')
    raw = path.read_bytes()
    return json.loads(raw), sha(raw)


def write_private(path, raw):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def write_json(path, value):
    raw = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    write_private(path, raw)
    return sha(raw)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Unexpected HTTP redirect refused.')


class CaptureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api_headers(token):
    return {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nova-Release-Verification'}


def api(path, token):
    require(any(path == '/repos/HatimTheDream/' + name or path.startswith('/repos/HatimTheDream/' + name + '/') for name in REPOS)
            and not urllib.parse.urlsplit(path).scheme and not urllib.parse.urlsplit(path).netloc,
            'Unexpected GitHub API origin.')
    request = urllib.request.Request('https://api.github.com' + path, headers=api_headers(token), method='GET')
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=45) as response:
            raw = response.read(4 * 1024 ** 2 + 1)
            require(response.status == 200 and len(raw) <= 4 * 1024 ** 2, 'GitHub JSON response exceeded its bound.')
            return json.loads(raw)
    except (urllib.error.HTTPError, urllib.error.URLError):
        raise RuntimeError('Read-only GitHub API request failed.') from None


def download_zip(prefix, artifact_id, token):
    request = urllib.request.Request('https://api.github.com' + prefix + '/actions/artifacts/' + str(artifact_id) + '/zip',
                                     headers=api_headers(token), method='GET')
    try:
        with urllib.request.build_opener(CaptureRedirect()).open(request, timeout=45):
            raise RuntimeError('Expected the GitHub artifact delivery redirect.')
    except urllib.error.HTTPError as error:
        require(error.code == 302, 'GitHub artifact download is unavailable.')
        location = error.headers.get('Location', '')
    except urllib.error.URLError:
        raise RuntimeError('GitHub artifact delivery request failed.') from None
    parsed = urllib.parse.urlsplit(location)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password and not parsed.fragment
            and parsed.port in (None, 443) and parsed.hostname
            and (parsed.hostname.endswith('.blob.core.windows.net') or parsed.hostname.endswith('.actions.githubusercontent.com')),
            'Unreviewed GitHub artifact delivery origin.')
    # Separate unauthenticated request: never forward API credentials or retain the signed URL.
    try:
        with urllib.request.build_opener(NoRedirect()).open(location, timeout=45) as response:
            raw = response.read(MAX_ZIP + 1)
            require(response.status == 200 and 0 < len(raw) <= MAX_ZIP, 'GitHub artifact ZIP exceeded its bound.')
            return raw
    except (urllib.error.HTTPError, urllib.error.URLError):
        raise RuntimeError('Unauthenticated artifact byte download failed.') from None


def frozen_source(repo, commit, git, *, checkout=None, output_root=None, committed_only=False, private_release=False):
    folder, prefix, workflow, _ = REPOS[repo]
    checkout = pathlib.Path(checkout) if checkout is not None else WORKSPACE / '.local-development' / folder
    require(checkout.resolve(strict=True) == checkout, 'Frozen checkout was redirected.')
    def command(*arguments):
        result = subprocess.run([str(git), *arguments], cwd=checkout, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30, check=False)
        require(result.returncode == 0 and len(result.stdout) <= 16 * 1024 ** 2
                and len(result.stderr) <= 65536, 'Frozen Git source check failed.')
        return result.stdout
    require(command('rev-parse', commit + '^{commit}').decode().strip() == commit, 'Explicit committed source is unavailable.')
    if not committed_only:
        require(command('rev-parse', 'HEAD').decode().strip() == commit, 'Local source does not match the explicit frozen commit.')
    remote = command('remote', 'get-url', 'origin').decode().strip()
    require(remote in ('https://github.com/HatimTheDream/' + repo + '.git',
                       'git@github.com:HatimTheDream/' + repo + '.git'), 'Checkout origin does not match the repository.')
    if not committed_only:
        command('diff', '--quiet', 'HEAD', '--', prefix or '.', workflow)
    paths = ['package.json', 'package-lock.json', 'scripts/host.mjs', 'scripts/candidate.mjs',
             'scripts/update-app-archive.py', 'scripts/retain-ci-candidate.py',
             *('deploy/update-runner/' + name for name in ('install.py', 'recovery.py', 'app_dependencies.py',
                'codex_log_retention.py', 'workspace_key.py', 'verify-session-bindings.mjs', 'request_install.py',
                'operator_rehearsal.py'))]
    package_path = prefix + '/package.json' if prefix else 'package.json'
    package = json.loads(command('show', commit + ':' + package_path))
    if 'release:deliver' in package.get('scripts', {}):
        # Bind the exact committed command source; never take it from a mutable
        # checkout or infer its presence from a package script alone.
        paths.append('scripts/release-deliver.mjs')
    if package.get('scripts', {}).get('quality') == 'node scripts/quality.mjs':
        paths.append('scripts/quality.mjs')
    if private_release:
        require(repo == 'Nova-Dream', 'private-release-source-repository')
        paths.extend((PRIVATE_PRODUCER, PRIVATE_PRIMITIVES))
    bound, blobs = {}, {}
    for relative in paths:
        name = prefix + '/' + relative if prefix else relative
        raw = command('show', commit + ':' + name)
        bound[relative] = {'path': name, 'sha256': sha(raw)}
        blobs[relative] = raw
    raw = command('show', commit + ':' + workflow)
    bound['workflow'] = {'path': workflow, 'sha256': sha(raw)}
    # Always execute/import exact frozen Git bytes, independent of Windows autocrlf.
    # This immutable local source copy contains no build, credentials or saved data.
    extracted = (pathlib.Path(output_root) if output_root is not None else ROOT) / ('frozen-source-' + repo + '-' + commit)
    frozen_receipt = {'format': 1, 'repository': 'HatimTheDream/' + repo,
                      'sourceCommit': commit, 'sourceHashes': bound, 'gitBlobBytes': True}
    if not extracted.exists() and not extracted.is_symlink():
        extracted.mkdir(mode=0o700)
        for name, content in blobs.items():
            target = extracted / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            write_private(target, content)
        write_private(extracted / 'frozen-workflow.yml', raw)
        write_json(extracted / 'frozen-source-receipt.json', frozen_receipt)
    require(extracted.is_dir() and not extracted.is_symlink() and extracted.resolve(strict=True) == extracted,
            'Frozen source destination was redirected.')
    require(read_json(extracted / 'frozen-source-receipt.json')[0] == frozen_receipt,
            'Existing frozen source receipt differs; preserve the partial output.')
    for name, content in {**blobs, 'frozen-workflow.yml': raw}.items():
        target = extracted / name
        require(target.is_file() and not target.is_symlink() and target.resolve(strict=True) == target
                and target.read_bytes() == content, 'Frozen Git-blob source changed.')
    return extracted, bound


def exact_run(repo, selected, token):
    commit, run_id, attempt = selected['sourceCommit'], selected['runId'], selected['runAttempt']
    prefix = '/repos/HatimTheDream/' + repo
    run = api(prefix + '/actions/runs/' + str(run_id) + '/attempts/' + str(attempt), token)
    require(run['id'] == run_id and run['run_attempt'] == attempt and run['head_sha'] == commit
            and run['event'] == 'push' and run['head_branch'] == 'main'
            and run['status'] == 'completed' and run['conclusion'] == 'success'
            and run['name'] == REPOS[repo][3] and run['repository']['full_name'] == 'HatimTheDream/' + repo
            and run['head_repository']['full_name'] == 'HatimTheDream/' + repo,
            'Exact source/workflow/run/attempt has not passed.')
    workflow = api(prefix + '/actions/workflows/' + str(run['workflow_id']), token)
    require(positive(run['workflow_id']) and workflow['id'] == run['workflow_id']
            and workflow['path'] == REPOS[repo][2] and workflow['name'] == REPOS[repo][3], 'Unexpected quality workflow identity.')
    jobs = api(prefix + '/actions/runs/' + str(run_id) + '/attempts/' + str(attempt) + '/jobs?per_page=100', token)
    require(jobs['total_count'] == len(jobs['jobs']) <= 100, 'Job listing was incomplete.')
    quality = [job for job in jobs['jobs'] if job['name'] == 'quality']
    require(len(quality) == 1, 'Expected one canonical quality job.')
    job = quality[0]
    require(positive(job['id']) and job['run_id'] == run_id and job['head_sha'] == commit
            and job['status'] == 'completed' and job['conclusion'] == 'success' and len(job['steps']) <= 100,
            'Canonical quality job did not complete successfully.')
    steps = []
    for name in REQUIRED_STEPS:
        matching = [step for step in job['steps'] if step['name'] == name]
        require(len(matching) == 1 and matching[0]['status'] == 'completed' and matching[0]['conclusion'] == 'success',
                'A required quality/recovery/retention/upload step did not pass.')
        steps.append({key: matching[0][key] for key in ('number', 'name', 'status', 'conclusion')})
    artifacts = api(prefix + '/actions/runs/' + str(run_id) + '/artifacts?per_page=100', token)
    require(artifacts['total_count'] == len(artifacts['artifacts']) <= 100, 'Artifact listing was incomplete.')
    matches = [item for item in artifacts['artifacts'] if item['name'] == 'nova-hosted-' + commit]
    require(len(matches) == 1, 'Expected one exact source hosted artifact.')
    artifact = matches[0]
    require(positive(artifact['id']) and artifact['expired'] is False and type(artifact['size_in_bytes']) is int
            and 0 < artifact['size_in_bytes'] <= MAX_ZIP and artifact['workflow_run']['id'] == run_id
            and artifact['workflow_run']['head_sha'] == commit, 'Artifact is expired or has another source/run.')
    return prefix, run, job, steps, artifact


def successful_steps(job, names):
    require(isinstance(job.get('steps'), list) and len(job['steps']) <= 100, 'private-ci-step-list')
    result = []
    for name in names:
        rows = [step for step in job['steps'] if step.get('name') == name]
        require(len(rows) == 1 and rows[0].get('status') == 'completed'
                and rows[0].get('conclusion') == 'success', 'private-ci-required-step')
        result.append({key: rows[0][key] for key in ('number', 'name', 'status', 'conclusion')})
    return result


def private_asset(asset, name, prefix, maximum, producer):
    require(isinstance(asset, dict) and positive(asset.get('id')) and asset.get('name') == name
            and type(asset.get('size')) is int and 0 < asset['size'] <= maximum
            and asset.get('state') == 'uploaded' and re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or '')
            and asset.get('url') == 'https://api.github.com' + prefix + '/releases/assets/' + str(asset['id'])
            and asset.get('uploader', {}).get('login') == 'github-actions[bot]'
            and asset.get('uploader', {}).get('type') == 'Bot', 'private-ci-asset-identity')
    try:
        times = [datetime.datetime.fromisoformat(value.replace('Z', '+00:00')) for value in
                 (producer['started_at'], asset['created_at'], asset['updated_at'], producer['completed_at'])]
        require(all(value.tzinfo is not None for value in times) and times == sorted(times), 'private-ci-asset-job-time')
    except (KeyError, TypeError, ValueError):
        raise RuntimeError('private-ci-asset-job-time') from None
    return {key: asset[key] for key in ('id', 'name', 'size', 'state', 'digest', 'url', 'created_at', 'updated_at', 'uploader')}


def exact_private_release(selected, version, token):
    """Explicit private transport. A failed Actions run never falls back here."""
    prefix = '/repos/HatimTheDream/Nova-Dream'
    commit, run_id, attempt = (selected[key] for key in ('sourceCommit', 'runId', 'runAttempt'))
    repository = api(prefix, token)
    require(positive(repository.get('id')) and repository.get('full_name') == 'HatimTheDream/Nova-Dream'
            and repository.get('private') is True, 'private-ci-repository')
    run = api(prefix + f'/actions/runs/{run_id}/attempts/{attempt}', token)
    require(run.get('id') == run_id and run.get('run_attempt') == attempt and run.get('head_sha') == commit
            and run.get('event') == 'push' and run.get('head_branch') == 'main'
            and run.get('status') == 'completed' and run.get('conclusion') == 'success'
            and run.get('name') == REPOS['Nova-Dream'][3]
            and all(run.get(key, {}).get('full_name') == repository['full_name']
                    and run[key].get('id') == repository['id'] for key in ('repository', 'head_repository')),
            'private-ci-run-not-successful')
    require(positive(run.get('workflow_id')), 'private-ci-workflow')
    workflow = api(prefix + '/actions/workflows/' + str(run['workflow_id']), token)
    require(workflow.get('id') == run['workflow_id'] and workflow.get('path') == REPOS['Nova-Dream'][2]
            and workflow.get('name') == REPOS['Nova-Dream'][3], 'private-ci-workflow')
    jobs = api(prefix + f'/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100', token)
    require(isinstance(jobs.get('jobs'), list) and type(jobs.get('total_count')) is int
            and jobs['total_count'] == len(jobs['jobs']) <= 100
            and all(positive(job.get('id')) and job.get('run_id') == run_id and job.get('head_sha') == commit
                    and job.get('status') == 'completed' and job.get('conclusion') == 'success' for job in jobs['jobs']),
            'private-ci-jobs-not-successful')
    chosen = {}
    for name in ('quality', 'release'):
        rows = [job for job in jobs['jobs'] if job.get('name') == name]
        require(len(rows) == 1, 'private-ci-job-ambiguous')
        chosen[name] = rows[0]
    quality, producer = chosen['quality'], chosen['release']
    require(quality['id'] != producer['id'], 'private-ci-job-identity')
    quality_steps = successful_steps(quality, REQUIRED_STEPS[:2])
    producer_steps = successful_steps(producer, PRIVATE_PRODUCER_STEPS)
    tag = 'nova-v' + version
    release = api(prefix + '/releases/tags/' + tag, token)
    require(positive(release.get('id')) and release.get('tag_name') == tag
            and release.get('target_commitish') == commit and release.get('draft') is False
            and release.get('prerelease') is False, 'private-ci-release-identity')
    gitref = api(prefix + '/git/ref/tags/' + tag, token)
    require(gitref.get('object', {}).get('type') == 'commit' and gitref['object'].get('sha') == commit,
            'private-ci-tag-identity')
    assets = api(prefix + '/releases/' + str(release['id']) + '/assets?per_page=100', token)
    require(isinstance(assets, list) and len(assets) < 100, 'private-ci-assets-incomplete')
    stem = f'nova-ci-{commit}-run-{run_id}-attempt-{attempt}'
    resolved = {}
    for role, suffix, maximum in (('archive', '.zip', PRIVATE_ZIP_MAXIMUM),
                                  ('transport', '.transport.json', PRIVATE_TRANSPORT_MAXIMUM)):
        rows = [asset for asset in assets if asset.get('name') == stem + suffix]
        require(len(rows) == 1, 'private-ci-asset-ambiguous')
        resolved[role] = private_asset(rows[0], stem + suffix, prefix, maximum, producer)
    require(resolved['archive']['id'] != resolved['transport']['id'], 'private-ci-asset-identity')
    return {'repository': {'id': repository['id'], 'fullName': repository['full_name'], 'private': True},
            'run': {'id': run_id, 'attempt': attempt, 'workflowId': run['workflow_id'],
                    'workflowPath': workflow['path'], 'event': 'push', 'branch': 'main'},
            'qualityJob': {'id': quality['id'], 'name': 'quality'},
            'producerJob': {'id': producer['id'], 'name': 'release'},
            'qualitySteps': quality_steps, 'producerSteps': producer_steps,
            'release': {'id': release['id'], 'tag': tag, 'targetCommitish': commit}, 'assets': resolved}


def download_release_asset(asset, token, maximum):
    """Same authenticated API -> credential-free release CDN boundary as publication readback."""
    require(type(asset.get('size')) is int and 0 < asset['size'] <= maximum, 'private-ci-download-size')
    headers = api_headers(token); headers['Accept'] = 'application/octet-stream'
    request = urllib.request.Request(asset['url'], headers=headers, method='GET')
    try:
        try:
            response = urllib.request.build_opener(CaptureRedirect()).open(request, timeout=30)
        except urllib.error.HTTPError as error:
            try:
                require(error.code == 302, 'private-ci-download-unavailable')
                location = error.headers.get('Location', '')
            finally:
                error.close()
            parsed = urllib.parse.urlsplit(location)
            require(parsed.scheme == 'https' and parsed.hostname == 'release-assets.githubusercontent.com'
                    and not parsed.username and not parsed.password and not parsed.fragment
                    and parsed.port in (None, 443), 'private-ci-download-origin')
            response = urllib.request.build_opener(NoRedirect()).open(
                urllib.request.Request(location, headers={'User-Agent': 'Nova-Release-Verification'}), timeout=30)
        deadline = time.monotonic() + 120
        chunks, count = [], 0
        with response:
            require(response.status == 200, 'private-ci-download-unavailable')
            while True:
                require(time.monotonic() < deadline, 'private-ci-download-deadline')
                block = response.read1(min(1024 ** 2, asset['size'] + 1 - count))
                require(time.monotonic() < deadline, 'private-ci-download-deadline')
                if not block:
                    break
                count += len(block)
                require(count <= asset['size'], 'private-ci-download-oversize')
                chunks.append(block)
        raw = b''.join(chunks)
        require(count == asset['size'] and 'sha256:' + sha(raw) == asset['digest'], 'private-ci-download-corrupt')
        return raw
    except (urllib.error.HTTPError, urllib.error.URLError):
        raise RuntimeError('private-ci-download-unavailable') from None


def validate_private_transport(raw, snapshot, bound, selected, version, ci_source=None):
    require(0 < len(raw) <= PRIVATE_TRANSPORT_MAXIMUM, 'private-ci-transport-size')
    manifest = json.loads(raw)
    archive = snapshot['assets']['archive']
    expected = {'format': 1, 'kind': 'private-ci-release-artifact', 'repository': snapshot['repository'],
                'sourceCommit': selected['sourceCommit'], 'version': version, 'run': snapshot['run'],
                'qualityJob': snapshot['qualityJob'], 'producerJob': snapshot['producerJob'],
                'producer': {'path': PRIVATE_PRODUCER, 'sha256': bound[PRIVATE_PRODUCER]['sha256'],
                             'primitivesSha256': bound[PRIVATE_PRIMITIVES]['sha256'],
                             'retainerSha256': bound['scripts/retain-ci-candidate.py']['sha256'],
                             'workflowSha256': bound['workflow']['sha256']},
                'release': snapshot['release'], 'archive': {'name': archive['name'], 'bytes': archive['size'],
                                                         'sha256': archive['digest'][7:]},
                'ciSourceSha256': manifest.get('ciSourceSha256'), 'buildOrigin': 'same-run-release-job',
                'deliveryQualification': False}
    require(json.dumps(manifest, sort_keys=True) == json.dumps(expected, sort_keys=True)
            and hex_digest(manifest['ciSourceSha256']), 'private-ci-transport-binding')
    if ci_source is not None:
        require(sha(ci_source) == manifest['ciSourceSha256'], 'private-ci-producer-receipt-changed')
    return manifest


def extract_zip(raw, output, *, maximum=MAXIMUM):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        items = archive.infolist()
        require(len(items) == 3 and {item.filename for item in items} == set(FILES), 'ZIP must contain exactly the three retained files.')
        require(len({item.filename for item in items}) == len(items), 'Duplicate ZIP member.')
        for item in items:
            mode = item.external_attr >> 16
            limit = min(FILES[item.filename], maximum) if item.filename == 'app.tgz' else FILES[item.filename]
            require(not item.is_dir() and not item.flag_bits & 1 and not stat.S_ISLNK(mode)
                    and stat.S_IFMT(mode) in (0, stat.S_IFREG) and 0 < item.file_size <= limit
                    and item.compress_size <= MAX_ZIP, 'Unsafe or oversized ZIP member.')
            with archive.open(item) as stream:
                content = stream.read(limit + 1)
            require(len(content) == item.file_size, 'ZIP member expansion changed.')
            write_private(output / item.filename, content)


def verify_application(source, bound, output, metadata, node, *, verify_existing=False):
    # Invoke the actual maintained parser method, isolated as in its focused fixture test.
    installer = source / 'deploy/update-runner/install.py'
    tree = ast.parse(installer.read_text(encoding='utf-8'))
    driver = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == 'Driver')
    method = next(item for item in driver.body if isinstance(item, ast.FunctionDef) and item.name == 'archive_members')
    namespace = {'tarfile': tarfile, 'pathlib': pathlib, 'MAXIMUM': MAXIMUM, 'require': require}
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(installer), 'exec'), namespace)
    members = namespace['archive_members'](types.SimpleNamespace(archive=output / 'app.tgz'))
    require(len(members) == metadata['fileCount'] and sum(item.size for item in members) == metadata['expandedBytes'],
            'Archive structure does not match metadata.')
    application = output / 'verified-application'
    if verify_existing:
        require(application.is_dir() and not application.is_symlink() and application.resolve(strict=True) == application,
                'Retained application directory changed.')
    else:
        application.mkdir(mode=0o700)
    with tarfile.open(output / 'app.tgz', 'r:gz') as archive:
        for member in members:
            name = member.name
            require('\\' not in name and ':' not in name and '\0' not in name
                    and member.uid == member.gid == member.mtime == 0
                    and member.mode == (0o755 if member.isdir() else 0o644), 'Application member is not canonical.')
            target = application / pathlib.PurePosixPath(name)
            require(target.resolve(strict=False) == target, 'Application output path was redirected.')
            if member.isdir():
                if verify_existing:
                    require(target.is_dir() and not target.is_symlink(), 'Retained application directory changed.')
                else:
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                if not verify_existing:
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                stream = archive.extractfile(member)
                require(stream is not None, 'Application archive member is unavailable.')
                content = stream.read(MAXIMUM + 1)
                require(len(content) == member.size, 'Application expansion differs from its member size.')
                if verify_existing:
                    require(target.is_file() and not target.is_symlink() and target.stat().st_size == len(content)
                            and target.read_bytes() == content, 'Retained application file differs from its canonical archive.')
                else:
                    write_private(target, content)
    for name in ('package.json', 'package-lock.json', 'scripts/host.mjs', 'scripts/candidate.mjs'):
        require(sha((application / name).read_bytes()) == bound[name]['sha256'], 'Archive source input differs from the frozen repository.')
    definition = importlib.util.spec_from_file_location('frozen_app_packager', source / 'scripts/update-app-archive.py')
    packager = importlib.util.module_from_spec(definition)
    definition.loader.exec_module(packager)
    candidate = packager.verified_candidate(application, node)
    require(candidate['id'] == metadata['candidateId']
            and all(candidate[key] == metadata[key] for key in ('version', 'buildVersion', 'schemaVersion', 'apiVersion')),
            'Maintained candidate verifier disagrees with metadata.')
    selected_files = set(candidate['files']) | {'package-lock.json', 'scripts/host.mjs', 'scripts/candidate.mjs'}
    directories = {str(parent) for name in selected_files for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.'}
    require({member.name for member in members} == selected_files | directories,
            'Archive contains files outside the verified candidate closure.')
    require({str(path.relative_to(application)).replace('\\', '/') for path in application.rglob('*')} == selected_files | directories,
            'Extracted application contains unverified additional files.')
    require(metadata['packageLockSha256'] == bound['package-lock.json']['sha256'], 'Archive lockfile identity changed.')
    return candidate


def collect(inputs_path):
    inputs, input_hash = read_json(inputs_path, 32768)
    require(set(inputs) == {'format', 'version', 'git', 'node', 'nodeSha256', 'nodeToolchain', 'ciNodeSha256', 'repositories'}
            and inputs['format'] == 1 and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', inputs['version'])
            and set(inputs['repositories']) == set(REPOS) and hex_digest(inputs['nodeSha256'])
            and hex_digest(inputs['ciNodeSha256']), 'Actual frozen source/run/toolchain inputs are required.')
    git, node = pathlib.Path(inputs['git']), pathlib.Path(inputs['node'])
    require(git.is_absolute() and git.is_file() and node.is_absolute() and node.is_file() and not node.is_symlink()
            and sha(node.read_bytes()) == inputs['nodeSha256'], 'Local verifier Node identity differs.')
    require(isinstance(inputs['nodeToolchain'], dict)
            and set(inputs['nodeToolchain']) == {'nodeVersion', 'platform', 'arch'}
            and inputs['nodeToolchain']['nodeVersion'] == '22.23.2'
            and inputs['nodeToolchain']['platform'] in ('win32', 'linux')
            and inputs['nodeToolchain']['arch'] == 'x64', 'Local verifier toolchain input is invalid.')
    runtime = subprocess.run([str(node), '-e',
                             'console.log(JSON.stringify({nodeVersion:process.versions.node,platform:process.platform,arch:process.arch}))'], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=15, check=False)
    require(runtime.returncode == 0 and len(runtime.stdout) <= 4096 and len(runtime.stderr) <= 4096
            and json.loads(runtime.stdout) == inputs['nodeToolchain'], 'Use the qualified local Node verifier.')
    credential_file = WORKSPACE / 'output/nova-github-backup-current1155/github-account-check.py'
    spec = importlib.util.spec_from_file_location('github_credentials', credential_file)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    token = helper.credential()
    for repo, selected in inputs['repositories'].items():
        require(set(selected) == {'sourceCommit', 'runId', 'runAttempt'} and isinstance(selected['sourceCommit'], str)
                and re.fullmatch('[a-f0-9]{40}', selected['sourceCommit'])
                and positive(selected['runId']) and positive(selected['runAttempt']), 'Exact commit/run/attempt inputs are missing.')
        source, bound = frozen_source(repo, selected['sourceCommit'], git)
        prefix, run, job, steps, artifact = exact_run(repo, selected, token)
        output = ROOT / ('ci-artifacts-' + repo + '-' + selected['sourceCommit'] + '-run' + str(selected['runId']) + '-attempt' + str(selected['runAttempt']))
        output.mkdir(mode=0o700)  # Exclusive, retained on any uncertainty/failure.
        write_json(output / 'collection-intent.json', {'format': 1, 'inputsSha256': input_hash, 'repository': repo,
                   **selected, 'artifactId': artifact['id'], 'readOnlyGithub': True})
        raw = download_zip(prefix, artifact['id'], token)
        digest = artifact.get('digest')
        require(digest is None or (isinstance(digest, str) and re.fullmatch('sha256:[a-f0-9]{64}', digest)
                and digest == 'sha256:' + sha(raw)), 'GitHub artifact digest does not match ZIP bytes.')
        require(len(raw) == artifact['size_in_bytes'], 'GitHub artifact byte size differs.')
        write_private(output / 'artifact.zip', raw)
        extract_zip(raw, output)
        metadata, metadata_hash = read_json(output / 'app.tgz.metadata.json')
        ci, ci_hash = read_json(output / 'ci-source.json')
        require(set(ci) == {'format', 'kind', 'sourceCommit', 'repository', 'runId', 'runAttempt', 'toolchain',
                           'nodeSha256', 'packagerSha256', 'candidateVerifierSha256', 'application', 'rebuilt', 'deliveryQualification'}
                and ci['format'] == 1 and ci['kind'] == 'canonical-ci-built-candidate'
                and ci['sourceCommit'] == selected['sourceCommit'] and ci['repository'] == 'HatimTheDream/' + repo
                and ci['runId'] == str(selected['runId']) and ci['runAttempt'] == str(selected['runAttempt'])
                and ci['toolchain'] == {'nodeVersion': '22.23.2', 'platform': 'linux', 'arch': 'x64'}
                and ci['nodeSha256'] == inputs['ciNodeSha256'] and ci['rebuilt'] is False and ci['deliveryQualification'] is False
                and ci['packagerSha256'] == bound['scripts/update-app-archive.py']['sha256']
                and ci['candidateVerifierSha256'] == bound['scripts/candidate.mjs']['sha256'] and ci['application'] == metadata,
                'CI source/toolchain/helper receipt differs from frozen inputs.')
        require(set(metadata) == {'format', 'version', 'buildVersion', 'schemaVersion', 'apiVersion', 'candidateId',
                                 'archiveBytes', 'archiveSha256', 'expandedBytes', 'fileCount', 'packageLockSha256'}
                and metadata['format'] == 1 and metadata['version'] == inputs['version'] and hex_digest(metadata['candidateId'])
                and metadata['archiveBytes'] == (output / 'app.tgz').stat().st_size
                and metadata['archiveSha256'] == sha((output / 'app.tgz').read_bytes()), 'App archive identity differs from metadata.')
        candidate = verify_application(source, bound, output, metadata, node)
        require(frozen_source(repo, selected['sourceCommit'], git) == (source, bound)
                and read_json(inputs_path, 32768) == (inputs, input_hash), 'Frozen source or collection inputs changed.')
        origin = 'https://github.com/HatimTheDream/' + repo + '/actions/runs/' + str(selected['runId'])
        receipt = {'format': 1, 'kind': 'collected-exact-ci-hosted-artifact', 'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'inputsSha256': input_hash, 'repository': 'HatimTheDream/' + repo, **selected,
                   'githubOrigin': origin, 'githubApiOrigin': 'https://api.github.com' + prefix,
                   'workflowId': run['workflow_id'], 'workflowPath': REPOS[repo][2], 'workflowName': run['name'],
                   'qualityJobId': job['id'], 'requiredSteps': steps, 'artifactId': artifact['id'], 'artifactName': artifact['name'],
                   'artifactApiDigest': digest, 'zipSha256': sha(raw), 'zipBytes': len(raw), 'sourceHashes': bound,
                   'ciSourceSha256': ci_hash, 'metadataSha256': metadata_hash, 'application': metadata,
                   'maintainedArchiveParser': True, 'maintainedCandidateVerifier': True, 'candidateId': candidate['id'],
                   'localVerifierNodeSha256': inputs['nodeSha256'], 'localVerifierToolchain': inputs['nodeToolchain'],
                   'ciToolchain': ci['toolchain'], 'ciNodeSha256': inputs['ciNodeSha256'],
                   'rebuilt': False, 'deliveryQualification': False}
        receipt_hash = write_json(output / 'collection-receipt.json', receipt)
        print(json.dumps({'repository': repo, 'receiptPath': str(output / 'collection-receipt.json'),
                          'receiptSha256': receipt_hash, 'candidateId': candidate['id'],
                          'archiveSha256': metadata['archiveSha256']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inputs', type=pathlib.Path)
    mode.add_argument('--extract-frozen-source', type=pathlib.Path,
                      help='Actual source-commits JSON; extracts exact Git blobs locally without network.')
    args = parser.parse_args()
    try:
        if args.inputs:
            collect(args.inputs.resolve(strict=True))
        else:
            commits, commit_hash = read_json(args.extract_frozen_source.resolve(strict=True), 4096)
            require(set(commits) == {'format', 'version', 'sourceCommits'} and commits['format'] == 1
                    and set(commits['sourceCommits']) == set(REPOS), 'Exact committed source inputs are required.')
            baseline, _ = read_json(ROOT / 'hosted-artifact-input.draft.json', 32768)
            for repo, commit in commits['sourceCommits'].items():
                require(isinstance(commit, str) and re.fullmatch('[a-f0-9]{40}', commit), 'Source commit is not frozen.')
                directory, hashes = frozen_source(repo, commit, pathlib.Path(baseline['git']))
                print(json.dumps({'repository': repo, 'sourceCommit': commit, 'sourceDirectory': str(directory),
                                  'commitsInputSha256': commit_hash, 'sourceHashes': hashes, 'networkUsed': False}))
    except Exception as error:
        # Network exception details can contain temporary signed delivery URLs.
        print('Collection refused; exclusive partial output was preserved. ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
