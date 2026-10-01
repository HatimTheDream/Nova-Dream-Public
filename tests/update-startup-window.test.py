"""Real private startup receipts; mocked systemctl and clocks, no host actions.

Linux runs the receipt writer's actual no-follow open and directory fsync.
Other platforms skip rather than stub these production filesystem guarantees.
"""
import importlib.util
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy' / 'update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('startup_window_driver', ROOT / 'deploy' / 'update-runner' / 'install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


@unittest.skipUnless(sys.platform == 'linux', 'Requires real Linux no-follow receipt writes and directory fsync; no service is used.')
class StartupWindowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='nova-startup-window-fixture-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        self.output = self.root / 'receipts'
        self.output.mkdir(mode=0o700)
        self.instance = driver.Driver(self.output / 'request.json')
        self.instance.prior = self.root / 'prior'
        self.instance.target = self.root / 'target'
        self.instance.prior.mkdir()
        self.instance.target.mkdir()
        # An ordinary selected directory exercises Path.resolve without needing
        # a fixture selector or mocking any production path/receipt validation.
        self.instance.current = self.instance.target
        self.instance.prior_id = 'a' * 64
        self.instance.target_id = 'b' * 64
        self.instance.job_id = 'synthetic-startup-job'
        self.instance.settings = {'serviceName': 'synthetic-nova.service'}
        self.instance.before = {'epoch': 'synthetic-workspace-epoch', 'accounts': []}
        self.instance.release = {'novaVersion': '2.0.1', 'compatibility': {'fromNovaVersion': '2.0.0'}}
        self.instance.active_engine = '2026.9.6'
        self.process = {'pid': 1234, 'startTicks': 1000000}
        self.instance.startup_process_identity = lambda: dict(self.process)
        self.invocation = 'a' * 32
        self.instance.startup_process_binding = lambda **kwargs: {'process': dict(self.process), 'invocationId': self.invocation}
        self.instance.controller_hold = lambda: None
        self.instance.acceptance = lambda *args, **kwargs: dict(self.instance.before)
        self.running = False
        self.instance.require_stopped = self.stopped
        self.clock_ns = 1_700_000_000_250_000_000
        self.enterContext(patch.object(driver.time, 'time_ns', side_effect=lambda: self.clock_ns))
        self.enterContext(patch.object(driver.time, 'clock_gettime', return_value=200))
        self.systemctl = self.enterContext(patch.object(driver.subprocess, 'run', side_effect=self.service))

    def service(self, command, **kwargs):
        self.running = command[1] == 'start'

    def stopped(self):
        if self.running:
            raise RuntimeError('Synthetic service is still running.')

    def ready(self):
        self.clock_ns += 2_500_000_000
        self.instance.startup_ready(self.instance.launched['candidateId'], self.instance.before['epoch'])

    def receipt(self, attempt, phase):
        return self.output / ('startup-' + str(attempt) + '-' + phase + '.json')

    def close(self, restored=False):
        self.clock_ns += 30_000_000_000
        self.instance.stop_for_retention(restored_prior=restored)

    def test_start_receipt_precedes_systemctl_and_window_rounds_outward(self):
        def started(command, **kwargs):
            record = json.loads(self.receipt(1, 'started').read_bytes())
            self.assertEqual(record, {'format': 1, 'jobId': self.instance.job_id, **self.instance.launched})
            self.assertEqual(record['candidateId'], self.instance.target_id)
            self.assertEqual(record['agentVersion'], '2026.9.6')
            self.assertEqual(record['epoch'], self.instance.before['epoch'])
            self.assertEqual(command, ['/usr/bin/systemctl', 'start', 'synthetic-nova.service'])
            self.assertEqual(kwargs, {'check': True, 'timeout': 120})
            self.assertEqual(stat.S_IMODE(self.receipt(1, 'started').stat().st_mode), 0o600)
            self.assertFalse(self.receipt(1, 'ready').exists())
            self.service(command, **kwargs)
        self.systemctl.side_effect = started
        self.instance.service('start')
        self.assertIsNone(self.instance.log_retention_window())
        self.ready()
        self.assertIsNone(self.instance.log_retention_window())
        self.assertEqual(stat.S_IMODE(self.receipt(1, 'ready').stat().st_mode), 0o600)
        self.systemctl.side_effect = self.service
        self.close()
        self.assertEqual(self.instance.log_retention_window(), (1_700_000_000, 1_700_000_033))
        closed = json.loads(self.receipt(1, 'closed').read_bytes())
        self.assertEqual(closed['readyReceiptSha256'], driver.digest(self.receipt(1, 'ready')))
        self.assertEqual(closed['process'], self.process)
        self.assertEqual(closed['service'], 'synthetic-nova.service')
        self.assertTrue(closed['owningServiceFullyStopped'])
        self.assertEqual(stat.S_IMODE(self.receipt(1, 'closed').stat().st_mode), 0o600)

    def test_readiness_rejects_wrong_candidate_engine_and_epoch(self):
        self.instance.service('start')
        for field, value in (('candidate', self.instance.prior_id), ('engine', '2026.9.2'), ('epoch', 'another-epoch')):
            with self.subTest(field=field):
                self.instance.active_engine = value if field == 'engine' else '2026.9.6'
                with self.assertRaises(RuntimeError):
                    self.instance.startup_ready(value if field == 'candidate' else self.instance.target_id,
                                                value if field == 'epoch' else self.instance.before['epoch'])
                self.assertFalse(self.receipt(1, 'ready').exists())
                self.assertNotIn('readyAtSeconds', self.instance.launched)
        self.instance.active_engine = '2026.9.6'
        self.ready()
        self.assertIsNone(self.instance.log_retention_window())

    def test_first_readiness_is_frozen_and_readiness_cannot_extend_window(self):
        self.instance.service('start')
        self.ready()
        path = self.receipt(1, 'ready')
        original = path.read_bytes(), path.stat().st_mtime_ns
        self.close()
        window = self.instance.log_retention_window()
        self.clock_ns += 7_200_000_000_000
        self.instance.startup_ready(self.instance.target_id, self.instance.before['epoch'])
        self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), original)
        self.assertEqual(self.instance.log_retention_window(), window)

    def test_rollback_start_gets_new_window_and_preserves_target_receipts(self):
        self.instance.service('start')
        self.ready()
        self.close()
        target_receipts = {path.name: path.read_bytes() for path in self.output.iterdir()}
        self.instance.current = self.instance.prior
        with self.assertRaises(RuntimeError):
            self.instance.log_retention_window()
        self.clock_ns += 90_000_000_000
        self.instance.service('start')
        self.assertEqual(self.instance.launched['attempt'], 2)
        self.assertEqual(self.instance.launched['candidateId'], self.instance.prior_id)
        self.assertIsNone(self.instance.log_retention_window())
        self.ready()
        self.assertIsNone(self.instance.log_retention_window())
        self.close(restored=True)
        self.assertEqual(self.instance.log_retention_window(), (1_700_000_122, 1_700_000_156))
        for name, content in target_receipts.items():
            self.assertEqual((self.output / name).read_bytes(), content)
        self.assertEqual(json.loads(self.receipt(2, 'ready').read_bytes())['candidateId'], self.instance.prior_id)

    def test_failed_start_does_not_reuse_previous_ready_proof(self):
        self.instance.service('start')
        self.ready()
        self.close()
        first_ready = self.receipt(1, 'ready').read_bytes()
        self.instance.current = self.instance.prior
        self.systemctl.side_effect = subprocess.CalledProcessError(1, 'synthetic systemctl')
        with self.assertRaises(subprocess.CalledProcessError):
            self.instance.service('start')
        self.assertTrue(self.receipt(2, 'started').is_file())
        self.assertFalse(self.receipt(2, 'ready').exists())
        self.assertNotIn('readyAtSeconds', self.instance.launched)
        self.assertIsNone(self.instance.log_retention_window())
        self.assertEqual(self.receipt(1, 'ready').read_bytes(), first_ready)

    def test_changed_ready_receipt_or_current_authority_is_refused(self):
        self.instance.service('start')
        self.ready()
        self.close()
        path = self.receipt(1, 'ready')
        original = path.read_bytes()
        for field, value in (('candidateId', self.instance.prior_id), ('agentVersion', '2026.9.2'),
                             ('epoch', 'another-epoch'), ('jobId', 'another-job'), ('attempt', 2),
                             ('service', 'another.service'), ('process', {'pid': 10, 'startTicks': 1}),
                             ('startedAtSeconds', 0), ('readyAtSeconds', 1_800_000_000), ('extra', True)):
            with self.subTest(field=field):
                path.write_text(json.dumps({**json.loads(original), field: value}), encoding='utf8')
                with self.assertRaises(RuntimeError):
                    self.instance.log_retention_window()
        path.write_bytes(original)
        self.instance.before['epoch'] = 'changed-live-epoch'
        with self.assertRaises(RuntimeError):
            self.instance.log_retention_window()
        self.instance.before['epoch'] = 'synthetic-workspace-epoch'
        self.assertIsNotNone(self.instance.log_retention_window())

    def test_closed_receipt_is_required_immutable_and_bound_to_ready(self):
        self.instance.service('start'); self.ready(); self.close()
        path = self.receipt(1, 'closed')
        original = path.read_bytes()
        for field, value in (('closedAtSeconds', 1_800_000_000), ('closedAtSeconds', True),
                             ('readyReceiptSha256', 'a' * 64), ('owningServiceFullyStopped', False),
                             ('jobId', 'another-job'), ('epoch', 'another-epoch'), ('extra', True)):
            with self.subTest(field=field, value=value):
                path.write_text(json.dumps({**json.loads(original), field: value}), encoding='utf8')
                with self.assertRaises(RuntimeError):
                    self.instance.log_retention_window()
        path.write_bytes(original)
        path.rename(path.with_suffix('.retained'))
        with self.assertRaises(FileNotFoundError):
            self.instance.log_retention_window()

    def test_changed_process_or_epoch_before_stop_never_stops(self):
        self.instance.service('start'); self.ready()
        for field, value in (('pid', 1235), ('startTicks', 1000001)):
            with self.subTest(field=field):
                previous = self.process[field]
                self.process[field] = value
                with self.assertRaisesRegex(RuntimeError, 'process or receipt changed'):
                    self.instance.stop_for_retention()
                self.process[field] = previous
        for changed in ({'epoch': 'another-epoch', 'accounts': []},
                        {'epoch': self.instance.before['epoch'], 'accounts': ['another-account']}):
            self.instance.acceptance = lambda *args, **kwargs: changed
            with self.assertRaisesRegex(RuntimeError, 'workspace identity changed'):
                self.instance.stop_for_retention()
        self.assertEqual(self.systemctl.call_count, 1)
        self.assertTrue(self.running)
        self.assertFalse(self.receipt(1, 'closed').exists())

    def test_changed_process_after_acceptance_or_missing_hold_never_stops(self):
        self.instance.service('start'); self.ready()
        def changed(*args, **kwargs):
            self.process['startTicks'] += 1
            return dict(self.instance.before)
        self.instance.acceptance = changed
        with self.assertRaisesRegex(RuntimeError, 'process or receipt changed'):
            self.instance.stop_for_retention()
        self.process['startTicks'] -= 1
        self.instance.controller_hold = lambda: driver.require(False, 'Synthetic hold lost.')
        with self.assertRaisesRegex(RuntimeError, 'hold lost'):
            self.instance.stop_for_retention()
        self.assertEqual(self.systemctl.call_count, 1)
        self.assertTrue(self.running)

    def test_expired_retention_cannot_block_emergency_stop(self):
        self.instance.service('start'); self.ready()
        self.clock_ns += 3_480_000_000_000
        with self.assertRaisesRegex(RuntimeError, 'bounded stop'):
            self.instance.stop_for_retention()
        self.assertTrue(self.running)
        self.assertFalse(self.receipt(1, 'closed').exists())
        # The original emergency route uses genuine held acceptance but does
        # not require retention evidence, whose time limit has already expired.
        self.instance.guarded_stop()
        self.assertFalse(self.running)
        self.assertIsNone(self.instance.log_retention_window())

    def test_failed_or_incomplete_or_overlong_stop_never_publishes_closed_proof(self):
        self.instance.service('start'); self.ready()
        for failure in ('failed', 'incomplete', 'overlong'):
            with self.subTest(failure=failure):
                self.running = True
                self.clock_ns = 1_700_000_010_000_000_000
                def stopped(command, **kwargs):
                    if failure == 'failed':
                        raise subprocess.CalledProcessError(1, command)
                    if failure == 'overlong':
                        self.running = False
                        self.clock_ns += 3_600_000_000_000
                self.systemctl.side_effect = stopped
                with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                    self.instance.stop_for_retention()
                self.assertFalse(self.receipt(1, 'closed').exists())
                self.assertIsNone(self.instance.closed_startup)

    def test_start_rejects_preexisting_process_and_closed_proof_cannot_be_replayed(self):
        self.process['startTicks'] = 1
        with self.assertRaisesRegex(RuntimeError, 'predates'):
            self.instance.service('start')
        self.assertTrue(self.receipt(1, 'started').exists())
        self.assertFalse(self.receipt(1, 'process').exists())
        self.process['startTicks'] = 1000000
        self.instance.service('start')
        self.ready(); self.close()
        with self.assertRaisesRegex(RuntimeError, 'not replayed'):
            self.instance.stop_for_retention()
        self.running = True
        with self.assertRaisesRegex(RuntimeError, 'still running'):
            self.instance.log_retention_window()

    def test_restart_before_first_ready_cannot_replace_original_process(self):
        self.instance.service('start')
        original = self.receipt(1, 'process').read_bytes()
        self.process = {'pid': 1235, 'startTicks': 1000001}
        with self.assertRaisesRegex(RuntimeError, 'differs from this guarded startup'):
            self.ready()
        self.assertEqual(self.receipt(1, 'process').read_bytes(), original)
        self.assertFalse(self.receipt(1, 'ready').exists())

    def test_changed_original_process_receipt_cannot_be_accepted(self):
        self.instance.service('start')
        path = self.receipt(1, 'process')
        path.write_text(json.dumps({**json.loads(path.read_bytes()), 'extra': True}), encoding='utf8')
        with self.assertRaisesRegex(RuntimeError, 'startup process changed'):
            self.ready()
        self.assertFalse(self.receipt(1, 'ready').exists())

    def test_failed_closure_write_leaves_no_in_memory_retention_authority(self):
        self.instance.service('start'); self.ready()
        with patch.object(driver, 'write_json', side_effect=OSError('synthetic durable write failure')):
            with self.assertRaisesRegex(OSError, 'durable write failure'):
                self.instance.stop_for_retention()
        self.assertFalse(self.running)
        self.assertIsNone(self.instance.closed_startup)
        self.assertIsNone(self.instance.log_retention_window())
        self.assertFalse(self.receipt(1, 'closed').exists())

    def test_no_installer_start_or_other_engine_has_no_log_exception(self):
        self.instance.startup_ready(self.instance.prior_id, self.instance.before['epoch'])
        self.assertIsNone(self.instance.log_retention_window())
        self.assertEqual(list(self.output.iterdir()), [])
        self.instance.active_engine = '2026.9.2'
        self.instance.service('start')
        self.ready()
        self.assertTrue(self.receipt(1, 'ready').is_file())
        self.assertIsNone(self.instance.log_retention_window())

    def test_unreviewed_clock_window_cannot_create_ready_proof(self):
        self.instance.service('start')
        for clock in (1_699_999_998_000_000_000, 1_700_003_600_000_000_001):
            with self.subTest(clock=clock):
                self.clock_ns = clock
                with self.assertRaises(RuntimeError):
                    self.instance.startup_ready(self.instance.target_id, self.instance.before['epoch'])
                self.assertFalse(self.receipt(1, 'ready').exists())
                self.assertIsNone(self.instance.log_retention_window())


if __name__ == '__main__':
    unittest.main()
