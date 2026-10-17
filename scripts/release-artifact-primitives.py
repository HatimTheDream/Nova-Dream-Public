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
    require(any(path.startswith('/repos/HatimTheDream/' + name + '/') for name in REPOS)
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


def frozen_source(repo, commit, git, *, checkout=None, output_root=None, committed_only=False):
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


def extract_zip(raw, output):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        items = archive.infolist()
        require(len(items) == 3 and {item.filename for item in items} == set(FILES), 'ZIP must contain exactly the three retained files.')
        require(len({item.filename for item in items}) == len(items), 'Duplicate ZIP member.')
        for item in items:
            mode = item.external_attr >> 16
            require(not item.is_dir() and not item.flag_bits & 1 and not stat.S_ISLNK(mode)
                    and stat.S_IFMT(mode) in (0, stat.S_IFREG) and 0 < item.file_size <= FILES[item.filename]
                    and item.compress_size <= MAX_ZIP, 'Unsafe or oversized ZIP member.')
            with archive.open(item) as stream:
                content = stream.read(FILES[item.filename] + 1)
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
