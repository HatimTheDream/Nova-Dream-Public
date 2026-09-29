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
        self.instance.before = {'epoch': 'synthetic-workspace-epoch'}
        self.instance.active_engine = '2026.9.6'
        self.clock_ns = 1_700_000_000_250_000_000
        self.enterContext(patch.object(driver.time, 'time_ns', side_effect=lambda: self.clock_ns))
        self.enterContext(patch.object(driver.time, 'clock_gettime', return_value=200))
        self.systemctl = self.enterContext(patch.object(driver.subprocess, 'run'))

    def ready(self):
        self.clock_ns += 2_500_000_000
        self.instance.startup_ready(self.instance.launched['candidateId'], self.instance.before['epoch'])

    def receipt(self, attempt, phase):
        return self.output / ('startup-' + str(attempt) + '-' + phase + '.json')

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
        self.systemctl.side_effect = started
        self.instance.service('start')
        self.assertIsNone(self.instance.log_retention_window())
        self.ready()
        self.assertEqual(self.instance.log_retention_window(), (1_700_000_000, 1_700_000_003))
        self.assertEqual(stat.S_IMODE(self.receipt(1, 'ready').stat().st_mode), 0o600)

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
        self.assertIsNotNone(self.instance.log_retention_window())

    def test_first_readiness_is_frozen_and_readiness_cannot_extend_window(self):
        self.instance.service('start')
        self.ready()
        path = self.receipt(1, 'ready')
        original = path.read_bytes(), path.stat().st_mtime_ns
        window = self.instance.log_retention_window()
        self.clock_ns += 7_200_000_000_000
        self.instance.startup_ready(self.instance.target_id, self.instance.before['epoch'])
        self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), original)
        self.assertEqual(self.instance.log_retention_window(), window)

    def test_rollback_start_gets_new_window_and_preserves_target_receipts(self):
        self.instance.service('start')
        self.ready()
        target_receipts = {path.name: path.read_bytes() for path in self.output.iterdir()}
        self.instance.service('stop')
        self.instance.current = self.instance.prior
        with self.assertRaises(RuntimeError):
            self.instance.log_retention_window()
        self.clock_ns += 90_000_000_000
        self.instance.service('start')
        self.assertEqual(self.instance.launched['attempt'], 2)
        self.assertEqual(self.instance.launched['candidateId'], self.instance.prior_id)
        self.assertIsNone(self.instance.log_retention_window())
        self.ready()
        self.assertEqual(self.instance.log_retention_window(), (1_700_000_092, 1_700_000_096))
        for name, content in target_receipts.items():
            self.assertEqual((self.output / name).read_bytes(), content)
        self.assertEqual(json.loads(self.receipt(2, 'ready').read_bytes())['candidateId'], self.instance.prior_id)

    def test_failed_start_does_not_reuse_previous_ready_proof(self):
        self.instance.service('start')
        self.ready()
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
        path = self.receipt(1, 'ready')
        original = path.read_bytes()
        for field, value in (('candidateId', self.instance.prior_id), ('agentVersion', '2026.9.2'),
                             ('epoch', 'another-epoch'), ('jobId', 'another-job'), ('attempt', 2),
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
