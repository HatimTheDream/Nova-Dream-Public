"""Read-only original-receipt consumer for settled same-runtime startup trials.

No producer import/execution, database access, process launch, or receipt writes.
The maintained JavaScript collector supplies the compiled-in reviewed source map.
"""
import copy
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
# The fixed JS source-family selector authenticates this exact parent before consume.
LIFECYCLE_PARENT = '81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036'
# Exact source capability only; it grants no candidate or runtime acceptance.
RETIRED_RECAPTURE_PRODUCER = 'f9307cd30f7c9b4b50034e81942604772f93027f5ba915ebd9e9176e67b00092'
RETIRED_RECAPTURE_PRODUCERS = {RETIRED_RECAPTURE_PRODUCER, '0c86d97f56addc71e0d8c57665265da1f40009f14caf19bcf75c1899f4d430c6'}
HELPERS = ('install.py', 'recovery.py', 'operator_rehearsal.py', 'app_dependencies.py',
           'codex_log_retention.py', 'workspace_key.py', 'verify-session-bindings.mjs')
APPLICATION_HELPERS = ('hosted_retained_configuration.py', 'local-retained-configuration.mjs', 'hosted_retained_catalog.py', 'hosted-retained-catalog.mjs')
SAME_SCHEMA_QUALIFICATION = {'format': 1, 'kind': 'schema-60-same-runtime', 'schemaVersion': 60, 'apiVersion': 1, 'agentVersion': '2026.9.8'}
SAME_SCHEMA_BASELINE = 'verified-closed-schema60-target-retained'

APPLICATION_TRANSITION = {'format': 1, 'kind': 'schema-55-to-60-same-runtime', 'fromSchemaVersion': 55, 'toSchemaVersion': 60, 'apiVersion': 1, 'fromAgentVersion': '2026.9.8', 'toAgentVersion': '2026.9.8'}



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


def consume_home_capture(review, document, sources, same_schema=False):
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
    source_root = str(PurePosixPath(review['baseline']['workspace']).parent) if same_schema else '/var/lib/nova'
    roles = ['.bash_logout', '.bashrc', '.cache', '.codex', '.config', '.local', '.npm', '.profile']
    need(capture.get('format') == 1 and capture.get('kind') == 'complete-original-home-state-capture'
         and capture.get('sourceRoot') == plan.get('sourceRoot') == source_root
         and capture.get('roles') == plan.get('roles') == roles
         and capture.get('excludedRoles') == plan.get('excludedRoles') == ['backups', 'install-stage', 'qa', 'recovery', 'workspace']
         and capture.get('sourceUnchanged') is True and capture.get('sourceUnchangedScope') == 'capture-interval-only'
         and (not same_schema or capture.get('sourceAccessTimesPreserved') is True)
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
            need(isinstance(row, list) and len(row) == (11 if same_schema and physical is source else 10)
                 and all(type(v) is int for v in row) and (len(row) != 11 or row[10] >= 0)
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
         and authority.get('path') == source_root and type(authority.get('mountId')) is int
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


def consume(request, read, sources, same_schema_helpers=None):
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
    runtime = ('7800000000', '2h 10min', '2h10min') if sources['qualified-parent.py'] == LIFECYCLE_PARENT else ('4200000000', '1h 10min', '1h10min')
    need(profile.get('unit') == 'nova-qa-qualified-' + op + '.service'
         and properties.get('MainPID') == str(worker['pid']) and properties.get('ControlGroup') == worker['controlGroup']
         and properties.get('Type') == 'exec' and properties.get('Restart') == 'no' and properties.get('KillMode') == 'control-group'
         and properties.get('RuntimeMaxUSec') in runtime
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
    binding = review.get('qualificationBinding')
    same_schema = same_schema_helpers is not None
    marker = binding.get('sameSchemaQualification') if isinstance(binding, dict) else None
    need((marker is not None) == same_schema, 'startup-proof-same-schema-producer-required')
    if same_schema:
        need(type(marker) is dict and marker == SAME_SCHEMA_QUALIFICATION
             and all(type(marker[k]) is int for k in ('format', 'schemaVersion', 'apiVersion'))
             and 'applicationTransition' not in binding
             and type(same_schema_helpers) is dict and set(same_schema_helpers) == set(HELPERS + APPLICATION_HELPERS)
             and all(type(v) is str and HASH.fullmatch(v) for v in same_schema_helpers.values())
             and binding.get('helpers') == same_schema_helpers,
             'startup-proof-same-schema-contract-changed')
    consume_home_capture(review, document, sources, same_schema)
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
    transition = binding.get('applicationTransition') if isinstance(binding, dict) else None
    if transition is not None:
        need(transition == APPLICATION_TRANSITION and all(type(transition[k]) is int for k in ('format','fromSchemaVersion','toSchemaVersion','apiVersion')), 'startup-proof-application-transition-changed')
    application = transition is not None or same_schema
    prior_schema = 60 if same_schema else 55
    if application:
        prior_root = PurePosixPath(review['prior']['path'])
        prior_package_raw = read(str(prior_root / 'package.json'), 1024**2)
        prior_manifest_raw = read(str(prior_root / 'dist/candidate.json'), 2*1024**2)
        prior_package, prior_manifest = parse(prior_package_raw), parse(prior_manifest_raw)
        need(sha(prior_package_raw + prior_manifest_raw) == review['prior']['candidateId']
             and prior_package.get('version') == prior_manifest.get('version') == review['prior']['version']
             and prior_package.get('edition3',{}).get('schemaVersion') == prior_manifest.get('schemaVersion') == prior_schema
             and prior_package.get('edition3',{}).get('apiVersion') == prior_manifest.get('apiVersion') == 1, 'startup-proof-prior-schema-changed')
    target_schema = 60 if application else 55
    dependencies = binding.get('applicationDependencies') if isinstance(binding,dict) else None
    if dependencies is not None:
        fields={'format','archiveBytes','archiveSha256','expandedBytes','fileCount','packageLockSha256','dependencyGraphSha256','platform','arch','nodeVersion','nodeAbi'}
        need(application and type(dependencies) is dict and set(dependencies)==fields
             and type(dependencies['format']) is int and dependencies['format']==1
             and all(type(dependencies[k]) is int and 0<dependencies[k]<=limit for k,limit in [('archiveBytes',512*1024**2),('expandedBytes',2*1024**3),('fileCount',200000)])
             and all(HASH.fullmatch(dependencies[k]) for k in ('archiveSha256','packageLockSha256','dependencyGraphSha256'))
             and dependencies['platform']=='linux' and dependencies['arch']=='x64' and dependencies['nodeVersion']=='22.23.2'
             and type(dependencies['nodeAbi']) is int and dependencies['nodeAbi']==127
             and dependencies['dependencyGraphSha256']==binding['dependencyGraphSha256']
             and all(t['packageLockSha256']==dependencies['packageLockSha256'] for t in binding['targets'].values()), 'startup-proof-application-dependencies-changed')
    need(isinstance(binding, dict) and all(v.get('qualificationBinding') == binding for v in (parent, plan, child))
         and binding.get('format') == 1 and binding.get('kind') == 'same-runtime-startup-candidate-binding'
         and binding.get('workspaceEpoch') == review.get('baseline', {}).get('epoch') == plan.get('workspaceEpoch')
         and UUID.fullmatch(binding.get('workspaceEpoch', ''))
         and binding.get('runtime') == review.get('runtime') and binding['runtime'].get('agentVersion') == '2026.9.8'
         and binding.get('helpers') == plan.get('helperHashes') == review.get('helpers', {}).get('sha256')
         and set(binding['helpers']) == set(HELPERS + (APPLICATION_HELPERS if application else ())), 'startup-proof-complete-binding-required')
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
    capture_manifest = consume_closed_schema_baseline(review, plan, parent, document) if same_schema else None
    if runner_sha in CAPTURE_REAPING_PRODUCERS:
        need(binding['helpers'].get('recovery.py') == '23b7d18d415393a315a8140b674edee4a12cbc1b8f996b439843472208dcbd15'
             and binding['helpers'].get('install.py') in {'941e295816bbb4c5da054928018ee59ae3164d032dffcab63d79f36b79050a59', 'f85ef9249d9722558ad6ab6dccee60b8d4412ca793afeeb1a53d316a85a2e62a', '522b78eeb6a6d986dde2ac353516c47a987d8283bb030d273b0b4122d08cbe24'},
             'startup-proof-capture-lifecycle-helper-source-required')
        original_manifest = review['baseline']['manifest']
        need(plan['inputHashes'].get(original_manifest['path']) == original_manifest['sha256'],
             'startup-proof-original-capture-manifest-input-binding')
        capture_manifest = document('baselineManifest', original_manifest)
    summaries = []
    capture_preceding = None
    transition_preceding = None
    capture_history = None
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
             and health.get('version') == app['version'] and health.get('schemaVersion') == (prior_schema if scenario == 'pristine-prior-restoration' else target_schema) and health.get('apiVersion') == 1,
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
        if runner_sha in REPLICA_OBSERVATION_PRODUCERS or same_schema:
            first_start = summaries[0]['startedAtSeconds'] if index == 2 else started['startedAtSeconds']
            validate_replica_observation_receipt(preserved.get('replicaConfigObservation'), plan, first_start)
        capture_key = None
        if same_schema:
            capture_keys = [name for name in ('captureObservation', 'captureRetirement', 'captureContinuity', 'captureTransition') if name in preserved]
            need(len(capture_keys) == 1, 'startup-proof-single-capture-branch-required')
            capture_key = capture_keys[0]
            need(not summaries or capture_key in summaries[0], 'startup-proof-single-capture-branch-required')
            if capture_key == 'captureObservation':
                capture = capture_observation_summary(preserved[capture_key], plan, app['candidateId'], binding['workspaceEpoch'],
                    index, summaries[0].get(capture_key) if summaries else None, capture_manifest, folder, scenario, document)
            elif capture_key == 'captureTransition':
                need(runner_sha in RETIRED_RECAPTURE_PRODUCERS,
                     'startup-proof-retired-recapture-source-not-qualified')
                if capture_history is None:
                    capture_history=consume_capture_history(plan,review,values,document)
                capture,transition_preceding=capture_transition_summary(preserved[capture_key],plan,review,values,
                    capture_history,ordinary_window,item,index,folder,scenario,document,transition_preceding)
            elif capture_key == 'captureContinuity':
                need(runner_sha in RETIRED_RECAPTURE_PRODUCERS,
                     'startup-proof-retired-recapture-source-not-qualified')
                capture = capture_continuity_summary(preserved[capture_key], plan, app['candidateId'], binding['workspaceEpoch'],
                    index, ordinary_window, capture_preceding,
                    capture_manifest, folder, scenario, document, review['runtime']['agent'])
                capture_preceding = preserved[capture_key]
            else:
                capture = capture_retirement_summary(preserved[capture_key], plan, started['leaseId'], app['candidateId'],
                    binding['workspaceEpoch'], index, [started['startedAtSeconds'], closed['closedAtSeconds']],
                    summaries[0][capture_key]['roles'] if summaries else None, True, capture_manifest)
        elif runner_sha in CAPTURE_PRODUCERS:
            need(review['baseline'].get('kind') == parent.get('baselineLineage') == CAPTURE_BASELINE,
                 'startup-proof-required-incident-source-lineage')
            capture = capture_retirement_summary(preserved.get('captureRetirement'), plan, started['leaseId'],
                app['candidateId'], binding['workspaceEpoch'], index, [started['startedAtSeconds'], closed['closedAtSeconds']],
                summaries[0]['captureRetirement']['roles'] if summaries else None, runner_sha in CAPTURE_REAPING_PRODUCERS, capture_manifest)
        child_ref = child['scenarios'][index - 1]
        need(type(child_ref) is dict and type(child_ref.get('bytes')) is int and child_ref['bytes'] > 0
             and child_ref == {'path': '/qualification/evidence/attempt-' + str(index) + '/preservation.json',
                 'sha256': refs[scenario + '/preservation']['sha256'],
                 'bytes': refs[scenario + '/preservation']['bytes']}, 'startup-proof-child-canonical-receipt-changed')
        summaries.append({'scenario': scenario, 'candidateId': app['candidateId'], 'preservation': item['preservation'],
                          'startedAtSeconds': started['startedAtSeconds'], 'closedAtSeconds': closed['closedAtSeconds']})
        if runner_sha in REPLICA_OBSERVATION_PRODUCERS or same_schema:
            summaries[-1]['replicaConfigObservation'] = preserved['replicaConfigObservation']
        if same_schema:
            summaries[-1][capture_key] = capture
        elif runner_sha in CAPTURE_PRODUCERS:
            summaries[-1]['captureRetirement'] = capture
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
         and manifest.get('schemaVersion') == target_schema and manifest.get('apiVersion') == 1
         and (not application or (package.get('edition3',{}).get('schemaVersion') == target_schema and package.get('edition3',{}).get('apiVersion') == 1)), 'startup-proof-tested-candidate-changed')
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
            **({'baselineLineage': SAME_SCHEMA_BASELINE} if same_schema else {'baselineLineage': CAPTURE_BASELINE} if runner_sha in CAPTURE_PRODUCERS else {}),
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


CAPTURE_BASELINE = 'verified-pre-swap-aborted-operator-snapshot'
CAPTURE_TOKEN = 'f9b7a02201bbcec6133d5d043ba09d189aec76517b4db7e337696cd16d40db9b'
CAPTURE_EMPTY = hashlib.sha256(b'').hexdigest()


def consume_closed_schema_baseline(review, plan, parent, document):
    """Join the complete closed-source inventory to its original qualified owner."""
    fail = 'startup-proof-closed-schema-source-lineage-required'
    baseline = review.get('baseline', {})
    names = ('retainedParent', 'retainedRoles', 'retainedClosure', 'retainedSecondPreservation')
    need(type(baseline) is dict and set(baseline) == {'kind', 'workspace', 'epoch', 'sourceApp', 'manifest', 'verified', *names}
         and baseline.get('kind') == parent.get('baselineLineage') == SAME_SCHEMA_BASELINE
         and baseline.get('sourceApp') == review['prior'] and baseline.get('epoch') == plan['workspaceEpoch'], fail)
    workspace = PurePosixPath(baseline['workspace'])
    need(workspace.is_absolute() and str(workspace) == baseline['workspace'] and '..' not in workspace.parts
         and workspace.name == 'workspace', fail)
    records = {}
    for name, ref in {'baselineManifest': baseline['manifest'], 'baselineVerified': baseline['verified'],
                      **{name: baseline[name] for name in names}}.items():
        need(plan.get('inputHashes', {}).get(ref['path']) == ref['sha256'], fail)
        records[name] = document(name, ref)
    original, closed, preserved = (records[name] for name in ('retainedParent', 'retainedClosure', 'retainedSecondPreservation'))
    need(original.get('kind') == 'actual-retained-startup-parent-verification' and original.get('passed') is True
         and original.get('targetCandidateId') == review['prior']['candidateId']
         and original.get('workspaceEpoch') == baseline['epoch']
         and original.get('disposableRoles') == baseline['retainedRoles'] and original.get('outsideClosure') == baseline['retainedClosure']
         and len(original.get('scenarios', [])) == 3
         and original['scenarios'][1].get('preservation') == baseline['retainedSecondPreservation']
         and original.get('originalSourceAndProtectedClosuresUnchanged') is True
         and records['retainedRoles'].get('kind') == 'successful-qualification-disposable-role-inventory'
         and closed.get('kind') == 'rich-held-outside-closure'
         and closed.get('ownedProcessesAndNamespacesClosed') is True
         and preserved.get('scenario') == 'target-restart' and preserved.get('candidateId') == review['prior']['candidateId']
         and preserved.get('fullyStopped') is True and preserved.get('fullMaintainedNativeVerifier') is True
         and type(preserved.get('savedStoreCount')) is int and preserved['savedStoreCount'] > 0, fail)
    verified, manifest = records['baselineVerified'], records['baselineManifest']
    need(verified.get('kind') == 'closed-schema60-retained-source-inventory'
         and verified.get('sourceRoot') == str(workspace)
         and verified.get('sourceRootIdentity') == plan['baselineRootIdentity'][:5]
         and verified.get('manifestSha256') == baseline['manifest']['sha256']
         and verified.get('sourceBeforeMetadataSha256') == verified.get('sourceAfterMetadataSha256')
         and HASH.fullmatch(verified.get('sourceBeforeMetadataSha256', ''))
         and verified.get('originalReferences') == {name: baseline[name] for name in names}
         and verified.get('sourceOwnerClosure', {}).get('closed') is True
         and verified.get('sourceSqliteOpened') is False and verified.get('sourceUnchanged') is True
         and verified.get('currentLiveSnapshotQualified') is False and type(manifest) is dict and len(manifest) > 40000,
         'startup-proof-complete-closed-source-inventory-required')
    return manifest


# Pure raw-proof reconstruction, copied from the separately reviewed producer predicate.
# No producer code is imported or executed; all evidence comes from authenticated original files.
CONTINUITY_WRITER_SOURCES={"retirement":{"sqlite-staging-token-CcxeaYVw.mjs":"640abcf7ec6e84134f752e94c9c49b8d4d1eea55d0416b4f0102e722ff89702f","plugin-source-capture-path-L0n-8p-6.mjs":"2b5c87c781d8299882aa5ca90d66f8f20eda194a84cd3b73224f2fdd8163d7cf","plugin-source-capture-directory-CsjPVlzr.mjs":"bb59fd7c7b721a67fce0201e8f6bd250a66c84bc055d06d0ce645ecf18b25f79","plugin-generation-artifact-Bm1J86Hz.mjs":"cf407e9631824208f504fd5271253647b5423d53020694228a732938bf149686"},"reaping":{"startup-config-preflight-n5_82TxL.mjs":"5c6b4c413548ab08e5168d429be1de37b439ab1a3c40b104e1e7a8b5958ca243","plugin-source-capture-report-BdUXHa10.mjs":"4aa98618a9fbac29e1bf83af25e486d20eeed416ce2cdcc5e95a231bbba71ac9","plugin-source-capture-report-UvN1qTM0.mjs":"0f8775cc9fa4787877e379b69c1412bcfbf6fd74ee54eb634e2c8a3d3abc391b","doctor-sqlite-maintenance-lock-BMIeQhbQ.mjs":"c4d81de690f07f2b3e283df0f388bb50b7153a27ad3c55e239554fb47a25cf9d","doctor-sqlite-maintenance-lock-TnMKHoAr.mjs":"a08726a748f566409f2fef2481824a2209717be02cd10c3fe3d42768bca4c657","installed-plugin-index-store-CUXGXwqh.mjs":"8f44c30d7555a3efdbe0c02254c2d050b019ae24b416d83a9cb61c8da8356232"}}

def continuity_encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'\n').encode()
def continuity_digest(value):return hashlib.sha256(continuity_encoded(value)).hexdigest()
def continuity_copied(value):return json.loads(continuity_encoded(value))
def continuity_relative(value):
 need(type(value) is str and value and '\0' not in value and '\\' not in value,'capture-relative-path-required')
 path=PurePosixPath(value);need(not path.is_absolute() and '..' not in path.parts and str(path)==value,'capture-relative-path-required');return path

def continuity_exact_window(value):
 need(type(value) in (list,tuple) and len(value)==2 and all(type(v) is int for v in value)
      and 0<=value[0]<=value[1] and value[1]-value[0]<=3600,'capture-genuine-window-required')
 return list(value)

def continuity_state_hashes(state):
 return {'baselineInventorySha256':continuity_digest(state['inventory']['baseline']),'liveInventorySha256':continuity_digest(state['inventory']['live']),
  'baselineClassificationSha256':continuity_digest(state['classification']['baseline']),'liveClassificationSha256':continuity_digest(state['classification']['live'])}

def continuity_validate_state(state):
 fields={'format','kind','phase','candidateId','attempt','workspaceEpoch','selectedRelative','physicalRoots','classification','inventory','classificationSha256','inventorySha256','stagingCount'}
 need(type(state) is dict and set(state)==fields and state['format']==1 and state['kind']=='closed-9.8-retired-capture-state'
      and state['phase'] in ('before','closed') and type(state['attempt']) is int and state['attempt'] in (1,2,3) and type(state['stagingCount']) is int and state['stagingCount']==0,'capture-state-contract-changed')
 need(type(state['candidateId']) is str and re.fullmatch('[a-f0-9]{64}',state['candidateId'])
      and type(state['physicalRoots']) is list and len(state['physicalRoots'])==2
      and all(type(row) is list and len(row)==5 and all(type(v) is int and 0<=v<=2**53-1 for v in row)
              and row[0]>0 and row[1]>0 and stat.S_ISDIR(row[2]) and row[3:]==[999,986] for row in state['physicalRoots'])
      and state['physicalRoots'][0][:2]!=state['physicalRoots'][1][:2],'capture-physical-authority-changed')
 need(set(state['inventory'])==set(state['classification'])=={'baseline','live'}
      and state['inventorySha256']==continuity_digest(state['inventory']) and state['classificationSha256']==continuity_digest(state['classification']),'capture-state-hashes-changed')
 for role in ('baseline','live'):
  rows=state['inventory'][role];need(type(rows) is dict and 0<len(rows)<=8192 and '.' in rows,'capture-complete-inventory-required')
  for path,row in rows.items():
   continuity_relative(path);need(type(row) is dict and row.get('kind') in ('file','directory','symlink'),'capture-row-kind-changed')
   need(type(row.get('mtime_ns')) is int and row['mtime_ns']>=0 and type(row.get('xattrs')) is dict,'capture-exact-metadata-required')
  classes=state['classification'][role];prefix=state['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures/'
  owners=sorted(prefix+p for p,row in rows.items() if p.endswith('/owner.sqlite') and p.count('/')==1)
  need(classes==owners,'capture-owner-classification-incomplete')
 return state

def continuity_prestart(before,previous=None):
 continuity_validate_state(before);need(before['phase']=='before','capture-prestart-phase-required')
 baseline=before['inventory']['baseline'];live=before['inventory']['live']
 if before['attempt'] in (1,3):
  need(previous is None and baseline==live and before['classification']['baseline']==before['classification']['live'],'capture-pristine-prestart-required')
 else:
  need(type(previous) is dict and set(previous)=={'before','closed','proof','beforeSha256','closedSha256','proofSha256'},'capture-restart-predecessor-required')
  old=continuity_validate_state(previous['closed']);proof=previous['proof']
  need(previous['beforeSha256']==continuity_digest(previous['before']) and previous['closedSha256']==continuity_digest(old)
       and previous['proofSha256']==continuity_digest(proof) and proof['beforeSha256']==previous['beforeSha256']
       and proof['closedSha256']==previous['closedSha256'] and old['attempt']==1 and old['phase']=='closed','capture-restart-predecessor-hashes-changed')
  need(before['candidateId']==old['candidateId'] and before['workspaceEpoch']==old['workspaceEpoch']
       and before['selectedRelative']==old['selectedRelative'] and before['physicalRoots']==old['physicalRoots']
       and before['inventory']==old['inventory'] and before['classification']==old['classification'],'capture-restart-exact-closed-state-required')
 return continuity_state_hashes(before)

def continuity_namespace_rows(admissions):
 need(type(admissions) is dict and len(admissions)==1,'capture-canonical-admission-key-required')
 receipt=next(iter(admissions.values()));need(type(receipt) is dict and set(receipt)=={'signature','sourceDigest','nativeArtifacts','nativeNamespaces'},'capture-canonical-receipt-required')
 need(type(receipt['nativeNamespaces']) is dict and 0<len(receipt['nativeNamespaces'])<=16,'capture-canonical-namespaces-required')
 return receipt['nativeNamespaces']

def continuity_mappings(reports,logical_root):
 need(type(reports) is list and 0<len(reports)<=8,'capture-successful-canonical-reports-required')
 result={};current_names=set()
 for report in reports:
  need(report['kind']=='canonical-retired-capture-admissions' and report['canonicalReturnedTrue'] is True,'capture-successful-canonical-report-required')
  old=continuity_namespace_rows(report['originalSourceAdmissions']);new=continuity_namespace_rows(report['currentSourceAdmissions']);mapping=report['provedNamespaceMapping']
  a_receipt=next(iter(report['originalSourceAdmissions'].values()));b_receipt=next(iter(report['currentSourceAdmissions'].values()))
  need(all(a_receipt[k]==b_receipt[k] for k in ('signature','sourceDigest')) and set(a_receipt['nativeArtifacts'])==set(b_receipt['nativeArtifacts']),'capture-canonical-content-authority-changed')
  need(set(mapping)==set(old),'capture-complete-canonical-mapping-required')
  for receipt in (a_receipt,b_receipt):
   for source,artifact in receipt['nativeArtifacts'].items():
    need(type(artifact) is dict and set(artifact)=={'sourceIdentity','contentHash','sizeBytes','namespace','capturedPath','capturedIdentity'} and artifact['namespace'] in receipt['nativeNamespaces'],'capture-native-artifact-shape-changed')
    ns=receipt['nativeNamespaces'][artifact['namespace']];directory=PurePosixPath(ns['sourceDirectory']);path=PurePosixPath(source)
    need(path.is_relative_to(directory),'capture-native-artifact-source-changed');rel=str(path.relative_to(directory));member=ns['members'].get(rel)
    need(member is not None and artifact['capturedPath']==str(PurePosixPath(artifact['namespace'])/'content'/rel)
         and all(artifact[k]==member[k] for k in ('sourceIdentity','contentHash','sizeBytes','capturedIdentity')),'capture-native-artifact-member-changed')
  need(all(a_receipt['nativeArtifacts'][k]['contentHash']==b_receipt['nativeArtifacts'][k]['contentHash']
       and a_receipt['nativeArtifacts'][k]['sizeBytes']==b_receipt['nativeArtifacts'][k]['sizeBytes'] for k in a_receipt['nativeArtifacts']),'capture-native-artifact-content-changed')
  for old_name,proof in mapping.items():
   new_name=proof['current'];need(proof['original']==old[old_name] and new_name in new,'capture-current-preprojection-receipt-required')
   a,b=PurePosixPath(old_name),PurePosixPath(new_name);base=PurePosixPath(logical_root)
   need(a.is_relative_to(base) and b.is_relative_to(base),'capture-mapping-root-changed')
   a,b=str(a.relative_to(base)),str(b.relative_to(base))
   pattern=r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/native/admission-[A-Za-z0-9]{6}'
   need(re.fullmatch(pattern,a) and re.fullmatch(pattern,b) and a not in result and b not in current_names,'capture-mapping-not-bijective')
   original,current=old[old_name],new[new_name]
   need(original['sourceDirectory']==current['sourceDirectory'] and original['managed'] is current['managed'] is True
        and set(original['members'])==set(current['members']),'capture-managed-source-members-changed')
   selected_window=continuity_exact_window(report['evaluatedWindow'])
   for rel,member in original['members'].items():
    observed=current['members'][rel]
    need(set(member)==set(observed) and all(member[k]==observed[k] for k in member if k not in ('sourceIdentity','capturedIdentity')),'capture-member-content-or-boundary-policy-changed')
    for field in ('sourceIdentity','capturedIdentity'):
     parse=lambda value:tuple(map(int,value.split(':')))
     x,y=parse(member[field]),parse(observed[field]);need(len(x)==len(y)==6,'capture-member-physical-identity-required')
     positions=(2,3,4) if stat.S_ISREG(x[2]) and (field=='sourceIdentity' or not member['boundaryChecked']) else (2,)
     need(all(x[p]==y[p] for p in positions),'capture-member-mode-size-mtime-changed')
     if field=='capturedIdentity' and (a!=b or x[4]!=y[4]) and (stat.S_ISDIR(y[2]) or member['boundaryChecked']):
      need(all(selected_window[0]*10**9<=y[p]<=selected_window[1]*10**9 for p in (4,5)),'capture-member-outside-canonical-window')
   result[a]={'current':b,'original':original,'receipt':current,'window':report['evaluatedWindow'],
              'windowSource':report['windowSource'],'canonicalReportSha256':continuity_digest(report)};current_names.add(b)
  need(set(new)=={v['current'] for v in mapping.values()},'capture-current-namespace-complement-unproved')
 return result

def continuity_family_rows(rows,family,namespaces,runtime,retired_sha):
 names={p for p in rows if p==family or p.startswith(family+'/')};owner=family+'/owner.sqlite';expected={family,owner,family+'/native'}
 need(owner in names and rows[owner]['kind']=='file' and rows[owner]['size']==4096 and rows[owner]['sha256']==retired_sha
      and rows[owner]['mode'] in (0o600,0o644) and rows[owner]['xattrs']=={} and 'hardlink_group' not in rows[owner], 'capture-exact-retired-owner-required')
 uid,gid=rows[owner]['uid'],rows[owner]['gid'];need((uid,gid)==(999,986),'capture-service-owner-changed')
 member_rows={}
 for name,receipt in namespaces.items():
  need(name.startswith(family+'/native/') and receipt['managed'] is True,'capture-family-namespace-changed')
  expected.update((name,name+'/node_modules',name+'/node_modules/openclaw'))
  for rel,member in receipt['members'].items():
   need(rel=='' or str(continuity_relative(rel))==rel,'capture-member-relative-path-changed')
   path=name+'/content'+('/'+rel if rel else '');expected.add(path);row=rows.get(path)
   parts=member['capturedIdentity'].split(':');need(len(parts)==6 and all(p.isdigit() for p in parts),'capture-member-identity-required');identity=tuple(map(int,parts))
   need(row is not None and row['mode']==stat.S_IMODE(identity[2]) and row['mtime_ns']==identity[4],'capture-member-exact-metadata-changed')
   if stat.S_ISREG(identity[2]):
    need(row['kind']=='file' and row['size']==member['sizeBytes'] and row['sha256']==member['contentHash'],'capture-member-content-changed')
   else:need(stat.S_ISDIR(identity[2]) and row['kind']=='directory','capture-member-kind-changed')
   member_rows[path]=member
  link=rows.get(name+'/node_modules/openclaw')
  need(link is not None and link['kind']=='symlink' and link['mode']==0o777 and link['target']==runtime,'capture-runtime-link-changed')
 need(names==expected,'capture-family-neighbor-or-partial-removal')
 for name in names:
  row=rows[name];need((row['uid'],row['gid'])==(uid,gid) and row['xattrs']=={},'capture-family-protection-changed')
  if row['kind']=='directory':need(row['mode']==0o700,'capture-family-private-ancestry-required')
 return member_rows

def continuity_hardlink_classes(rows,rename):
 groups={}
 for path,row in rows.items():
  if row['kind']=='file':groups.setdefault(row.get('hardlink_group',path),[]).append(rename[path])
 for group,members in groups.items():
  original=[p for p,row in rows.items() if row['kind']=='file' and row.get('hardlink_group',p)==group]
  need(group==min(original) and (len(original)>1 or 'hardlink_group' not in rows[original[0]]),'capture-hardlink-group-shape-changed')
 return sorted(sorted(v) for v in groups.values())

def continuity_source_capture_partition(matched,current):
 identities={};groups={}
 for name,value in matched.items():
  namespace=value['receipt' if current else 'original']
  for rel,member in namespace['members'].items():
   if 'contentHash' not in member:continue
   captured=value['current']+'/content'+('/'+rel if rel else '')
   for label,field in (('source:'+member['source'],'sourceIdentity'),('capture:'+captured,'capturedIdentity')):
    parts=member[field].split(':');need(len(parts)==6 and all(p.isdigit() for p in parts),'capture-link-partition-identity-required')
    identity=tuple(map(int,parts[:2]))
    need(identities.setdefault(label,identity)==identity,'capture-shared-source-identity-conflict')
 for label,identity in identities.items():groups.setdefault(identity,[]).append(label)
 return sorted(sorted(labels) for labels in groups.values())


def continuity_closure(before,closed,reports,window,runtime,retired_sha,writer_sources,previous=None):
 continuity_prestart(before,previous);continuity_validate_state(closed);ordinary=continuity_exact_window(window)
 need(closed['phase']=='closed' and all(closed[k]==before[k] for k in ('candidateId','attempt','workspaceEpoch','selectedRelative','physicalRoots'))
      and closed['inventory']['baseline']==before['inventory']['baseline'] and closed['classification']['baseline']==before['classification']['baseline'],'capture-baseline-or-scenario-changed')
 old=before['inventory']['baseline'];new=closed['inventory']['live'];logical='/var/lib/nova/workspace/'+before['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures'
 matched=continuity_mappings(reports,logical);families={};reverse={}
 for name,value in matched.items():
  a=name.split('/')[0];b=value['current'].split('/')[0]
  need(families.setdefault(a,b)==b and reverse.setdefault(b,a)==a,'capture-family-mapping-not-bijective')
 changed={a:b for a,b in families.items() if a!=b or any(p not in new or old[p]!=new[p] for p in old if p==a or p.startswith(a+'/'))}
 # Every changed family is fully covered by original AND actual current receipts.
 old_members={};new_members={}
 for a,b in changed.items():
  old_ns={n:v['original'] for n,v in matched.items() if n.split('/')[0]==a};new_ns={v['current']:v['receipt'] for n,v in matched.items() if n.split('/')[0]==a}
  old_members.update(continuity_family_rows(old,a,old_ns,runtime,retired_sha));new_members.update(continuity_family_rows(new,b,new_ns,runtime,retired_sha))
 rename={};categories={};windows={}
 for path in old:
  if path=='.':rename[path]='.';continue
  family=path.split('/')[0]
  if family not in changed:rename[path]=path;continue
  replacement=changed[family];dest=replacement+path[len(family):];category='container'
  for name,value in matched.items():
   if path==name or path.startswith(name+'/'):
    dest=value['current']+path[len(name):];windows[path]=continuity_exact_window(value['window'])
    if path in old_members:
     member=old_members[path];category='canonical-directory' if old[path]['kind']=='directory' else 'canonical-boundary-file' if member['boundaryChecked'] else 'unchanged-content-file'
    elif path==name+'/node_modules/openclaw':category='host-runtime-symlink'
    break
  if path==family+'/owner.sqlite':category='retired-owner'
  rename[path]=dest;categories[path]=category
 need(len(set(rename.values()))==len(rename) and set(rename.values())==set(new),'capture-complete-inventory-bijection-required')
 changes=[]
 for path,dest in rename.items():
  a,b=dict(old[path]),dict(new[dest]);ag=a.pop('hardlink_group',None);bg=b.pop('hardlink_group',None)
  if a==b:continue
  need({k:v for k,v in a.items() if k!='mtime_ns'}=={k:v for k,v in b.items() if k!='mtime_ns'},'capture-unproved-content-link-or-metadata-change')
  category=categories.get(path,'root-container' if path=='.' and changed else None)
  need(category in {'container','root-container','canonical-directory','canonical-boundary-file','host-runtime-symlink','retired-owner'},'capture-unattributed-mtime-change')
  # Retained whole capture state can inherit only its preceding authenticated window.
  selected_window=windows.get(path,ordinary)
  if previous is not None and closed['inventory']['live']==previous['closed']['inventory']['live']:
   selected_window=continuity_exact_window(previous['proof']['ordinaryWindow'])
  need(selected_window[0]*10**9<=b['mtime_ns']<=selected_window[1]*10**9,'capture-mtime-outside-proved-writer-window')
  if category in {'host-runtime-symlink','retired-owner'}:
   need(path.split('/')[0]!=dest.split('/')[0],'capture-fresh-writer-family-required')
  changes.append({'beforePath':path,'closedPath':dest,'field':'mtime_ns','category':category,'before':a['mtime_ns'],'closed':b['mtime_ns'],'window':selected_window})
 need(continuity_hardlink_classes(old,rename)==continuity_hardlink_classes(new,{p:p for p in new}),'capture-hardlink-equivalence-changed')
 # Compare the full source+mapped-capture partition, including boundary copies.
 need(continuity_source_capture_partition(matched,False)==continuity_source_capture_partition(matched,True),'capture-source-capture-partition-changed')
 need(writer_sources==CONTINUITY_WRITER_SOURCES,'capture-authenticated-writer-sources-required')
 prior=previous['closedSha256'] if previous else None
 return {'format':1,'kind':'closed-9.8-retired-recapture-closure','beforeSha256':continuity_digest(before),'closedSha256':continuity_digest(closed),
  'ordinaryWindow':ordinary,'predecessorClosedSha256':prior,'writerSources':continuity_copied(writer_sources),
  'canonicalReports':continuity_copied(reports),'namespaceMapping':{n:{'current':v['current'],'sourceDirectory':v['original']['sourceDirectory'],'canonicalReportSha256':v['canonicalReportSha256']} for n,v in sorted(matched.items())},
  'timestampChanges':changes,'pathMappingSha256':continuity_digest(rename),'hardlinkClassesSha256':continuity_digest(continuity_hardlink_classes(new,{p:p for p in new})),
  'unchangedFamilies':sorted({p.split('/')[0] for p in old if p!='.'}-set(changed)),
  'baselineInventorySha256':continuity_digest(old),'beforeLiveInventorySha256':continuity_digest(before['inventory']['live']),'closedLiveInventorySha256':continuity_digest(new),
  'baselineClassificationSha256':continuity_digest(before['classification']['baseline']),'beforeLiveClassificationSha256':continuity_digest(before['classification']['live']),'closedLiveClassificationSha256':continuity_digest(closed['classification']['live'])}


def continuity_capture_subtree(source_manifest, prefix):
    """Restrict the authenticated whole-manifest link partition to this subtree."""
    fail = 'startup-proof-capture-manifest-link-partition-changed'
    inventory, groups, selected_groups = {}, {}, {}
    for name, row in source_manifest.items():
        if row.get('kind') == 'file':
            group = row.get('hardlink_group', name)
            need(type(group) is str, fail)
            groups.setdefault(group, []).append(name)
        if name == prefix or name.startswith(prefix+'/'):
            relative = '.' if name == prefix else name[len(prefix)+1:]
            copied = dict(row)
            copied.pop('hardlink_group', None)
            inventory[relative] = copied
            if row.get('kind') == 'file':
                selected_groups.setdefault(row.get('hardlink_group', name), []).append(relative)
    for group, selected in selected_groups.items():
        members = groups[group]
        need(group == min(members) and all(
            source_manifest[name].get('hardlink_group') == group if len(members) > 1
            else 'hardlink_group' not in source_manifest[name] for name in members), fail)
        if len(selected) > 1:
            representative = min(selected)
            for relative in selected:
                inventory[relative]['hardlink_group'] = representative
    return inventory

def capture_continuity_summary(evidence, plan, candidate, epoch, attempt, window, previous, source_manifest, folder, scenario, document, runtime):
    """Recompute complete raw closure; authenticated producer capability is checked by the caller."""
    fail = 'startup-proof-authentic-retired-capture-continuity-required'
    need(type(evidence) is dict and set(evidence) == {'before','closed','proof','beforeSha256','closedSha256','proofSha256'}, fail)
    expected = {'format','kind','phase','candidateId','attempt','workspaceEpoch','selectedRelative',
                'physicalRoots','classification','inventory','classificationSha256','inventorySha256','stagingCount'}
    for phase in ('before','closed'):
        value = evidence[phase]
        need(type(value) is dict and set(value) == expected and type(value['format']) is int and value['format'] == 1
             and value['kind'] == 'closed-9.8-retired-capture-state' and value['phase'] == phase
             and value['candidateId'] == candidate and value['workspaceEpoch'] == epoch
             and type(value['attempt']) is int and value['attempt'] == attempt
             and value['selectedRelative'] == plan['selectedRelative']
             and type(value['stagingCount']) is int and value['stagingCount'] == 0
             and continuity_digest(value) == evidence[phase+'Sha256'], fail)
        continuity_validate_state(value)
        raw = document(scenario+'/capture-'+phase, {'path':str(folder/('capture-'+phase+'.json')), 'sha256':evidence[phase+'Sha256']})
        need(continuity_encoded(raw) == continuity_encoded(value), fail)
    before, closed, proof = (evidence[k] for k in ('before','closed','proof'))
    need(type(proof) is dict and continuity_digest(proof) == evidence['proofSha256']
         and len(continuity_encoded(proof)) <= 4*1024**2, fail)
    raw = document(scenario+'/capture-continuity', {'path':str(folder/'capture-continuity.json'), 'sha256':evidence['proofSha256']})
    need(continuity_encoded(raw) == continuity_encoded(proof), fail)
    roots = before['physicalRoots']
    need(roots[0] == plan['baselineRootIdentity'][:5] and roots[1][0] == plan['fixtureStorageAuthority']['device'], fail)
    prefix = str(PurePosixPath(plan['selectedRelative'])/'openclaw-runtime/state/tmp/plugin-captures')
    inventory = continuity_capture_subtree(source_manifest, prefix)
    classification = []
    for name, row in inventory.items():
        if re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/owner[.]sqlite', name):
            need(row.get('kind') == 'file' and not any(name+s in inventory for s in ('-journal','-wal','-shm')), fail)
            classification.append(prefix+'/'+name)
    classification.sort()
    need(before['inventory']['baseline'] == inventory and before['classification']['baseline'] == classification, fail)
    need((attempt == 1) == (previous is None), fail)
    if previous is not None:
        prior = previous['closed']
        need(roots[0] == prior['physicalRoots'][0] and before['workspaceEpoch'] == prior['workspaceEpoch']
             and before['selectedRelative'] == prior['selectedRelative'], fail)
        if attempt == 3:
            need(prior['attempt'] == 2 and roots[1][:2] != prior['physicalRoots'][1][:2], fail)
    predecessor = previous if attempt == 2 else None
    continuity_prestart(before, predecessor)
    reports = proof.get('canonicalReports')
    need(type(reports) is list and 0 < len(reports) <= 8, fail)
    report_keys = {'format','kind','packageRoot','workspaceRoots','originalSourceAdmissions','currentSourceAdmissions',
                   'provedNamespaceMapping','canonicalReturnedTrue','ordinaryWindow','evaluatedWindow','windowSource','predecessorClosedSha256'}
    report_summaries = []
    for report in reports:
        need(type(report) is dict and set(report) == report_keys and type(report['format']) is int and report['format'] == 1
             and report['kind'] == 'canonical-retired-capture-admissions' and report['canonicalReturnedTrue'] is True
             and report['ordinaryWindow'] == window and len(continuity_encoded(report)) <= 4*1024**2, fail)
        need(report['workspaceRoots'] == ['/qualification/recovery/workspace','/var/lib/nova/workspace','/var/lib/nova/workspace',plan['selectedRelative']], fail)
        package = PurePosixPath(report['packageRoot'])
        projects = PurePosixPath('/var/lib/nova/workspace')/plan['selectedRelative']/'openclaw-runtime/state/npm/projects'
        need(package.is_relative_to(projects) and str(package) == report['packageRoot']
             and len(package.relative_to(projects).parts) == 4 and '..' not in package.parts
             and package.relative_to(projects).parts[1:] == ('node_modules','@openclaw','codex'), fail)
        need(all(type(report[k]) is dict and set(report[k]) == {str(package)+'\0'} for k in ('originalSourceAdmissions','currentSourceAdmissions')), fail)
        evaluated = continuity_exact_window(report['evaluatedWindow'])
        if report['windowSource'] == 'current-startup':
            need(evaluated == window and report['predecessorClosedSha256'] is None, fail)
        else:
            need(report['windowSource'] == 'exact-preceding-closed-state' and predecessor is not None
                 and report['predecessorClosedSha256'] == predecessor['closedSha256']
                 and all(closed[k] == predecessor['closed'][k] for k in ('inventory','classification','physicalRoots'))
                 and evaluated[1] <= window[0], fail)
            matches = [r for r in predecessor['proof']['canonicalReports'] if all(r[k] == report[k]
                       for k in ('packageRoot','workspaceRoots','originalSourceAdmissions','currentSourceAdmissions','provedNamespaceMapping'))]
            need(len(matches) == 1 and matches[0]['evaluatedWindow'] == evaluated, fail)
        report_summaries.append({'sha256':continuity_digest(report),'packageRootSha256':continuity_digest(report['packageRoot']),
            'originalSourceAdmissionsSha256':continuity_digest(report['originalSourceAdmissions']),
            'currentSourceAdmissionsSha256':continuity_digest(report['currentSourceAdmissions']),
            'namespaceMappingSha256':continuity_digest(report['provedNamespaceMapping']),
            'windowSource':report['windowSource'],'evaluatedWindow':evaluated,'predecessorClosedSha256':report['predecessorClosedSha256']})
    derived = continuity_closure(before,closed,reports,window,runtime,CAPTURE_TOKEN,CONTINUITY_WRITER_SOURCES,predecessor)
    need(continuity_encoded(proof) == continuity_encoded(derived), 'startup-proof-complete-retired-recapture-closure-changed')
    keys = ('baselineInventorySha256','beforeLiveInventorySha256','closedLiveInventorySha256',
            'baselineClassificationSha256','beforeLiveClassificationSha256','closedLiveClassificationSha256',
            'pathMappingSha256','hardlinkClassesSha256','predecessorClosedSha256')
    return {'kind':'closed-9.8-retired-capture-continuity','beforeSha256':evidence['beforeSha256'],
        'closedSha256':evidence['closedSha256'],'proofSha256':evidence['proofSha256'],
        'selectedRelative':before['selectedRelative'],'workspaceEpoch':epoch,'candidateId':candidate,'attempt':attempt,
        'physicalRoots':roots,'ordinaryWindow':list(window),'stagingCount':0,
        **{key:derived[key] for key in keys},'writerSourcesSha256':continuity_digest(derived['writerSources']),
        'canonicalReportsSha256':continuity_digest(reports),'namespaceMappingSha256':continuity_digest(derived['namespaceMapping']),
        'timestampChangesSha256':continuity_digest(derived['timestampChanges']),'canonicalReports':report_summaries}


def capture_observation_summary(evidence, plan, candidate, epoch, attempt, first, source_manifest, folder, scenario, document):
    """Consume raw no-staging records; absence of a retirement receipt proves nothing."""
    fail = 'startup-proof-authentic-no-staging-capture-observation-required'
    need(type(evidence) is dict and set(evidence) == {'before', 'closed', 'beforeSha256', 'closedSha256'}, fail)
    expected = {'format', 'kind', 'phase', 'candidateId', 'attempt', 'workspaceEpoch', 'selectedRelative',
                'physicalRoots', 'classification', 'inventory', 'classificationSha256', 'inventorySha256', 'stagingCount'}
    records = []
    for phase in ('before', 'closed'):
        value = evidence[phase]
        need(type(value) is dict and set(value) == expected
             and type(value['format']) is int and value['format'] == 1
             and value['kind'] == 'closed-9.8-no-staging-capture-observation' and value['phase'] == phase
             and value['candidateId'] == candidate and value['workspaceEpoch'] == epoch
             and type(value['attempt']) is int and value['attempt'] == attempt
             and value['selectedRelative'] == plan['selectedRelative']
             and type(value['stagingCount']) is int and value['stagingCount'] == 0
             and sha(encoded(value)) == evidence[phase + 'Sha256'], fail)
        raw = document(scenario + '/capture-' + phase, {'path': str(folder / ('capture-' + phase + '.json')),
                                                       'sha256': evidence[phase + 'Sha256']})
        need(raw == value, fail)
        records.append(value)
    before, closed = records
    need({k: v for k, v in before.items() if k != 'phase'} == {k: v for k, v in closed.items() if k != 'phase'}, fail)
    roots = before['physicalRoots']
    need(type(roots) is list and len(roots) == 2
         and all(type(row) is list and len(row) == 5 and all(type(v) is int and 0 <= v <= 2**53-1 for v in row)
                 and row[0] > 0 and row[1] > 0 and stat.S_ISDIR(row[2]) and row[3:] == [999, 986] for row in roots)
         and roots[0] == plan['baselineRootIdentity'][:5]
         and roots[1][0] == plan['fixtureStorageAuthority']['device'] and roots[0][:2] != roots[1][:2], fail)
    prefix = str(PurePosixPath(plan['selectedRelative']) / 'openclaw-runtime/state/tmp/plugin-captures')
    inventory = {}
    for name, row in source_manifest.items():
        if name == prefix or name.startswith(prefix + '/'):
            relative = '.' if name == prefix else name[len(prefix) + 1:]
            copied = dict(row)
            if 'hardlink_group' in copied:
                need(copied['hardlink_group'].startswith(prefix + '/'), fail)
                copied['hardlink_group'] = copied['hardlink_group'][len(prefix) + 1:]
            inventory[relative] = copied
    classification = []
    for name, row in inventory.items():
        if re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/owner[.]sqlite', name):
            need(row.get('kind') == 'file' and not any(name + suffix in inventory for suffix in ('-journal', '-wal', '-shm')), fail)
            classification.append(prefix + '/' + name)
    classification.sort()
    need(before['classification'] == {'baseline': classification, 'live': classification}
         and before['inventory'] == {'baseline': inventory, 'live': inventory}
         and before['classificationSha256'] == sha(encoded(before['classification']))
         and before['inventorySha256'] == sha(encoded(before['inventory'])), fail)
    if first is not None:
        need(before['selectedRelative'] == first['selectedRelative'] and before['workspaceEpoch'] == first['workspaceEpoch']
             and before['classificationSha256'] == first['classificationSha256'] and before['inventorySha256'] == first['inventorySha256']
             and roots[0] == first['physicalRoots'][0]
             and (attempt != 2 or roots[1] == first['physicalRoots'][1])
             and (attempt != 3 or roots[1][:2] != first['physicalRoots'][1][:2]), fail)
    return {'kind': 'closed-9.8-no-staging-captures', 'beforeSha256': evidence['beforeSha256'],
            'closedSha256': evidence['closedSha256'], 'classificationSha256': before['classificationSha256'],
            'inventorySha256': before['inventorySha256'], 'selectedRelative': before['selectedRelative'],
            'workspaceEpoch': epoch, 'candidateId': candidate, 'attempt': attempt, 'physicalRoots': roots,
            'stagingCount': 0, 'unchanged': True}


def capture_receipt_sha(value):
    # The hosted writer serializes protected receipts with these options and no final newline.
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def capture_manifest_families(manifest, prefix):
    need(type(manifest) is dict, 'startup-proof-original-capture-manifest-required')
    result = {}
    for path, row in manifest.items():
        if (path.startswith(prefix) and re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/owner[.]sqlite', path[len(prefix):])
                and row.get('kind') == 'file' and row.get('size') == 0 and row.get('sha256') == CAPTURE_EMPTY
                and path + '-journal' in manifest):
            result[path] = {'owner':row,'journal':manifest[path+'-journal'],
                            'parent':manifest.get(str(PurePosixPath(path).parent)),
                            'captures':manifest.get(str(PurePosixPath(path).parent/'captures'))}
    return result


def capture_manifest_family(source, family):
    fail = 'startup-proof-original-capture-manifest-required'
    for name, size in (('owner',0),('journal',512)):
        row, observed = family[name], source[name]
        need(type(row) is dict and row.get('kind') == 'file' and row.get('size') == size
             and row.get('mode') == 0o600 and not row.get('xattrs')
             and type(row.get('sha256')) is str and HASH.fullmatch(row['sha256'])
             and observed[2:5] == [stat.S_IFREG | row['mode'],row['uid'],row['gid']]
             and observed[5:8] == [1,size,row['mtime_ns']], fail)
    parent = family['parent']
    need(type(parent) is dict and parent.get('kind') == 'directory'
         and source['coverage'][0] == {key:parent[key] for key in ('uid','gid','mode','xattrs')}
         and source['coverage'][1] == family['owner']['xattrs']
         and source['captures'] == family['captures'], fail)



def capture_lifecycle_restart(row, done, source, prior, window, physical_device):
    fail = 'startup-proof-authentic-closed-capture-lifecycle-required'
    carry, live, after = row['carry'], row['liveBefore'], done['after']
    need(type(carry) is dict and capture_receipt_sha(carry) == prior['proofSha256']
         and carry['source'] == source and carry['after'] == live
         and done['firstWindow'] == carry['firstWindow'] == prior['firstWindow'], fail)
    predecessor = prior['proofSha256']
    if set(done) == {'source', 'after', 'firstWindow'}:
        need(done == carry and after == live and after is not None
             and [str(value) for value in after['owner'][:2]] == prior['physicalOwner'], fail)
        return {'physicalOwner':prior['physicalOwner'], 'state':'retired', 'reaped':False,
                'remainingNamespaces':None, 'remainingCount':None, 'remainingSha256':None,
                'sourceAdmissionsSha256':None, 'predecessorProofSha256':predecessor, 'lastWindow':window}
    need(set(done) == {'source','after','firstWindow','lastWindow','remaining','sourceAdmissionsSha256'}
         and done['lastWindow'] == window and done['firstWindow'][1] <= window[0]
         and type(done['sourceAdmissionsSha256']) is str and HASH.fullmatch(done['sourceAdmissionsSha256']), fail)
    remaining = done['remaining']
    need(type(remaining) is list and len(remaining) <= 16
         and all(type(name) is str and re.fullmatch(r'admission-[A-Za-z0-9]{6}', name) for name in remaining)
         and remaining == sorted(set(remaining)) and (after is None) == (not remaining), fail)
    old_remaining = prior.get('remainingNamespaces')
    if old_remaining is not None:
        need(set(remaining) <= set(old_remaining) and done['sourceAdmissionsSha256'] == prior['sourceAdmissionsSha256'], fail)
    if live is None:
        need(prior['physicalOwner'] is None and old_remaining == [] and after is None, fail)
    else:
        need([str(value) for value in live['owner'][:2]] == prior['physicalOwner']
             and live['journal'] is None and live['hashes'] == [CAPTURE_TOKEN,None]
             and live['owner'][5:7] == [1,4096], fail)
    physical = None
    if after is not None:
        need(after['owner'][0] == physical_device and after['owner'][:6] == live['owner'][:6]
             and after['parent'][:5] == live['parent'][:5] and after['journal'] is None
             and after['hashes'] == [CAPTURE_TOKEN,None] and after['owner'][5:7] == [1,4096]
             and after['coverage'][:2] == source['coverage'][:2]
             and (after['captures'] is None or after['captures'] == source['captures']), fail)
        physical = [str(value) for value in after['owner'][:2]]
    return {'physicalOwner':physical, 'state':'reaped' if after is None else 'partially-reaped',
            'reaped':after is None, 'remainingNamespaces':remaining, 'remainingCount':len(remaining),
            'remainingSha256':capture_receipt_sha(remaining), 'sourceAdmissionsSha256':done['sourceAdmissionsSha256'],
            'predecessorProofSha256':predecessor, 'lastWindow':window}



def capture_retirement_summary(evidence, plan, lease, candidate, epoch, attempt, window, first, reaping=False, source_manifest=None):
    fail = 'startup-proof-authentic-closed-capture-retirement-required'
    need(type(evidence) is dict and set(evidence) == {'before', 'closed', 'beforeSha256', 'closedSha256'}, fail)
    pre, closed = evidence['before'], evidence['closed']
    need(capture_receipt_sha(pre) == evidence['beforeSha256'] == closed['beforeSha256']
         and capture_receipt_sha(closed) == evidence['closedSha256'] and closed['closedWindow'] == window
         and pre['physicalRoots'] == closed['physicalRoots'] and len(pre['physicalRoots']) == 2
         and pre['physicalRoots'][0][:2] != pre['physicalRoots'][1][:2]
         and all([d['format'], d['jobId'], d['candidateId'], d['attempt'], d['epoch']] ==
                 [1, lease, candidate, attempt, epoch] for d in (pre, closed))
         and type(pre['observedAtNs']) is int and window[0]-60 <= pre['observedAtNs']//10**9 <= window[0], fail)
    prefix = str(PurePosixPath(plan['selectedRelative']) / 'openclaw-runtime/state/tmp/plugin-captures') + '/'
    families = {key: value for key, value in plan['baselineFamilies'].items() if key.startswith(prefix)
                and re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/owner\.sqlite', key[len(prefix):])
                and set(value) == {'', '-journal'} and value[''][0][6] == 0 and value[''][1] == CAPTURE_EMPTY
                and value['-journal'][0][6] == 512}
    if reaping:
        need(pre['physicalRoots'][0] == plan['baselineRootIdentity'][:5], 'startup-proof-original-capture-root-binding')
        families = capture_manifest_families(source_manifest, prefix)
    need(families and set(pre['roles']) == set(closed['retired']) == set(families), fail)
    result = []
    prior_roles = {row['roleSha256']: row for row in first} if first else {}
    for path, family in sorted(families.items()):
        row = pre['roles'][path]
        done = closed['retired'][path]
        source, live, after = row['source'], row['liveBefore'], done['after']
        role = hashlib.sha256(path.encode()).hexdigest()
        if reaping:
            capture_manifest_family(source, family)
            header = family['journal']['sha256']
        else:
            header = family['-journal'][1]
            need(source['owner'][2:5] == family[''][0][2:5] and source['journal'][2:5] == family['-journal'][0][2:5], fail)
        need(done['source'] == source and source['hashes'] == [CAPTURE_EMPTY, header]
             and source['owner'][5:7] == [1, 0] and source['journal'][5:7] == [1, 512]
             and source['owner'][0] == pre['physicalRoots'][0][0]
             and len(source['coverage']) == 3 and HASH.fullmatch(source['coverage'][2]), fail)
        if reaping and attempt == 2:
            need(role in prior_roles, fail)
            extra = capture_lifecycle_restart(row, done, source, prior_roles[role], window, pre['physicalRoots'][1][0])
            result.append({'roleSha256':role,'headerSha256':source['hashes'][1],'contextSha256':source['coverage'][2],
                           'proofSha256':capture_receipt_sha(done),'firstWindow':done['firstWindow'],**extra})
            continue
        if reaping:
            need(set(done) == {'source','after','firstWindow'}, fail)
        need(after['owner'][0] == pre['physicalRoots'][1][0]
             and after['journal'] is None and after['hashes'] == [CAPTURE_TOKEN, None] and after['owner'][5:7] == [1, 4096]
             and after['coverage'] == source['coverage'] and len(source['coverage']) == 3 and HASH.fullmatch(source['coverage'][2])
             and (after['captures'] is None or after['captures'] == source['captures']), fail)
        proof_hash = capture_receipt_sha(done)
        physical = [str(value) for value in after['owner'][:2]]
        if attempt == 2:
            need(role in prior_roles and row['carry'] == done and live == after
                 and proof_hash == prior_roles[role]['proofSha256'] and physical == prior_roles[role]['physicalOwner']
                 and done['firstWindow'] == prior_roles[role]['firstWindow'], fail)
        else:
            need(row['carry'] is None and done['firstWindow'] == window and live['hashes'] == source['hashes']
                 and live['coverage'] == source['coverage'] and live['captures'] == source['captures']
                 and live['owner'][:6] == after['owner'][:6] and live['parent'][:5] == after['parent'][:5]
                 and all(window[0]*10**9 <= stamp <= window[1]*10**9 for stamp in after['owner'][7:]), fail)
            if attempt == 3:
                need(role in prior_roles and prior_roles[role]['physicalOwner'] != physical, fail)
        result.append({'roleSha256': role, 'headerSha256': source['hashes'][1], 'contextSha256': source['coverage'][2],
                       'physicalOwner': physical, 'proofSha256': proof_hash, 'firstWindow': done['firstWindow'],
                       **({'state':'retired','reaped':False,'remainingNamespaces':None,'remainingCount':None,
                           'remainingSha256':None,'sourceAdmissionsSha256':None,'predecessorProofSha256':None,
                           'lastWindow':window} if reaping else {})})
    if first:
        need(set(prior_roles) == {row['roleSha256'] for row in result}, fail)
        for row in result:
            original = prior_roles[row['roleSha256']]
            need(original['headerSha256'] == row['headerSha256'] and original['contextSha256'] == row['contextSha256'], fail)
    return {'kind': 'closed-9.8-capture-lifecycle' if reaping else 'closed-9.8-capture-retirement', 'beforeSha256': evidence['beforeSha256'],
            'closedSha256': evidence['closedSha256'], 'roles': result}


CAPTURE_PRODUCER = 'bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58'
CAPTURE_REAPING_PRODUCER = '7ca0aa07ead0d6d6672352a59a520cd93e42295993cd36064994bfb701cfe6eb'
CAPTURE_REAPING_PRODUCERS = frozenset({CAPTURE_REAPING_PRODUCER, '479a10e7303411aaf5e76a08d857747798cf6a65362fdd75a2808d7f2a585294', '4e1f6d0aaa729b5df938bb0566e7442be6abf9bfc832c0b5ab1cfcd1746b7dd3', '352ce2f79419c0722e902a15df639a04b7854d87d3bab6ed7d79484148da6db9',
    '4404a1c0a7658c206b49d6daa64e4f7c1c0bf8ffa905ce19a4015312c823d599',
    'f1004fc0fafec1669c5bd4822cf27925d64e861b0bb74301a033a431becccc10',
    'f8de414f4822707675dbe0fca150ad0dd917202579bacd8432a6115c4a218a28',
    '82794c1b913e241bd881d8c89dac4871c2c4b5ae70c12f362754f9fcc60cc9fb'})
CAPTURE_PRODUCERS = frozenset({CAPTURE_PRODUCER, *CAPTURE_REAPING_PRODUCERS})

REPLICA_OBSERVATION_PRODUCERS = frozenset({
    *CAPTURE_PRODUCERS,
    '3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af',
    '0a45ca346ec848ec8b17a0f1dcab43314ae344b12b5f8a0144f518d05144f3f5',
    '9a30fd20d3a8321d763abba55dfc9ba55818d27984b1aa0337f3a17c0607554b',
})


def validate_replica_observation_receipt(proof, plan, startup_start):
    need(isinstance(proof, dict) and set(proof) == {'kind', 'sourceDevice', 'replicaDevice', 'observations', 'queueExpiry'}
            and proof['kind'] == 'closed-selected-replica-config-observation'
            and proof['sourceDevice'] == plan['baselineRootIdentity'][0]
            and proof['replicaDevice'] == plan['fixtureStorageAuthority']['device']
            and isinstance(proof['observations'], list) and len(proof['observations']) == 1,
            'Original selected replica observation proof is required.')
    entry, queue = proof['observations'][0], proof['queueExpiry']
    need(type(queue) is dict and set(queue) == {'ordinaryAcknowledgements', 'authenticatedStartSeconds', 'retentionDays'}
            and queue['retentionDays'] == 30 and queue['authenticatedStartSeconds'] == startup_start
            and type(queue['ordinaryAcknowledgements']) is int and 0 <= queue['ordinaryAcknowledgements'] <= 1000000,
            'Original selected queue expiry accounting is required.')
    if entry.get('mode') == 'proved-independent-filesystems':
        need(proof['sourceDevice'] != proof['replicaDevice'] and entry.get('changedFields') == ['dev']
                and set(entry) == {'mode', 'changedFields', 'configurationHashes', 'configurationBytes', 'observationWriterHashes'}
                and isinstance(entry['configurationHashes'], list) and len(entry['configurationHashes']) == 2
                and all(type(h) is str and re.fullmatch('[0-9a-f]{64}', h) for h in entry['configurationHashes'])
                and isinstance(entry['configurationBytes'], list) and len(entry['configurationBytes']) == 2
                and all(type(n) is int and 0 < n <= 4 * 1024 * 1024 for n in entry['configurationBytes'])
                and entry['observationWriterHashes'] == {
                    'io.factory-DBfPTl1R.mjs': 'c0cb4b39847898580ac68ca0154498838bf32f028cd4ccfbfbd894e373e50056',
                    'io.warnings-AdNkx0te.mjs': '836fb6dcdfb3057f581d91e74d791e1c310188dca20815814c12e89d5ec20ab0'},
                'The independently proved observation writer, files or storage changed.')
    else:
        need(entry == {'mode': 'unchanged-original-record', 'changedFields': []}
                or proof['sourceDevice'] == proof['replicaDevice'] and entry == {'mode': 'same-filesystem-original-equality', 'changedFields': []},
                'An unqualified configuration observation projection was requested.')


def invoke(request, sources, same_schema_helpers=None):
    need(os.name == 'posix' and os.geteuid() == 0, 'root-linux-readonly-startup-proof-required')
    reader = ProtectedReader()
    result = consume(request, reader, sources, same_schema_helpers)
    worker_closed(result['workerIdentity'])
    reader.unchanged()
    result['workerClosed'] = True
    result['observedAtMilliseconds'] = time.time_ns() // 1000000
    need(len(encoded(result)) <= 500 * 1024, 'startup-proof-summary-bound')
    return result

TRANSITION_CORE_SHA256='26477f1c0610d753194929d10dc910395eaa99aaa9f25513cfa1028b68943d93'
TRANSITION_FAMILY=r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
TRANSITION_NS=TRANSITION_FAMILY+r'/native/admission-[A-Za-z0-9]{6}'
TRANSITION_RETIRED='f9b7a02201bbcec6133d5d043ba09d189aec76517b4db7e337696cd16d40db9b'

def transition_need(v,r):
 if not v:raise RuntimeError(r)
def transition_encoded(v):return (json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'\n').encode()
def transition_digest(v):return hashlib.sha256(transition_encoded(v)).hexdigest()
def transition_without_group(v):return {k:x for k,x in v.items() if k!='hardlink_group'}
def transition_window(core,v):return core.exact_window(v)
def transition_intime(n,w):return type(n) is int and w[0]*10**9<=n<=w[1]*10**9

def transition_reference(v):
 transition_need(type(v) is dict and set(v) in ({'path','sha256'},{'path','sha256','bytes'}) and type(v['path']) is str and v['path'] and ('bytes' not in v or type(v['bytes']) is int and 0<v['bytes']<=67108864) and re.fullmatch('[a-f0-9]{64}',v['sha256']),'transition-exact-raw-reference-required')
 return v

def transition_document(v,limit=4194304):
 transition_need(type(v) is dict and set(v)=={'ref','raw'} and type(v['raw']) is str,'transition-raw-document-required')
 ref=transition_reference(v['ref']);raw=v['raw'].encode();transition_need(len(raw)<=limit and ('bytes' not in ref or len(raw)==ref['bytes']) and hashlib.sha256(raw).hexdigest()==ref['sha256'],'transition-raw-document-hash-changed')
 return json.loads(raw)

def transition_validate_state(core,state,authority):
 fields={'format','kind','phase','candidateId','attempt','workspaceEpoch','selectedRelative','physicalRoots','classification','inventory','classificationSha256','inventorySha256','stagingCount'}
 transition_need(type(state) is dict and set(state)==fields and state['format']==1 and state['kind']=='closed-9.8-retired-capture-state'
      and state['phase'] in ('before','closed') and type(state['attempt']) is int and state['attempt'] in (1,2,3) and type(state['stagingCount']) is int and state['stagingCount']==0,'capture-state-contract-changed')
 transition_need(type(state['candidateId']) is str and re.fullmatch('[a-f0-9]{64}',state['candidateId'])
      and type(state['physicalRoots']) is list and len(state['physicalRoots'])==2
      and all(type(row) is list and len(row)==5 and all(type(v) is int and 0<=v<=2**53-1 for v in row)
              and row[0]>0 and row[1]>0 and stat.S_ISDIR(row[2]) and row[3:]==authority['serviceOwner'] for row in state['physicalRoots'])
      and state['physicalRoots'][0][:2]!=state['physicalRoots'][1][:2],'capture-physical-authority-changed')
 transition_need(set(state['inventory'])==set(state['classification'])=={'baseline','live'}
      and state['inventorySha256']==core.digest(state['inventory']) and state['classificationSha256']==core.digest(state['classification']),'capture-state-hashes-changed')
 for role in ('baseline','live'):
  rows=state['inventory'][role];transition_need(type(rows) is dict and 0<len(rows)<=8192 and '.' in rows,'capture-complete-inventory-required')
  for path,row in rows.items():
   core.relative(path);transition_need(type(row) is dict and row.get('kind') in ('file','directory','symlink'),'capture-row-kind-changed')
   transition_need(type(row.get('mtime_ns')) is int and row['mtime_ns']>=0 and type(row.get('xattrs')) is dict,'capture-exact-metadata-required')
  classes=state['classification'][role];prefix=state['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures/'
  owners=sorted(prefix+p for p,row in rows.items() if p.endswith('/owner.sqlite') and p.count('/')==1)
  transition_need(classes==owners,'capture-owner-classification-incomplete')
 return state

def transition_families(rows):
 result={p.split('/')[0] for p in rows if p!='.'}
 transition_need(all(re.fullmatch(TRANSITION_FAMILY,p) for p in result),'transition-family-name-invalid');return result

def transition_semantic(ns):
 return {'sourceDirectory':ns['sourceDirectory'],'managed':ns['managed'],'members':{p:{k:v for k,v in m.items() if k not in ('sourceIdentity','capturedIdentity')} for p,m in ns['members'].items()}}

def transition_source_roster(namespaces):
 result={}
 for ns in namespaces.values():
  for member in ns['members'].values():
   if 'contentHash' not in member:continue
   key=member['source'];identity=tuple(map(int,member['sourceIdentity'].split(':')))
   transition_need(len(identity)==6 and stat.S_ISREG(identity[2]),'transition-source-regular-identity-required')
   stable=(stat.S_IMODE(identity[2]),identity[3],identity[4],member['contentHash'])
   transition_need(result.setdefault(key,stable)==stable,'transition-source-semantic-conflict')
 return result

def transition_family_check(core,rows,family,entry,authority):
 names={p for p in rows if p==family or p.startswith(family+'/')};ns=entry['namespaces'];w=transition_window(core,entry['window'])
 transition_need(ns and all(n.startswith(family+'/native/') and re.fullmatch(TRANSITION_NS,n) for n in ns),'transition-family-namespaces-invalid')
 transition_need(entry['kind'] in ('canonical','archived-native-receipt','historical-template'),'transition-family-origin-kind-invalid')
 expected={family,family+'/native',family+'/owner.sqlite'};members={}
 for name,t in ns.items():
  expected.update((name,name+'/node_modules',name+'/node_modules/openclaw'))
  for rel,m in t['members'].items():
   p=name+'/content'+('/'+rel if rel else '');expected.add(p);members[p]=m;row=rows.get(p)
   transition_need(row is not None,'transition-family-member-missing')
   src=tuple(map(int,m['sourceIdentity'].split(':')));capt=tuple(map(int,m['capturedIdentity'].split(':')))
   transition_need(row['mode']==stat.S_IMODE(capt[2]),'transition-family-member-mode-changed')
   if entry['kind']!='historical-template':transition_need(row['mtime_ns']==capt[4],'transition-exact-captured-metadata-changed')
   if 'contentHash' in m:
    transition_need(row['kind']=='file' and row['size']==m['sizeBytes'] and row['sha256']==m['contentHash'],'transition-family-content-changed')
    if m['boundaryChecked']:
     transition_need(row['mode']==(0o600|(src[2]&0o100)) and transition_intime(row['mtime_ns'],w),'transition-copied-boundary-policy-changed')
    else:transition_need(row['mtime_ns']==src[4],'transition-stable-member-time-changed')
   else:transition_need(row['kind']=='directory' and transition_intime(row['mtime_ns'],w),'transition-directory-time-unproved')
  link=rows.get(name+'/node_modules/openclaw')
  transition_need(link and link['kind']=='symlink' and link['mode']==0o777 and link['target']==authority['runtime'],'transition-runtime-link-changed')
 transition_need(names==expected,'transition-family-roster-not-complete')
 owner=rows[family+'/owner.sqlite']
 transition_need(owner['kind']=='file' and owner['size']==4096 and owner['sha256']==TRANSITION_RETIRED and owner['mode'] in (0o600,0o644) and 'hardlink_group' not in owner,'transition-retired-owner-invalid')
 for p in names:
  row=rows[p];transition_need([row['uid'],row['gid']]==authority['serviceOwner'] and row['xattrs']=={},'transition-protection-changed')
  if row['kind']=='directory':transition_need(row['mode']==0o700,'transition-private-ancestry-required')
  m=members.get(p)
  if m is None or row['kind']=='directory' or m.get('boundaryChecked'):transition_need(transition_intime(row['mtime_ns'],w),'transition-writer-time-outside-origin')
 return members

def transition_initial_ledger(core,baseline,namespaces,origins,first_window,baseline_kind,authority):
 transition_need(set(origins)=={'format','parent','baselineManifest','workspaceEpoch','selectedRelative','candidateId','windows'} and origins['format']==1,'transition-baseline-origin-contract')
 transition_reference(origins['parent']);transition_reference(origins['baselineManifest'])
 transition_need(origins['parent']==authority['baselineParent'] and origins['candidateId']==authority['baselineCandidateId'],'transition-exact-archived-baseline-authority-required')
 transition_need(set(origins['windows'])=={'target-first-start','target-restart'},'transition-two-historical-windows-required')
 windows={}
 for name,origin in origins['windows'].items():
  transition_need(set(origin)=={'window','references'} and set(origin['references'])=={'started','process','ready','closed'},'transition-historical-receipt-roster-changed')
  w=transition_window(core,origin['window']);transition_need(w[1]<first_window[0],'transition-historical-window-not-prior')
  for ref in origin['references'].values():transition_reference(ref)
  transition_need(len({ref['sha256'] for ref in origin['references'].values()})==4,'transition-distinct-historical-receipts-required');windows[name]=w
 transition_need(windows['target-first-start'][1]<windows['target-restart'][0],'transition-historical-window-order-changed')
 active={p.split('/')[0] for p in namespaces};transition_need(len(active)==1,'transition-one-baseline-active-family-required')
 active=next(iter(active));all_families=transition_families(baseline);transition_need(0<len(all_families)<=16,'transition-baseline-family-bound')
 result={}
 for family in sorted(all_families):
  compatible=[]
  for window_name,w in windows.items():
   if family==active:ns=copy.deepcopy(namespaces);kind=baseline_kind
   else:
    ns={};seen=set();okay=True
    for name in sorted(p for p in baseline if re.fullmatch(TRANSITION_NS,p) and p.startswith(family+'/')):
     candidates=[]
     for source,t in namespaces.items():
      prefix=name+'/content';actual={p[len(prefix):].lstrip('/'):r for p,r in baseline.items() if p==prefix or p.startswith(prefix+'/')}
      if set(actual)!=set(t['members']):continue
      matches=True
      for rel,row in actual.items():
       m=t['members'][rel];src=tuple(map(int,m['sourceIdentity'].split(':')));cap=tuple(map(int,m['capturedIdentity'].split(':')))
       matches=matches and row['mode']==stat.S_IMODE(cap[2])
       if 'contentHash' in m:matches=matches and row['kind']=='file' and row['size']==m['sizeBytes'] and row['sha256']==m['contentHash'] and (transition_intime(row['mtime_ns'],w) if m['boundaryChecked'] else row['mtime_ns']==src[4])
       else:matches=matches and row['kind']=='directory' and transition_intime(row['mtime_ns'],w)
      if matches:candidates.append(source)
     if len(candidates)!=1 or candidates[0] in seen:okay=False;break
     seen.add(candidates[0]);ns[name]=copy.deepcopy(namespaces[candidates[0]])
    if not okay or seen!=set(namespaces):continue
    kind='historical-template'
   entry={'kind':kind,'window':w,'namespaces':ns,'origin':{'kind':'archived-writer-field-window-compatibility','windowName':window_name,'parent':origins['parent'],'references':origins['windows'][window_name]['references'],'creatorAttribution':False},'rowsSha256':transition_digest({p:r for p,r in baseline.items() if p==family or p.startswith(family+'/')})}
   try:transition_family_check(core,baseline,family,entry,authority)
   except RuntimeError:continue
   compatible.append(entry)
  transition_need(len(compatible)==1,'transition-historical-shape-window-not-unique');result[family]=compatible[0]
 return result

def transition_capture_subtree(source_manifest, prefix):
    """Restrict the authenticated whole-manifest link partition to this subtree."""
    fail = 'startup-proof-capture-manifest-link-partition-changed'
    inventory, groups, selected_groups = {}, {}, {}
    for name, row in source_manifest.items():
        if row.get('kind') == 'file':
            group = row.get('hardlink_group', name)
            transition_need(type(group) is str, fail)
            groups.setdefault(group, []).append(name)
        if name == prefix or name.startswith(prefix+'/'):
            relative = '.' if name == prefix else name[len(prefix)+1:]
            copied = dict(row)
            copied.pop('hardlink_group', None)
            inventory[relative] = copied
            if row.get('kind') == 'file':
                selected_groups.setdefault(row.get('hardlink_group', name), []).append(relative)
    for group, selected in selected_groups.items():
        members = groups[group]
        transition_need(group == min(members) and all(
            source_manifest[name].get('hardlink_group') == group if len(members) > 1
            else 'hardlink_group' not in source_manifest[name] for name in members), fail)
        if len(selected) > 1:
            representative = min(selected)
            for relative in selected:
                inventory[relative]['hardlink_group'] = representative
    return inventory

def transition_exact_report_context(core,reports,before,ordinary,previous,authority):
 transition_need(type(reports) is list and len(reports)==1,'transition-canonical-reports-required')
 expected=authority['workspaceRoots'];transition_need(expected[3]==before['selectedRelative'],'transition-selected-root-context-changed')
 for r in reports:
  transition_need(r['workspaceRoots']==expected and r['ordinaryWindow']==ordinary and r['canonicalReturnedTrue'] is True and r['kind']=='canonical-retired-capture-admissions','transition-genuine-canonical-context-required')
  transition_need(set(r['originalSourceAdmissions'])=={r['packageRoot']+'\0'} and set(r['currentSourceAdmissions'])=={r['packageRoot']+'\0'},'transition-canonical-package-key-changed')
  if r['windowSource']=='current-startup':transition_need(r['evaluatedWindow']==ordinary and r['predecessorClosedSha256'] is None,'transition-current-window-changed')
  else:
   transition_need(previous is not None and r['windowSource']=='exact-preceding-closed-state' and r['predecessorClosedSha256']==previous['closedSha256'],'transition-inherited-window-predecessor-missing')
   matches=[p for p in previous['canonicalReports'] if all(p[k]==r[k] for k in ('packageRoot','originalSourceAdmissions','currentSourceAdmissions'))]
   transition_need(len(matches)==1 and r['evaluatedWindow']==matches[0]['evaluatedWindow'] and r['evaluatedWindow'][1]<ordinary[0],'transition-inherited-window-authority-changed')
 logical=authority['workspaceRoots'][2]+'/'+before['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures'
 return core.mappings(reports,logical)

def transition_registry_selection(value,admissions,logical,raw_index):
 transition_need(value['format']==1 and value['kind']=='complete-writer-retained-paths' and value['wholeIndexSha256'] and re.fullmatch('[a-f0-9]{64}',value['wholeIndexSha256']),'transition-whole-index-authority-required')
 transition_need(value['writerRule']=='all-rows/all-receipts:capturedRoot/content UNION capturedPath','transition-writer-selection-rule-changed')
 transition_need(type(raw_index) is dict and type(raw_index.get('plugins')) is list and value['wholeIndexSha256']==transition_digest(raw_index),'transition-raw-whole-index-binding-changed')
 rows=value['registryRows'];transition_need(type(rows) is list and len(rows)==value['registryRowCount'] and len(rows)<=4096 and [r['position'] for r in rows]==list(range(len(rows))),'transition-registry-coverage-incomplete')
 transition_need(len(rows)==len(raw_index['plugins']),'transition-raw-registry-row-count-changed')
 for row,raw_row in zip(rows,raw_index['plugins']):
  transition_need(type(raw_row) is dict and row['pluginId']==raw_row.get('pluginId') and row['sourceAdmissions']==raw_row.get('sourceAdmissions') and ('sourceAdmissions' not in raw_row or type(raw_row['sourceAdmissions']) is dict),'transition-raw-registry-admissions-changed')
 union=set();codex=[]
 for row in rows:
  transition_need(set(row)=={'position','pluginId','sourceAdmissions'},'transition-raw-registry-row-required');raw=row['sourceAdmissions']
  if row['pluginId']=='codex':codex.append(raw)
  if raw is None:continue
  transition_need(type(raw) is dict,'transition-invalid-raw-admissions')
  for receipt in raw.values():
   transition_need(type(receipt) is dict and set(receipt)=={'signature','sourceDigest','nativeNamespaces','nativeArtifacts'},'transition-unclassified-receipt')
   for name,ns in receipt['nativeNamespaces'].items():
    transition_need(name==ns['capturedRoot'],'transition-namespace-root-changed');union.add(name+'/content')
   for item in receipt['nativeArtifacts'].values():union.add(item['capturedPath'])
 transition_need(len(codex)==1 and codex[0]==admissions,'transition-codex-selection-not-canonical')
 transition_need(value['retainedPaths']==sorted(union),'transition-complete-writer-union-changed')
 result=set()
 for name in union:
  p=PurePosixPath(name);transition_need(p.is_absolute() and str(p)==name and '..' not in p.parts,'transition-noncanonical-retained-path')
  if p.is_relative_to(PurePosixPath(logical)):result.add(p.relative_to(PurePosixPath(logical)).as_posix())
 return result

def transition_labeled_partition(labels):
 groups={}
 for label,identity in labels.items():groups.setdefault(tuple(identity),[]).append(label)
 return sorted(sorted(g) for g in groups.values())

def transition_expected_partition(rows,ledger):
 parent={}
 def find(x):
  parent.setdefault(x,x)
  if parent[x]!=x:parent[x]=find(parent[x])
  return parent[x]
 def join(labels):
  first=None
  for x in labels:
   r=find(x)
   if first is None:first=r
   else:parent[r]=find(first)
 for family,entry in ledger.items():
  groups={}
  for name,ns in entry['namespaces'].items():
   for rel,m in ns['members'].items():
    if 'contentHash' not in m:continue
    source='source:'+m['source'];capture='capture:'+name+'/content/'+rel
    sid=tuple(map(int,m['sourceIdentity'].split(':')[:2]));cid=tuple(map(int,m['capturedIdentity'].split(':')[:2]))
    groups.setdefault(sid,[]).append(source)
    if entry['kind'] in ('canonical','archived-native-receipt'):groups.setdefault(cid,[]).append(capture)
    elif m['boundaryChecked']:find(capture)
    else:join([source,capture])
  for labels in groups.values():join(labels)
 for p,r in rows.items():
  if r['kind']=='file':find('capture:'+p)
 groups={}
 for label in parent:groups.setdefault(find(label),[]).append(label)
 return sorted(sorted(v) for v in groups.values())

def transition_measured_partition(core,rows,ledger,physical):
 transition_need(set(physical)=={'sources','captures'},'transition-complete-physical-role-required')
 files={p for p,r in rows.items() if r['kind']=='file'};transition_need(set(physical['captures'])==files,'transition-physical-capture-roster-incomplete')
 ns={n:t for entry in ledger.values() for n,t in entry['namespaces'].items()};roster=transition_source_roster(ns)
 transition_need(set(physical['sources'])==set(roster),'transition-physical-source-roster-incomplete')
 labels={};capture_labels={}
 for p,value in physical['captures'].items():
  transition_need(type(value) is dict and all(type(value.get(k)) is int and value[k]>0 for k in ('device','inode')),'transition-capture-physical-identity-invalid')
  labels['capture:'+p]=(value['device'],value['inode']);capture_labels[p]=labels['capture:'+p]
 transition_need(transition_labeled_partition(capture_labels)==core.hardlink_classes(rows,{p:p for p in rows}),'transition-capture-raw-partition-changed')
 for p,v in physical['sources'].items():
  transition_need(set(v)=={'device','inode','mode','size','mtime_ns','ctime_ns'} and all(type(x) is int and x>=0 for x in v.values()) and v['device']>0 and v['inode']>0,'transition-physical-source-identity-invalid')
  mode,size,mtime,_=roster[p];transition_need(stat.S_ISREG(v['mode']) and stat.S_IMODE(v['mode'])==mode and v['size']==size and v['mtime_ns']==mtime,'transition-source-metadata-authority-changed')
  labels['source:'+p]=(v['device'],v['inode'])
 actual=transition_labeled_partition(labels);expected=transition_expected_partition(rows,ledger)
 transition_need(actual==expected,'transition-full-source-capture-partition-changed')
 return actual

def transition_prove(core,core_sha,packet,authority,previous=None,_depth=0):
 transition_need(core_sha==TRANSITION_CORE_SHA256 and _depth<=1,'transition-reviewed-core-required')
 transition_need(set(authority)=={'baselineParent','baselineCandidateId','workspaceRoots','runtime','serviceOwner'} and type(authority['workspaceRoots']) is list and len(authority['workspaceRoots'])==4 and type(authority['serviceOwner']) is list and len(authority['serviceOwner'])==2 and all(type(v) is int and v>=0 for v in authority['serviceOwner']),'transition-authenticated-context-required')
 transition_reference(authority['baselineParent']);transition_need(re.fullmatch('[a-f0-9]{64}',authority['baselineCandidateId']) and all(PurePosixPath(p).is_absolute() for p in authority['workspaceRoots'][:3]) and PurePosixPath(authority['runtime']).is_absolute(),'transition-context-paths-invalid')
 transition_need(set(packet)=={'before','closed','canonical','selection','physical','origins','baselineManifest','rawIndexes','lifecycle','writerSources'},'transition-input-contract-changed')
 docs={k:transition_document(v,67108864 if k=='baselineManifest' else 4194304) for k,v in packet.items() if k!='writerSources'}
 transition_need(packet['writerSources']==core.WRITER_SOURCES,'transition-writer-sources-changed')
 before,closed=docs['before'],docs['closed'];transition_validate_state(core,before,authority);transition_validate_state(core,closed,authority)
 life=docs['lifecycle'];transition_need(set(life)=={'window','started','closed'} and life['started']!=life['closed'],'transition-ordinary-lifecycle-required')
 transition_reference(life['started']);transition_reference(life['closed']);ordinary=transition_window(core,life['window']);attempt=before['attempt']
 transition_need(before['phase']=='before' and closed['phase']=='closed' and all(before[k]==closed[k] for k in ('candidateId','attempt','workspaceEpoch','selectedRelative','physicalRoots')),'transition-scenario-identity-changed')
 transition_need(before['inventory']['baseline']==closed['inventory']['baseline'] and before['classification']['baseline']==closed['classification']['baseline'],'transition-baseline-mutated')
 prior=None
 if attempt==2:
  transition_need(previous is not None and set(previous)=={'packet','proof'},'transition-restart-predecessor-required')
  prior=transition_prove(core,core_sha,previous['packet'],authority,None,_depth+1);transition_need(transition_document(previous['proof'])==prior,'transition-predecessor-proof-changed')
  pb=transition_document(previous['packet']['before']);pc=transition_document(previous['packet']['closed']);pp=transition_document(previous['packet']['physical']);ps=transition_document(previous['packet']['selection'])
  transition_need(pb['attempt']==1 and ordinary[0]>prior['ordinaryWindow'][1] and all(before[k]==pc[k] for k in ('candidateId','workspaceEpoch','selectedRelative','physicalRoots','inventory','classification')),'transition-restart-exact-prior-closed-required')
  transition_need(docs['origins']==transition_document(previous['packet']['origins']) and docs['physical']['beforeLive']==pp['closedLive'] and docs['selection']['before']==ps['after'],'transition-restart-physical-or-registry-predecessor-changed')
 else:
  transition_need(attempt in (1,3) and previous is None and before['inventory']['baseline']==before['inventory']['live'] and before['classification']['baseline']==before['classification']['live'],'transition-pristine-prestart-required')
 reports=docs['canonical'];unchanged_catalog=reports==[]
 if unchanged_catalog:
  transition_need(before['inventory']==closed['inventory'] and before['classification']==closed['classification'] and docs['physical']['beforeLive']==docs['physical']['closedLive'] and docs['selection']['before']==docs['selection']['after'],'transition-no-callback-requires-exact-whole-state')
  active=[r['sourceAdmissions'] for r in docs['selection']['before']['registryRows'] if r['pluginId']=='codex'];transition_need(len(active)==1,'transition-unchanged-codex-row-required')
  closed_admissions=active[0];baseline_admissions=prior['baselineSourceAdmissions'] if prior else closed_admissions
  baseline_ns=copy.deepcopy(core.namespace_rows(baseline_admissions));current_ns=copy.deepcopy(core.namespace_rows(closed_admissions));matched=None
  # Raw catalog namespaces use absolute paths; all remaining predicates operate on selected relative names.
  logical=authority['workspaceRoots'][2]+'/'+before['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures'
  for group in (baseline_ns,current_ns):transition_need(all(str(PurePosixPath(n).parent.parent.parent)==logical and re.fullmatch(TRANSITION_NS,str(PurePosixPath(n).relative_to(logical))) for n in group),'transition-unchanged-namespace-root-changed')
  baseline_ns={str(PurePosixPath(n).relative_to(logical)):v for n,v in baseline_ns.items()};current_ns={str(PurePosixPath(n).relative_to(logical)):v for n,v in current_ns.items()}
 else:
  matched=transition_exact_report_context(core,reports,before,ordinary,prior,authority)
  baseline_admissions=reports[0]['originalSourceAdmissions'];closed_admissions=reports[0]['currentSourceAdmissions']
  baseline_ns={name:v['original'] for name,v in matched.items()};current_ns={v['current']:v['receipt'] for v in matched.values()}
 transition_need(len({n.split('/')[0] for n in baseline_ns})==len({n.split('/')[0] for n in current_ns})==1,'transition-one-active-family-required')
 if prior:
  transition_need(baseline_admissions==prior['baselineSourceAdmissions'],'transition-common-baseline-admissions-changed')
  prior_current={n:t for e in prior['closedLedger'].values() if e['kind'] in ('canonical','archived-native-receipt') for n,t in e['namespaces'].items()}
  previous_active=prior['closedActiveFamily'];prior_ns={n:t for n,t in prior_current.items() if n.startswith(previous_active+'/')}
  transition_need(len(prior_ns)==len(current_ns),'transition-composed-namespace-count-changed')
  used=set()
  for ns in prior_ns.values():
   matches=[n for n,t in current_ns.items() if transition_semantic(t)==transition_semantic(ns)]
   transition_need(len(matches)==1 and matches[0] not in used,'transition-composed-semantic-join-not-unique');used.add(matches[0])
 baseline=before['inventory']['baseline'];old=before['inventory']['live'];new=closed['inventory']['live']
 transition_need(docs['origins']['baselineManifest']==packet['baselineManifest']['ref'] and docs['origins']['workspaceEpoch']==before['workspaceEpoch'] and docs['origins']['selectedRelative']==before['selectedRelative'],'transition-archived-baseline-join-changed')
 transition_need(transition_capture_subtree(docs['baselineManifest'],before['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures')==baseline,'transition-complete-archived-baseline-projection-changed')
 base_ledger=transition_initial_ledger(core,baseline,baseline_ns,docs['origins'],ordinary,'archived-native-receipt' if unchanged_catalog else 'canonical',authority)
 old_ledger=copy.deepcopy(prior['closedLedger'] if prior else base_ledger)
 transition_need(set(old_ledger)==transition_families(old),'transition-prestart-family-ledger-incomplete')
 for f,e in old_ledger.items():transition_family_check(core,old,f,e,authority)
 physical=docs['physical'];transition_need(set(physical)=={'baseline','beforeLive','closedLive'},'transition-three-physical-roles-required')
 baseline_partition=transition_measured_partition(core,baseline,base_ledger,physical['baseline']);before_partition=transition_measured_partition(core,old,old_ledger,physical['beforeLive'])
 logical=authority['workspaceRoots'][2]+'/'+before['selectedRelative']+'/openclaw-runtime/state/tmp/plugin-captures'
 transition_need(set(docs['selection'])=={'before','after'},'transition-two-writer-selections-required')
 before_admissions=prior['closedSourceAdmissions'] if prior else baseline_admissions
 before_paths=transition_registry_selection(docs['selection']['before'],before_admissions,logical,docs['rawIndexes']['before']);after_paths=transition_registry_selection(docs['selection']['after'],closed_admissions,logical,docs['rawIndexes']['after'])
 removed=transition_families(old)-transition_families(new);created=transition_families(new)-transition_families(old);survived=transition_families(old)&transition_families(new)
 transition_need(len(created)<=1 and len(removed)<=16,'transition-family-change-bound')
 closed_active=next(iter({n.split('/')[0] for n in current_ns}));transition_need(closed_active in transition_families(new),'transition-current-active-family-absent')
 if created:transition_need(created=={closed_active} and all(r['windowSource']=='current-startup' for r in reports),'transition-created-family-current-window-required')
 for f in removed:transition_need(not any(p==f or p.startswith(f+'/') for p in before_paths|after_paths),'transition-referenced-family-removal')
 closed_ledger={}
 for f in survived:
  old_rows={p:r for p,r in old.items() if p==f or p.startswith(f+'/')};new_rows={p:r for p,r in new.items() if p==f or p.startswith(f+'/')}
  transition_need(set(old_rows)==set(new_rows) and all(transition_without_group(old_rows[p])==transition_without_group(new_rows[p]) for p in old_rows),'transition-surviving-family-mutated')
  closed_ledger[f]=copy.deepcopy(old_ledger[f]);closed_ledger[f]['rowsSha256']=transition_digest(new_rows)
 for f in created:
  entry={'kind':'canonical','window':ordinary,'namespaces':copy.deepcopy(current_ns),'origin':{'canonical':packet['canonical']['ref'],'started':life['started'],'closed':life['closed']},'rowsSha256':transition_digest({p:r for p,r in new.items() if p==f or p.startswith(f+'/')})}
  transition_family_check(core,new,f,entry,authority);closed_ledger[f]=entry
 transition_need(set(closed_ledger)==transition_families(new),'transition-closed-family-complement-unproved')
 if not created:
  transition_need(closed_active in closed_ledger and closed_ledger[closed_active]['kind'] in ('canonical','archived-native-receipt') and closed_ledger[closed_active]['namespaces']==current_ns,'transition-existing-active-authority-changed')
 if any(r['windowSource']!='current-startup' for r in reports):transition_need(prior is not None and before['inventory']==closed['inventory'] and before['classification']==closed['classification'] and docs['selection']['before']==docs['selection']['after'] and physical['beforeLive']==physical['closedLive'],'transition-inherited-window-requires-entire-unchanged-state')
 if old==new:transition_need(not removed and not created,'transition-unchanged-family-set-differs')
 else:transition_need((removed or created) and {k:v for k,v in old['.'].items() if k!='mtime_ns'}=={k:v for k,v in new['.'].items() if k!='mtime_ns'} and transition_intime(new['.']['mtime_ns'],ordinary),'transition-root-writer-time-unproved')
 for f,e in closed_ledger.items():transition_family_check(core,new,f,e,authority)
 closed_partition=transition_measured_partition(core,new,closed_ledger,physical['closedLive'])
 if matched is not None:transition_need(core.source_capture_partition(matched,False)==core.source_capture_partition(matched,True),'transition-canonical-source-topology-changed')
 # Complete survivor/source projection remains equal even if group representatives or new family names sort earlier.
 common_labels={'source:'+p for p in physical['beforeLive']['sources']}|{'capture:'+p for p,r in old.items() if r['kind']=='file' and p.split('/')[0] in survived}
 def restricted(parts):return sorted(sorted(set(group)&common_labels) for group in parts if set(group)&common_labels)
 transition_need(restricted(before_partition)==restricted(closed_partition),'transition-surviving-source-topology-changed')
 return {'format':1,'kind':'retired-capture-role-transition','attempt':attempt,'candidateId':before['candidateId'],'workspaceEpoch':before['workspaceEpoch'],'selectedRelative':before['selectedRelative'],'physicalRoots':before['physicalRoots'],
 'beforeSha256':packet['before']['ref']['sha256'],'closedSha256':packet['closed']['ref']['sha256'],'bindings':{k:v['ref'] for k,v in packet.items() if k!='writerSources'},'ordinaryWindow':ordinary,'predecessorProofSha256':previous['proof']['ref']['sha256'] if previous else None,
 'removedFamilies':sorted(removed),'createdFamilies':sorted(created),'survivingFamilies':sorted(survived),'closedActiveFamily':closed_active,'closedLedger':closed_ledger,'canonicalReports':copy.deepcopy(reports),'closedSourceAdmissions':copy.deepcopy(closed_admissions),'baselineSourceAdmissions':copy.deepcopy(baseline_admissions),'unchangedCatalogEarlyReturn':unchanged_catalog,'canonicalFunctionObserved':not unchanged_catalog,
 'baselinePartitionSha256':transition_digest(baseline_partition),'beforePartitionSha256':transition_digest(before_partition),'closedPartitionSha256':transition_digest(closed_partition),'composedSemanticJoin':prior is not None,'composedCanonicalInvocationClaimed':False,
 'writerSources':copy.deepcopy(packet['writerSources']),'authorityContext':copy.deepcopy(authority),'qualificationAccepted':False}

def transition_packet_need(value,reason):
 if not value:raise RuntimeError(reason)

def transition_packet_encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'\n').encode()

def transition_packet_digest(value):return hashlib.sha256(transition_packet_encoded(value)).hexdigest()

def transition_packet_value(doc):
 raw=doc['raw'].encode();ref=doc['ref']
 transition_packet_need(hashlib.sha256(raw).hexdigest()==ref['sha256'] and ('bytes' not in ref or len(raw)==ref['bytes']),'capture-packet-raw-document-changed')
 return json.loads(raw)
TRANSITION_DOCUMENT_NAMES={'before':'capture-before.json','closed':'capture-closed.json','canonical':'capture-canonical.json',
 'selection':'capture-registry-selection.json','physical':'capture-physical-roles.json','origins':'capture-history.json',
 'rawIndexes':'capture-registry-indexes.json','lifecycle':'capture-lifecycle.json'}
TRANSITION_OBSERVATION_KEYS={'registryInputs','registrySelections','canonical','canonicalPhysical','capturePhysical','prestart','selectedIndexRead','coverage','closedSources'}


def transition_packet_compose(before_doc,closed_doc,observations,prestart_input,baseline_doc,origins,lifecycle,writer_sources,write,previous=None):
 before,closed=transition_packet_value(before_doc),transition_packet_value(closed_doc);attempt=before['attempt']
 transition_packet_need(attempt in (1,2,3) and (previous is not None)==(attempt==2),'capture-packet-predecessor-role')
 def get(name):transition_packet_need(name in observations,'capture-packet-observation-missing:'+name);return transition_packet_value(observations[name])
 raw=get('registry-input-1.json');selection=get('registry-selection-1.json');read=get('registry-selected-read.json');coverage=get('registry-coverage.json')
 transition_packet_need(raw['ordinal']==selection['ordinal']==1 and raw['rawIndexesSha256']==selection['rawIndexesSha256']==read['rawIndexesSha256']==transition_packet_digest(raw['indexes'])
      and raw['observationOrigin']==selection['observationOrigin']==read['observationOrigin'],'capture-packet-original-registry-bindings')
 transition_packet_need(len(raw['indexes'])==2 and read['wholeIndexSha256']==dict(zip(('before','after'),map(transition_packet_digest,raw['indexes'])))
      and read['originalSelectedIndexReturned'] is True,'capture-packet-selected-whole-index-join')
 canonical_names=sorted(n for n in observations if n.startswith('canonical-observation-'))
 physical_names=sorted(n for n in observations if n.startswith('canonical-source-files-'))
 transition_packet_need(len(canonical_names)==len(physical_names)<=1 and coverage['canonicalCallbackCount']==len(canonical_names),'capture-packet-canonical-roster')
 reports=[get(n) for n in canonical_names]
 transition_packet_need(coverage['selectedIndexReadCount']==1 and coverage['observationOrigin']==raw['observationOrigin'],'capture-packet-coverage-origin')
 if reports:
  transition_packet_need(raw['observationOrigin']=='qualifier' and coverage['catalogCallbackCount']==1,'capture-packet-genuine-callback-origin')
 else:
  transition_packet_need(raw['observationOrigin']=='unchanged-index-return' and coverage['catalogCallbackCount']==0 and read['indexRowsExactlyEqual'] is True
       and raw['indexes'][0]==raw['indexes'][1],'capture-packet-exact-unchanged-index-required')
 input_selections=selection['selection'];transition_packet_need(set(input_selections)=={'before','after'},'capture-packet-two-selections-required')
 if attempt==2:
  old_indexes=transition_packet_value(previous['packet']['rawIndexes']);old_selections=transition_packet_value(previous['packet']['selection'])
  transition_packet_need(raw['indexes'][0]==old_indexes['before'],'capture-packet-restart-common-baseline-index-changed')
  indexes={'before':old_indexes['after'],'after':raw['indexes'][1]}
  selected={'before':old_selections['after'],'after':input_selections['after']}
  transition_packet_need(prestart_input is None,'capture-packet-restart-no-fake-prestart-index')
 else:
  transition_packet_need(prestart_input is not None,'capture-packet-pristine-prestart-index-required')
  initial=transition_packet_value(prestart_input)
  transition_packet_need(initial['rawIndex']==raw['indexes'][0] and initial['originalSelectedIndexReturned'] is True
       and initial['canonicalReturnedTrue'] is False,'capture-packet-actual-prestart-index-join')
  indexes=dict(zip(('before','after'),raw['indexes']));selected=input_selections
 physical_before=get('capture-physical-before.json');physical_pre=get('capture-physical-pre-native.json');physical_post=get('capture-physical-post-native.json')
 transition_packet_need(physical_before['stateSha256']==before_doc['ref']['sha256'] and physical_pre['stateSha256']==physical_post['stateSha256']==closed_doc['ref']['sha256'],'capture-packet-same-walk-state-join')
 for role in ('baseline','live'):
  transition_packet_need(physical_pre['inventory'][role]==physical_post['inventory'][role] and physical_pre['fileInodes'][role]==physical_post['fileInodes'][role],'capture-packet-closed-physical-state-changed')
 transition_packet_need(physical_before['inventory']==before['inventory'] and physical_post['inventory']==closed['inventory']
      and physical_before['fileInodes']['baseline']==physical_post['fileInodes']['baseline'],'capture-packet-baseline-physical-state-changed')
 source_names=sorted(n for n in observations if n.startswith('prestart-source-files-'));transition_packet_need(len(source_names)==1,'capture-packet-prestart-source-roster')
 initial_sources=get(source_names[0]);transition_packet_need(initial_sources['physicalSourceRoles']=={'before':'retained-baseline','after':'unstarted-live'},'capture-packet-prestart-source-role')
 if reports:
  closed_sources=get(physical_names[0]);transition_packet_need(closed_sources['canonicalReportSha256']==transition_packet_digest(reports[0]) and closed_sources['physicalSourceRoles']=={'before':'retained-baseline','after':'closed-live'},'capture-packet-actual-canonical-source-binding')
  closed_source_ref=None
 else:
  closed_sources=get('closed-source-files.json');closed_source_ref=observations['closed-source-files.json']['ref']
  transition_packet_need(closed_sources['canonicalReturnedTrue'] is False and closed_sources['physicalSourceRoles']=={'before':'retained-baseline','after':'closed-live'},'capture-packet-unchanged-source-no-canonical-claim')
 transition_packet_need(initial_sources['workspaceRoots']==closed_sources['workspaceRoots'] and initial_sources['packageRoot']==closed_sources['packageRoot']
      and initial_sources['physicalSources']['before']==closed_sources['physicalSources']['before'],'capture-packet-source-baseline-role-changed')
 physical={'baseline':{'sources':initial_sources['physicalSources']['before'],'captures':physical_before['fileInodes']['baseline']},
  'beforeLive':{'sources':initial_sources['physicalSources']['after'],'captures':physical_before['fileInodes']['live']},
  'closedLive':{'sources':closed_sources['physicalSources']['after'],'captures':physical_post['fileInodes']['live']}}
 if attempt==2:transition_packet_need(physical['beforeLive']==transition_packet_value(previous['packet']['physical'])['closedLive'],'capture-packet-restart-full-physical-join')
 documents={'before':before_doc,'closed':closed_doc,'baselineManifest':baseline_doc}
 values={'canonical':reports,'selection':selected,'physical':physical,'origins':origins,'rawIndexes':indexes,'lifecycle':lifecycle}
 for role,content in values.items():documents[role]=write(TRANSITION_DOCUMENT_NAMES[role],content)
 packet={**documents,'writerSources':writer_sources}
 manifest={'format':1,'kind':'capture-role-transition-packet','documents':{k:v['ref'] for k,v in documents.items()},'writerSources':writer_sources}
 packet_doc=write('capture-transition-packet.json',manifest)
 references={'registryInputs':[observations['registry-input-1.json']['ref']], 'registrySelections':[observations['registry-selection-1.json']['ref']],
  'canonical':[observations[n]['ref'] for n in canonical_names],'canonicalPhysical':[observations[n]['ref'] for n in physical_names],
  'capturePhysical':{'before':observations['capture-physical-before.json']['ref'],'preNative':observations['capture-physical-pre-native.json']['ref'],'postNative':observations['capture-physical-post-native.json']['ref']},
  'prestart':{'input':prestart_input['ref'] if prestart_input else None,'sources':[observations[n]['ref'] for n in source_names]},
  'selectedIndexRead':observations['registry-selected-read.json']['ref'],'coverage':observations['registry-coverage.json']['ref'],'closedSources':closed_source_ref}
 transition_packet_need(set(references)==TRANSITION_OBSERVATION_KEYS,'capture-packet-observation-reference-shape')
 return packet,packet_doc,references



# Exact source-bound pure role predicate and composition copies; no producer import/execution.
TRANSITION_PREDICATE_SHA256='df724c3ab3fcbfa53da4ec611603ababe0839c5a41900b606583ffe8a54b27a0'
TRANSITION_PARSER_SOURCES={'installed-plugin-index-store-CUXGXwqh.mjs':'8f44c30d7555a3efdbe0c02254c2d050b019ae24b416d83a9cb61c8da8356232','plugin-source-capture-report-BdUXHa10.mjs':'4aa98618a9fbac29e1bf83af25e486d20eeed416ce2cdcc5e95a231bbba71ac9'}

class _TransitionCore:
    exact_window=staticmethod(continuity_exact_window)
    digest=staticmethod(continuity_digest)
    relative=staticmethod(continuity_relative)
    mappings=staticmethod(continuity_mappings)
    hardlink_classes=staticmethod(continuity_hardlink_classes)
    namespace_rows=staticmethod(continuity_namespace_rows)
    source_capture_partition=staticmethod(continuity_source_capture_partition)
    WRITER_SOURCES=CONTINUITY_WRITER_SOURCES

def transition_same(left,right):
    return continuity_encoded(left)==continuity_encoded(right)

def consume_capture_history(plan,review,values,document):
    fail='startup-proof-original-capture-history-required'
    history=plan.get('originalCaptureHistory');baseline=review['baseline'];original=values['retainedParent']
    need(type(history) is dict and set(history)=={'format','parent','baselineManifest','workspaceEpoch','selectedRelative','candidateId','windows'}
         and history['format']==1 and history['parent']==baseline['retainedParent'] and history['baselineManifest']==baseline['manifest']
         and history['workspaceEpoch']==baseline['epoch']==plan['workspaceEpoch'] and history['selectedRelative']==plan['selectedRelative']
         and history['candidateId']==review['prior']['candidateId']==original['targetCandidateId']
         and original['selectedRelative']==plan['selectedRelative'] and [s['scenario'] for s in original['scenarios']]==list(SCENARIOS)
         and set(history['windows'])==set(SCENARIOS[:2]),fail)
    last=None
    for attempt,name in enumerate(SCENARIOS[:2],1):
        witness=history['windows'][name];prior=original['scenarios'][attempt-1]
        need(type(witness) is dict and set(witness)=={'window','references'} and set(witness['references'])=={'started','process','ready','closed'},fail)
        records={}
        for role,ref in witness['references'].items():
            need(ref==prior[role] and plan['inputHashes'].get(ref['path'])==ref['sha256']
                 and PurePosixPath(ref['path'])==PurePosixPath(baseline['retainedParent']['path']).parent/('attempt-'+str(attempt))/(role+'.json'),fail)
            records[role]=document('capture-history/'+name+'/'+role,ref)
        started,process,ready,closed=(records[k] for k in ('started','process','ready','closed'))
        need(started['operationId']==original['operationId'] and started['candidateId']==history['candidateId']
             and started['epoch']==history['workspaceEpoch'] and started['attempt']==attempt
             and ready['startedSha256']==sha(encoded(started)) and ready['processSha256']==sha(encoded(process))
             and transition_same(ready['process'],process) and closed['readySha256']==sha(encoded(ready))
             and closed['owningServiceFullyStopped'] is True and ready['candidateId']==history['candidateId'] and ready['epoch']==history['workspaceEpoch'],fail)
        start,settled,end=started['startedAtSeconds'],ready['readyAtSeconds'],closed['closedAtSeconds']
        need(all(type(n) is int for n in (start,settled,end)) and start<=settled<=end and end-start<=3600
             and witness['window']==[start,end] and (last is None or last<=start),fail)
        last=end
    return history

def transition_registry_provenance(raw,selection,selected,roots,ordinary):
    fail='startup-proof-complete-official-registry-observation-required'
    need(raw.get('format')==selection.get('format')==1 and raw.get('kind')=='private-original-registry-pair'
         and selection.get('kind')=='pre-normalization-registry-selection' and raw.get('ordinal')==selection.get('ordinal')==1
         and raw.get('observationOrigin')==selection.get('observationOrigin')==selected.get('observationOrigin')
         and raw['observationOrigin'] in ('qualifier','unchanged-index-return')
         and raw['rawIndexesSha256']==selection['rawIndexesSha256']==selected['rawIndexesSha256']==continuity_digest(raw['indexes'])
         and selection['workspaceRoots']==roots and selection['ordinaryWindow']==ordinary
         and selection['parserSources']==TRANSITION_PARSER_SOURCES and len(raw['indexes'])==len(selection['sides'])==2,fail)
    for key,index,side in zip(('before','after'),raw['indexes'],selection['sides']):
        need(side['parserReturnedIndex'] is True and side['presentAdmissionsUnchanged'] is True
             and HASH.fullmatch(side['parsedIndexSha256']) and type(index.get('plugins')) is list
             and len(index['plugins'])==side['registryRowCount']==len(side['registryRows'])<=4096,fail)
        rows=[]
        for position,(row,observed) in enumerate(zip(index['plugins'],side['registryRows'])):
            present='sourceAdmissions' in row
            need(observed['position']==position and observed['pluginId']==row['pluginId']
                 and ('sourceAdmissions' in observed)==present and (not present or transition_same(observed['sourceAdmissions'],row['sourceAdmissions'])),fail)
            rows.append({'position':position,'pluginId':row['pluginId'],'sourceAdmissions':row.get('sourceAdmissions')})
        framed={'format':1,'kind':'complete-writer-retained-paths','wholeIndexSha256':continuity_digest(index),
                'writerRule':'all-rows/all-receipts:capturedRoot/content UNION capturedPath','registryRowCount':len(rows),
                'registryRows':rows,'retainedPaths':side['retainedPaths']}
        need(transition_same(selection['selection'][key],framed) and selection['retained_paths'][key]==side['retainedPaths']
             and selected['wholeIndexSha256'][key]==continuity_digest(index),fail)

def transition_package(report,roots):
    fail='startup-proof-transition-package-context-required'
    need(report['workspaceRoots']==roots,fail)
    package=PurePosixPath(report['packageRoot']);projects=PurePosixPath(roots[2])/roots[3]/'openclaw-runtime/state/npm/projects'
    need(package.is_absolute() and str(package)==report['packageRoot'] and package.is_relative_to(projects)
         and len(package.relative_to(projects).parts)==4 and package.relative_to(projects).parts[1:]==('node_modules','@openclaw','codex')
         and '..' not in package.parts,fail)
    return str(package)


def capture_transition_summary(evidence,plan,review,values,history,window,item,attempt,folder,scenario,document,previous):
    fail='startup-proof-authentic-capture-transition-required'
    need(type(evidence) is dict and set(evidence)=={'packet','proof','observationRefs'},fail)
    def read_fixed(role,ref,name):
        reference(ref);need(ref['path']==str(folder/name),fail)
        raw=document(scenario+'/transition/'+role,ref,MAX_JSON,True);parse(raw)
        return {'ref':ref,'raw':raw.decode('utf-8')}
    packet_doc=read_fixed('packet',evidence['packet'],'capture-transition-packet.json')
    manifest=transition_packet_value(packet_doc)
    need(type(manifest) is dict and set(manifest)=={'format','kind','documents','writerSources'}
         and manifest['format']==1 and manifest['kind']=='capture-role-transition-packet'
         and set(manifest['documents'])==set(TRANSITION_DOCUMENT_NAMES)|{'baselineManifest'}
         and manifest['writerSources']==CONTINUITY_WRITER_SOURCES,fail)
    packet={}
    for name,ref in manifest['documents'].items():
        if name=='baselineManifest':
            need(ref==review['baseline']['manifest'] and plan['inputHashes'].get(ref['path'])==ref['sha256'],fail)
            raw=document(scenario+'/transition/baselineManifest',ref,MAX_JSON,True);parse(raw)
            packet[name]={'ref':ref,'raw':raw.decode('utf-8')}
        else:packet[name]=read_fixed(name,ref,TRANSITION_DOCUMENT_NAMES[name])
    packet['writerSources']=manifest['writerSources'];docs={k:transition_packet_value(v) for k,v in packet.items() if k!='writerSources'}
    proof_doc=read_fixed('proof',evidence['proof'],'capture-continuity.json');proof=transition_packet_value(proof_doc)
    app=review['prior' if attempt==3 else 'target'];before,closed=docs['before'],docs['closed']
    roots=['/qualification/recovery/workspace','/var/lib/nova/workspace','/var/lib/nova/workspace',plan['selectedRelative']]
    authority={'baselineParent':review['baseline']['retainedParent'],'baselineCandidateId':review['prior']['candidateId'],
               'workspaceRoots':roots,'runtime':review['runtime']['agent'],'serviceOwner':[review['serviceUid'],review['serviceGid']]}
    need(all(v['candidateId']==app['candidateId'] and v['workspaceEpoch']==plan['workspaceEpoch'] and v['attempt']==attempt
             and v['selectedRelative']==plan['selectedRelative'] for v in (before,closed))
         and before['physicalRoots'][0]==plan['baselineRootIdentity'][:5]
         and before['physicalRoots'][1][0]==plan['fixtureStorageAuthority']['device']
         and transition_same(docs['origins'],history)
         and docs['lifecycle']=={'window':window,'started':item['started'],'closed':item['closed']},fail)
    need((attempt==1)==(previous is None),fail)
    if attempt==3:need(previous['proofValue']['attempt']==2 and before['physicalRoots'][1][:2]!=previous['proofValue']['physicalRoots'][1][:2],fail)
    predecessor={'packet':previous['packet'],'proof':previous['proof']} if attempt==2 else None
    refs=evidence['observationRefs'];need(type(refs) is dict and set(refs)==TRANSITION_OBSERVATION_KEYS,fail)
    observations={}
    def observation(ref,name):
        doc=read_fixed('observation/'+name,ref,name);need(name not in observations,fail);observations[name]=doc;return transition_packet_value(doc)
    for key,prefix,count in (('registryInputs','registry-input-',1),('registrySelections','registry-selection-',1),
                             ('canonical','canonical-observation-',None),('canonicalPhysical','canonical-source-files-',None)):
        need(type(refs[key]) is list and (len(refs[key])==count if count is not None else len(refs[key])<=1),fail)
        for ordinal,ref in enumerate(refs[key],1):observation(ref,prefix+str(ordinal)+'.json')
    need(set(refs['capturePhysical'])=={'before','preNative','postNative'} and set(refs['prestart'])=={'input','sources'},fail)
    for key,suffix,phase,state in (('before','before','before',before),('preNative','pre-native','closed',closed),('postNative','post-native','closed',closed)):
        observed=observation(refs['capturePhysical'][key],'capture-physical-'+suffix+'.json')
        need(observed['format']==1 and observed['kind']=='same-walk-capture-physical-observation' and observed['phase']==phase
             and all(observed[k]==state[k] for k in ('attempt','candidateId','workspaceEpoch','selectedRelative','physicalRoots'))
             and transition_same(observed['inventory'],state['inventory'])
             and observed['stateSha256']==packet['before' if key=='before' else 'closed']['ref']['sha256'],fail)
    need(type(refs['prestart']['sources']) is list and len(refs['prestart']['sources'])==1,fail)
    initial_sources=observation(refs['prestart']['sources'][0],'prestart-source-files-1.json')
    selected=observation(refs['selectedIndexRead'],'registry-selected-read.json');coverage=observation(refs['coverage'],'registry-coverage.json')
    if refs['closedSources'] is not None:observation(refs['closedSources'],'closed-source-files.json')
    prestart=None
    if attempt==2:need(refs['prestart']['input'] is None,fail)
    else:
        ref=refs['prestart']['input'];reference(ref)
        need(ref['path']==str(folder.parent/('registry-prestart-'+str(attempt))/'registry-prestart-input.json'),fail)
        raw=document(scenario+'/transition/prestart-input',ref,MAX_JSON,True);parse(raw);prestart={'ref':ref,'raw':raw.decode('utf-8')}
        initial=transition_packet_value(prestart)
        need(initial['workspaceRoots']==roots and initial['selection']['before']==initial['selection']['after']
             and initial['sourceAdmissions']==next(r['sourceAdmissions'] for r in initial['rawIndex']['plugins'] if r['pluginId']=='codex')
             and initial_sources['rosterSha256']==continuity_digest(initial),fail)
        transition_package(initial,roots)
    raw=transition_packet_value(observations['registry-input-1.json']);selection=transition_packet_value(observations['registry-selection-1.json'])
    transition_registry_provenance(raw,selection,selected,roots,window)
    need(selection['runtimeRoot']==review['runtime']['agent'] and selection['nativeSourcePinsSha256']=='87576ee6b9e1a2a5c0bb6b9d5caccbf42b8e2d311e225591272c73503c516b0d',fail)
    need(selected['workspaceRoots']==roots and selected['ordinaryWindow']==window and selected['originalSelectedIndexReturned'] is True,fail)
    canonical=[transition_packet_value(observations['canonical-observation-'+str(i)+'.json']) for i in range(1,len(refs['canonical'])+1)]
    need(transition_same(canonical,docs['canonical']),fail)
    transition_package(initial_sources,roots)
    for ordinal,report in enumerate(canonical,1):
        package=transition_package(report,roots)
        need(report['canonicalReturnedTrue'] is True and report['ordinaryWindow']==window and report['kind']=='canonical-retired-capture-admissions'
             and set(report['originalSourceAdmissions'])==set(report['currentSourceAdmissions'])=={package+'\0'},fail)
        physical=transition_packet_value(observations['canonical-source-files-'+str(ordinal)+'.json'])
        need(physical['kind']=='actual-canonical-source-physical-observation' and physical['canonicalReportSha256']==continuity_digest(report)
             and physical['workspaceRoots']==roots and physical['packageRoot']==package and physical['ordinaryWindow']==window,fail)
    if not canonical:
        need(refs['closedSources'] is not None and len(refs['canonicalPhysical'])==0,fail)
        transition_package(transition_packet_value(observations['closed-source-files.json']),roots)
    def compare_written(name,value):
        role=next((k for k,v in TRANSITION_DOCUMENT_NAMES.items() if v==name),None)
        if name=='capture-transition-packet.json':doc=packet_doc
        else:need(role in packet,fail);doc=packet[role]
        need(continuity_encoded(value)==doc['raw'].encode('utf-8'),'startup-proof-transition-document-recomposition-changed')
        return doc
    recomposed,_,recomposed_refs=transition_packet_compose(packet['before'],packet['closed'],observations,prestart,
        packet['baselineManifest'],history,docs['lifecycle'],CONTINUITY_WRITER_SOURCES,compare_written,predecessor)
    need(transition_same(recomposed_refs,refs),fail)
    derived=transition_prove(_TransitionCore,TRANSITION_CORE_SHA256,recomposed,authority,predecessor)
    need(continuity_encoded(derived)==proof_doc['raw'].encode('utf-8'),'startup-proof-complete-capture-transition-changed')
    summary={'kind':'closed-9.8-retired-capture-transition','candidateId':app['candidateId'],'workspaceEpoch':plan['workspaceEpoch'],
             'selectedRelative':plan['selectedRelative'],'attempt':attempt,'physicalRoots':before['physicalRoots'],'ordinaryWindow':window,
             'packetSha256':evidence['packet']['sha256'],'proofSha256':evidence['proof']['sha256'],
             'beforeSha256':packet['before']['ref']['sha256'],'closedSha256':packet['closed']['ref']['sha256'],
             'predicateSha256':TRANSITION_PREDICATE_SHA256,'writerSourcesSha256':continuity_digest(CONTINUITY_WRITER_SOURCES),
             'baselineManifestSha256':packet['baselineManifest']['ref']['sha256'],'originsSha256':packet['origins']['ref']['sha256'],
             'observationRefsSha256':continuity_digest(refs),'authorityContextSha256':continuity_digest(authority),
             'baselineInventorySha256':continuity_digest(before['inventory']['baseline']),
             'beforeLiveInventorySha256':continuity_digest(before['inventory']['live']),'closedLiveInventorySha256':continuity_digest(closed['inventory']['live']),
             'baselineClassificationSha256':continuity_digest(before['classification']['baseline']),
             'beforeLiveClassificationSha256':continuity_digest(before['classification']['live']),'closedLiveClassificationSha256':continuity_digest(closed['classification']['live']),
             **{k:derived[k] for k in ('baselinePartitionSha256','beforePartitionSha256','closedPartitionSha256','predecessorProofSha256','unchangedCatalogEarlyReturn','canonicalFunctionObserved')},
             'canonicalReportsSha256':continuity_digest(canonical),'canonicalReportCount':len(canonical)}
    return summary,{'packet':packet,'proof':proof_doc,'proofValue':derived}
