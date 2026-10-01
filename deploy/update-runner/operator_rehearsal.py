"""Root-reviewed maintenance rehearsal; never creates an update job or release.

--plan is read-only. --execute requires a provisioned root-only operator lease
controller and an exact private review. Interrupted operations remain held;
there is deliberately no automatic resume based on a phase label.
"""
import argparse
import contextlib
import gc
import http.cookiejar
import http.client
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True
import app_dependencies
from install import Driver, NoRedirect, STARTUP_FILES, candidate, protected, protected_selector, read_json
from recovery import (ALLOWANCE, RESERVE, InsufficientStorage, capacity, digest, inventory, inode_ids,
                      native_preflight, native_saved_state, prepare_independent, require, saved_state,
                      snapshot_closed, sync_dir, verification_scratch, write_json)
from workspace_key import read_workspace_key

OPERATOR_SOCKET = '/run/nova-update/operator.sock'
HELPERS = {'operator_rehearsal.py', 'install.py', 'recovery.py', 'codex_log_retention.py',
           'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs'}
OPERATOR_REJECTIONS = {
    'A fresh idle workspace identity is required.': 'fresh_idle_identity_required',
    'An existing installation must settle before operator maintenance.': 'installation_unsettled',
    'An operator maintenance lease is already active.': 'operator_lease_active',
    'A completed operator identity cannot be reused.': 'identity_already_used',
    'The original operator identity changed.': 'original_identity_changed',
    'The selected candidate or workspace changed.': 'selected_identity_changed',
    'This operator lease is not current.': 'lease_not_current',
    'Only an unchanged pre-stop lease can be cancelled.': 'cancellation_not_admitted',
    'The exact workspace and native process must acknowledge this hold.': 'native_hold_unconfirmed',
    'Operator maintenance phase cannot be skipped or reversed.': 'invalid_phase_transition',
    'A verified returned source and matching native hold are required.': 'returned_source_unconfirmed',
    'Operator acceptance does not match the original lease.': 'acceptance_identity_changed',
    'Operator authority is uncertain. Restart the controller to reconcile its durable record.': 'authority_uncertain',
    'Operator maintenance clock moved backwards.': 'clock_moved_backwards',
}


class OperatorSocket(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(OPERATOR_SOCKET)


def root_identity(path):
    info = path.lstat()
    require(path.is_dir() and not path.is_symlink(), 'The workspace role must be an ordinary directory.')
    return {'device': info.st_dev, 'inode': info.st_ino}


def fixed_uuid(value):
    require(isinstance(value, str) and str(uuid.UUID(value)) == value, 'Invalid exact maintenance identity.')
    return value


def allocated_metadata(root):
    """Observed allocation only; no file contents/database connections or links followed."""
    device = root.lstat().st_dev
    pending, seen, total = [root], set(), 0
    while pending:
        path = pending.pop()
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue  # Live observation can race disposable runtime files.
        require(info.st_dev == device, 'Startup allocation crossed an unreviewed filesystem.')
        if path.is_symlink():
            continue
        if path.is_dir():
            pending.extend(path.iterdir())
        elif path.is_file() and (info.st_dev, info.st_ino) not in seen:
            seen.add((info.st_dev, info.st_ino)); total += info.st_blocks * 512
    return total


def loaded_workspace_guard(service, workspace):
    response = json.loads(subprocess.check_output(['/usr/bin/busctl', '--json=short', 'call', 'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit', 's', service], text=True, timeout=10))
    require(response.get('type') == 'o' and len(response.get('data', [])) == 1, 'Cannot identify the actual systemd unit.')
    unit = response['data'][0]
    response = json.loads(subprocess.check_output(['/usr/bin/busctl', '--json=short', 'get-property', 'org.freedesktop.systemd1',
        unit, 'org.freedesktop.systemd1.Unit', 'Conditions'], text=True, timeout=10))
    require(response.get('type') == 'a(sbbsi)' and any(len(item) == 5 and item[0] == 'ConditionPathIsDirectory'
            and item[1] is False and item[2] is False and item[3] == str(workspace) for item in response.get('data', [])),
            'A loaded persistent exact-workspace startup guard is required.')


class Rehearsal(Driver):
    """Reuse maintained acceptance/closure/verifiers, never Driver.run/result/switch.

    The inherited host helpers use the names job_id and release for their local
    startup records. Here job_id is explicitly the operator lease UUID, and the
    version adapter describes only the unchanged prior app. Neither is written
    to an installation journal, feed, request, result or latest-update selector.
    """
    def __init__(self, review_path):
        super().__init__(review_path)
        self.review_path = review_path
        self.sequence = 0
        self.leased = False
        self.phase = 'unstarted'
        self.roles = {}
        self.startup_allocations = []
        self.startup_budgets = []
        self.startup_budget = None
        self.release_publication_started = False
        self.release_confirmed = False
        self.request_failure_recorded = False

    def request_failure(self, action, status, outcome, reason):
        # Keep the first failure, before status/cancel reconciliation can itself
        # fail. Never retain a response body, transport exception, or owner data.
        if self.request_failure_recorded:
            return
        path = self.output / 'operator-request-failure.json'
        require(not path.exists(), 'The original operator request failure must be retained.')
        write_json(path, {'format': 1, 'kind': 'operator-request-failure', 'leaseId': self.job_id,
                         'candidateId': self.prior_id, 'workspaceEpoch': self.expected_prior['workspaceEpoch'],
                         'action': action, 'httpStatus': status, 'outcome': outcome, 'reason': reason})
        self.request_failure_recorded = True

    def operator(self, action, value=None):
        require(action in {'status', 'enter', 'phase', 'release', 'cancel'}, 'Unsupported operator action.')
        protected(pathlib.Path(OPERATOR_SOCKET).parent, True)
        info = pathlib.Path(OPERATOR_SOCKET).lstat()
        require(info.st_uid == info.st_gid == 0 and info.st_mode & 0o777 == 0o600 and pathlib.Path(OPERATOR_SOCKET).is_socket(),
                'Operator maintenance requires its root-only socket.')
        client = OperatorSocket('localhost', timeout=5)
        status = None
        outcome, reason = 'uncertain', 'transport_failure'
        try:
            client.request('POST', '/v1/' + action, body=json.dumps(value or {}).encode(), headers={'Content-Type': 'application/json'})
            response = client.getresponse()
            status = response.status
            raw = response.read(8193)
            outcome, reason = 'uncertain', 'invalid_response'
            require(len(raw) <= 8192, 'The operator controller response exceeded its bound.')
            result = json.loads(raw)
            if status != 200:
                message = result.get('message') if isinstance(result, dict) else None
                reason = OPERATOR_REJECTIONS.get(message, 'unrecognized_controller_response') if isinstance(message, str) else 'unrecognized_controller_response'
                # A 5xx or unrecognized body may follow a committed lease. A
                # known 409 is a refusal, but never authorizes request replay.
                outcome = 'rejected' if status == 409 and reason in OPERATOR_REJECTIONS.values() else 'uncertain'
                raise RuntimeError('Operator request failed (HTTP ' + str(status) + '; ' + reason + ').')
            require(isinstance(result, dict) and result.get('format') == 1, 'Invalid operator status.')
            return result
        except Exception:
            self.request_failure(action, status, outcome, reason)
            raise
        finally:
            client.close()

    def controller_hold(self):
        result = self.operator('status')
        lease = result.get('lease') or {}
        require(lease.get('id') == self.job_id and lease.get('candidateId') == self.prior_id
                and lease.get('workspaceEpoch') == self.expected_prior['workspaceEpoch']
                and lease.get('phase') not in {'releasing', 'released', 'cancelled'},
                'The exact operator maintenance authority is not retained.')
        return result

    def wait_for_fresh_admission(self):
        """Observe a new real heartbeat, not the unknown age of an initial true.

        The idle app beats every 30s; the controller correctly admits only beats
        under 10s. Observe false -> true within two seconds using fast replies,
        then let the single enter request recheck the authoritative identity and
        freshness. No synthetic beat, session, feed check, or lease is written.
        """
        require(self.process_identity() == self.source_process,
                'The admitted source restarted before operator entry.')
        deadline = time.monotonic() + 45
        previous = None
        while time.monotonic() < deadline:
            started = time.monotonic()
            state = self.operator('status')
            observed = time.monotonic()
            lease = state.get('lease')
            valid = (type(state.get('freshHeartbeat')) is bool and state.get('held') is False
                     and (lease is None or isinstance(lease, dict) and lease.get('phase') in {'released', 'cancelled'}))
            if not valid:
                self.request_failure('admission', None, 'not_attempted', 'admission_status_not_idle')
                raise RuntimeError('Operator admission requires an unchanged idle controller.')
            elapsed = observed - started
            require(elapsed >= 0, 'The operator admission clock moved backwards.')
            if (observed < deadline and elapsed <= 1 and state['freshHeartbeat'] and previous is not None
                    and previous[0] is False and 0 <= observed - previous[1] <= 2):
                return
            previous = (state['freshHeartbeat'], observed) if elapsed <= 1 else None
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(0.5, remaining))
        self.request_failure('admission', None, 'not_attempted', 'new_heartbeat_not_observed')
        raise RuntimeError('No newly observed idle heartbeat within the operator admission deadline.')

    def mark(self, phase):
        self.controller_hold()
        return self.operator('phase', {'leaseId': self.job_id, 'phase': phase})

    def record(self, phase, **details):
        self.sequence += 1
        observed = {}
        for role, path in self.roles.items():
            observed[role] = root_identity(path) if path.exists() and not path.is_symlink() else None
        write_json(self.output / ('phase-%03d.json' % self.sequence),
                   {'format': 1, 'kind': 'operator-rehearsal-phase', 'leaseId': self.job_id,
                    'candidateId': self.prior_id, 'workspaceEpoch': self.expected_prior['workspaceEpoch'],
                    'phase': phase, 'roles': observed, **details})
        self.phase = phase

    def validate_operator(self):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'Use the provisioned Linux root maintenance host.')
        protected(self.review_path, private=True)
        review = self.review = read_json(self.review_path, 1024 * 1024)
        fields = {'format', 'kind', 'leaseId', 'candidateId', 'workspaceEpoch', 'novaVersion', 'agentVersion',
                  'hostConfiguration', 'baselineDirectory', 'baselineManifestSha256', 'labParent',
                  'startupGuardFile', 'startupGuardSha256', 'startupBarrier', 'helperHashes', 'nodeSha256',
                  'sourceDependencies', 'sourceHostHashes'}
        require(set(review) == fields and review['format'] == 1 and review['kind'] == 'operator-rehearsal-review',
                'Unexpected operator rehearsal review.')
        self.job_id = fixed_uuid(review['leaseId'])
        self.prior_id = self.target_id = review['candidateId']
        require(re.fullmatch('[a-f0-9]{64}', self.prior_id), 'Invalid reviewed prior candidate.')
        self.expected_prior = {'candidateId': self.prior_id, 'workspaceEpoch': fixed_uuid(review['workspaceEpoch'])}
        self.from_engine = self.to_engine = self.active_engine = review['agentVersion']
        require(self.active_engine == '2026.9.6', 'This rehearsal qualifies only the reviewed unchanged 2026.9.6 engine.')
        require(re.fullmatch(r'\d+\.\d+\.\d+', review['novaVersion']), 'Invalid reviewed prior version.')
        self.release = {'novaVersion': review['novaVersion'], 'compatibility': {'fromNovaVersion': review['novaVersion']},
                        'recovery': {'readinessTimeoutSeconds': 300}}
        require(set(review['helperHashes']) == HELPERS, 'All rehearsal and verifier helpers must be pinned.')
        for name, expected in review['helperHashes'].items():
            protected(self.bundle / name, private=True)
            require(re.fullmatch('[a-f0-9]{64}', expected) and digest(self.bundle / name) == expected, 'Reviewed operator helper changed.')
        host_path = pathlib.Path(review['hostConfiguration'])
        protected(host_path)
        self.host = read_json(host_path, 65536)
        runner_path = host_path.with_name('runner.json')
        protected(runner_path, private=True)
        self.settings = read_json(runner_path, 65536)
        fields = {'format', 'serviceName', 'serviceUser', 'nodePath', 'healthPort', 'dependencyDirectory',
                  'recoveryDirectory', 'baselineDirectory', 'protectedFiles', 'workspaceKeyCredential'}
        require(set(self.settings) == fields and self.settings['format'] == 1, 'Rehearsal requires the reviewed derived-state runner config.')
        require(re.fullmatch(r'[a-zA-Z0-9_-]+\.service', self.settings['serviceName'])
                and isinstance(self.settings['healthPort'], int) and 1024 <= self.settings['healthPort'] <= 65535,
                'Invalid reviewed service identity.')
        self.data = pathlib.Path(self.host['workspaceDirectory'])
        self.releases = pathlib.Path(self.host['releaseDirectory'])
        self.current = pathlib.Path(self.host['appCurrent'])
        self.runtime_root = pathlib.Path(self.host['runtimeDirectory'])
        self.agent = pathlib.Path(self.host['agentDirectory'])
        self.agent_node = pathlib.Path(self.host['agentNodePath'])
        self.node = pathlib.Path(self.settings['nodePath'])
        self.recovery_root = pathlib.Path(self.settings['recoveryDirectory'])
        self.lab_parent = pathlib.Path(review['labParent'])
        for path in (self.releases, self.runtime_root, self.recovery_root, self.lab_parent):
            protected(path, True)
        require(self.lab_parent.stat().st_mode & 0o077 == 0, 'The rehearsal lab parent must be root-private.')
        require(self.data.resolve(strict=True) == self.data and not self.data.is_symlink(), 'The original workspace was redirected.')
        for left, right in ((self.data, self.recovery_root), (self.data, self.lab_parent), (self.recovery_root, self.lab_parent)):
            require(not left.is_relative_to(right) and not right.is_relative_to(left), 'Rehearsal, recovery and live roots must be separate.')
        for root in (pathlib.Path(self.host['stateDirectory']), self.releases, self.runtime_root, host_path.parent):
            require(not self.lab_parent.is_relative_to(root) and not root.is_relative_to(self.lab_parent),
                    'Mutable rehearsal trees must remain outside controller, release, runtime and configuration roots.')
        require(self.data.stat().st_dev == self.data.parent.stat().st_dev == self.recovery_root.stat().st_dev == self.lab_parent.stat().st_dev,
                'Rehearsal and recovery must use the live filesystem.')
        require(self.current.is_symlink() and self.current.lstat().st_uid == 0, 'The app selector is not root-owned.')
        self.prior = self.target = self.current.resolve(strict=True)
        require(self.prior.parent == self.releases, 'The unchanged prior release left its protected root.')
        self.prior_manifest = candidate(self.prior, self.prior_id, review['novaVersion'])
        require(set(review['sourceHostHashes']) == {'scripts/host.mjs', 'scripts/candidate.mjs'}, 'Pin both prior startup scripts.')
        for name, expected in review['sourceHostHashes'].items():
            protected(self.prior / name)
            require(digest(self.prior / name) == expected, 'Prior startup script changed.')
        actual = {item['path']: item['sha256'] for item in self.prior_manifest['artifacts']}
        require(STARTUP_FILES <= set(review['startupBarrier']) and all(actual.get(k) == v for k, v in review['startupBarrier'].items()),
                'The operator startup barrier is not bound to the exact prior artifacts.')
        self.pair = {'startupBarrier': {'format': 1, 'prior': review['startupBarrier'], 'target': review['startupBarrier']}}
        self.prior_agent = protected_selector(self.agent, self.runtime_root, True) if self.agent.is_symlink() else self.agent
        self.prior_agent_node = protected_selector(self.agent_node, self.runtime_root, False) if self.agent_node.is_symlink() else self.agent_node
        protected(self.prior_agent, True); protected(self.prior_agent_node); protected(self.node)
        require(read_json(self.prior_agent / 'package.json')['version'] == self.active_engine and digest(self.node) == review['nodeSha256'],
                'The reviewed engine or Node executable changed.')
        self.agent_identity = inventory(self.prior_agent)[0]
        self.runtime_node_hash, self.agent_node_hash = digest(self.node), digest(self.prior_agent_node)
        self.dependencies = (self.prior / 'node_modules').resolve(strict=True)
        require(app_dependencies.inspect_retained_dependencies(self.dependencies) == review['sourceDependencies'], 'Actual prior dependencies changed.')
        self.dependency_identity = inventory(self.dependencies)[0]
        self.config_files = [pathlib.Path(p) for p in self.settings['protectedFiles']]
        require(1 <= len(self.config_files) <= 16 and len(set(self.config_files)) == len(self.config_files), 'Invalid protected configuration set.')
        for path in self.config_files:
            protected(path)
            require(not path.is_relative_to(self.data) and not path.is_relative_to(self.releases), 'Protected configuration must remain outside replacements.')
        self.config_hashes = {str(path): digest(path) for path in self.config_files}
        self.workspace_key_credential = pathlib.Path(self.settings['workspaceKeyCredential'])
        protected(self.workspace_key_credential, private=True)
        require(self.workspace_key_credential in self.config_files and self.workspace_key_credential.stat().st_size == 32
                and self.workspace_key_credential.stat().st_nlink == 1, 'The wrapping credential needs independent retained coverage.')
        guard = pathlib.Path(review['startupGuardFile'])
        require(guard in self.config_files and digest(guard) == review['startupGuardSha256'], 'The retained missing-workspace guard changed.')
        loaded_workspace_guard(self.settings['serviceName'], self.data)
        self.baseline = pathlib.Path(review['baselineDirectory'])
        protected(self.baseline, True, True)
        require(self.baseline.parent == self.recovery_root, 'The deduplication generation left the protected recovery root.')
        manifest = self.baseline / ('snapshot-manifest.json' if (self.baseline / 'snapshot-manifest.json').exists() else 'linked-snapshot-source.json')
        require(digest(manifest) == review['baselineManifestSha256'] == read_json(self.baseline / 'snapshot-verified.json')['manifestSha256'],
                'The pinned deduplication manifest changed.')
        require(inventory(self.baseline / 'workspace')[0] == read_json(manifest, 64*1024**2), 'The old deduplication generation changed.')
        self.output = self.lab_parent / ('rehearsal-' + self.job_id)
        self.recovery = self.recovery_root / ('operator-rehearsal-' + self.job_id)
        self.restore = self.output / 'restored-workspace'
        self.original = self.output / 'original-workspace'
        self.trial = self.output / 'trial-workspace'
        self.roles = {'live': self.data, 'original': self.original, 'restore': self.restore, 'trial': self.trial}
        require(not self.output.exists() and not self.output.is_symlink() and not self.recovery.exists(), 'Retain and review an existing rehearsal; never replay it.')
        self.origin = 'http://127.0.0.1:' + str(self.settings['healthPort'])
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.client_candidate = None
        context, health = self.api('access/context'), self.api('health')
        require(context.get('workspaceEpoch') == self.expected_prior['workspaceEpoch'] and health.get('candidateId') == self.prior_id
                and health.get('status') == 'ready' and health.get('version') == review['novaVersion'], 'The read-only prior identity changed.')
        native_preflight(self.data, self.expected_prior['workspaceEpoch'], self.active_engine)
        self.verify_configuration()
        self.source_process = self.process_identity()
        return {'format': 1, 'kind': 'operator-rehearsal-plan', 'candidateId': self.prior_id,
                'workspaceEpoch': self.expected_prior['workspaceEpoch'], 'leaseId': self.job_id,
                'threeHeldStarts': True, 'closedCapacityRequired': True, 'readOnly': True}

    def process_identity(self):
        pid = subprocess.check_output(['/usr/bin/systemctl', 'show', self.settings['serviceName'], '--property=MainPID', '--value'], text=True, timeout=10).strip()
        require(pid.isdigit() and int(pid) > 1, 'The exact prior process is not running.')
        process = pathlib.Path('/proc') / pid
        state = (process/'stat').read_bytes()
        require(len(state) <= 4096, 'Process identity exceeds its bound.')
        ticks = int(state[state.rfind(b')')+2:].split()[19])
        require((process/'exe').resolve(strict=True) == self.node and (process/'cwd').resolve(strict=True) == self.prior,
                'The prior process is not the exact reviewed code and Node mapping.')
        with (process/'environ').open('rb') as source:
            environment = source.read(256*1024+1)
        require(len(environment) <= 256*1024, 'Process authority environment exceeds its bound.')
        parts = environment.split(b'\0')
        require([value for value in parts if value.startswith(b'E3_UPDATE_SOCKET=')] == [b'E3_UPDATE_SOCKET=/run/nova-update/control.sock']
                and [value for value in parts if value.startswith(b'E3_DATA_DIR=')] == [b'E3_DATA_DIR='+str(self.data).encode()],
                'The prior process is not bound to the exact controller and workspace.')
        require((process/'stat').read_bytes().split(b')')[-1].split()[19] == str(ticks).encode(), 'The observed prior process changed.')
        return {'pid': int(pid), 'startTicks': ticks}

    def verify_configuration(self):
        require(self.current.resolve(strict=True) == self.prior, 'Operator rehearsal cannot change the selected application.')
        candidate(self.prior, self.prior_id, self.review['novaVersion'])
        for name, expected in self.review['sourceHostHashes'].items():
            require(digest(self.prior/name) == expected, 'Reviewed prior startup bytes changed.')
        return super().verify_configuration()

    def prepare_startup_budget(self):
        """Budget only unallocated growth at this exact stopped lifecycle boundary."""
        self.require_stopped()
        live = root_identity(self.data)
        absent = lambda path: not path.exists() and not path.is_symlink()
        if self.phase == 'capacity-refused':
            require(live == self.source_root and not self.workspace_mutated
                    and all(absent(path) for path in (self.original, self.restore, self.trial, self.recovery)),
                    'Unchanged startup must precede every snapshot or workspace replacement.')
            basis = 'unchanged-original-no-copy-planned'
        elif self.phase == 'trial-start-intent':
            require(live == self.trial_root and root_identity(self.original) == self.source_root
                    and absent(self.restore) and absent(self.trial) and (self.recovery / 'snapshot-manifest.json').is_file(),
                    'Trial startup requires the allocated verified snapshot, trial and preserved original.')
            basis = 'verified-trial-and-preserved-original-already-allocated'
        elif self.phase in {'return-original-complete', 'returned-original-retention-verified'}:
            require(live == self.source_root and root_identity(self.trial) == self.trial_root
                    and absent(self.original) and absent(self.restore) and (self.recovery / 'snapshot-manifest.json').is_file(),
                    'Returned startup requires the allocated verified snapshot and retained trial.')
            basis = 'returned-original-and-retained-trial-already-allocated'
        else:
            raise RuntimeError('No reviewed allocation phase permits this startup.')
        # These three maintained paths allocate no further full workspace copy.
        # Existing copies are already reflected in actual free bytes. The two
        # established allowances remain reserved for verification/operation.
        allocated = allocated_metadata(self.data)
        free = shutil.disk_usage(self.recovery_root).free
        floor = RESERVE + 2 * ALLOWANCE
        self.require_stopped()
        require(root_identity(self.data) == live, 'Stopped startup workspace changed during allocation review.')
        attempt = getattr(self, 'startup_attempt', 0) + 1
        record = {'format': 1, 'kind': 'operator-startup-capacity-budget', 'leaseId': self.job_id,
                  'candidateId': self.prior_id, 'workspaceEpoch': self.expected_prior['workspaceEpoch'],
                  'attempt': attempt, 'phase': self.phase, 'sourceRootIdentity': live,
                  'observedAtSeconds': time.time_ns() // 1_000_000_000,
                  'closedAllocatedBytes': allocated, 'freeBytesBeforeStart': free,
                  'remainingCopyBytes': 0, 'copyAccounting': basis,
                  'reserveBytes': RESERVE, 'allowanceBytes': 2 * ALLOWANCE,
                  'minimumFreeBytes': floor, 'startupGrowthBudgetBytes': max(0, free - floor),
                  'permitted': free > floor}
        path = self.output / ('startup-' + str(attempt) + '-capacity.json')
        write_json(path, record)  # Exclusive: refused or uncertain attempts cannot be rebudgeted.
        self.startup_budgets.append({**record, 'receiptSha256': digest(path)})
        require(record['permitted'], 'Actual stopped free space cannot preserve the startup operating reserve.')
        self.startup_budget = self.startup_budgets[-1]

    def service(self, action):
        if action == 'start':
            self.controller_hold(); self.verify_configuration()
            loaded_workspace_guard(self.settings['serviceName'], self.data)
            require(root_identity(self.data) in (self.source_root, getattr(self, 'trial_root', None)),
                    'Refuse to start an unknown workspace role.')
            self.prepare_startup_budget()
        return super().service(action)

    def wait_acceptance(self, expected, version, *, restored_prior=False):
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            if self.launched is not None:
                budget = self.startup_budget
                require(budget is not None and budget['attempt'] == self.launched['attempt'],
                        'Startup allocation requires this exact immutable stopped budget.')
                allocated = allocated_metadata(self.data)
                observation = {'attempt': self.launched['attempt'], 'allocatedBytes': allocated,
                               'growthBytes': max(0, allocated - budget['closedAllocatedBytes']),
                               'freeBytes': shutil.disk_usage(self.recovery_root).free}
                self.startup_allocations.append(observation)
                require(len(self.startup_allocations) <= 1200, 'Startup observation exceeded its bounded history.')
                growth_exceeded = observation['growthBytes'] > budget['startupGrowthBudgetBytes']
                reserve_exceeded = observation['freeBytes'] < budget['minimumFreeBytes']
                if growth_exceeded or reserve_exceeded:
                    # Only this exact reviewed startup can be stopped without
                    # ordinary readiness; unknown running work remains held.
                    # Retain the live observation before stop changes WAL and
                    # temporary allocations. Diagnostic failure must not prevent
                    # the existing independently qualified protective stop.
                    try:
                        write_json(self.output / ('startup-' + str(self.launched['attempt']) + '-capacity-refusal.json'),
                                   {'format': 1, 'kind': 'operator-startup-capacity-refusal', 'leaseId': self.job_id,
                                    'candidateId': expected, 'workspaceEpoch': self.expected_prior['workspaceEpoch'],
                                    'observedAtSeconds': time.time_ns() // 1_000_000_000,
                                    **observation, 'closedAllocatedBytes': budget['closedAllocatedBytes'],
                                    'startupGrowthBudgetBytes': budget['startupGrowthBudgetBytes'],
                                    'capacityReceiptSha256': budget['receiptSha256'],
                                    'minimumFreeBytes': budget['minimumFreeBytes'],
                                    'growthLimitExceeded': growth_exceeded, 'reserveLimitExceeded': reserve_exceeded,
                                    'reason': 'growth_and_reserve_limits' if growth_exceeded and reserve_exceeded else
                                              'growth_limit' if growth_exceeded else 'reserve_limit',
                                    'observedBeforeStop': True, 'stopConfirmed': False})
                    finally:
                        self.qualify_started_barrier(self.prior, expected, version)
                        self.service('stop'); self.require_stopped()
                    raise RuntimeError('Observed startup growth exceeded its reviewed allowance; the original and evidence remain held.')
            try:
                accepted = self.acceptance(expected, version, restored_prior=restored_prior)
                require(self.before is None or (accepted['accounts'] == self.before['accounts'] and accepted['epoch'] == self.before['epoch']),
                        'Returned account or workspace identity changed.')
                self.startup_ready(expected, accepted['epoch'])
                accepted['process'] = self.process_identity()
                return accepted
            except Exception:
                time.sleep(1)
        raise RuntimeError('Exact operator-held prior readiness did not pass its bound.')

    def move_role(self, source, target, expected, label):
        self.require_stopped(); self.controller_hold(); self.verify_configuration()
        require(root_identity(source) == expected and not target.exists() and not target.is_symlink(), 'Workspace role identity is ambiguous; retain the hold.')
        self.record(label + '-intent', source=str(source), destination=str(target), expectedRoot=expected,
                    snapshotManifestSha256=digest(self.recovery / 'snapshot-manifest.json'))
        self.workspace_mutated = True
        os.rename(source, target)
        sync_dir(source.parent)
        if source.parent != target.parent:
            sync_dir(target.parent)
        require(root_identity(target) == expected, 'Renamed workspace root identity changed.')
        self.record(label + '-complete')

    def proof(self, outcome, accepted):
        status = self.controller_hold()
        require(status.get('held') is True and status['lease']['phase'] == 'checking', 'Final operator acceptance requires an acknowledged held source.')
        folder = pathlib.Path(self.host['stateDirectory']) / 'operator-maintenance' / self.job_id
        protected(folder, True, True)
        evidence = {'format': 1, 'kind': 'operator-rehearsal-evidence', 'leaseId': self.job_id,
                    'candidateId': self.prior_id, 'workspaceEpoch': self.before['epoch'], 'outcome': outcome,
                    'reviewSha256': digest(self.review_path), 'phase': self.phase, 'configurationHashes': self.config_hashes,
                    'sourceRootIdentity': self.source_root, 'returnedRootIdentity': root_identity(self.data),
                    'workspaceMutationAttempted': self.workspace_mutated, 'nodeSha256': self.runtime_node_hash,
                    'sourceCandidateId': self.prior_id, 'heldRunningAllocatedBytes': self.held_allocated,
                    'closedAllocatedBytes': self.closed_allocated, 'startupGrowthAllowanceBytes': self.startup_growth,
                    'startupAllocationObservations': self.startup_allocations, 'startupCapacityBudgets': self.startup_budgets,
                    'startupGrowthDisclosure': 'Initial fit estimates held-to-closed growth plus 128 MiB. Each actual restart uses its own stopped allocation and free-space budget, preserving the reserve and two allowances; observed samples are not an absolute future bound.'}
        if outcome == 'rehearsed':
            evidence['snapshotManifestSha256'] = digest(self.recovery / 'snapshot-manifest.json')
        else:
            require(not self.workspace_mutated and root_identity(self.data) == self.source_root, 'Unchanged cannot describe a workspace rename or replacement.')
        write_json(folder / 'prior-acceptance.json', self.before)
        write_json(folder / 'returned-acceptance.json', accepted)
        write_json(folder / 'rehearsal.json', evidence)
        proof = {'format': 1, 'kind': 'operator-maintenance-acceptance', 'leaseId': self.job_id,
                 'candidateId': self.prior_id, 'workspaceEpoch': self.before['epoch'], 'outcome': outcome,
                 'evidenceSha256': digest(folder / 'rehearsal.json'), 'priorAcceptanceSha256': digest(folder / 'prior-acceptance.json'),
                 'returnedAcceptanceSha256': digest(folder / 'returned-acceptance.json'), 'accountsVerified': True, 'healthVerified': True}
        proof.update({'savedWorkVerified': True, 'recoveryVerified': True} if outcome == 'rehearsed'
                     else {'unchangedVerified': True, 'reason': 'insufficient_storage'})
        write_json(folder / 'acceptance.ready.json', proof)
        require(not (folder/'acceptance.json').exists() and not (folder/'acceptance.json').is_symlink(),
                'Retain an existing operator acceptance; never overwrite it.')
        os.replace(folder / 'acceptance.ready.json', folder / 'acceptance.json'); sync_dir(folder)
        self.release_publication_started = True
        self.operator('release', {'leaseId': self.job_id})
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            state = self.operator('status')
            lease = state.get('lease') or {}
            require(lease.get('id') == self.job_id, 'The original operator lease changed during native resume.')
            if lease.get('phase') == 'released':
                self.release_confirmed = True
                self.record('released', outcome=outcome)
                return
            require(lease.get('phase') == 'releasing', 'Native resume did not retain its original operator authority.')
            time.sleep(1)
        raise RuntimeError('Native resume did not settle; preserve the operator evidence.')

    def run_rehearsal(self):
        self.validate_operator()
        self.output.mkdir(mode=0o700)
        sync_dir(self.output.parent)
        self.source_root = root_identity(self.data)
        self.record('preflight-passed')
        try:
            self.wait_for_fresh_admission()
            self.operator('enter', {'leaseId': self.job_id, **self.expected_prior})
            self.leased = True
            self.before = self.wait_acceptance(self.prior_id, self.review['novaVersion'])
            require(self.process_identity() == self.source_process, 'The admitted source restarted after read-only review.')
            prior_acceptance = self.output / 'prior-acceptance.json'
            write_json(prior_acceptance, self.before)
            self.held_allocated = allocated_metadata(self.data)
            self.record('held', priorAcceptanceSha256=digest(prior_acceptance),
                        acceptanceProvenance='actual-held-before-first-stop', sourceProcess=self.source_process)
            self.mark('stopping'); self.record('stopping-intent')
            self.stop_attempted = True
            self.service('stop'); self.require_stopped(); self.mark('stopped')
            self.record('stopped')
            source = inventory(self.data)
            baseline = inventory(self.baseline / 'workspace')
            self.closed_allocated = sum(item['allocated'] for item in source[1].values())
            self.startup_growth = max(0, self.held_allocated - self.closed_allocated) + ALLOWANCE
            try:
                plan = capacity(*source, *baseline, shutil.disk_usage(self.recovery_root).free)
                plan = {**plan, 'heldRunningAllocatedBytes': self.held_allocated, 'closedAllocatedBytes': self.closed_allocated,
                        'startupGrowthAllowanceBytes': self.startup_growth,
                        'requiredFreeBytes': plan['requiredFreeBytes'] + self.startup_growth}
                if plan['freeBytes'] < plan['requiredFreeBytes']:
                    raise InsufficientStorage('Closed snapshot, independent copy, explicit startup growth and operating reserve do not fit.')
            except InsufficientStorage:
                require(inventory(self.data) == source, 'The unchanged closed original changed during capacity review.')
                self.verify_configuration(); self.record('capacity-refused')
                del source, baseline; gc.collect()
                self.mark('checking'); self.service('start')
                accepted = self.wait_acceptance(self.prior_id, self.review['novaVersion'])
                self.verify_configuration(); self.proof('unchanged', accepted)
                return
            del source, baseline; gc.collect()
            write_json(self.output / 'closed-capacity.json', plan)
            self.recovery.mkdir(mode=0o700); sync_dir(self.recovery_root); self.mark('snapshot')
            with verification_scratch(self.recovery_root):
                snapshot_closed(self.data, self.recovery / 'workspace', self.baseline / 'workspace', self.require_stopped)
                saved_state(self.recovery / 'workspace', self.data, restored=True)
                native_saved_state(self.recovery / 'workspace', self.data, self.before['epoch'], self.active_engine, self.active_engine)
                self.session_binding_key = read_workspace_key(self.recovery / 'workspace', self.workspace_key_credential, self.node, self.prior)
                for index, path in enumerate(self.config_files):
                    target = self.recovery / ('protected-' + str(index))
                    shutil.copy2(path, target)
                    require(digest(path) == digest(target), 'Protected snapshot copy changed.')
                    with target.open('rb') as saved:
                        os.fsync(saved.fileno())
                sync_dir(self.recovery)
                self.verify_configuration(); self.record('snapshot-verified')
                self.mark('restore')
                prepare_independent(self.recovery / 'workspace', self.restore, self.data, self.require_stopped)
                saved_state(self.recovery / 'workspace', self.restore, restored=True)
                native_saved_state(self.recovery / 'workspace', self.restore, self.before['epoch'], self.active_engine, self.active_engine,
                                   logical_workspace_root=self.data)
                self.trial_root = root_identity(self.restore)
                require(shutil.disk_usage(self.recovery_root).free >= RESERVE + 2 * ALLOWANCE + self.startup_growth,
                        'Reserve and explicit startup growth must fit before any workspace swap.')
                self.record('independent-copy-verified')
                self.move_role(self.data, self.original, self.source_root, 'preserve-original')
                self.move_role(self.restore, self.data, self.trial_root, 'select-trial')
                self.record('trial-start-intent'); self.service('start')
                self.wait_acceptance(self.prior_id, self.review['novaVersion'], restored_prior=True)
                self.mark('checking'); self.record('trial-ready')
                self.stop_for_retention(restored_prior=True); self.require_stopped()
                saved_state(self.recovery / 'workspace', self.data, restored=True); self.retained_native(); self.verify_configuration()
                require(inventory(self.original)[0] == read_json(self.recovery / 'snapshot-manifest.json', 64*1024**2),
                        'The preserved original changed while the trial ran.')
                self.record('trial-retention-verified')
                self.move_role(self.data, self.trial, self.trial_root, 'retain-trial')
                self.move_role(self.original, self.data, self.source_root, 'return-original')
                require(inventory(self.data)[0] == read_json(self.recovery / 'snapshot-manifest.json', 64*1024**2),
                        'The returned original is not the preserved source.')
                self.service('start'); self.wait_acceptance(self.prior_id, self.review['novaVersion'], restored_prior=True)
                self.stop_for_retention(restored_prior=True); self.require_stopped()
                saved_state(self.recovery / 'workspace', self.data, restored=True); self.retained_native(); self.verify_configuration()
                self.record('returned-original-retention-verified')
                self.service('start')
                accepted = self.wait_acceptance(self.prior_id, self.review['novaVersion'], restored_prior=True)
                self.verify_configuration()
                require(shutil.disk_usage(self.recovery_root).free >= RESERVE + ALLOWANCE, 'The returned source lacks its operating reserve.')
                write_json(self.recovery / 'acceptance.json', {'health': accepted['health'], 'agentVersion': self.active_engine,
                           'operatorRehearsalId': self.job_id, 'sourceReviewSha256': digest(self.review_path)})
                self.proof('rehearsed', accepted)
            self.cleanup_trial()
        except BaseException:
            if not self.stop_attempted:
                # A failed enter response can still have durably acquired the
                # same lease. Observe its exact identity; never assume absence.
                with contextlib.suppress(Exception):
                    state = self.operator('status')
                    lease = state.get('lease') or {}
                    if (lease.get('id') == self.job_id and lease.get('candidateId') == self.prior_id
                            and lease.get('workspaceEpoch') == self.expected_prior['workspaceEpoch']
                            and lease.get('phase') in {'entered', 'held'} and lease.get('stopMarked') is False):
                        self.operator('cancel', {'leaseId': self.job_id})
            with contextlib.suppress(Exception):
                failure_phase = ('cleanup-failed-after-release' if self.release_confirmed else
                                 'release-uncertain' if self.release_publication_started else 'failed-review')
                self.record(failure_phase, previousPhase=self.phase,
                            releasePublicationStarted=self.release_publication_started, releaseConfirmed=self.release_confirmed,
                            action='Review exact inode roles before any manual recovery; no automatic retry or lease release.')
            raise
        finally:
            if self.session_binding_key is not None:
                self.session_binding_key[:] = b'\0' * len(self.session_binding_key)
                self.session_binding_key = None

    def cleanup_trial(self):
        state = self.operator('status')
        require(state.get('lease', {}).get('id') == self.job_id and state['lease']['phase'] == 'released', 'Cleanup requires settled native lease release.')
        require(root_identity(self.data) == self.source_root and not self.original.exists(), 'The preserved original is not back in place.')
        protected(self.output, True, True)
        require(self.trial.parent == self.output and self.trial.resolve(strict=True) == self.trial
                and root_identity(self.trial) == self.trial_root, 'Only the exact newly created trial tree may be removed.')
        self.record('trial-cleanup-intent', expectedRoot=self.trial_root)
        shutil.rmtree(self.trial)
        sync_dir(self.output)
        self.record('complete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', type=pathlib.Path)
    mode.add_argument('--execute', type=pathlib.Path)
    mode.add_argument('--status', type=pathlib.Path)
    arguments = parser.parse_args()
    if arguments.status:
        print(json.dumps(rehearsal_status(arguments.status.resolve())))
        return
    instance = Rehearsal((arguments.plan or arguments.execute).resolve())
    if arguments.plan:
        print(json.dumps(instance.validate_operator()))
    else:
        instance.run_rehearsal()


def rehearsal_status(review_path):
    """Bounded physical evidence for manual review; no inferred recovery action."""
    protected(review_path, private=True)
    review = read_json(review_path, 1024*1024)
    lease_id = fixed_uuid(review['leaseId'])
    host_path = pathlib.Path(review['hostConfiguration']); protected(host_path)
    host = read_json(host_path, 65536)
    parent = pathlib.Path(review['labParent']); protected(parent, True, True)
    output = parent / ('rehearsal-' + lease_id); protected(output, True, True)
    phases = sorted(output.glob('phase-*.json'))
    require(0 < len(phases) <= 100 and all(re.fullmatch(r'phase-\d{3}\.json', p.name) for p in phases), 'Invalid bounded rehearsal history.')
    for path in phases:
        protected(path, private=True)
    first, last = read_json(phases[0]), read_json(phases[-1])
    require(first.get('leaseId') == last.get('leaseId') == lease_id, 'Rehearsal phase identity changed.')
    roles = {'live': pathlib.Path(host['workspaceDirectory']), 'original': output/'original-workspace',
             'restore': output/'restored-workspace', 'trial': output/'trial-workspace'}
    return {'format': 1, 'leaseId': lease_id, 'candidateId': review['candidateId'], 'workspaceEpoch': review['workspaceEpoch'],
            'lastPhase': last['phase'], 'originalRootIdentity': first['roles']['live'],
            'roles': {name: root_identity(path) if path.exists() and not path.is_symlink() else None for name,path in roles.items()},
            'automaticRecoveryPermitted': False,
            'action': 'Preserve the operator hold and all trees. Review exact identities and recorded rename intents before a separately reviewed manual recovery.'}


if __name__ == '__main__':
    main()
