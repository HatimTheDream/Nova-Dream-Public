"""Signed frontend readiness and obsolete-base selector retirement.

Maintained delivery helper; no service, workspace, runtime or asset mutation.
Plan is read-only. Execute/resume use the maintained root worker's exclusion,
signature verifier, protected IO and retained-manifest closure validator.
"""
import base64
import hashlib
import http.client
import json
import os
import pathlib
import signal
import socket
import stat
import sys
import time
import types
import uuid
import re

WORKER_SHA = "73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171"
ROOT = pathlib.Path("/opt/nova/frontend")
STATE = pathlib.Path("/var/lib/nova-update/frontend")
SELECTOR = ROOT / "selector.json"
MARKER = STATE / "current.json"

class HeartbeatExpired(RuntimeError):
    pass


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def protected_read(path, limit):
    """Bootstrap only, before loading the exact maintained IO implementation."""
    path = pathlib.Path(path)
    require(path.is_absolute(), 'absolute-protected-source-required')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and info.st_uid == 0 and not info.st_mode & 0o022, 'unprotected-source-parent')
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
            and not before.st_mode & 0o022 and before.st_size <= limit, 'unprotected-source-file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(limit + 1)
        after, final = os.fstat(fd), path.lstat()
        identity = lambda v: (v.st_dev, v.st_ino, v.st_mode, v.st_nlink, v.st_uid,
                              v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        require(identity(before) == identity(opened) == identity(after) == identity(final)
                and len(raw) == before.st_size and len(raw) <= limit, 'source-changed-during-read')
        return raw
    finally:
        os.close(fd)


def load_worker(reference):
    require(set(reference) == {'path', 'sha256'} and reference['sha256'] == WORKER_SHA
            and re.fullmatch(r'/opt/nova-updater-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}/deploy/update-runner/frontend\.py', reference['path']),
            'maintained-worker-reference-changed')
    raw = protected_read(reference['path'], 256 * 1024)
    require(sha(raw) == WORKER_SHA, 'maintained-worker-source-changed')
    module = types.ModuleType('maintained_frontend_readiness')
    module.__file__ = reference['path']
    exec(compile(raw, reference['path'], 'exec'), module.__dict__)
    return module


class Retirement:
    def __init__(self, worker, binding, source_sha, io=None, clock=None, wait_clock=None, sleeper=None):
        require(set(binding) == {'operationId', 'runId', 'baseCandidateId', 'serviceInputsSha256', 'workspaceEpoch', 'baseVersion', 'worker', 'config'}, 'readiness-binding-fields')
        for key in ('operationId', 'runId', 'workspaceEpoch'):
            require(str(uuid.UUID(binding[key])) == binding[key], 'readiness-binding-uuid')
        require(all(worker.is_hash(binding[key]) for key in ('baseCandidateId', 'serviceInputsSha256'))
                and worker.is_hash(source_sha) and worker.VERSION.fullmatch(binding['baseVersion']), 'readiness-binding-identity')
        require(set(binding['config']) == {'path', 'sha256'} and binding['config']['path'] == '/etc/nova-update/frontend.json'
                and worker.is_hash(binding['config']['sha256']), 'readiness-config-reference')
        self.binding = binding
        self.source_sha = source_sha
        self.repair_id = str(uuid.uuid5(uuid.UUID(binding['operationId']), 'frontend-readiness-' + binding['runId']))
        self.record_path = STATE / ('readiness-' + self.repair_id + '.json')
        self.base = {'candidateId': binding['baseCandidateId'], 'serviceInputsSha256': binding['serviceInputsSha256'], 'apiVersion': 1, 'schemaVersion': 55}
        self.worker = worker
        self.io = io or worker.FileIO()
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.wait_clock = wait_clock or time.monotonic
        self.sleeper = sleeper or time.sleep
        self.config_raw = self.io.read(self.binding['config']['path'], 65536, private=True)
        require(sha(self.config_raw) == self.binding['config']['sha256'], 'frontend-config-changed')
        self.config = worker.validate_config(worker.strict_json(self.config_raw))
        require(self.config['frontendDirectory'] == str(ROOT)
                and self.config['stateDirectory'] == str(STATE), 'frontend-roots-changed')
        # Reuse the exact retained-closure validator without constructing a new
        # promotion/rollback operation or invoking its incompatible health gate.
        self.retained = types.SimpleNamespace(io=self.io, root=ROOT, config=self.config)
        self.io.protect(ROOT, directory=True)
        self.io.protect(STATE, directory=True, private=True)
        self.marker = encoded({'format': 1, 'operationId': self.repair_id, 'journalPath': str(self.record_path)})

    def optional(self, path, maximum=131072, private=True):
        try:
            return self.io.read(path, maximum, private=private)
        except FileNotFoundError:
            self.io.protect(pathlib.Path(path).parent, directory=True, private=private)
            return None

    def source(self):
        require(sha(self.io.read(self.binding['worker']['path'], 1024 * 1024)) == WORKER_SHA
                and self.io.read(self.binding['config']['path'], 65536, private=True) == self.config_raw,
                'frozen-authority-changed')
        return {'worker': {'path': self.binding['worker']['path'], 'sha256': WORKER_SHA},
                'adapterSha256': self.source_sha,
                'config': {'path': self.binding['config']['path'], 'sha256': self.binding['config']['sha256']}}

    def operator_status(self, timeout):
        path = '/run/nova-update/operator.sock'
        self.io.protect(pathlib.Path(path).parent, directory=True)
        info = os.lstat(path)
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
                'operator-status-socket-not-root-only')
        connection = http.client.HTTPConnection('localhost', timeout=timeout)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(timeout)
        try:
            connection.sock.connect(path)
            connection.request('POST', '/v1/status', body=b'{}', headers={
                'Content-Type': 'application/json', 'Content-Length': '2', 'Connection': 'close'})
            response = connection.getresponse()
            raw = response.read(16385)
            require(response.status == 200 and len(raw) <= 16384, 'operator-status-unavailable')
            value = self.worker.strict_json(raw)
            require(set(value) == {'format', 'lease', 'held', 'freshHeartbeat'} and value['format'] == 1
                    and type(value['held']) is bool and type(value['freshHeartbeat']) is bool,
                    'invalid-operator-status')
            return value
        finally:
            connection.close()

    def wait_fresh_heartbeat(self, deadline=None):
        deadline = self.wait_clock() + 35 if deadline is None else deadline
        while self.wait_clock() < deadline:
            status = self.operator_status(min(5, deadline - self.wait_clock()))
            require(status['held'] is False and (status['lease'] is None
                    or isinstance(status['lease'], dict) and status['lease'].get('phase') in ('released', 'cancelled')),
                    'operator-maintenance-not-idle')
            if status['freshHeartbeat'] is True:
                return deadline
            remaining = deadline - self.wait_clock()
            if remaining > 0:
                self.sleeper(min(1, remaining))
        raise HeartbeatExpired('real-heartbeat-not-fresh-within-35s')

    def pointer_identity(self):
        value = self.io.stat(SELECTOR) if hasattr(self.io, 'stat') else os.lstat(SELECTOR)
        return [value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_nlink,
                value.st_size, value.st_mtime_ns, value.st_ctime_ns]

    def retained_proof(self, raw, *, obsolete=True):
        selector = self.worker.strict_json(raw)
        manifest_raw, signature, manifest, files = self.worker.FrontendWorker.stored_manifest(self.retained, selector)
        require((manifest['base'] != self.base) if obsolete else (manifest['base'] == self.base),
                'selector-base-does-not-match-readiness-action')
        old_operation = selector['operationId']
        original_raw = self.io.read(STATE / (old_operation + '.json'), 131072, private=True)
        original = self.worker.strict_json(original_raw)
        require(original.get('format') == 1 and original.get('operationId') == old_operation
                and original.get('phase') == 'completed' and original.get('outcome') == 'selected'
                and original.get('configSha256') == self.binding['config']['sha256']
                and original.get('manifestSha256') == sha(manifest_raw)
                and original.get('frontendId') == selector['frontendId'] and original.get('targetSelector') == selector
                and original.get('leaseId') == old_operation
                and all(original.get('health', {}).get(k) == manifest['base'][k] for k in self.base),
                'old-promotion-is-not-authenticated-completed-selection')
        sequence = self.io.read(STATE / 'sequence.json', 16384, private=True)
        high = self.worker.strict_json(sequence)
        require(set(high) == {'format', 'sequence', 'manifestSha256'} and type(high['format']) is int and high['format'] == 1
                and type(high['sequence']) is int and high['sequence'] >= manifest['sequence']
                and self.worker.is_hash(high['manifestSha256'])
                and (high['sequence'] != manifest['sequence'] or high['manifestSha256'] == sha(manifest_raw)), 'sequence-changed')
        return {'selectorSha256': sha(raw), 'manifestSha256': sha(manifest_raw), 'signatureSha256': sha(signature),
                'originalJournalSha256': sha(original_raw), 'sequenceSha256': sha(sequence), 'fileCount': len(files),
                'fileInventorySha256': sha(encoded(manifest['files'])), 'base': manifest['base']}

    def health(self, retired=None):
        value, context = self.io.get('health'), self.io.get('access/context')
        require(value.get('application') == 'nova-dream-edition-3' and value.get('status') == 'ready'
                and all(value.get(k) == v for k, v in self.base.items())
                and value.get('version') == self.binding['baseVersion'] and self.worker.VERSION.fullmatch(value.get('buildVersion', ''))
                and self.worker.is_uuid(value.get('processIdentity'))
                and context.get('recovery') is False and context.get('recoveryLocal') is False
                and context.get('workspaceEpoch') == self.binding['workspaceEpoch'], 'accepted-service-or-workspace-changed')
        bundled = {'id': self.base['candidateId'], 'version': value['version'], 'buildVersion': value['buildVersion'], 'source': 'bundled'}
        frontend = value.get('frontend')
        if retired is not None:
            require(frontend == (bundled if retired else {**bundled, 'blocked': True}), 'unexpected-frontend-health')
        else:
            require(isinstance(frontend, dict) and self.worker.is_hash(frontend.get('id'))
                    and frontend.get('source') in ('bundled', 'frontend'), 'frontend-identity-missing')
        return {'base': self.base, 'applicationProcessIdentity': value['processIdentity'],
                'epoch': context['workspaceEpoch'], 'frontend': frontend}

    def observe(self):
        value = self.io.control(self.config, 'observe', {'operationId': self.repair_id})
        fields = {'format', 'operationId', 'leaseId', 'leaseProcessIdentity', 'active', 'candidateId',
                  'serviceInputsSha256', 'apiVersion', 'schemaVersion', 'epoch', 'processIdentity'}
        require(set(value) == fields and value['format'] == 1 and value['operationId'] == self.repair_id
                and type(value['active']) is bool and all(value[k] == v for k, v in self.base.items())
                and self.worker.is_uuid(value['epoch']) and self.worker.is_uuid(value['processIdentity'])
                and (value['leaseId'] is None or self.worker.is_uuid(value['leaseId']))
                and (value['leaseProcessIdentity'] is None or self.worker.is_uuid(value['leaseProcessIdentity'])),
                'invalid-current-controller-identity')
        return value

    def same_view(self, view, plan, active):
        require(view['active'] is active and view['leaseId'] == self.repair_id
                and view['processIdentity'] == plan['controller']['processIdentity']
                and view['leaseProcessIdentity'] == plan['controller']['processIdentity']
                and view['epoch'] == plan['health']['epoch'], 'original-repair-lease-needs-reconciliation')

    def plan(self):
        require(self.optional(self.record_path) is None, 'resume-original-retirement-record')
        require(self.optional(MARKER) is None, 'unresolved-native-frontend-operation')
        health = self.health()
        raw = self.optional(SELECTOR, 8192, private=False)
        if health['frontend'].get('blocked') is not True:
            if raw is None:
                require(health['frontend']['source'] == 'bundled' and health['frontend']['id'] == self.base['candidateId'], 'missing-selected-frontend-pointer')
                proof = None
            else:
                proof = self.retained_proof(raw, obsolete=False)
                require(health['frontend']['source'] == 'frontend' and health['frontend']['id'] == self.worker.strict_json(raw)['frontendId'], 'selected-frontend-health-changed')
            view = self.observe()
            require(not view['active'] and view['epoch'] == health['epoch'], 'controller-not-idle-for-readiness')
            require(self.health() == health and self.optional(SELECTOR, 8192, private=False) == raw, 'readiness-changed-during-plan')
            return {'format': 1, 'kind': 'frontend-readiness-plan', 'operationId': self.binding['operationId'],
                    'runId': self.binding['runId'], 'repairOperationId': self.repair_id, 'binding': self.binding,
                    'sourceSha256': self.source_sha, 'readOnly': True, 'ready': True, 'retirementRequired': False,
                    'health': health, 'proof': proof, 'observedAtMilliseconds': self.clock()}
        require(raw is not None, 'blocked-frontend-without-authenticated-selector')
        identity = self.pointer_identity()
        proof, health, view = self.retained_proof(raw), self.health(False), self.observe()
        require(not view['active'] and view['leaseId'] != self.repair_id
                and view['epoch'] == health['epoch'], 'controller-not-idle-for-retirement')
        require(self.io.read(SELECTOR, 8192) == raw and self.pointer_identity() == identity,
                'selector-changed-during-readonly-plan')
        return {'format': 1, 'kind': 'frontend-retirement-plan', 'operationId': self.repair_id,
                'blockedDeliveryOperationId': self.binding['operationId'], 'readOnly': True, 'sources': self.source(),
                'binding': self.binding, 'retirementRequired': True, 'realHeartbeatWaitMaximumSeconds': 35,
                'originalSelectorBase64': base64.b64encode(raw).decode(), 'selectorIdentity': identity,
                'proof': proof, 'health': health, 'controller': view,
                'observedAtMilliseconds': self.clock(), 'validForMilliseconds': 120000,
                'workerTimeoutSeconds': 120, 'effects': ['retain-pointer-in-private-record',
                    'begin-current-frontend-lease', 'remove-exact-obsolete-selector', 'end-original-lease'],
                'preserve': ['sequence', 'assets', 'manifests', 'original-journal', 'backend', 'workspace']}

    def bindings(self, plan_raw, intent_raw):
        plan, intent = self.worker.strict_json(plan_raw), self.worker.strict_json(intent_raw)
        require(plan.get('format') == 1 and plan.get('kind') == 'frontend-retirement-plan'
                and plan.get('operationId') == self.repair_id and plan.get('readOnly') is True
                and plan.get('blockedDeliveryOperationId') == self.binding['operationId'] and plan.get('binding') == self.binding and plan.get('sources') == self.source()
                and plan.get('validForMilliseconds') == 120000 and plan.get('workerTimeoutSeconds') == 120,
                'plan-source-or-scope-changed')
        require(intent == {'format': 1, 'kind': 'frontend-retirement-intent',
                'operationId': self.repair_id, 'planSha256': sha(plan_raw),
                'adapterSha256': plan['sources']['adapterSha256'], 'execute': True},
                'separate-exact-execution-intent-required')
        return plan, {'planSha256': sha(plan_raw), 'intentSha256': sha(intent_raw),
                      'adapterSha256': plan['sources']['adapterSha256']}

    def save(self, record, phase):
        record['phase'] = phase
        record['updatedAtMilliseconds'] = self.clock()
        self.io.write(self.record_path, encoded(record), private=True, replace=True)

    def check_original(self, plan, retired, allow_no_marker=False):
        marker = self.optional(MARKER)
        require(marker == self.marker or allow_no_marker and marker is None,
                'original-retirement-marker-missing-or-conflicting')
        raw = base64.b64decode(plan['originalSelectorBase64'], validate=True)
        require(self.retained_proof(raw) == plan['proof'], 'retained-original-evidence-changed')
        health = self.health(retired)
        require(health['epoch'] == plan['health']['epoch'] and health['applicationProcessIdentity'] == plan['health']['applicationProcessIdentity'], 'workspace-or-process-changed')
        current = self.optional(SELECTOR, 8192, private=False)
        require(current is None if retired else current == raw, 'selector-changed-outside-original-retirement')
        if not retired:
            require(self.pointer_identity() == plan['selectorIdentity'], 'selector-inode-or-metadata-changed')

    def clear_marker(self):
        marker = self.optional(MARKER)
        require(marker is None or marker == self.marker, 'different-operation-owns-native-marker')
        if marker is not None:
            self.io.remove(MARKER)

    def run(self, plan_raw, intent_raw, resume=False):
        plan, binding = self.bindings(plan_raw, intent_raw)
        with self.io.lock(STATE / 'worker.lock'):
            existing = self.optional(self.record_path)
            if not resume:
                require(existing is None, 'retirement-already-reserved-use-resume')
                fresh = self.plan()
                require({k: v for k, v in fresh.items() if k != 'observedAtMilliseconds'} ==
                        {k: v for k, v in plan.items() if k != 'observedAtMilliseconds'}
                        and 0 <= self.clock() - plan['observedAtMilliseconds'] <= 120000,
                        'readonly-retirement-plan-changed-or-expired')
                record = {'format': 1, 'kind': 'frontend-retirement-record', 'operationId': self.repair_id,
                          **binding, 'plan': plan, 'phase': 'prepared', 'createdAtMilliseconds': self.clock(),
                          'heartbeatDeadlineAtMilliseconds': self.clock() + 35000}
                self.io.write(self.record_path, encoded(record), private=True)
            else:
                require(existing is not None, 'original-retirement-record-missing')
                record = self.worker.strict_json(existing)
                require(record.get('format') == 1 and record.get('kind') == 'frontend-retirement-record'
                        and record.get('operationId') == self.repair_id and record.get('plan') == plan
                        and all(record.get(k) == v for k, v in binding.items()), 'original-retirement-binding-changed')
            phase = record['phase']
            require(phase in ('prepared', 'begin-intent', 'leased', 'retire-intent', 'retired',
                              'end-intent', 'completed', 'refused'), 'unknown-retirement-phase')
            marker = self.optional(MARKER)
            require(marker == self.marker or marker is None and phase in ('prepared', 'completed', 'refused'),
                    'original-retirement-marker-missing-or-conflicting')
            if phase == 'refused':
                self.check_original(plan, False, allow_no_marker=True)
                require(not self.observe()['active'], 'refused-retirement-has-active-lease')
                self.clear_marker()
                return record
            if phase == 'prepared':
                require(0 <= self.clock() - plan['observedAtMilliseconds'] <= 120000, 'unstarted-original-plan-expired')
                self.check_original(plan, False, allow_no_marker=True)
                view = self.observe()
                require(view == plan['controller'], 'controller-changed-before-begin')
                if marker is None:
                    self.io.write(MARKER, self.marker, private=True)
                # Wait for the application's real periodic heartbeat. This only
                # observes the maintained operator status endpoint; it never
                # submits a heartbeat or changes an admission freshness rule.
                try:
                    remaining = (record['heartbeatDeadlineAtMilliseconds'] - self.clock()) / 1000
                    heartbeat_deadline = self.wait_fresh_heartbeat(self.wait_clock() + max(0, remaining))
                    self.check_original(plan, False)
                    require(self.observe() == plan['controller'], 'controller-changed-during-heartbeat-wait')
                    # Recheck actual freshness after full asset reads. A resume
                    # retains the original 35-second deadline instead of restarting it.
                    self.wait_fresh_heartbeat(heartbeat_deadline)
                    require(0 <= self.clock() - plan['observedAtMilliseconds'] <= 120000,
                            'original-plan-expired-during-heartbeat-wait')
                except HeartbeatExpired:
                    self.check_original(plan, False)
                    require(self.observe() == plan['controller'], 'controller-changed-before-readiness-refusal')
                    record['reason'] = 'real-heartbeat-not-fresh-within-35s'
                    self.save(record, 'refused')
                    self.clear_marker()
                    return record
                self.save(record, 'begin-intent')
                try:
                    self.io.control(self.config, 'begin', {'operationId': self.repair_id,
                        'baseCandidateId': self.base['candidateId'], 'serviceInputsSha256': self.base['serviceInputsSha256'],
                        'workspaceEpoch': plan['health']['epoch']})
                except self.worker.ControlRejected:
                    self.save(record, 'refused')
                    self.check_original(plan, False)
                    require(not self.observe()['active'], 'refused-retirement-has-active-lease')
                    self.clear_marker()
                    return record
                # Observe the original result even when begin was acknowledged.
                self.same_view(self.observe(), plan, True)
                self.save(record, 'leased')
            elif phase == 'begin-intent':
                # Never redispatch begin after an uncertain response. An observed
                # original active lease can be adopted; absence remains a gap.
                self.same_view(self.observe(), plan, True)
                self.save(record, 'leased')
            if record['phase'] == 'leased':
                self.check_original(plan, False)
                self.same_view(self.observe(), plan, True)
                self.save(record, 'retire-intent')
            if record['phase'] == 'retire-intent':
                self.same_view(self.observe(), plan, True)
                if self.optional(SELECTOR, 8192, private=False) is not None:
                    self.check_original(plan, False)
                    self.io.remove(SELECTOR)
                self.check_original(plan, True)
                self.save(record, 'retired')
            if record['phase'] == 'retired':
                self.check_original(plan, True)
                self.same_view(self.observe(), plan, True)
                self.save(record, 'end-intent')
            if record['phase'] == 'end-intent':
                self.check_original(plan, True)
                view = self.observe()
                self.same_view(view, plan, view['active'])
                if view['active']:
                    self.io.control(self.config, 'end', {'operationId': self.repair_id, 'leaseId': self.repair_id})
                self.same_view(self.observe(), plan, False)
                self.check_original(plan, True)
                self.save(record, 'completed')
            if record['phase'] == 'completed':
                self.check_original(plan, True, allow_no_marker=True)
                self.same_view(self.observe(), plan, False)
                self.clear_marker()
            return record


def main(value, source_sha):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'frontend-readiness-needs-linux-root')
    require(set(value) in ({'mode', 'binding'}, {'mode', 'binding', 'plan', 'intent'})
            and value['mode'] in ('readiness-plan', 'readiness-execute', 'readiness-observe'), 'readiness-mode-invalid')
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('readiness-worker-120s-deadline')))
    signal.alarm(120)
    try:
        adapter = Retirement(load_worker(value['binding']['worker']), value['binding'], source_sha)
        if value['mode'] == 'readiness-plan':
            require(set(value) == {'mode', 'binding'}, 'readiness-plan-takes-no-intent')
            return adapter.plan()
        require(set(value) == {'mode', 'binding', 'plan', 'intent'}, 'readiness-exact-plan-and-intent-required')
        return adapter.run(encoded(value['plan']), encoded(value['intent']), value['mode'] == 'readiness-observe')
    finally:
        signal.alarm(0)
