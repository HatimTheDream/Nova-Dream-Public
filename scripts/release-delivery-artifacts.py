"""Fixed authenticated artifact producer around the maintained collector.

Execute performs one bounded read-only GitHub collection. Observe reconciles
the original exclusive output; it never downloads or re-extracts after a lost
response. Partial output remains uncertain, preserving the original operation.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

P = pathlib.Path
HERE = P(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('retained_artifact_primitives', HERE / 'release-artifact-primitives.py')
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


def need(value, code):
    if not value:
        raise RuntimeError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def read_ref(ref, maximum=1024 ** 2):
    need(set(ref) == {'path', 'sha256'}, 'invalid-reference')
    path = P(ref['path'])
    need(path.is_absolute() and path.resolve(strict=True) == path, 'redirected-reference')
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'symlink-reference')
    info = path.stat()
    need(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, 'oversized-reference')
    raw = path.read_bytes()
    need(len(raw) == info.st_size and C.sha(raw) == ref['sha256'], 'reference-hash-changed')
    return raw


def reference(path):
    return {'path': str(path), 'sha256': C.sha(path.read_bytes())}


def credentials(git):
    # Existing Git credential-provider pattern. Never return it in an artifact,
    # exception or CLI response and never forward it to a redirected host.
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
    value = subprocess.run([str(git), 'credential', 'fill'], input=b'protocol=https\nhost=github.com\n\n',
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30)
    need(value.returncode == 0 and len(value.stdout) <= 65536, 'credential-provider-unavailable')
    fields = dict(line.split('=', 1) for line in value.stdout.decode().splitlines() if '=' in line)
    need(fields.get('password'), 'credential-provider-unavailable')
    return fields['password']


def validate_receipts(request, side, source_hashes, output):
    source = request['sources'][side]
    selected = request['ci'][side]
    receipt, _ = C.read_json(output / 'ci-source.json')
    metadata, _ = C.read_json(output / 'app.tgz.metadata.json')
    need(set(receipt) == {'format', 'kind', 'sourceCommit', 'repository', 'runId', 'runAttempt', 'toolchain',
                         'nodeSha256', 'packagerSha256', 'candidateVerifierSha256', 'application', 'rebuilt', 'deliveryQualification'}, 'producer-fields-changed')
    need(receipt['format'] == 1 and receipt['kind'] == 'canonical-ci-built-candidate'
         and receipt['sourceCommit'] == source['commit'] and receipt['repository'] == source['repository']
         and receipt['runId'] == str(selected['runId']) and receipt['runAttempt'] == str(selected['runAttempt'])
         and receipt['toolchain'] == {'nodeVersion': '22.23.2', 'platform': 'linux', 'arch': 'x64'}
         and receipt['nodeSha256'] == request['tools']['ciNodeSha256'] and receipt['rebuilt'] is False and receipt['deliveryQualification'] is False
         and receipt['packagerSha256'] == source_hashes['scripts/update-app-archive.py']['sha256']
         and receipt['candidateVerifierSha256'] == source_hashes['scripts/candidate.mjs']['sha256'] and receipt['application'] == metadata, 'producer-identity-changed')
    need(set(metadata) == {'format', 'version', 'buildVersion', 'schemaVersion', 'apiVersion', 'candidateId', 'archiveBytes', 'archiveSha256', 'expandedBytes', 'fileCount', 'packageLockSha256'}
         and metadata['format'] == 1 and metadata['version'] == request['version'] and metadata['buildVersion'] == request['buildVersion']
         and C.hex_digest(metadata['candidateId']) and metadata['archiveBytes'] == (output / 'app.tgz').stat().st_size
         and metadata['archiveSha256'] == C.sha((output / 'app.tgz').read_bytes()), 'retained-archive-corrupt')
    return receipt, metadata


def collect(request, *, observe=False, token_provider=credentials):
    need(set(request) == {'format', 'operationId', 'key', 'inputSha256', 'version', 'buildVersion', 'sources', 'ci', 'tools', 'outputDirectory', 'helperHashes'}, 'artifact-request-fields')
    need(request['format'] == 1 and set(request['sources']) == set(request['ci']) == {'private', 'public'}, 'artifact-request-format')
    need(re.fullmatch('[0-9a-f-]{36}', request['key']) and re.fullmatch('[0-9a-f-]{36}', request['operationId']) and C.hex_digest(request['inputSha256']), 'artifact-operation-identity')
    for name in ('release-delivery-artifacts.py', 'release-artifact-primitives.py'):
        need(C.sha((HERE / name).read_bytes()) == request['helperHashes'][name], 'artifact-helper-changed')
    root = P(request['outputDirectory'])
    need(root.is_absolute() and root.resolve(strict=False) == root and root.name == 'delivery-artifacts-' + request['key'], 'artifact-output-scope')
    tools = request['tools']
    for name in ('git', 'node', 'python'):
        read_ref(tools[name], 128 * 1024 ** 2)
    node, git = P(tools['node']['path']), P(tools['git']['path'])
    runtime = subprocess.run([str(node), '-e', 'console.log(JSON.stringify({nodeVersion:process.versions.node,platform:process.platform,arch:process.arch}))'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    need(runtime.returncode == 0 and len(runtime.stdout) <= 4096 and json.loads(runtime.stdout) == tools['nodeToolchain']
         and tools['nodeToolchain']['nodeVersion'] == '22.23.2', 'verifier-toolchain-changed')
    if observe:
        need(root.is_dir() and not root.is_symlink(), 'original-artifact-worker-output-unavailable')
        completed, _ = C.read_json(root / 'result.json')
        need(completed['key'] == request['key'] and completed['inputSha256'] == request['inputSha256'], 'original-artifact-operation-changed')
    else:
        root.mkdir(mode=0o700)
        C.write_json(root / 'request.json', request)
    need(C.read_json(root / 'request.json')[0] == request, 'retained-artifact-request-changed')
    repositories = (('private', 'Nova-Dream'), ('public', 'Nova-Dream-Public'))
    # Validate both source selections before either worker can contact GitHub.
    for side, repo in repositories:
        source_input, ci = request['sources'][side], request['ci'][side]
        need(source_input['repository'] == 'HatimTheDream/' + repo and ci['sourceCommit'] == source_input['commit']
             and C.positive(ci['runId']) and C.positive(ci['runAttempt']), 'ci-source-binding-changed')
        need(ci.get('transport', 'actions-artifact') in ('actions-artifact', 'private-release-asset')
             and (ci.get('transport') != 'private-release-asset' or side == 'private'), 'artifact-transport-selection')
        need(ci.get('transport') != 'private-release-asset' or C.positive(ci.get('releaseId')), 'artifact-ci-release-binding')
    token = None if observe else token_provider(git)

    def prepare_repository(side, repo):
        source_input, ci = request['sources'][side], request['ci'][side]
        selected = {k: ci[k] for k in ('sourceCommit', 'runId', 'runAttempt')}
        private_release = ci.get('transport') == 'private-release-asset'
        if observe:
            need((root / ('frozen-source-' + repo + '-' + source_input['commit'])).is_dir(), 'original-frozen-source-unavailable')
        source, bound = C.frozen_source(repo, source_input['commit'], git, checkout=P(source_input['root']), output_root=root,
                                       committed_only=True, private_release=private_release)
        output = root / side
        snapshot = None
        if observe:
            intent, _ = C.read_json(output / 'collection-intent.json')
            need(intent['selected'] == selected and intent['key'] == request['key'], 'original-artifact-intent-changed')
            need(intent.get('transport', 'actions-artifact') == ci.get('transport', 'actions-artifact'), 'original-artifact-transport-changed')
            if private_release:
                snapshot = intent['releaseTransport']; artifact = snapshot['assets']['archive']
            else:
                artifact = intent['artifact']
            raw = (output / 'artifact.zip').read_bytes()
        elif private_release:
            snapshot = C.exact_private_release(selected, request['version'], token)
            need(snapshot['release']['id'] == ci['releaseId'], 'artifact-ci-release-changed')
            artifact = snapshot['assets']['archive']
            output.mkdir(mode=0o700)
            C.write_json(output / 'collection-intent.json', {'format': 1, 'key': request['key'], 'selected': selected,
                          'transport': 'private-release-asset', 'releaseTransport': snapshot})
            transport_raw = C.download_release_asset(snapshot['assets']['transport'], token, C.PRIVATE_TRANSPORT_MAXIMUM)
            C.write_private(output / 'transport.json', transport_raw)
            C.validate_private_transport(transport_raw, snapshot, bound, selected, request['version'])
            raw = C.download_release_asset(artifact, token, C.PRIVATE_ZIP_MAXIMUM)
            C.write_private(output / 'artifact.zip', raw); C.extract_zip(raw, output, maximum=C.PRIVATE_ZIP_MAXIMUM)
        else:
            prefix, run, job, steps, artifact = C.exact_run(repo, selected, token)
            output.mkdir(mode=0o700)
            C.write_json(output / 'collection-intent.json', {'format': 1, 'key': request['key'], 'selected': selected, 'artifact': artifact,
                          'workflowId': run['workflow_id'], 'jobId': job['id'], 'requiredSteps': steps})
            raw = C.download_zip(prefix, artifact['id'], token)
            need(len(raw) == artifact['size_in_bytes'] and (artifact.get('digest') is None or artifact['digest'] == 'sha256:' + C.sha(raw)), 'artifact-download-corrupt')
            C.write_private(output / 'artifact.zip', raw); C.extract_zip(raw, output)
        need(len(raw) == artifact['size' if private_release else 'size_in_bytes']
             and (artifact.get('digest') is None or artifact['digest'] == 'sha256:' + C.sha(raw)), 'artifact-retained-zip-corrupt')
        if private_release:
            need(snapshot['release']['id'] == ci['releaseId'], 'artifact-ci-release-changed')
            need(len(raw) <= C.PRIVATE_ZIP_MAXIMUM and (output / 'app.tgz').stat().st_size <= C.PRIVATE_ZIP_MAXIMUM,
                 'private-ci-retained-size')
            transport_raw = (output / 'transport.json').read_bytes()
            transport_asset = snapshot['assets']['transport']
            need(len(transport_raw) == transport_asset['size'] and 'sha256:' + C.sha(transport_raw) == transport_asset['digest'],
                 'private-ci-retained-transport-corrupt')
            C.validate_private_transport(transport_raw, snapshot, bound, selected, request['version'], (output / 'ci-source.json').read_bytes())
        receipt, metadata = validate_receipts(request, side, bound, output)
        candidate = C.verify_application(source, bound, output, metadata, node, verify_existing=observe)
        transport = ({'kind': 'private-release-asset', 'releaseId': snapshot['release']['id'], 'releaseAssetId': artifact['id'],
                      'assetName': artifact['name'], 'assetApiDigest': artifact['digest'], 'zipBytes': len(raw),
                      'transportAssetId': snapshot['assets']['transport']['id'], 'receipt': reference(output / 'transport.json'),
                      'qualityJobId': snapshot['qualityJob']['id'], 'producerJobId': snapshot['producerJob']['id'],
                      'authenticatedDownloadVerified': True, 'buildOrigin': 'same-run-release-job'}
                     if private_release else {'kind': 'actions-artifact', 'artifactId': artifact['id']})
        return {'repository': source_input['repository'], **selected, 'candidateId': candidate['id'], 'applicationDirectory': str(output / 'verified-application'),
                'archive': reference(output / 'app.tgz'), 'metadata': reference(output / 'app.tgz.metadata.json'), 'ciSourceReceipt': reference(output / 'ci-source.json'),
                'zip': reference(output / 'artifact.zip'), **({'transport': transport, 'releaseAssetId': artifact['id']} if private_release else {'artifactId': artifact['id']}),
                'sourceHashes': bound, 'frozenSourceDirectory': str(source)}

    # Each worker owns distinct frozen-source and repository output directories.
    # All primitive subprocesses use explicit cwd; HTTP clients and verification
    # namespaces are per call. Never change the process cwd/environment here.
    results, errors = {}, []
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix='nova-artifact') as workers:
        pending = [(side, workers.submit(prepare_repository, side, repo)) for side, repo in repositories]
        for side, future in pending:
            try:
                results[side] = future.result()
            except Exception as error:
                errors.append(error)
    # A failure is reported only after both original workers close. Retain every
    # partial output, and never hide an uncertain peer behind a known refusal.
    if errors:
        raise next((error for error in errors if failure_result(error)['state'] == 'uncertain'), errors[0])
    value = {'format': 1, 'kind': 'nova-delivery-authenticated-artifacts', 'key': request['key'], 'operationId': request['operationId'], 'inputSha256': request['inputSha256'],
             'repositories': results, 'authenticatedGithubCollection': True, 'rebuilt': False, 'deliveryQualification': False}
    if observe:
        need(value == completed, 'retained-artifact-result-changed')
    else:
        C.write_json(root / 'result.json', value)
    return {'state': 'completed', 'reason': 'authenticated-artifacts-verified', 'externalId': request['key'], 'receipt': reference(root / 'result.json'), 'output': value}


def failure_result(error):
    reason = str(error)
    verified_failure = isinstance(error, RuntimeError) and re.fullmatch('[a-z][a-z0-9-]{0,99}', reason) and reason not in {
        'credential-provider-unavailable', 'original-artifact-worker-output-unavailable', 'original-frozen-source-unavailable',
        'private-ci-download-unavailable', 'private-ci-download-deadline'}
    return {'state': 'failed' if verified_failure else 'uncertain', 'reason': reason if verified_failure else 'original-artifact-collection-unverified',
            'externalId': None, 'receipt': None, 'output': {'verificationFailed': True} if verified_failure else None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('mode', choices=['execute', 'observe']); parser.add_argument('request', type=P)
    args = parser.parse_args()
    try:
        request, _ = C.read_json(args.request, 256 * 1024)
        print(json.dumps(collect(request, observe=args.mode == 'observe')))
    except Exception as error:
        # No token, signed URL, stderr content or private raw diagnostic escapes.
        print(json.dumps(failure_result(error)))
        sys.exit(2)
