"""Inert state-machine tests; no host, transport, controller or crypto calls."""
import contextlib
import copy
import importlib.util
import json
import pathlib
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('retirement_tested', HERE / 'scripts/release-frontend-readiness.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
WORKER = HERE / 'deploy/update-runner/frontend.py'
worker_raw = WORKER.read_bytes()
assert m.sha(worker_raw) == m.WORKER_SHA
w = types.ModuleType('maintained_frontend_fixture')
w.__file__ = str(WORKER)
exec(compile(worker_raw, str(WORKER), 'exec'), w.__dict__)

m.CONFIG_PATH = '/etc/nova-update/frontend.json'
m.WORKER_PATH = '/opt/nova-updater-2.3.0-' + 'a' * 12 + '/deploy/update-runner/frontend.py'
m.APP_PROCESS = '55555555-5555-4555-8555-555555555555'
m.OLD_OPERATION = '66666666-6666-4666-8666-666666666666'
m.UI_OPERATION = '77777777-7777-4777-8777-777777777777'
m.FRONTEND_ID = 'f' * 64
m.MANIFEST_SHA = m.sha(b'fixture-manifest')
m.BASE = {'candidateId': 'a' * 64, 'serviceInputsSha256': 'b' * 64, 'apiVersion': 1, 'schemaVersion': 55}
m.OLD_BASE = {**m.BASE, 'candidateId': 'c' * 64, 'serviceInputsSha256': 'd' * 64}
m.BUNDLED = {'id': m.BASE['candidateId'], 'version': '2.7.5', 'buildVersion': '1.0.302', 'source': 'bundled'}


class FakeIO:
    def __init__(self):
        self.files, self.events = {}, []
        self.time = 1000000
        self.signature_ok = True
        self.lease = None
        self.active = False
        self.process = m.APP_PROCESS
        self.controller = '11111111-1111-4111-8111-111111111111'
        self.epoch = '22222222-2222-4222-8222-222222222222'
        self.begin_loss = self.end_loss = self.remove_loss = None
        self.process_drift = False
        self.inode = 19
        self.locked = False
        self.fresh_after = self.time
        self.operator_held = False
        self.status_reads = 0

    def status(self, timeout):
        assert 0 < timeout <= 5
        self.status_reads += 1
        return {'format': 1, 'lease': None, 'held': self.operator_held,
                'freshHeartbeat': self.time >= self.fresh_after}

    def sleep(self, seconds):
        self.time += round(seconds * 1000)

    def read(self, path, maximum, private=False):
        if str(path) not in self.files:
            raise FileNotFoundError(str(path))
        raw = self.files[str(path)]
        assert len(raw) <= maximum
        return raw

    def protect(self, path, directory=False, private=False):
        pass

    def stat(self, path):
        return types.SimpleNamespace(st_dev=2049, st_ino=self.inode, st_mode=0o100644, st_uid=0,
            st_nlink=1, st_size=len(self.files[str(path)]), st_mtime_ns=100, st_ctime_ns=100)

    @contextlib.contextmanager
    def lock(self, path):
        assert path == m.STATE / 'worker.lock'
        assert not self.locked
        self.locked = True
        try:
            yield
        finally:
            self.locked = False

    def write(self, path, raw, private=True, replace=False):
        assert self.locked and private
        assert replace or str(path) not in self.files
        self.events.append(('write', str(path)))
        self.files[str(path)] = raw

    def remove(self, path):
        assert self.locked
        if path == m.SELECTOR:
            assert self.active and str(m.MARKER) in self.files
            assert self.record()['phase'] == 'retire-intent'
        else:
            assert path == m.MARKER and not self.active
            assert self.record()['phase'] in ('completed', 'refused')
        self.events.append(('remove', str(path)))
        del self.files[str(path)]
        if path == m.SELECTOR and self.remove_loss:
            self.remove_loss = None
            raise TimeoutError('lost-remove-response')

    def get(self, endpoint):
        if endpoint == 'access/context':
            return {'workspaceEpoch': self.epoch, 'recovery': False, 'recoveryLocal': False}
        assert endpoint == 'health'
        return {'application': 'nova-dream-edition-3', 'status': 'ready', **m.BASE,
                'version': '2.7.5', 'buildVersion': '1.0.302', 'processIdentity': self.process,
                'frontend': {**m.BUNDLED, **({'blocked': True} if str(m.SELECTOR) in self.files else {})}}

    def control(self, config, action, body):
        self.events.append((action, copy.deepcopy(body)))
        assert body['operationId'] == m.REPAIR_ID
        if action == 'begin':
            assert self.locked and str(m.MARKER) in self.files and self.record()['phase'] == 'begin-intent'
            assert body == {'operationId': m.REPAIR_ID, 'baseCandidateId': m.BASE['candidateId'],
                            'serviceInputsSha256': m.BASE['serviceInputsSha256'], 'workspaceEpoch': self.epoch}
            if self.begin_loss == 'before':
                self.begin_loss = None
                raise TimeoutError('lost-before-begin')
            if self.begin_loss == 'refused':
                self.begin_loss = None
                raise w.ControlRejected('rejected')
            self.active, self.lease = True, m.REPAIR_ID
            if self.process_drift:
                self.process = '33333333-3333-4333-8333-333333333333'
            if self.begin_loss == 'after':
                self.begin_loss = None
                raise TimeoutError('lost-after-begin')
        elif action == 'end':
            assert self.locked and self.record()['phase'] == 'end-intent'
            assert body == {'operationId': m.REPAIR_ID, 'leaseId': m.REPAIR_ID}
            self.active = False
            if self.end_loss:
                self.end_loss = None
                raise TimeoutError('lost-after-end')
        else:
            assert action == 'observe' and body == {'operationId': m.REPAIR_ID}
        return {'format': 1, 'operationId': m.REPAIR_ID, 'leaseId': self.lease,
                'leaseProcessIdentity': self.controller if self.lease else None,
                'active': self.active, **m.BASE, 'epoch': self.epoch, 'processIdentity': self.controller}

    def record(self):
        return json.loads(self.files[str(m.RECORD)])


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.io = FakeIO()
        self.config = {'format': 1, 'frontendDirectory': str(m.ROOT), 'stateDirectory': str(m.STATE)}
        self.raw_config = m.encoded(self.config)
        self.selector = {'format': 1, 'frontendId': m.FRONTEND_ID, 'manifestSha256': m.MANIFEST_SHA,
            'manifestPath': str(m.ROOT / 'manifests' / (m.MANIFEST_SHA + '.json')),
            'signaturePath': str(m.ROOT / 'manifests' / (m.MANIFEST_SHA + '.sig')), 'operationId': m.OLD_OPERATION}
        self.raw_selector = m.encoded(self.selector)
        self.manifest = {'base': copy.deepcopy(m.OLD_BASE), 'frontendVersion': '2.3.5', 'sequence': 1,
                         'files': [{'path': 'index.html', 'bytes': 3, 'sha256': 'a' * 64}]}
        self.raw_manifest, self.signature = b'fixture-manifest', b'x' * 64
        self.sequence = m.encoded({'format': 1, 'sequence': 1, 'manifestSha256': m.MANIFEST_SHA})
        m.CONFIG_SHA = m.sha(self.raw_config)
        self.patches = [patch.object(w, 'validate_config', lambda value: value),
                        patch.object(w.FrontendWorker, 'stored_manifest', self.stored),
                        patch.object(m.Retirement, 'operator_status', lambda _self, timeout: self.io.status(timeout))]
        for p in self.patches: p.start()
        original = {'format': 1, 'operationId': m.OLD_OPERATION, 'phase': 'completed', 'outcome': 'selected',
                    'configSha256': m.CONFIG_SHA, 'manifestSha256': m.MANIFEST_SHA, 'frontendId': m.FRONTEND_ID,
                    'targetSelector': self.selector, 'leaseId': m.OLD_OPERATION, 'health': m.OLD_BASE}
        self.io.files = {str(m.SELECTOR): self.raw_selector, m.CONFIG_PATH: self.raw_config,
                        m.WORKER_PATH: worker_raw, str(m.STATE / 'sequence.json'): self.sequence,
                        str(m.STATE / (m.OLD_OPERATION + '.json')): m.encoded(original)}
        self.binding = {'operationId': m.UI_OPERATION, 'runId': '88888888-8888-4888-8888-888888888888',
                        'baseCandidateId': m.BASE['candidateId'], 'serviceInputsSha256': m.BASE['serviceInputsSha256'],
                        'workspaceEpoch': self.io.epoch, 'baseVersion': '2.7.5',
                        'worker': {'path': m.WORKER_PATH, 'sha256': m.WORKER_SHA},
                        'config': {'path': m.CONFIG_PATH, 'sha256': m.CONFIG_SHA}}
        self.adapter = m.Retirement(w, self.binding, 'e' * 64, self.io, lambda: self.io.time,
                                   wait_clock=lambda: self.io.time / 1000, sleeper=self.io.sleep)
        m.REPAIR_ID = self.adapter.repair_id
        m.RECORD = self.adapter.record_path

    def tearDown(self):
        for p in reversed(self.patches): p.stop()

    def stored(self, retained, selector):
        self.assertIs(retained.io, self.io)
        self.assertEqual(retained.root, m.ROOT)
        self.assertEqual(selector, self.selector)
        if not self.io.signature_ok:
            raise RuntimeError('Frontend signature did not verify.')
        return self.raw_manifest, self.signature, self.manifest, {'index.html': b'abc'}

    def prepare(self):
        plan = m.encoded(self.adapter.plan())
        intent = m.encoded({'format': 1, 'kind': 'frontend-retirement-intent',
            'operationId': m.REPAIR_ID, 'planSha256': m.sha(plan),
            'adapterSha256': json.loads(plan)['sources']['adapterSha256'], 'execute': True})
        return plan, intent

    def count(self, action):
        return sum(1 for name, _ in self.io.events if name == action)

    def test_readonly_plan_and_complete_retirement_preserve_all_original_bytes(self):
        original = dict(self.io.files)
        plan, intent = self.prepare()
        self.assertEqual(self.io.files, original)
        result = self.adapter.run(plan, intent)
        self.assertEqual(result['phase'], 'completed')
        self.assertNotIn(str(m.MARKER), self.io.files)
        self.assertNotIn(str(m.SELECTOR), self.io.files)
        self.assertEqual(base64_decode(result['plan']['originalSelectorBase64']), self.raw_selector)
        for path, raw in original.items():
            if path != str(m.SELECTOR):
                self.assertEqual(self.io.files[path], raw)
        self.assertEqual((self.count('begin'), self.count('end')), (1, 1))
        self.adapter.run(plan, intent, resume=True)
        self.assertEqual((self.count('begin'), self.count('end')), (1, 1))

    def test_signature_or_old_base_mismatch_refuses_before_any_effect(self):
        self.io.signature_ok = False
        with self.assertRaisesRegex(RuntimeError, 'signature'):
            self.prepare()
        self.io.signature_ok = True
        self.manifest['base'] = copy.deepcopy(m.BASE)
        with self.assertRaisesRegex(RuntimeError, 'selector-base'):
            self.prepare()
        self.assertEqual(self.count('write'), 0)

    def test_current_marker_and_active_controller_conflicts_refuse(self):
        self.io.files[str(m.MARKER)] = b'other operation'
        with self.assertRaisesRegex(RuntimeError, 'unresolved-native'):
            self.prepare()
        del self.io.files[str(m.MARKER)]
        self.io.active, self.io.lease = True, '44444444-4444-4444-8444-444444444444'
        with self.assertRaisesRegex(RuntimeError, 'not-idle'):
            self.prepare()

    def test_process_drift_after_begin_prevents_retirement(self):
        plan, intent = self.prepare()
        self.io.process_drift = True
        with self.assertRaisesRegex(RuntimeError, 'workspace-or-process'):
            self.adapter.run(plan, intent)
        self.assertIn(str(m.SELECTOR), self.io.files)
        self.assertTrue(self.io.active)
        self.assertIn(str(m.MARKER), self.io.files)

    def test_lost_begin_response_adopts_original_lease_without_redispatch(self):
        plan, intent = self.prepare()
        self.io.begin_loss = 'after'
        with self.assertRaises(TimeoutError):
            self.adapter.run(plan, intent)
        self.assertEqual(self.io.record()['phase'], 'begin-intent')
        self.adapter.run(plan, intent, resume=True)
        self.assertEqual((self.count('begin'), self.count('end')), (1, 1))

    def test_unknown_begin_is_not_replayed(self):
        plan, intent = self.prepare()
        self.io.begin_loss = 'before'
        with self.assertRaises(TimeoutError):
            self.adapter.run(plan, intent)
        with self.assertRaisesRegex(RuntimeError, 'lease-needs-reconciliation'):
            self.adapter.run(plan, intent, resume=True)
        self.assertEqual(self.count('begin'), 1)
        self.assertIn(str(m.SELECTOR), self.io.files)

    def test_lost_end_response_is_adopted_without_second_end(self):
        plan, intent = self.prepare()
        self.io.end_loss = True
        with self.assertRaises(TimeoutError):
            self.adapter.run(plan, intent)
        self.assertEqual(self.io.record()['phase'], 'end-intent')
        self.assertIn(str(m.MARKER), self.io.files)
        self.adapter.run(plan, intent, resume=True)
        self.assertEqual(self.count('end'), 1)

    def test_lost_pointer_remove_response_adopts_absence_and_finishes(self):
        plan, intent = self.prepare()
        self.io.remove_loss = True
        with self.assertRaises(TimeoutError):
            self.adapter.run(plan, intent)
        self.assertEqual(self.io.record()['phase'], 'retire-intent')
        self.adapter.run(plan, intent, resume=True)
        self.assertEqual(sum(1 for event in self.io.events if event == ('remove', str(m.SELECTOR))), 1)

    def test_expired_plan_changed_pointer_or_source_refuses_before_begin(self):
        plan, intent = self.prepare()
        self.io.time += 120001
        with self.assertRaisesRegex(RuntimeError, 'expired'):
            self.adapter.run(plan, intent)
        self.io.time -= 120001
        self.io.inode += 1
        with self.assertRaisesRegex(RuntimeError, 'plan-changed'):
            self.adapter.run(plan, intent)
        self.io.inode -= 1
        self.io.files[m.WORKER_PATH] = b'changed worker'
        with self.assertRaisesRegex(RuntimeError, 'authority-changed'):
            self.adapter.run(plan, intent)
        self.assertEqual(self.count('begin'), 0)

    def test_acknowledged_refusal_clears_only_owned_marker(self):
        plan, intent = self.prepare()
        self.io.begin_loss = 'refused'
        self.assertEqual(self.adapter.run(plan, intent)['phase'], 'refused')
        self.assertIn(str(m.SELECTOR), self.io.files)
        self.assertNotIn(str(m.MARKER), self.io.files)

    def test_waits_for_real_fresh_heartbeat_before_only_begin(self):
        plan, intent = self.prepare()
        self.io.fresh_after = self.io.time + 5000
        self.adapter.run(plan, intent)
        self.assertGreaterEqual(self.io.status_reads, 7)
        self.assertEqual(self.io.time, 1005000)
        self.assertEqual((self.count('begin'), self.count('end')), (1, 1))

    def test_stale_heartbeat_timeout_is_terminal_without_restarting_original_wait(self):
        plan, intent = self.prepare()
        self.io.fresh_after = self.io.time + 40000
        result = self.adapter.run(plan, intent)
        self.assertEqual(result['phase'], 'refused')
        self.assertEqual(result['reason'], 'real-heartbeat-not-fresh-within-35s')
        self.assertEqual(self.io.time, 1035000)
        self.assertEqual(self.count('begin'), 0)
        self.assertEqual(self.io.files[str(m.SELECTOR)], self.raw_selector)
        self.assertEqual(self.io.record()['phase'], 'refused')
        self.assertNotIn(str(m.MARKER), self.io.files)
        self.io.fresh_after = self.io.time
        self.adapter.run(plan, intent, resume=True)
        self.assertEqual(self.count('begin'), 0)

    def test_operator_hold_stops_before_begin(self):
        plan, intent = self.prepare()
        self.io.operator_held = True
        with self.assertRaisesRegex(RuntimeError, 'maintenance-not-idle'):
            self.adapter.run(plan, intent)
        self.assertEqual(self.count('begin'), 0)
        self.assertIn(str(m.SELECTOR), self.io.files)

    def test_absent_selector_ready_is_readonly_and_never_admits_lease(self):
        del self.io.files[str(m.SELECTOR)]
        before = dict(self.io.files)
        plan = self.adapter.plan()
        self.assertTrue(plan['ready'])
        self.assertFalse(plan['retirementRequired'])
        self.assertEqual(self.io.files, before)
        self.assertEqual(self.count('begin'), 0)

    def test_compatible_selected_pointer_is_authenticated_and_kept(self):
        self.manifest['base'] = copy.deepcopy(m.BASE)
        original_path = str(m.STATE / (m.OLD_OPERATION + '.json'))
        original = json.loads(self.io.files[original_path]); original['health'] = copy.deepcopy(m.BASE)
        self.io.files[original_path] = m.encoded(original)
        get = self.io.get
        def selected_health(endpoint):
            value = get(endpoint)
            if endpoint == 'health':
                value['frontend'] = {'source': 'frontend', 'id': m.FRONTEND_ID, 'version': '2.7.6', 'buildVersion': '1.0.303'}
            return value
        self.io.get = selected_health
        before = dict(self.io.files)
        plan = self.adapter.plan()
        self.assertFalse(plan['retirementRequired'])
        self.assertEqual(plan['proof']['selectorSha256'], m.sha(self.raw_selector))
        self.assertEqual(self.io.files, before)
        self.assertEqual(self.count('begin'), 0)
        self.io.signature_ok = False
        with self.assertRaisesRegex(RuntimeError, 'signature'):
            self.adapter.plan()

    def test_service_binding_and_original_promotion_changes_refuse(self):
        self.io.epoch = '99999999-9999-4999-8999-999999999999'
        with self.assertRaisesRegex(RuntimeError, 'service-or-workspace'):
            self.adapter.plan()
        self.io.epoch = self.binding['workspaceEpoch']
        original = json.loads(self.io.files[str(m.STATE / (m.OLD_OPERATION + '.json'))])
        original['phase'] = 'begin-intent'
        self.io.files[str(m.STATE / (m.OLD_OPERATION + '.json'))] = m.encoded(original)
        with self.assertRaisesRegex(RuntimeError, 'authenticated-completed'):
            self.adapter.plan()
        self.assertEqual(self.count('write'), 0)


def base64_decode(value):
    import base64
    return base64.b64decode(value, validate=True)


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'Actual protected source checks require Linux root.')
class ProtectedReadinessTests(unittest.TestCase):
    def test_protected_helper_read_refuses_writable_parents_symlinks_and_hardlinks(self):
        parent = os.environ.get('QA_PROTECTED_PARENT')
        if not parent:
            self.skipTest('QA_PROTECTED_PARENT is required for isolated root-protected fixtures.')
        with tempfile.TemporaryDirectory(prefix='nova-readiness-protected-', dir=parent) as name:
            root = pathlib.Path(name); root.chmod(0o700)
            path = root / 'source.py'; path.write_bytes(b'pass\n'); path.chmod(0o600)
            self.assertEqual(m.protected_read(path, 128), b'pass\n')
            path.chmod(0o622)
            with self.assertRaisesRegex(RuntimeError, 'unprotected-source-file'): m.protected_read(path, 128)
            path.chmod(0o600)
            linked = root / 'linked.py'; linked.symlink_to(path)
            with self.assertRaisesRegex(RuntimeError, 'unprotected-source-file'): m.protected_read(linked, 128)
            linked.unlink(); os.link(path, linked)
            with self.assertRaisesRegex(RuntimeError, 'unprotected-source-file'): m.protected_read(path, 128)
            linked.unlink(); root.chmod(0o722)
            with self.assertRaisesRegex(RuntimeError, 'unprotected-source-parent'): m.protected_read(path, 128)
            root.chmod(0o700)


if __name__ == '__main__':
    unittest.main()
