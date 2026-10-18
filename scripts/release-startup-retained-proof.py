"""Read-only original-receipt consumer for settled same-runtime startup trials.

No producer import/execution, database access, process launch, or receipt writes.
The maintained JavaScript collector supplies the compiled-in reviewed source map.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time

MAX_JSON = 16 * 1024**2
MAX_TOTAL = 128 * 1024**2
HASH = re.compile(r'^[a-f0-9]{64}$')
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
SOURCES = ('qualified-startup.py', 'qualified-parent.py', 'produce-startup-inputs.py', 'contracts.py')
SCENARIOS = ('target-first-start', 'target-restart', 'pristine-prior-restoration')
SCOPE = 'retained-same-runtime-startup-restart-restoration'
HELPERS = ('install.py', 'recovery.py', 'operator_rehearsal.py', 'app_dependencies.py',
           'codex_log_retention.py', 'workspace_key.py', 'verify-session-bindings.mjs')


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
            need(key not in value, 'duplicate-startup-proof-field')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: need(False, 'nonfinite-startup-proof-field'))


def reference(value):
    need(isinstance(value, dict) and set(value) in ({'path', 'sha256'}, {'path', 'sha256', 'bytes'})
         and isinstance(value.get('path'), str) and PurePosixPath(value['path']).is_absolute()
         and str(PurePosixPath(value['path'])) == value['path']
         and '..' not in PurePosixPath(value['path']).parts
         and HASH.fullmatch(value.get('sha256', '')), 'startup-proof-reference-invalid')
    if 'bytes' in value:
        need(type(value['bytes']) is int and 0 <= value['bytes'] <= MAX_JSON, 'startup-proof-byte-count-invalid')
    return value


def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class ProtectedReader:
    """Same bounded no-follow/ownership/race contract as the runtime collector."""
    def __init__(self):
        self.total = 0
        self.started = time.monotonic()
        self.identities = {}

    def __call__(self, path, maximum=MAX_JSON):
        need(time.monotonic() - self.started < 90, 'startup-proof-read-deadline')
        path = Path(path)
        need(path.is_absolute() and path.resolve(strict=True) == path, 'startup-proof-path-redirected')
        for parent in (path, *path.parents):
            info = parent.lstat()
            need(info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and not info.st_mode & 0o022,
                 'startup-proof-path-unprotected')
        before = path.lstat()
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
             'startup-proof-file-role-invalid')
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            need(file_identity(before) == file_identity(opened), 'startup-proof-open-changed')
            raw = stream.read(maximum + 1)
            need(file_identity(opened) == file_identity(os.fstat(stream.fileno())), 'startup-proof-read-changed')
        need(len(raw) == before.st_size and file_identity(before) == file_identity(path.lstat()),
             'startup-proof-path-changed')
        self.total += len(raw)
        need(self.total <= MAX_TOTAL, 'startup-proof-total-size-bound')
        previous = self.identities.setdefault(str(path), file_identity(before))
        need(previous == file_identity(before), 'startup-proof-original-file-changed')
        return raw

    def unchanged(self):
        for path, original in self.identities.items():
            need(file_identity(Path(path).lstat()) == original, 'startup-proof-closure-changed')


def consume_home_capture(review, document, sources):
    """Retain the original short capture and its closed worker; no live reads."""
    binding = review.get('homeCapture', {})
    need(set(binding) == {'result', 'closure'}, 'startup-proof-home-capture-required')
    result = document('homeCapture/result', binding['result'])
    closed = document('homeCapture/closure', binding['closure'])
    operation = result.get('operationId', '')
    startup = review['operationId']
    need(isinstance(operation, str) and UUID.fullmatch(operation) and operation != startup
         and result.get('format') == 1 and result.get('kind') == 'coherent-original-home-capture-result'
         and result.get('completed') is True and result.get('startupOperationId') == startup
         and result.get('producerSha256') == sources['produce-startup-inputs.py']
         and result.get('sourceUnchangedScope') == 'capture-interval-only'
         and result.get('productionMutation') is False and result.get('sourceSqliteOpened') is False
         and result.get('actualStartupQualified') is False, 'startup-proof-original-home-capture-result-required')
    root = PurePosixPath('/opt/nova-release-tools/qualified-startup-inputs-' + startup)
    capture_root = root / ('home-capture-' + operation)
    need(binding['result']['path'] == str(capture_root / 'result.json')
         and binding['closure']['path'] == str(root / 'materialized/home-capture-worker-closed.json')
         and result.get('homeSeed') == review.get('homeSeed')
         and result['homeSeed'].get('path') == str(capture_root / 'home-seed'), 'startup-proof-sealed-home-role-changed')
    control = {name: document('homeCapture/' + name, result[key]) for name, key in
               (('input', 'captureInput'), ('plan', 'capturePlan'), ('intent', 'captureIntent'))}
    request, plan, intent = (control[name] for name in ('input', 'plan', 'intent'))
    base = request.get('startupInput', {})
    need(request == {'format': 1, 'kind': 'coherent-home-capture-input', 'operationId': operation, 'startupInput': base}
         and base.get('operationId') == startup and base.get('inputParent') == str(root) and 'homeCapture' not in base
         and base.get('sourceFiles') == review.get('sourceFiles')
         and base.get('baseline') == review.get('baseline') and base.get('technicalReview') == review.get('reviewReceipt')
         and base.get('buildReceipt') == review.get('buildReceipt') and base.get('installedIdentity') == review.get('installedIdentity')
         and sha(encoded(base)) == result.get('startupInputSha256'), 'startup-proof-home-capture-input-lineage-changed')
    need(plan.get('format') == 1 and plan.get('kind') == 'coherent-home-capture-plan'
         and plan.get('operationId') == operation and plan.get('startupOperationId') == startup
         and plan.get('inputSha256') == result['captureInput']['sha256']
         and plan.get('producerSha256') == result['producerSha256']
         and plan.get('startupInputSha256') == result['startupInputSha256']
         and plan.get('destination') == str(capture_root)
         and plan.get('contentIdentityChosenAtCapture') is True and plan.get('requiresLiveHomeUnchangedAfterCapture') is False
         and plan.get('maximumCaptureSeconds') == 120 and plan.get('workerSeconds') == 180 and plan.get('workerStopSeconds') == 30
         and intent == {'format': 1, 'kind': 'capture-coherent-original-home', 'operationId': operation,
              'planSha256': result['capturePlan']['sha256'], 'inputSha256': plan['inputSha256'],
              'producerSha256': result['producerSha256']}, 'startup-proof-home-capture-plan-intent-changed')
    authority = plan.get('authority', {})
    live = document('homeCapture/liveContext', review['liveContext'])
    unit_context = document('homeCapture/effectiveUnit', review['effectiveUnit'])
    need(authority.get('hostConfiguration') == review.get('hostConfiguration')
         and authority.get('prior') == review.get('prior') and authority.get('selectedApp') == review['prior']['path']
         and authority.get('liveContext') == live and authority.get('effectiveUnit') == unit_context,
         'startup-proof-home-capture-live-origin-changed')
    seed = review['homeSeed']
    capture = document('homeCapture/sourceCapture', seed['sourceCapture'])
    maps = {name: document('homeCapture/' + name, owner[key]) for name, owner, key in (
        ('sourceBefore', capture, 'sourceBefore'), ('sourceAfter', capture, 'sourceAfter'),
        ('sourcePhysical', capture, 'sourcePhysical'), ('sourceMetadata', capture, 'sourceFullMetadata'),
        ('seedInventory', seed, 'inventory'), ('seedPhysical', result, 'seedPhysical'), ('seedMetadata', result, 'seedMetadata'))}
    names = {'sourceCapture': 'home-source-capture.json', 'sourceBefore': 'home-source-before.json',
             'sourceAfter': 'home-source-after.json', 'sourcePhysical': 'home-source-physical.json',
             'sourceMetadata': 'home-source-metadata.json', 'seedInventory': 'home-seed-inventory.json',
             'seedPhysical': 'home-seed-physical.json', 'seedMetadata': 'home-seed-metadata.json'}
    actual_refs = {'sourceCapture': seed['sourceCapture'], 'sourceBefore': capture['sourceBefore'], 'sourceAfter': capture['sourceAfter'],
                   'sourcePhysical': capture['sourcePhysical'], 'sourceMetadata': capture['sourceFullMetadata'],
                   'seedInventory': seed['inventory'], 'seedPhysical': result['seedPhysical'], 'seedMetadata': result['seedMetadata']}
    need(all(actual_refs[name]['path'] == str(capture_root / filename) for name, filename in names.items()),
         'startup-proof-home-capture-evidence-role-changed')
    roles = ['.bash_logout', '.bashrc', '.cache', '.codex', '.config', '.local', '.npm', '.profile']
    need(capture.get('format') == 1 and capture.get('kind') == 'complete-original-home-state-capture'
         and capture.get('sourceRoot') == plan.get('sourceRoot') == '/var/lib/nova'
         and capture.get('roles') == plan.get('roles') == roles
         and capture.get('excludedRoles') == plan.get('excludedRoles') == ['backups', 'install-stage', 'qa', 'recovery', 'workspace']
         and capture.get('sourceUnchanged') is True and capture.get('sourceUnchangedScope') == 'capture-interval-only'
         and all(capture.get(key) is True for key in ('completeRoleCoverage', 'independentInodes', 'sparseVerified', 'flushed'))
         and capture.get('productionMutation') is False and capture.get('sourceSqliteOpened') is False
         and (capture.get('sourceUid'), capture.get('sourceGid'), capture.get('sourceMode')) == (999, 986, 0o700)
         and all(capture.get(key) == result[key] for key in ('captureInput', 'capturePlan', 'captureIntent')),
         'startup-proof-full-home-capture-contract-required')
    start, end = capture.get('captureStartedAtNs'), capture.get('captureEndedAtNs')
    need(type(start) is int and type(end) is int and 0 < start <= end and end - start <= 120 * 10**9,
         'startup-proof-home-capture-interval-required')
    inventory = maps['seedInventory']; source = maps['sourcePhysical']; copied = maps['seedPhysical']
    need(maps['sourceBefore'] == maps['sourceAfter'] == inventory and '.' in inventory
         and {PurePosixPath(name).parts[0] for name in inventory if name != '.'} == set(roles)
         and all(set(value) == set(inventory) for value in maps.values())
         and capture.get('sourceBeforeSha256') == capture['sourceBefore']['sha256']
         and capture.get('sourceAfterSha256') == capture['sourceAfter']['sha256'] == capture['sourceBefore']['sha256']
         and capture.get('seedInventorySha256') == seed['inventory']['sha256'] == capture['sourceBefore']['sha256']
         and capture.get('sourcePhysicalSha256') == capture['sourcePhysical']['sha256'], 'startup-proof-full-home-capture-maps-required')
    for name, item in inventory.items():
        path = PurePosixPath(name)
        need(name == '.' or not path.is_absolute() and str(path) == name and '..' not in path.parts,
             'startup-proof-home-member-path-invalid')
        for physical, metadata in ((source, maps['sourceMetadata']), (copied, maps['seedMetadata'])):
            row = metadata[name]; member = physical[name]
            need(isinstance(row, list) and len(row) == 10 and all(type(v) is int for v in row)
                 and row[:2] == [member['device'], member['inode']] and row[7] == member['allocated']
                 and stat.S_IMODE(row[2]) == item['mode'] and row[3:5] == [item['uid'], item['gid']]
                 and row[8] == item['mtime_ns'] and row[5] >= 1
                 and ((item['kind'] == 'directory' and stat.S_ISDIR(row[2]))
                      or (item['kind'] == 'symlink' and stat.S_ISLNK(row[2]))
                      or (item['kind'] == 'file' and stat.S_ISREG(row[2]) and row[6] == item['size'])),
                 'startup-proof-home-metadata-identity-changed')
    need({(v['device'], v['inode']) for v in source.values()}.isdisjoint({(v['device'], v['inode']) for v in copied.values()}),
         'startup-proof-home-source-copy-inodes-overlap')
    original = capture.get('sourceRootBefore'); authority = result.get('sourceRootAuthority', {})
    root_row = maps['sourceMetadata']['.']
    need(original == capture.get('sourceRootAfter') == root_row[:5] + root_row[8:10]
         and authority == plan.get('authority', {}).get('sourceRootAuthority')
         and [authority.get(k) for k in ('device', 'inode', 'mode', 'uid', 'gid')] == original[:5]
         and authority.get('path') == '/var/lib/nova' and type(authority.get('mountId')) is int
         and result.get('seedRootIdentity') == maps['seedMetadata']['.'][:5] + maps['seedMetadata']['.'][8:10],
         'startup-proof-home-root-identity-changed')
    observation = closed.get('observation', {}); properties = observation.get('properties', {}); cgroup = observation.get('cgroup', {})
    unit = 'nova-qa-home-capture-' + operation + '.service'
    need(closed.get('format') == 1 and closed.get('kind') == 'coherent-home-capture-worker-closure'
         and closed.get('operationId') == operation and closed.get('startupOperationId') == startup
         and closed.get('captureResult') == binding['result'] and observation.get('unit') == unit
         and properties.get('Id') == unit and properties.get('InvocationID') == result.get('worker', {}).get('properties', {}).get('InvocationID')
         and re.fullmatch('[a-f0-9]{32}', properties.get('InvocationID', ''))
         and properties.get('LoadState') == 'loaded' and properties.get('Type') == 'exec'
         and properties.get('ActiveState') == 'active' and properties.get('SubState') == 'exited' and properties.get('Result') == 'success'
         and properties.get('ExecMainStatus') == '0' and properties.get('ExecMainCode') == '1'
         and properties.get('MainPID') == '0' and properties.get('ControlPID') == '0' and not properties.get('Job')
         and properties.get('Restart') == 'no' and properties.get('KillMode') == 'control-group' and properties.get('RemainAfterExit') == 'yes'
         and properties.get('RuntimeMaxUSec') in ('180000000', '3min', '180s') and properties.get('TimeoutStopUSec') in ('30000000', '30s')
         and properties.get('ControlGroup') in ('', '/system.slice/' + unit)
         and cgroup.get('path') == '/system.slice/' + unit and cgroup.get('pids') == [] and cgroup.get('populated') is False
         and isinstance(cgroup.get('groups'), list) and len(cgroup['groups']) <= 128
         and all(p == '/sys/fs/cgroup/system.slice/' + unit or p.startswith('/sys/fs/cgroup/system.slice/' + unit + '/') for p in cgroup['groups'])
         and type(observation.get('observedAtNs')) is int and observation['observedAtNs'] >= end,
         'startup-proof-home-capture-worker-not-successfully-closed')


def consume(request, read, sources):
    need(isinstance(sources, dict) and set(sources) == set(SOURCES)
         and all(isinstance(v, str) and HASH.fullmatch(v) and v != '0' * 64 for v in sources.values()),
         'reviewed-startup-producer-required')
    need(isinstance(request, dict) and set(request) == {'format', 'kind', 'parent', 'producer'}
         and request['format'] == 1 and request['kind'] == 'collect-actual-retained-startup-proof',
         'startup-proof-request-invalid')
    reference(request['parent']); reference(request['producer'])
    need(request['parent']['path'].endswith('/evidence/parent-verified.json')
         and request['producer']['path'].endswith('/qualified-startup.py')
         and request['producer']['sha256'] == sources['qualified-startup.py'], 'startup-proof-fixed-producer-required')
    refs, values = {}, {}

    def document(role, ref, maximum=MAX_JSON, opaque=False):
        reference(ref)
        raw = read(ref['path'], maximum)
        need(sha(raw) == ref['sha256'] and ('bytes' not in ref or ref['bytes'] == len(raw)),
             'startup-proof-original-reference-changed')
        need(role not in refs, 'startup-proof-duplicate-role')
        refs[role] = {'path': ref['path'], 'sha256': ref['sha256'], 'bytes': len(raw)}
        if not opaque:
            values[role] = parse(raw)
            return values[role]
        return raw

    runner_sha = sources['qualified-startup.py']
    document('producer', request['producer'], 2 * 1024**2, True)
    parent = document('parent', request['parent'])
    need(parent.get('format') == 1 and parent.get('kind') == 'actual-retained-startup-parent-verification'
         and parent.get('passed') is True and parent.get('adapterSha256') == runner_sha
         and parent.get('qualificationScope') == SCOPE
         and parent.get('originalSourceAndProtectedClosuresUnchanged') is True
         and parent.get('independentOriginalRestored') is True
         and parent.get('sourceSqliteOpened') is False and parent.get('productionMutation') is False
         and parent.get('deliveryQualification') is False, 'actual-retained-startup-parent-required')
    need(set(parent.get('sourceFiles', {})) == set(SOURCES), 'startup-proof-source-closure-required')
    for name in SOURCES:
        ref = parent['sourceFiles'][name]
        need(ref['sha256'] == sources[name] and ref['path'].endswith('/' + name), 'startup-proof-reviewed-source-changed')
        document('source/' + name, ref, 2 * 1024**2, True)
    need(parent['sourceFiles']['qualified-startup.py'] == request['producer'], 'startup-proof-runner-reference-changed')
    roles = ('review', 'originalPlan', 'executionIntent', 'technicalReview', 'originalIntention',
             'childResult', 'outsideClosure', 'restorationIntent', 'restorationCompleted')
    for name in roles:
        document(name, parent[name])
    review, plan, intent, technical, intention, child, closure, restoration_intent, restoration = (values[name] for name in roles)
    op = parent.get('operationId')
    need(isinstance(op, str) and UUID.fullmatch(op)
         and all(v.get('operationId') == op for v in (review, plan, intent, child, closure, restoration_intent, restoration)),
         'startup-proof-operation-changed')
    worker = parent.get('workerIdentity', {})
    need(set(worker) == {'pid', 'startTicks', 'controlGroup'}
         and type(worker['pid']) is int and worker['pid'] > 1
         and type(worker['startTicks']) is int and worker['startTicks'] > 0
         and worker['controlGroup'] == '/system.slice/nova-qa-qualified-' + op + '.service',
         'startup-proof-original-worker-identity-required')
    profile = document('effectiveProfile', parent['effectiveProfile'])
    properties = profile.get('properties', {})
    need(profile.get('unit') == 'nova-qa-qualified-' + op + '.service'
         and properties.get('MainPID') == str(worker['pid']) and properties.get('ControlGroup') == worker['controlGroup']
         and properties.get('Type') == 'exec' and properties.get('Restart') == 'no' and properties.get('KillMode') == 'control-group'
         and properties.get('RuntimeMaxUSec') in ('4200000000', '1h 10min', '1h10min')
         and properties.get('TimeoutStopUSec') in ('60000000', '1min', '60s'), 'startup-proof-finite-worker-profile-required')
    need(all(v.get('format') == 1 for v in (review, plan, intent, child))
         and review.get('kind') == 'actual-retained-startup-qualification'
         and plan.get('kind') == 'actual-retained-startup-plan'
         and intent.get('kind') == 'execute-actual-retained-startup'
         and child.get('kind') == 'actual-retained-startup-result', 'startup-proof-original-kinds-required')
    need(parent.get('reviewSha256') == refs['review']['sha256'] == plan.get('reviewSha256') == child.get('reviewSha256')
         and intent.get('reviewSha256') == refs['review']['sha256']
         and plan.get('adapterSha256') == intent.get('adapterSha256') == child.get('adapterSha256') == runner_sha
         and intent.get('plan') == parent['originalPlan'] and review.get('reviewReceipt') == parent['technicalReview']
         and intent.get('reviewReceiptSha256') == refs['technicalReview']['sha256'], 'startup-proof-plan-intent-changed')
    need(technical.get('status') == 'passed' and technical.get('sourceHashes') == sources
         and technical.get('callContractsReviewed') is True and technical.get('isolationReviewed') is True
         and technical.get('heldBootstrapReviewed') is True, 'startup-proof-independent-review-required')
    consume_home_capture(review, document, sources)
    negatives = technical.get('negativeVerifierEvidence', {})
    need(set(negatives) == {'source', 'result'}, 'startup-proof-negative-verifier-evidence-required')
    document('negativeVerifierSource', negatives['source'], 2 * 1024**2, True)
    document('negativeVerifierResult', negatives['result'], 2 * 1024**2, True)
    need(intention.get('intent') == intent and intention.get('plan') == plan
         and intention.get('originalPlanSha256') == refs['originalPlan']['sha256']
         and intention.get('intentSha256') == refs['executionIntent']['sha256'], 'startup-proof-original-intention-changed')
    stable = lambda value: {k: v for k, v in value.items() if k != 'observedFreeBytes'}
    need(stable(intention.get('freshAdmission', {})) == stable(plan)
         and type(plan.get('requiredFreeBytes')) is int and plan['requiredFreeBytes'] > 0
         and intention['freshAdmission'].get('observedFreeBytes', -1) >= plan['requiredFreeBytes'],
         'startup-proof-original-capacity-admission-required')
    fixture = PurePosixPath(plan.get('fixtureDirectory', ''))
    need(fixture.is_absolute() and fixture.name == op and str(fixture) == intent.get('fixtureDirectory')
         and request['parent']['path'] == str(fixture / 'evidence/parent-verified.json')
         and parent['originalIntention']['path'] == str(fixture / 'intention.json'), 'startup-proof-fixture-binding-changed')
    binding = review.get('qualificationBinding')
    need(isinstance(binding, dict) and all(v.get('qualificationBinding') == binding for v in (parent, plan, child))
         and binding.get('format') == 1 and binding.get('kind') == 'same-runtime-startup-candidate-binding'
         and binding.get('workspaceEpoch') == review.get('baseline', {}).get('epoch') == plan.get('workspaceEpoch')
         and UUID.fullmatch(binding.get('workspaceEpoch', ''))
         and binding.get('runtime') == review.get('runtime') and binding['runtime'].get('agentVersion') == '2026.9.8'
         and binding.get('helpers') == plan.get('helperHashes') == review.get('helpers', {}).get('sha256')
         and set(binding['helpers']) == set(HELPERS), 'startup-proof-complete-binding-required')
    need(binding['prior'] == {k: review['prior'][k] for k in ('candidateId', 'version')}
         and binding['targets']['private']['candidateId'] == review['target']['candidateId']
         and binding['targets']['private']['version'] == review['target']['version']
         and review['target']['candidateId'] != review['prior']['candidateId'], 'startup-proof-target-roles-changed')
    need(child.get('passed') is True and child.get('qualificationScope') == SCOPE
         and child.get('freshActualSettledCopiedStartup') is True
         and child.get('completeMaintainedSavedAndNativeState') is True and child.get('independentOriginalRestored') is True
         and child.get('sourceSqliteOpened') is False and child.get('productionMutation') is False
         and child.get('deliveryQualification') is False and child.get('freshPostFreezeRehearsalStillRequired') is True
         and child.get('liveAcceptanceStillRequired') is True, 'startup-proof-actual-child-required')
    need(closure.get('kind') == 'rich-held-outside-closure'
         and closure.get('originalSourceAndProtectedClosuresUnchanged') is True
         and closure.get('ownedProcessesAndNamespacesClosed') is True
         and closure.get('sourceSqliteOpened') is False and closure.get('productionMutation') is False
         and closure.get('childResultSha256') == refs['childResult']['sha256'] == parent.get('childResultSha256')
         and all(closure.get(n) == [] for n in ('activeOwnedPids', 'activeNamespaceOwners', 'activeFixtureOwners')),
         'startup-proof-outside-closure-required')
    namespaces = child.get('childNamespaces')
    need(isinstance(namespaces, dict) and set(namespaces) == {'mnt', 'net', 'pid'}
         and child.get('parentNamespaces') == plan.get('parentNamespaces')
         and set(child['parentNamespaces']) == set(namespaces)
         and all(isinstance(v, str) and re.fullmatch(n + r':\[[0-9]+\]', v)
                 and re.fullmatch(n + r':\[[0-9]+\]', child['parentNamespaces'][n])
                 and v != child['parentNamespaces'][n] for n, v in namespaces.items()), 'startup-proof-private-namespaces-required')
    need(plan.get('scenarios') == list(SCENARIOS) and len(parent.get('scenarios', [])) == 3
         and [i.get('scenario') for i in parent['scenarios']] == list(SCENARIOS)
         and len(child.get('scenarios', [])) == 3, 'startup-proof-complete-scenarios-required')
    summaries = []
    for index, item in enumerate(parent['scenarios'], 1):
        scenario = item['scenario']; folder = fixture / 'evidence' / ('attempt-' + str(index))
        need(set(item) == {'scenario', 'started', 'process', 'ready', 'closed', 'preservation', 'bootstrap', 'clock-attribution'}, 'startup-proof-scenario-fields')
        for role in ('started', 'process', 'ready', 'closed', 'preservation', 'bootstrap', 'clock-attribution'):
            need(item[role]['path'] == str(folder / (role + '.json')), 'startup-proof-scenario-path-changed')
            document(scenario + '/' + role, item[role])
        started, process, ready, closed, preserved, bootstrap = (values[scenario + '/' + r] for r in
            ('started', 'process', 'ready', 'closed', 'preservation', 'bootstrap'))
        app = review['prior' if scenario == 'pristine-prior-restoration' else 'target']
        need(started.get('kind') == 'actual-isolated-startup' and started.get('operationId') == op
             and started.get('attempt') == index and started.get('scenario') == scenario
             and started.get('candidateId') == ready.get('candidateId') == preserved.get('candidateId') == app['candidateId']
             and started.get('epoch') == ready.get('epoch') == binding['workspaceEpoch']
             and started.get('namespaces') == namespaces and process.get('namespaces') == namespaces
             and process.get('cwd') == app['path'] and process.get('uid') == review.get('serviceUid')
             and process.get('nodeSha256') == plan.get('nodeSha256')
             and type(process.get('pid')) is int and process['pid'] > 1
             and type(process.get('startTicks')) is int and process['startTicks'] > 0, 'startup-proof-actual-start-process-required')
        need(ready.get('startedSha256') == refs[scenario + '/started']['sha256']
             and ready.get('processSha256') == refs[scenario + '/process']['sha256'] and ready.get('process') == process
             and closed.get('readySha256') == refs[scenario + '/ready']['sha256']
             and closed.get('owningServiceFullyStopped') is True
             and preserved.get('scenario') == scenario and preserved.get('fullyStopped') is True
             and preserved.get('fullMaintainedNativeVerifier') is True
             and preserved.get('closedReceiptSha256') == refs[scenario + '/closed']['sha256']
             and type(preserved.get('savedStoreCount')) is int and preserved['savedStoreCount'] > 0,
             'startup-proof-settled-closed-preservation-required')
        need(all(type(v) is int for v in (started.get('startedAtSeconds'), ready.get('readyAtSeconds'), closed.get('closedAtSeconds')))
             and started['startedAtSeconds'] <= ready['readyAtSeconds'] <= closed['closedAtSeconds']
             and closed['closedAtSeconds'] - started['startedAtSeconds'] <= 3600
             and (not summaries or started['startedAtSeconds'] >= summaries[-1]['closedAtSeconds'] - 1), 'startup-proof-scenario-time-order')
        ordinary_window = [started['startedAtSeconds'], closed['closedAtSeconds']]
        first_window = ordinary_window if index != 2 else [summaries[0]['startedAtSeconds'], summaries[0]['closedAtSeconds']]
        need(values[scenario + '/clock-attribution'] == {'ordinaryNativeWindow': ordinary_window, 'eventHistoryWindow': first_window,
             'eventClockAttribution': 'selected-shared-only', 'windowWidened': False, 'incrementalRestartQualified': False}
             and (index != 2 or first_window[1] <= ordinary_window[0]), 'startup-proof-actual-clock-attribution-required')
        held = ready.get('heldReadiness', {}); health = held.get('health', {})
        need(held.get('epoch') == binding['workspaceEpoch'] and isinstance(held.get('accounts'), list)
             and health.get('status') == 'ready' and health.get('candidateId') == app['candidateId']
             and health.get('version') == app['version'] and health.get('schemaVersion') == 55 and health.get('apiVersion') == 1,
             'startup-proof-held-readiness-changed')
        native = ready.get('nativeProcess', {})
        need(native.get('namespaces') == namespaces and native.get('uid') == review['serviceUid']
             and native.get('cwd') == '/var/lib/nova/workspace/' + plan['selectedRelative'] + '/openclaw-runtime'
             and native.get('nodeSha256') == review['runtime']['agentNodeSha256'] and native.get('pid') != process['pid']
             and type(native.get('pid')) is int and native['pid'] > 1
             and type(native.get('startTicks')) is int and native['startTicks'] > 0, 'startup-proof-native-process-required')
        authority = dict(process); authority['updateSocket'] = '/run/nova-update/control.sock'
        guard = bootstrap.get('acceptanceGuard', {})
        before, after = (bootstrap.get(n, {}) for n in ('controllerBefore', 'controllerAfter'))
        prestart_closure = bootstrap.get('controllerBeforeProcessClosure', {})
        need(bootstrap.get('format') == 1 and bootstrap.get('kind') == 'actual-held-bootstrap-observation'
             and bootstrap.get('operationId') == op and bootstrap.get('scenario') == scenario and bootstrap.get('attempt') == index
             and bootstrap.get('candidateId') == app['candidateId'] and bootstrap.get('leaseId') == started.get('leaseId')
             and bootstrap.get('startedSha256') == refs[scenario + '/started']['sha256']
             and bootstrap.get('processSha256') == refs[scenario + '/process']['sha256']
             and bootstrap.get('processAuthority') == authority and bootstrap.get('networkInterfaces') == ['lo']
             and bootstrap.get('productionMutation') is False
             and before.get('held') is False and before.get('freshHeartbeat') is False
             and before.get('lease', {}).get('stopMarked') is True
             and bootstrap.get('controllerBeforeControl', {}).get('holdFor') == started['leaseId']
             and prestart_closure.get('onlyPrivateController') is True
             and type(prestart_closure.get('controllerPid')) is int and prestart_closure['controllerPid'] > 1
             and prestart_closure['controllerPid'] != process['pid']
             and after.get('held') is True and after.get('freshHeartbeat') is True
             and all(c.get('lease', {}).get('id') == started['leaseId'] and c['lease'].get('phase') == 'checking'
                     and c['lease'].get('candidateId') == app['candidateId'] and c['lease'].get('workspaceEpoch') == binding['workspaceEpoch']
                     for c in (before, after))
             and guard.get('candidateId') == app['candidateId'] and guard.get('epoch') == binding['workspaceEpoch']
             and guard.get('heldFor') == started['leaseId'] and guard.get('maintenanceHeld') is True
             and guard.get('nativeSuspended') is True and guard.get('blockers') == [], 'startup-proof-held-bootstrap-required')
        child_ref = child['scenarios'][index - 1]
        need(type(child_ref) is dict and type(child_ref.get('bytes')) is int and child_ref['bytes'] > 0
             and child_ref == {'path': '/qualification/evidence/attempt-' + str(index) + '/preservation.json',
                 'sha256': refs[scenario + '/preservation']['sha256'],
                 'bytes': refs[scenario + '/preservation']['bytes']}, 'startup-proof-child-canonical-receipt-changed')
        summaries.append({'scenario': scenario, 'candidateId': app['candidateId'], 'preservation': item['preservation'],
                          'startedAtSeconds': started['startedAtSeconds'], 'closedAtSeconds': closed['closedAtSeconds']})
    need(parent['restorationIntent']['path'] == str(fixture / 'evidence/workspace-restoration-intent.json')
         and parent['restorationCompleted']['path'] == str(fixture / 'evidence/workspace-restoration-result.json')
         and restoration_intent.get('kind') == 'restore-independent-pristine-private-state'
         and restoration.get('kind') == 'independent-pristine-private-restoration-completed'
         and restoration.get('intentSha256') == refs['restorationIntent']['sha256']
         and restoration_intent.get('independentOriginalRequired') is True
         and restoration_intent.get('productionMutation') is False and restoration.get('productionMutation') is False
         and restoration.get('passed') is True and restoration.get('targetMutatedStateRetained') is True
         and restoration.get('independentlyRestoredPristine') is True
         and restoration.get('sourceManifestSha256') == restoration_intent.get('sourceManifestSha256') == review['baseline']['manifest']['sha256']
         and restoration.get('sourceHomeInventorySha256') == restoration_intent.get('sourceHomeInventorySha256') == review['homeSeed']['inventory']['sha256']
         and restoration.get('independentOriginalRestored') is True and restoration.get('independentHomeRestored') is True
         and restoration.get('fullPreStartSavedAndNativeEquality') is True
         and restoration.get('workspaceInodesDisjoint') is True and restoration.get('homeInodesDisjoint') is True
         and all(HASH.fullmatch(restoration.get(k, '')) for k in ('originalInventorySha256', 'restoredInventorySha256', 'originalHomeInventorySha256', 'restoredHomeInventorySha256'))
         and restoration['originalInventorySha256'] == restoration['restoredInventorySha256']
         and restoration['originalHomeInventorySha256'] == restoration['restoredHomeInventorySha256'], 'startup-proof-independent-pristine-restoration-required')
    # Read the actual tested installed candidate. A receipt containing only a
    # service hash map cannot replace original package/manifest/file bytes.
    target = PurePosixPath(review['target']['path'])
    package_raw = read(str(target / 'package.json'), 1024**2)
    manifest_raw = read(str(target / 'dist/candidate.json'), 2 * 1024**2)
    package, manifest = parse(package_raw), parse(manifest_raw)
    qualified = binding['targets']['private']
    need(sha(package_raw + manifest_raw) == qualified['candidateId'] == review['target']['candidateId']
         and sha(package_raw) == qualified['packageSha256'] and sha(manifest_raw) == qualified['candidateManifestSha256']
         and sha(read(str(target / 'package-lock.json'), 8 * 1024**2)) == qualified['packageLockSha256']
         and sha(read(str(target / 'scripts/host.mjs'), 2 * 1024**2)) == binding['hostEntrypointSha256']
         and package.get('version') == manifest.get('version') == qualified['version']
         and manifest.get('buildVersion') == qualified['buildVersion']
         and manifest.get('schemaVersion') == 55 and manifest.get('apiVersion') == 1, 'startup-proof-tested-candidate-changed')
    service_files = {}
    for item in manifest.get('artifacts', []):
        path = item.get('path', '')
        need(re.fullmatch(r'dist/(client|service|desktop)/[a-zA-Z0-9_./-]+', path)
             and not any(p in ('', '.', '..') for p in path.split('/')), 'startup-proof-artifact-path')
        if not path.startswith('dist/service/'):
            continue
        need(path not in service_files and HASH.fullmatch(item.get('sha256', '')), 'startup-proof-service-duplicate')
        need(sha(read(str(target / path), 4 * 1024**2)) == item['sha256'], 'startup-proof-service-bytes-changed')
        service_files[path] = item['sha256']
        need(len(service_files) <= 1000, 'startup-proof-service-count-bound')
    need(service_files == binding['serviceArtifacts'] and 'dist/service/apps/service/main.js' in service_files,
         'startup-proof-complete-service-closure-required')
    return {'format': 1, 'kind': 'actual-retained-startup-qualification-observation', 'readOnly': True, 'hostEffects': False,
            'request': request, 'requestSha256': sha(encoded(request)), 'sourceHashes': sources, 'qualificationOperationId': op,
            'scope': SCOPE, 'qualificationBinding': binding, 'scenarios': summaries, 'references': refs, 'workerIdentity': worker,
            'actualSettledQualification': True, 'independentOriginalRestored': True,
            'completeMaintainedSavedAndNativeState': True, 'heldBootstrapVerified': True,
            'productionAdmission': False, 'freshFullRehearsalStillRequired': True, 'liveAcceptanceStillRequired': True}


def worker_closed(worker, proc_root=Path('/proc'), cgroup_root=Path('/sys/fs/cgroup')):
    """Observe original owner and its whole cgroup; collected-unit defaults are not evidence."""
    def original_owner_absent():
        try:
            with (proc_root / str(worker['pid']) / 'stat').open('rb') as stream:
                raw = stream.read(4097)
        except FileNotFoundError:
            return
        need(len(raw) <= 4096 and b')' in raw, 'startup-proof-worker-stat-bound')
        fields = raw[raw.rfind(b')') + 2:].split()
        need(len(fields) > 19 and fields[19].isdigit(), 'startup-proof-worker-stat-invalid')
        need(int(fields[19]) != worker['startTicks'], 'startup-proof-original-worker-still-running')
    original_owner_absent()
    root = cgroup_root / worker['controlGroup'].lstrip('/')
    if root.exists():
        need(root.resolve(strict=True) == root and not root.is_symlink(), 'startup-proof-worker-cgroup-redirected')
        pending = [root]; visited = 0
        while pending:
            directory = pending.pop(); visited += 1
            need(visited <= 256, 'startup-proof-cgroup-count-bound')
            with (directory / 'cgroup.procs').open('rb') as stream:
                raw = stream.read(65537)
            need(len(raw) <= 65536 and not raw.strip(), 'startup-proof-worker-cgroup-not-closed')
            with os.scandir(directory) as entries:
                for entry in entries:
                    need(not entry.is_symlink(), 'startup-proof-worker-cgroup-redirected')
                    if entry.is_dir(follow_symlinks=False): pending.append(Path(entry.path))
    original_owner_absent()


def invoke(request, sources):
    need(os.name == 'posix' and os.geteuid() == 0, 'root-linux-readonly-startup-proof-required')
    reader = ProtectedReader()
    result = consume(request, reader, sources)
    worker_closed(result['workerIdentity'])
    reader.unchanged()
    result['workerClosed'] = True
    result['observedAtMilliseconds'] = time.time_ns() // 1000000
    need(len(encoded(result)) <= 500 * 1024, 'startup-proof-summary-bound')
    return result
