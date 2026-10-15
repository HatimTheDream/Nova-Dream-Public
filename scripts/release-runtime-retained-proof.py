"""Read-only consumer of one original, settled 9.6-to-9.8 qualification.

No runner import, process launch, database access, mutation, or receipt synthesis.
The source pin remains closed until the independent runner review is frozen.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time

FORMAT = 1
QUALIFIED_RUNNER_SHA256 = '27e4da22d0dce7af436db73c05ac6e2f45117c4f31a2ebe3b49cd76e627d8660'
QUALIFIED_MATERIALIZER_SHA256 = 'b2b702f08ee15b74c29e7924b41cb828a9530379fb031b76f4377e284bc6b17c'
MAX_JSON = 16 * 1024**2
MAX_TOTAL = 128 * 1024**2
HASH = re.compile(r'^[a-f0-9]{64}$')
SCENARIOS = ('target-first-start', 'target-restart', 'prior-rollback')
SCOPE = 'retained-96-to-98-startup-restart-restoration'
HELPERS = ('install.py', 'recovery.py', 'operator_rehearsal.py', 'app_dependencies.py',
           'codex_log_retention.py', 'workspace_key.py', 'verify-session-bindings.mjs')
TRANSITION_ROLES = ('migrationIntent', 'migrationCompleted', 'nativeMigrationVerified',
                    'nativeMigrationLog', 'companionInstallLog', 'restorationIntent', 'restorationCompleted')


def need(value, reason):
    if not value:
        raise RuntimeError(reason)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def parse(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'duplicate-runtime-proof-field')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: need(False, 'nonfinite-runtime-proof-field'))


def reference(value):
    need(isinstance(value, dict) and set(value) in ({'path', 'sha256'}, {'path', 'sha256', 'bytes'})
         and isinstance(value.get('path'), str) and PurePosixPath(value['path']).is_absolute()
         and str(PurePosixPath(value['path'])) == value['path']
         and '..' not in PurePosixPath(value['path']).parts
         and HASH.fullmatch(value.get('sha256', '')), 'runtime-proof-reference-invalid')
    if 'bytes' in value:
        need(type(value['bytes']) is int and 0 <= value['bytes'] <= MAX_JSON, 'runtime-proof-byte-count-invalid')
    return value


def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class ProtectedReader:
    def __init__(self):
        self.total = 0
        self.started = time.monotonic()
        self.identities = {}

    def __call__(self, path, maximum=MAX_JSON):
        need(time.monotonic() - self.started < 90, 'runtime-proof-read-deadline')
        path = Path(path)
        need(path.is_absolute() and path.resolve(strict=True) == path, 'runtime-proof-path-redirected')
        for parent in (path, *path.parents):
            info = parent.lstat()
            need(info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and not info.st_mode & 0o022,
                 'runtime-proof-path-unprotected')
        before = path.lstat()
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
             'runtime-proof-file-role-invalid')
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            need(file_identity(before) == file_identity(opened), 'runtime-proof-open-changed')
            raw = stream.read(maximum + 1)
            need(file_identity(opened) == file_identity(os.fstat(stream.fileno())), 'runtime-proof-read-changed')
        need(len(raw) == before.st_size and file_identity(before) == file_identity(path.lstat()),
             'runtime-proof-path-changed')
        self.total += len(raw)
        need(self.total <= MAX_TOTAL, 'runtime-proof-total-size-bound')
        previous = self.identities.setdefault(str(path), file_identity(before))
        need(previous == file_identity(before), 'runtime-proof-original-file-changed')
        return raw

    def unchanged(self):
        for path, original in self.identities.items():
            need(file_identity(Path(path).lstat()) == original, 'runtime-proof-closure-changed')


def consume(request, read, runner_sha, materializer_sha):
    """Pure semantic validation plus bounded reads; caller cannot assert success."""
    need(isinstance(runner_sha, str) and HASH.fullmatch(runner_sha)
         and isinstance(materializer_sha, str) and HASH.fullmatch(materializer_sha),
         'runtime-qualification-producer-not-reviewed')
    need(isinstance(request, dict) and set(request) == {'format', 'kind', 'parent', 'producer'}
         and request['format'] == 1 and request['kind'] == 'collect-actual-retained-runtime-proof',
         'runtime-proof-request-invalid')
    reference(request['parent']); reference(request['producer'])
    need(request['parent']['path'].endswith('/evidence/parent-verified.json')
         and request['producer']['path'].endswith('/fresh-runtime-held.py')
         and request['producer']['sha256'] == runner_sha, 'runtime-proof-fixed-producer-required')
    refs, values = {}, {}

    def document(role, ref, maximum=MAX_JSON, opaque=False):
        reference(ref)
        raw = read(ref['path'], maximum)
        need(sha(raw) == ref['sha256'] and ('bytes' not in ref or ref['bytes'] == len(raw)),
             'runtime-proof-original-reference-changed')
        need(role not in refs, 'runtime-proof-duplicate-role')
        refs[role] = {'path': ref['path'], 'sha256': ref['sha256'], 'bytes': len(raw)}
        if not opaque:
            values[role] = parse(raw)
            return values[role]
        return raw

    document('producer', request['producer'], 2 * 1024**2, True)
    parent = document('parent', request['parent'])
    need(parent.get('format') == 2 and parent.get('kind') == 'actual-retained-runtime-parent-verification'
         and parent.get('passed') is True and parent.get('adapterSha256') == runner_sha
         and parent.get('fromVersion') == '2026.9.6' and parent.get('toVersion') == '2026.9.8'
         and parent.get('qualificationScope') == SCOPE and parent.get('prior224IdleCompatibility') is None
         and parent.get('originalSourceAndProtectedClosuresUnchanged') is True
         and parent.get('independentOriginalRestored') is True
         and parent.get('sourceSqliteOpened') is False and parent.get('productionMutation') is False
         and parent.get('deliveryQualification') is False, 'actual-retained-runtime-parent-required')
    for name in ('review', 'originalPlan', 'executionIntent', 'technicalReview', 'originalIntention',
                 'acceptedSourceProof', 'childResult', 'outsideClosure'):
        document(name, parent[name])
    review, plan, intent, technical, intention, child, closure = (values[name] for name in
        ('review', 'originalPlan', 'executionIntent', 'technicalReview', 'originalIntention', 'childResult', 'outsideClosure'))
    op = parent.get('operationId')
    need(isinstance(op, str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', op),
         'runtime-proof-operation-invalid')
    need(all(value.get('operationId') == op for value in (review, plan, intent, child, closure)),
         'runtime-proof-operation-changed')
    need(parent['reviewSha256'] == refs['review']['sha256'] == plan.get('reviewSha256') == child.get('reviewSha256')
         and parent['review'] == {'path': refs['review']['path'], 'sha256': refs['review']['sha256']}
         and review.get('reviewReceipt') == parent['technicalReview']
         and review.get('acceptedSourceProof') == parent['acceptedSourceProof'], 'runtime-proof-review-chain-changed')
    need(technical.get('status') == 'passed' and technical.get('adapterSha256') == runner_sha
         and technical.get('producerSha256') == materializer_sha
         and technical.get('callContractsReviewed') is True and technical.get('isolationReviewed') is True,
         'runtime-proof-independent-source-review-required')
    need(review.get('format') == plan.get('format') == intent.get('format') == 2
         and review.get('kind') == 'actual-retained-runtime-transition-qualification'
         and plan.get('kind') == 'actual-retained-runtime-transition-plan'
         and intent.get('kind') == 'execute-actual-retained-runtime-transition'
         and plan.get('adapterSha256') == intent.get('adapterSha256') == child.get('adapterSha256') == runner_sha
         and intent.get('reviewSha256') == refs['review']['sha256']
         and intent.get('plan') == parent['originalPlan']
         and intent.get('reviewReceiptSha256') == refs['technicalReview']['sha256'],
         'runtime-proof-plan-intent-changed')
    need(intention.get('intent') == intent and intention.get('plan') == plan
         and intention.get('originalPlanSha256') == refs['originalPlan']['sha256']
         and intention.get('intentSha256') == refs['executionIntent']['sha256'], 'runtime-proof-original-intention-changed')
    stable = lambda value: {k: v for k, v in value.items() if k != 'observedFreeBytes'}
    need(stable(intention.get('freshAdmission', {})) == stable(plan)
         and type(plan.get('requiredFreeBytes')) is int and plan['requiredFreeBytes'] > 0
         and intention['freshAdmission'].get('observedFreeBytes', -1) >= plan['requiredFreeBytes'],
         'runtime-proof-original-capacity-admission-required')
    fixture = PurePosixPath(plan.get('fixtureDirectory', ''))
    need(fixture.is_absolute() and fixture.name == op and str(fixture) == intent.get('fixtureDirectory')
         and request['parent']['path'] == str(fixture / 'evidence/parent-verified.json')
         and parent['originalIntention']['path'] == str(fixture / 'intention.json'), 'runtime-proof-fixture-binding-changed')
    need(plan.get('scenarios') == list(SCENARIOS) and len(parent.get('scenarios', [])) == 3
         and [item.get('scenario') for item in parent['scenarios']] == list(SCENARIOS), 'runtime-proof-complete-scenarios-required')
    need(child.get('format') == 2 and child.get('kind') == 'actual-retained-runtime-transition-result'
         and child.get('passed') is True and child.get('qualificationScope') == SCOPE
         and child.get('freshActualSettledCopiedStartup') is True
         and child.get('completeMaintainedSavedAndNativeState') is True and child.get('independentOriginalRestored') is True
         and child.get('fromVersion') == '2026.9.6' and child.get('toVersion') == '2026.9.8'
         and child.get('sourceSqliteOpened') is False and child.get('productionMutation') is False
         and child.get('deliveryQualification') is False and child.get('freshPostFreezeRehearsalStillRequired') is True
         and child.get('liveAcceptanceStillRequired') is True and len(child.get('scenarios', [])) == 3,
         'runtime-proof-actual-child-required')
    need(closure.get('kind') == 'rich-held-outside-closure'
         and closure.get('originalSourceAndProtectedClosuresUnchanged') is True
         and closure.get('ownedProcessesAndNamespacesClosed') is True
         and closure.get('sourceSqliteOpened') is False and closure.get('productionMutation') is False
         and closure.get('childResultSha256') == refs['childResult']['sha256'] == parent.get('childResultSha256'),
         'runtime-proof-outside-closure-required')
    need(all(closure.get(name) == [] for name in ('activeOwnedPids', 'activeNamespaceOwners', 'activeFixtureOwners')),
         'runtime-proof-active-original-processes-remain')
    namespaces = child.get('childNamespaces')
    need(isinstance(namespaces, dict) and set(namespaces) == {'mnt', 'net', 'pid'}
         and child.get('parentNamespaces') == plan.get('parentNamespaces')
         and set(child['parentNamespaces']) == set(namespaces)
         and all(isinstance(value, str) and re.fullmatch(name + r':\[[0-9]+\]', value)
                 and re.fullmatch(name + r':\[[0-9]+\]', child['parentNamespaces'][name])
                 and value != child['parentNamespaces'][name] for name, value in namespaces.items()),
         'runtime-proof-private-namespaces-required')
    baseline = review.get('baseline', {})
    need(baseline.get('kind') == 'retained-operator-rehearsal-baseline' and baseline.get('sourceAgentVersion') == '2026.9.6'
         and baseline.get('sourceApp') == review.get('prior')
         and parent.get('priorCandidateId') == review['prior']['candidateId'] == plan.get('priorCandidateId')
         and parent.get('targetCandidateId') == review['target']['candidateId'] == plan.get('targetCandidateId')
         and parent.get('workspaceEpoch') == baseline.get('epoch') == plan.get('workspaceEpoch')
         and parent.get('selectedRelative') == plan.get('selectedRelative')
         and re.fullmatch(r'recovered-workspaces/[0-9a-f-]{36}', parent['selectedRelative']),
         'runtime-proof-original-baseline-binding-changed')
    need(set(plan.get('helperHashes', {})) == set(HELPERS)
         and plan['helperHashes'] == review.get('helpers', {}).get('sha256'), 'runtime-proof-helper-closure-required')
    scenario_summaries = []
    for index, item in enumerate(parent['scenarios'], 1):
        scenario = item['scenario']; folder = fixture / 'evidence' / ('attempt-' + str(index))
        need(set(item) == {'scenario', 'started', 'process', 'ready', 'closed', 'preservation'}, 'runtime-proof-scenario-fields')
        for role in ('started', 'process', 'ready', 'closed', 'preservation'):
            need(item[role]['path'] == str(folder / (role + '.json')), 'runtime-proof-scenario-path-changed')
            document(scenario + '/' + role, item[role])
        started, process, ready, closed, preserved = (values[scenario + '/' + role] for role in
            ('started', 'process', 'ready', 'closed', 'preservation'))
        app = review['prior' if scenario == 'prior-rollback' else 'target']
        need(started.get('kind') == 'actual-isolated-startup' and started.get('operationId') == op
             and started.get('attempt') == index and started.get('scenario') == scenario
             and started.get('candidateId') == ready.get('candidateId') == preserved.get('candidateId') == app['candidateId']
             and started.get('epoch') == ready.get('epoch') == baseline['epoch']
             and started.get('namespaces') == namespaces and process.get('namespaces') == namespaces
             and process.get('cwd') == app['path'] and process.get('uid') == review.get('serviceUid')
             and process.get('nodeSha256') == plan.get('nodeSha256')
             and type(process.get('pid')) is int and process['pid'] > 1
             and type(process.get('startTicks')) is int and process['startTicks'] > 0, 'runtime-proof-actual-start-process-required')
        need(ready.get('startedSha256') == refs[scenario + '/started']['sha256']
             and ready.get('processSha256') == refs[scenario + '/process']['sha256'] and ready.get('process') == process
             and closed.get('readySha256') == refs[scenario + '/ready']['sha256']
             and closed.get('owningServiceFullyStopped') is True
             and preserved.get('scenario') == scenario and preserved.get('fullyStopped') is True
             and preserved.get('fullMaintainedNativeVerifier') is True
             and preserved.get('closedReceiptSha256') == refs[scenario + '/closed']['sha256']
             and type(preserved.get('savedStoreCount')) is int and preserved['savedStoreCount'] > 0,
             'runtime-proof-settled-closed-preservation-required')
        need(all(type(value) is int for value in (started.get('startedAtSeconds'), ready.get('readyAtSeconds'), closed.get('closedAtSeconds')))
             and started['startedAtSeconds'] <= ready['readyAtSeconds'] <= closed['closedAtSeconds'], 'runtime-proof-scenario-time-order')
        # The maintained producer floors start seconds and ceilings stop seconds.
        # At a same-second restart these bounds overlap by at most one second.
        need(not scenario_summaries or started['startedAtSeconds'] >= scenario_summaries[-1]['closedAtSeconds'] - 1,
             'runtime-proof-restart-precedes-original-stop')
        held = ready.get('heldReadiness', {})
        health = held.get('health', {})
        need(held.get('epoch') == baseline['epoch'] and isinstance(held.get('accounts'), list)
             and health.get('status') == 'ready' and health.get('candidateId') == app['candidateId']
             and health.get('version') == app['version'] and health.get('schemaVersion') == 55 and health.get('apiVersion') == 1,
             'runtime-proof-held-readiness-changed')
        native = ready.get('nativeProcess', {})
        native_node = review['transition']['prior']['agentNodeSha256'] if scenario == 'prior-rollback' else review['runtime']['agentNodeSha256']
        need(native.get('namespaces') == namespaces and native.get('uid') == review['serviceUid']
             and native.get('cwd') == '/var/lib/nova/workspace/' + parent['selectedRelative'] + '/openclaw-runtime'
             and native.get('nodeSha256') == native_node and native.get('pid') != process['pid']
             and type(native.get('pid')) is int and native['pid'] > 1
             and type(native.get('startTicks')) is int and native['startTicks'] > 0,
             'runtime-proof-actual-native-process-required')
        expected_child = {'path': '/qualification/evidence/attempt-' + str(index) + '/preservation.json',
                          'sha256': refs[scenario + '/preservation']['sha256']}
        need(child['scenarios'][index - 1] == expected_child, 'runtime-proof-child-canonical-receipt-changed')
        scenario_summaries.append({'scenario': scenario, 'candidateId': app['candidateId'], 'preservation': item['preservation'],
                                   'startedAtSeconds': started['startedAtSeconds'], 'closedAtSeconds': closed['closedAtSeconds']})
    transition = parent.get('transitionEvidence', {})
    need(set(transition) == set(TRANSITION_ROLES), 'runtime-proof-migration-restoration-closure-required')
    transition_paths = dict(zip(TRANSITION_ROLES, ('migration-intent.json', 'migration-completed.json',
        'attempt-1/native-migration-verified.json', 'attempt-1/native-migration.log',
        'attempt-1/codex-companion-install.log', 'restoration-intent.json', 'restoration-completed.json')))
    for role in TRANSITION_ROLES:
        need(transition[role]['path'] == str(fixture / 'evidence' / transition_paths[role]), 'runtime-proof-transition-path-changed')
        document(role, transition[role], 16 * 1024**2, role.endswith('Log'))
    migration_intent, migration, native_result, restoration = (values[x] for x in
        ('migrationIntent', 'migrationCompleted', 'nativeMigrationVerified', 'restorationCompleted'))
    need(migration_intent.get('operationId') == op and migration_intent.get('reviewSha256') == refs['review']['sha256']
         and migration_intent.get('fromVersion') == '2026.9.6' and migration_intent.get('toVersion') == '2026.9.8'
         and migration == parent.get('migration') == child.get('migration')
         and migration.get('receipt') == {'path': '/qualification/evidence/attempt-1/native-migration-verified.json',
                                          'sha256': refs['nativeMigrationVerified']['sha256']}
         and native_result == {'format': 1, 'fromVersion': '2026.9.6', 'toVersion': '2026.9.8', 'savedWorkVerified': True},
         'runtime-proof-original-native-migration-required')
    restored_paths = {'baseline': '/qualification/recovery/workspace', 'migratedTrial': '/var/lib/nova/workspace.migrated-trial', 'restored': '/var/lib/nova/workspace'}
    need(all(restoration.get(k) == v and values['restorationIntent'].get(k) == v for k, v in restored_paths.items())
         and values['restorationIntent'].get('independentOriginalRequired') is True
         and restoration.get('independentOriginalRestored') is True
         and HASH.fullmatch(restoration.get('originalInventory', ''))
         and restoration['originalInventory'] == restoration.get('restoredInventory'), 'runtime-proof-independent-original-restoration-required')
    # Complete package/runtime identity is validated below, separately from the
    # settled proof. A projection never means fresh production admission.
    source = values['acceptedSourceProof']
    need(source.get('kind') == 'accepted-application-for-isolated-runtime-trial' and source.get('target') == review['target']
         and source.get('helpers', {}).get('sha256') == review['helpers']['sha256'], 'runtime-proof-accepted-source-changed')
    request_doc = document('acceptedRequest', source['installation']['request'])
    accepted = document('acceptedResult', source['installation']['result'])
    release = request_doc.get('release', {})
    host = document('acceptedHostConfiguration', review['hostConfiguration'])
    stage = PurePosixPath(host['stateDirectory']) / 'staging' / source['bundle']['sha256']
    attempt = stage / 'attempts' / source['installation']['jobId']
    need(set(request_doc) == {'format', 'jobId', 'release', 'hostConfiguration', 'expectedPrior'}
         and request_doc['format'] == 1 and request_doc['hostConfiguration'] == review['hostConfiguration']['path']
         and source['installation']['request']['path'] == str(attempt / 'request.json')
         and source['installation']['result']['path'] == str(attempt / 'result.json')
         and source['bundle']['path'] == str(stage / 'bundle.json')
         and request_doc['expectedPrior'] == {'candidateId': release.get('fromCandidateId'), 'workspaceEpoch': baseline['epoch']}
         and release.get('novaVersion') == review['target']['version'], 'runtime-proof-maintained-installation-paths-required')
    need(accepted == {'format': 1, 'jobId': source['installation']['jobId'], 'candidateId': review['target']['candidateId'],
                     'priorCandidateId': release.get('fromCandidateId'), 'outcome': 'completed', 'savedWorkVerified': True,
                     'accountsVerified': True, 'recoveryVerified': True, 'healthVerified': True}
         and request_doc.get('jobId') == source['installation']['jobId'] and release.get('candidateId') == review['target']['candidateId']
         and release.get('bundle', {}).get('sha256') == source['bundle']['sha256'], 'runtime-proof-actual-accepted-install-required')
    bundle = document('acceptedBundle', source['bundle'])
    need(bundle.get('format') == 1 and isinstance(bundle.get('files'), list) and len(bundle['files']) <= 32,
         'runtime-proof-accepted-bundle-shape')
    members = {}
    for row in bundle['files']:
        need(set(row) == {'name', 'sha256', 'data'} and row['name'] not in members
             and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}', row['name']), 'runtime-proof-accepted-bundle-member')
        data = base64.b64decode(row['data'], validate=True)
        need(sha(data) == row['sha256'], 'runtime-proof-accepted-bundle-hash')
        members[row['name']] = data
    need(set(members) == {'app.tgz', 'reviewed-pair.json', *set(HELPERS).difference({'operator_rehearsal.py'})},
         'runtime-proof-accepted-bundle-closure')
    pair = parse(members['reviewed-pair.json'])
    need(pair.get('candidateId') == accepted['candidateId'] and pair.get('priorCandidateId') == accepted['priorCandidateId']
         and pair.get('archiveSha256') == sha(members['app.tgz']) == source['applicationArchive']['sha256']
         and pair.get('archiveBytes') == len(members['app.tgz'])
         and pair.get('applicationDependencies', {}).get('archiveSha256') == source['dependencyArchive']['sha256']
         and release.get('applicationDependenciesBundle', {}).get('sha256') == source['dependencyArchive']['sha256']
         and release.get('applicationDependenciesBundle', {}).get('bytes') == pair['applicationDependencies'].get('archiveBytes'),
         'runtime-proof-accepted-pair-binding')
    need(all(sha(members[name]) == plan['helperHashes'][name] for name in members if name in HELPERS),
         'runtime-proof-qualified-helper-changed')
    package_path = str(PurePosixPath(review['target']['path']) / 'package.json')
    candidate_path = str(PurePosixPath(review['target']['path']) / 'dist/candidate.json')
    package_raw, candidate_raw = read(package_path, 1024**2), read(candidate_path, 2 * 1024**2)
    need(sha(package_raw + candidate_raw) == review['target']['candidateId'], 'runtime-proof-qualified-candidate-bytes-changed')
    package, candidate = parse(package_raw), parse(candidate_raw)
    need(package.get('version') == candidate.get('version') == review['target']['version']
         and candidate.get('schemaVersion') == 55 and candidate.get('apiVersion') == 1,
         'runtime-proof-qualified-candidate-schema')
    service_files = {}
    for entry in candidate.get('artifacts', []):
        path = entry.get('path', '')
        need(re.fullmatch(r'dist/(client|service|desktop)/[a-zA-Z0-9_./-]+', path)
             and not any(part in ('', '.', '..') for part in path.split('/')), 'runtime-proof-qualified-artifact-path')
        if not path.startswith('dist/service/'):
            continue
        need(path not in service_files and HASH.fullmatch(entry.get('sha256', '')), 'runtime-proof-qualified-service-duplicate')
        data = read(str(PurePosixPath(review['target']['path']) / path), 4 * 1024**2)
        need(sha(data) == entry['sha256'], 'runtime-proof-qualified-service-changed')
        service_files[path] = entry['sha256']
    need('dist/service/apps/service/main.js' in service_files, 'runtime-proof-complete-service-required')
    need(len(service_files) <= 1000, 'runtime-proof-service-file-count-bound')
    runtime = document('runtimeDescription', review['transition']['description'])
    need(runtime.get('format') == 1 and runtime.get('fromVersion') == '2026.9.6' and runtime.get('toVersion') == '2026.9.8'
         and runtime.get('archiveSha256') == review['transition']['archive']['sha256'] == migration_intent.get('runtimeArchiveSha256')
         and runtime.get('nodeVersion') == '24.21.0' and runtime.get('companion', {}).get('codexVersion') == '0.158.0',
         'runtime-proof-runtime-description-changed')
    need(all(plan.get('inputHashes', {}).get(ref['path']) == ref['sha256'] for ref in
             (review['acceptedSourceProof'], review['transition']['description'], review['transition']['cacheReceipt'], review['transition']['cacheManifest'])),
         'runtime-proof-original-input-binding-required')
    cache = document('cacheReceipt', review['transition']['cacheReceipt'])
    document('cacheManifest', review['transition']['cacheManifest'])
    need(cache.get('verified') is True and cache.get('SDKExecuted') is False
         and cache.get('installedRecordsMaterialized') is False and cache.get('accountStateMaterialized') is False
         and cache.get('productionAdmission') is False
         and cache.get('details', {}).get('artifactManifestSha256') == review['transition']['cacheManifest']['sha256'],
         'runtime-proof-authenticated-cache-binding-changed')
    return {'format': 1, 'kind': 'actual-retained-runtime-qualification-observation', 'readOnly': True, 'hostEffects': False,
            'request': request, 'requestSha256': sha(encoded(request)), 'runnerSha256': runner_sha, 'materializerSha256': materializer_sha,
            'qualificationOperationId': op, 'fromVersion': '2026.9.6', 'toVersion': '2026.9.8', 'scope': SCOPE,
            'prior': review['prior'], 'qualifiedTarget': review['target'], 'workspaceEpoch': baseline['epoch'],
            'selectedRelative': parent['selectedRelative'], 'helpers': plan['helperHashes'], 'applicationNodeSha256': plan['nodeSha256'],
            'runtime': runtime, 'acceptedSource': source, 'scenarios': scenario_summaries,
            'qualifiedPackage': package, 'qualifiedPair': pair, 'qualifiedServiceArtifacts': service_files,
            'qualifiedPackageSha256': sha(package_raw), 'qualifiedCandidateManifestSha256': sha(candidate_raw),
            'cacheReceipt': review['transition']['cacheReceipt'], 'cacheManifest': review['transition']['cacheManifest'],
            'references': refs, 'actualSettledQualification': True, 'independentOriginalRestored': True,
            'productionAdmission': False, 'freshFullRehearsalStillRequired': True, 'liveAcceptanceStillRequired': True}


def invoke(request):
    need(os.name == 'posix' and os.geteuid() == 0, 'root-linux-readonly-runtime-proof-required')
    reader = ProtectedReader()
    result = consume(request, reader, QUALIFIED_RUNNER_SHA256, QUALIFIED_MATERIALIZER_SHA256)
    reader.unchanged()
    result['observedAtMilliseconds'] = time.time_ns() // 1000000
    need(len(encoded(result)) <= 110 * 1024, 'runtime-proof-summary-bound')
    return result
