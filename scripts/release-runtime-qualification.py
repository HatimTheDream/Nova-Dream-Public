"""Read-only retained runtime provenance ingestion; never a release admission.

Authenticate two exact workflow attempts and API artifact ZIP digests. Read ZIP
members without extracting or executing them. Actual settled target startup and
restart qualification is deliberately unavailable in this format.
"""
import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import time
import zipfile

P = pathlib.Path
HERE = P(__file__).resolve().parent
MIB = 1024 ** 2
PREFIX = '/repos/HatimTheDream/Nova-Dream'
GAP = 'actual-settled-runtime-qualification-producer-required'
HELPERS = ('release-runtime-qualification.py', 'release-delivery-ci.py', 'release-ci-primitives.py')


def need(value, reason):
    if not value:
        raise RuntimeError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(info, include_ctime=False):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, getattr(info, 'st_file_attributes', 0)) + ((info.st_ctime_ns,) if include_ctime else ())


def ordinary(path):
    need(path.is_absolute() and path.resolve(strict=True) == path, 'runtime-reference-redirected')
    for ancestor in (path, *path.parents):
        info = ancestor.lstat()
        need(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
             'runtime-reference-reparse-or-symlink')
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'runtime-reference-not-ordinary')
    return info


@contextlib.contextmanager
def opened(reference, maximum, deadline):
    need(isinstance(reference, dict) and set(reference) == {'path', 'sha256'}
         and isinstance(reference['path'], str) and re.fullmatch('[a-f0-9]{64}', reference['sha256']), 'runtime-reference-fields')
    path = P(reference['path']); before = ordinary(path)
    need(0 < before.st_size <= maximum, 'runtime-reference-size')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        opened_info = os.fstat(stream.fileno())
        # Windows Python exposes different ctime semantics through lstat/fstat.
        # Bind their common identity and preserve each clock independently.
        need(identity(opened_info) == identity(before), 'runtime-reference-open-race')
        digest = hashlib.sha256(); count = 0
        while True:
            need(time.monotonic() < deadline, 'runtime-source-read-deadline')
            chunk = stream.read(MIB)
            if not chunk:
                break
            count += len(chunk); need(count <= before.st_size, 'runtime-reference-grew'); digest.update(chunk)
        need(count == before.st_size and digest.hexdigest() == reference['sha256'], 'runtime-reference-hash')
        stream.seek(0)
        yield stream
        need(identity(os.fstat(stream.fileno()), True) == identity(opened_info, True)
             and identity(ordinary(path), True) == identity(before, True), 'runtime-reference-changed-during-read')


def read_ref(reference, maximum, deadline):
    with opened(reference, maximum, deadline) as stream:
        return stream.read(maximum + 1)


def load_ci(hashes, deadline):
    need(isinstance(hashes, dict) and set(hashes) == set(HELPERS), 'runtime-helper-set')
    raws = {name: read_ref({'path': str(HERE / name), 'sha256': hashes[name]}, 2 * MIB, deadline) for name in HELPERS}
    # Compile the already checked CI bytes; pin its only imported local helper too.
    spec = importlib.util.spec_from_file_location('runtime_ci', HERE / 'release-delivery-ci.py')
    module = importlib.util.module_from_spec(spec)
    source = raws['release-delivery-ci.py'].decode()
    need(source.count('spec.loader.exec_module(C)') == 1, 'runtime-ci-loader-contract-changed')
    module.__dict__['_verified_ci_loader'] = lambda child: exec(compile(raws['release-ci-primitives.py'],
        str(HERE / 'release-ci-primitives.py'), 'exec'), child.__dict__)
    exec(compile(source.replace('spec.loader.exec_module(C)', '_verified_ci_loader(C)'),
                 str(HERE / 'release-delivery-ci.py'), 'exec'), module.__dict__)
    return module


def authenticated_artifact(item, role, api, token):
    need(set(item) == {'sourceCommit', 'runId', 'runAttempt', 'artifactId', 'zip'}, 'runtime-artifact-fields')
    need(re.fullmatch('[a-f0-9]{40}', item['sourceCommit']) and all(type(item[k]) is int and item[k] > 0
         for k in ('runId', 'runAttempt', 'artifactId')), 'runtime-artifact-identity')
    workflow = '.github/workflows/' + ('offline-runtime.yml' if role == 'build' else 'runtime-qualification.yml')
    name = ('offline-runtime-2026.9.8-' if role == 'build' else 'runtime-producer-evidence-') + item['sourceCommit']
    status, run = api(PREFIX + f"/actions/runs/{item['runId']}/attempts/{item['runAttempt']}", token)
    need(status == 200, 'authenticated-runtime-run-unavailable')
    need(run.get('id') == item['runId'] and run.get('run_attempt') == item['runAttempt']
         and run.get('head_sha') == item['sourceCommit'] and run.get('path') == workflow
         and run.get('event') == 'workflow_dispatch' and run.get('status') == 'completed'
         and run.get('conclusion') == 'success' and run.get('repository', {}).get('full_name') == 'HatimTheDream/Nova-Dream',
         'authenticated-runtime-run-differs')
    status, artifact = api(PREFIX + f"/actions/artifacts/{item['artifactId']}", token)
    need(status == 200, 'authenticated-runtime-artifact-unavailable')
    need(artifact.get('id') == item['artifactId'] and artifact.get('name') == name
         and artifact.get('workflow_run', {}).get('id') == item['runId']
         and artifact.get('workflow_run', {}).get('head_sha') == item['sourceCommit']
         and type(artifact.get('size_in_bytes')) is int and artifact['size_in_bytes'] > 0, 'authenticated-runtime-artifact-differs')
    def timestamp(value):
        need(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z', value), 'runtime-artifact-attempt-time-invalid')
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(timestamp(run.get('run_started_at')) <= timestamp(artifact.get('created_at')) <= timestamp(run.get('updated_at')),
         'runtime-artifact-outside-original-attempt')
    # A retained local hash is not authentication. No download fallback or new
    # producer run is hidden here when the API no longer provides its digest.
    need(isinstance(artifact.get('digest'), str) and re.fullmatch('sha256:[a-f0-9]{64}', artifact['digest']),
         'authenticated-retained-runtime-digest-unavailable')
    need(artifact['digest'] == 'sha256:' + item['zip']['sha256'], 'authenticated-runtime-zip-digest-differs')
    need(P(item['zip']['path']).stat().st_size == artifact['size_in_bytes'], 'authenticated-runtime-zip-size-differs')
    return {'runId': item['runId'], 'runAttempt': item['runAttempt'], 'sourceCommit': item['sourceCommit'],
            'artifactId': item['artifactId'], 'workflow': workflow, 'name': name, 'zip': item['zip'], 'apiDigest': artifact['digest']}


def zip_inventory(stream, total_limit, member_limit, deadline, wanted):
    with zipfile.ZipFile(stream) as archive:
        items = archive.infolist(); need(0 < len(items) <= 2000, 'runtime-zip-member-count')
        rows = {}; contents = {}; total = 0
        for item in items:
            name = item.filename; path = pathlib.PurePosixPath(name)
            mode = item.external_attr >> 16
            need(name and '\\' not in name and ':' not in name and not path.is_absolute()
                 and all(part not in ('', '.', '..') for part in name.rstrip('/').split('/'))
                 and name not in rows and not item.flag_bits & 1, 'runtime-zip-path-or-duplicate')
            if item.is_dir():
                need(stat.S_IFMT(mode) in (0, stat.S_IFDIR), 'runtime-zip-special-entry')
                rows[name] = {'bytes': 0, 'sha256': sha(b'')}; continue
            need(stat.S_IFMT(mode) in (0, stat.S_IFREG) and 0 <= item.file_size <= member_limit, 'runtime-zip-member-type-or-size')
            total += item.file_size; need(total <= total_limit, 'runtime-zip-expanded-bound')
            digest = hashlib.sha256(); count = 0; small = bytearray() if name in wanted else None
            with archive.open(item) as member:
                while True:
                    need(time.monotonic() < deadline, 'runtime-source-read-deadline')
                    chunk = member.read(MIB)
                    if not chunk:
                        break
                    count += len(chunk); need(count <= item.file_size, 'runtime-zip-member-grew'); digest.update(chunk)
                    if small is not None:
                        need(count <= 2 * MIB, 'runtime-json-member-bound'); small.extend(chunk)
            need(count == item.file_size, 'runtime-zip-member-short')
            rows[name] = {'bytes': count, 'sha256': digest.hexdigest()}
            if small is not None:
                contents[name] = bytes(small)
        need(set(contents) == set(wanted), 'runtime-required-zip-members-missing')
        return rows, contents


def description(value):
    need(isinstance(value, dict) and set(value) == {'format', 'fromVersion', 'toVersion', 'archiveBytes', 'archiveSha256',
         'expandedBytes', 'fileCount', 'nodeVersion', 'nodeSha256', 'companion'}, 'runtime-description-fields')
    need(value['format'] == 1 and value['fromVersion'] == '2026.9.6' and value['toVersion'] == '2026.9.8'
         and value['nodeVersion'] == '24.21.0' and re.fullmatch('[a-f0-9]{64}', value['nodeSha256'])
         and re.fullmatch('[a-f0-9]{64}', value['archiveSha256'])
         and type(value['archiveBytes']) is int and 0 < value['archiveBytes'] <= 512 * MIB
         and type(value['expandedBytes']) is int and 0 < value['expandedBytes'] <= 2 * 1024 * MIB
         and type(value['fileCount']) is int and 0 < value['fileCount'] < 100000, 'runtime-description-profile')
    c = value['companion']
    need(isinstance(c, dict) and set(c) == {'pluginVersion', 'codexVersion', 'packageLockSha256', 'binarySha256'}
         and c['pluginVersion'] == '2026.9.8' and c['codexVersion'] == '0.158.0'
         and all(re.fullmatch('[a-f0-9]{64}', c[k]) for k in ('packageLockSha256', 'binarySha256')), 'runtime-companion-profile')


def consume(request, api=None, token_provider=None):
    deadline = time.monotonic() + 210
    need(set(request) == {'format', 'kind', 'build', 'synthetic', 'tools', 'helperHashes', 'independentVerifier'}, 'runtime-source-request-fields')
    need(request['format'] == 1 and request['kind'] == 'retained-runtime-source-evidence', 'runtime-source-request-format')
    ci = load_ci(request['helperHashes'], deadline)
    token = (token_provider or ci.credential)(request['tools']); api = api or ci.C.api
    authenticated = {role: authenticated_artifact(request[key], role, api, token)
                     for role, key in (('build', 'build'), ('synthetic', 'synthetic'))}
    with opened(request['build']['zip'], 516 * MIB, deadline) as stream:
        build_rows, build_bytes = zip_inventory(stream, 516 * MIB, 512 * MIB, deadline, {'runtime.metadata.json', 'build-receipt.json'})
    need(set(build_rows) == {'runtime.tgz', 'runtime.metadata.json', 'build-receipt.json'}, 'runtime-build-artifact-file-set')
    meta = json.loads(build_bytes['runtime.metadata.json']); description(meta)
    need(build_rows['runtime.tgz'] == {'bytes': meta['archiveBytes'], 'sha256': meta['archiveSha256']}, 'runtime-build-archive-binding')
    build = json.loads(build_bytes['build-receipt.json'])
    need(build.get('format') == 1 and build.get('runtime') == meta and build.get('status') == 'prepared-not-installed'
         and all(build.get(k) is False for k in ('serviceActions', 'signatureCreated', 'workspaceDataUsed')), 'runtime-build-receipt')
    qprefix = 'runtime-producer-qualification/'
    qname = qprefix + 'qualification-receipt.json'
    with opened(request['synthetic']['zip'], 32 * MIB, deadline) as stream:
        rows, raw = zip_inventory(stream, 128 * MIB, 16 * MIB, deadline,
            {'runtime-source-binding.json', qname, qprefix + 'native/producer-manifest.json', qprefix + 'codex/producer-receipt.json'})
    q = json.loads(raw[qname]); binding = q.get('binding')
    expected = {'format': 1, 'kind': 'reviewed-runtime-artifact-binding', 'runId': str(request['build']['runId']),
                'runtimeSourceCommit': request['build']['sourceCommit'], 'qualificationSourceCommit': request['synthetic']['sourceCommit'],
                'runtimeArchiveSha256': meta['archiveSha256'], 'artifactId': request['build']['artifactId'],
                'artifactName': authenticated['build']['name'], 'workflow': authenticated['build']['workflow'],
                'conclusion': 'success', 'repository': 'HatimTheDream/Nova-Dream'}
    need(binding == expected and json.loads(raw['runtime-source-binding.json']) == binding, 'runtime-qualification-source-binding')
    need(q.get('format') == 1 and q.get('kind') == 'official-runtime-producer-qualification' and q.get('runtime') == meta
         and q.get('networkInterfaces') == ['lo'] and q.get('syntheticOnly') is True and q.get('savedWorkAccepted') is False
         and q.get('independentVerifierRequired') is True and q.get('dependencyRebuild') is False and q.get('serviceActions') is False,
         'runtime-synthetic-receipt-scope')
    pins = q.get('producerReceipts', {}); need(set(pins) == {'native', 'codex'}, 'runtime-producer-receipts')
    for role, path in (('native', 'native/producer-manifest.json'), ('codex', 'codex/producer-receipt.json')):
        need(pins[role] == {'path': path, 'sha256': rows[qprefix + path]['sha256']}, 'runtime-producer-receipt-binding')
        log_hash = q.get('producerLogs', {}).get(role)
        need(isinstance(log_hash, str) and re.fullmatch('[a-f0-9]{64}', log_hash)
             and qprefix + role + '-producer.log' in rows
             and log_hash == rows[qprefix + role + '-producer.log']['sha256'], 'runtime-producer-log-binding')
    sources = q.get('sourceFiles'); need(isinstance(sources, dict) and 3 <= len(sources) <= 32
        and all(isinstance(k, str) and '..' not in k.split('/') and re.fullmatch('[a-f0-9]{64}', v) for k, v in sources.items()), 'runtime-producer-source-inventory')
    native = json.loads(raw[qprefix + 'native/producer-manifest.json']); codex = json.loads(raw[qprefix + 'codex/producer-receipt.json'])
    need(native.get('harnessSha256') == sources.get('qualify-native-migration.mjs') and native.get('syntheticOnly') is True
         and native.get('producerExecuted') is True and native.get('preservationVerifierRequired') is True
         and native.get('packageVersion') == '2026.9.8', 'runtime-native-producer-scope')
    need(codex.get('kind') == 'official-codex-migration-producer' and codex.get('binarySha256') == meta['companion']['binarySha256']
         and codex.get('version') == 'codex-cli 0.158.0' and codex.get('producer', {}).get('exitCode') == 0
         and codex.get('savedWorkAccepted') is False and codex.get('independentVerifierRequired') is True, 'runtime-codex-producer-scope')
    verifier = None
    if request['independentVerifier'] is not None:
        v = request['independentVerifier']; need(set(v) == {'receipt', 'helpers'}, 'runtime-verifier-fields')
        need(set(v['helpers']) == {'recovery.py', 'codex_log_retention.py'}, 'runtime-verifier-helper-set')
        for reference in v['helpers'].values():
            read_ref(reference, 2 * MIB, deadline)
        value = json.loads(read_ref(v['receipt'], 2 * MIB, deadline))
        need(value.get('format') == 1 and value.get('kind') == 'maintained-verifier-synthetic-migration-acceptance'
             and value.get('qualificationReceiptSha256') == rows[qname]['sha256']
             and value.get('helperSourceCommit') == request['synthetic']['sourceCommit']
             and value.get('runtimeSourceCommit') == request['build']['sourceCommit']
             and value.get('runtimeArchiveSha256') == meta['archiveSha256']
             and value.get('maintainedVerifierSha256') == {k: r['sha256'] for k, r in v['helpers'].items()}
             and value.get('syntheticSchemaAndSavedContentVerified') is True and value.get('productionAcceptance') is False
             and value.get('notCovered') == ['host lifecycle', 'relocated derived process caches', 'full workspace restoration'], 'runtime-independent-verifier-binding')
        verifier = v
    gaps = [GAP]
    if verifier is None:
        gaps.append('current-independent-synthetic-verifier-receipt-required')
    return {'format': 1, 'kind': 'authenticated-retained-runtime-sources', 'state': 'gap', 'reason': GAP,
            'sourceEvidenceVerified': True, 'productionAdmission': False, 'actualSettledQualification': False,
            'independentVerificationRerun': False, 'independentVerifierCurrencyEstablished': False, 'retainedIndependentVerifier': verifier,
            'readOnly': True, 'hostEffects': False, 'sdkExecuted': False, 'workspaceDataOpened': False,
            'applicationNodeVersion': '22.23.2', 'runtime': meta, 'authenticated': authenticated,
            'qualificationReceiptSha256': rows[qname]['sha256'], 'syntheticInventorySha256': sha(json.dumps(rows, sort_keys=True).encode()),
            'gaps': gaps}


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--request-sha256', required=True)
    args = parser.parse_args()
    try:
        with opened({'path': args.request, 'sha256': args.request_sha256}, 65536, time.monotonic() + 240) as stream:
            result = consume(json.loads(stream.read()))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[a-z][a-z0-9-]{0,99}', str(error)) else 'runtime-source-verification-failed'
        result = {'state': 'gap' if code.endswith('-unavailable') else 'failed', 'reason': code,
                  'productionAdmission': False, 'sourceEvidenceVerified': False, 'readOnly': True, 'hostEffects': False}
    print(json.dumps(result))
    sys.exit(2 if result['state'] == 'failed' else 0)
