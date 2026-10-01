"""Real receipt/SQLite integration for delayed native startup retention.

Service/controller/process discovery are synthetic boundaries. The production
settled-acceptance flow, durable start/ready/closed receipts, private SQLite
copies and complete-row retention qualifier run unchanged. Runtime executable
attestation is covered by update-log-retention-integration.test.py.
"""
import contextlib
import importlib.util
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
import recovery
import codex_log_retention as retention
spec = importlib.util.spec_from_file_location('startup_lifecycle_driver', ROOT / 'deploy/update-runner/install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

START = retention.RETENTION_SECONDS + 1000
SCHEMA = '''create table logs(id integer primary key,ts integer,ts_nanos integer,level text,target text,
    feedback_log_body text,module_path text,file text,line integer,thread_id text,process_uuid text,estimated_bytes integer)'''


@unittest.skipUnless(sys.platform == 'linux', 'Requires real no-follow receipts, directory fsync and closed SQLite copies.')
class StartupLifecycleTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self, restored=False, failure=None):
        with tempfile.TemporaryDirectory(prefix='nova-startup-lifecycle-') as directory, contextlib.ExitStack() as patches:
            root = pathlib.Path(directory).resolve()
            output = root / 'attempt'
            output.mkdir(mode=0o700)
            instance = driver.Driver(output / 'request.json')
            instance.prior, instance.target = root / 'prior', root / 'target'
            instance.prior.mkdir();instance.target.mkdir()
            instance.current = instance.prior if restored else instance.target
            instance.prior_id, instance.target_id = 'a' * 64, 'b' * 64
            expected = instance.prior_id if restored else instance.target_id
            instance.job_id = 'fixture-lifecycle-job'
            instance.settings = {'serviceName': 'fixture-nova.service'}
            instance.release = {'novaVersion': '2.0.1', 'compatibility': {'fromNovaVersion': '2.0.0'},
                                'recovery': {'readinessTimeoutSeconds': 2}}
            version = instance.release['compatibility']['fromNovaVersion'] if restored else instance.release['novaVersion']
            instance.active_engine = instance.from_engine = '2026.9.6'
            instance.before = {'epoch': 'fixture-epoch', 'accounts': [('fixture-account', 'connected')]}
            instance.recovery_root, instance.recovery, instance.data = root, root / 'recovery', root / 'live'
            snapshot = instance.recovery / 'workspace'
            snapshot.mkdir(parents=True);instance.data.mkdir()
            for folder in (snapshot, instance.data):
                with contextlib.closing(sqlite3.connect(folder / 'logs.sqlite')) as connection, connection:
                    connection.execute(SCHEMA)
                    for identity, timestamp in ((1, 1030), (2, 1060)):
                        connection.execute('insert into logs values(?,?,?,?,?,?,?,?,?,?,?,?)',
                            (identity, timestamp, 7, 'INFO', 'fixture', 'retained content', None, None, None, None, None, 16))
            snapshot_bytes = (snapshot / 'logs.sqlite').read_bytes()
            state = types.SimpleNamespace(clock=START, running=False, starts=0, events=[], proof=None,
                                          cleanup=False, ready_only_rejected=False)

            def systemctl(command, **kwargs):
                self.assertEqual(command[:1], ['/usr/bin/systemctl'])
                self.assertEqual(command[-1], 'fixture-nova.service')
                self.assertEqual(kwargs, {'check': True, 'timeout': 120})
                action = command[1]
                state.events.append(action)
                if action == 'start':
                    if state.starts:
                        self.assertIsNotNone(state.proof, 'A final start cannot precede complete retention proof.')
                    state.starts += 1;state.running = True
                else:
                    if failure == 'shutdown':
                        raise subprocess.CalledProcessError(1, command)
                    state.running = False;state.clock += 5
                return types.SimpleNamespace(returncode=0)

            def stopped():
                if state.running:
                    raise RuntimeError('Synthetic dispatcher still running.')

            def process_identity():
                self.assertTrue(state.running)
                return {'pid': 4000 + state.starts, 'startTicks': 20000 + state.starts}

            def acceptance(candidate, app_version, **kwargs):
                self.assertTrue(state.running)
                self.assertEqual((candidate, app_version), (expected, version))
                self.assertIn(kwargs, ({'restored_prior': True},) if restored else ({}, {'restored_prior': False}))
                state.clock += 1
                if state.starts == 2 and failure == 'final-readiness':
                    raise RuntimeError('Synthetic final readiness unavailable.')
                state.events.append('readiness-' + str(state.starts))
                return {'health': {'candidateId': expected, 'startup': state.starts},
                        'accounts': instance.before['accounts'], 'epoch': instance.before['epoch']}

            def hold():
                state.events.append('hold')
                # Nova is ready before Codex opens its own state runtime. Native
                # startup's genuine ten-day cleanup runs later under the hold.
                if (output / 'startup-1-ready.json').exists() and not state.cleanup:
                    self.assertTrue(state.running)
                    state.clock = START + 35
                    with contextlib.closing(sqlite3.connect(instance.data / 'logs.sqlite')) as connection, connection:
                        connection.execute('delete from logs where ts < ?', (state.clock - retention.RETENTION_SECONDS,))
                    state.cleanup = True;state.events.append('native-cleanup-after-ready')

            def native():
                stopped()
                window = instance.log_retention_window()
                self.assertIsNotNone(window)
                ready = json.loads((output / 'startup-1-ready.json').read_bytes())
                self.assertLess(ready['readyAtSeconds'], START + 31)
                with recovery.verification_scratch(root):
                    with contextlib.closing(recovery.database(snapshot / 'logs.sqlite', True)) as before, \
                         contextlib.closing(recovery.database(instance.data / 'logs.sqlite', True)) as after:
                        with self.assertRaisesRegex(RuntimeError, 'exact startup age'):
                            retention.qualify_logs(before, after, ready['startedAtSeconds'], ready['readyAtSeconds'])
                        state.ready_only_rejected = True
                        state.proof = retention.qualify_logs(before, after, *window)
                self.assertEqual((snapshot / 'logs.sqlite').read_bytes(), snapshot_bytes)
                state.events.append('retention-verified')

            instance.acceptance = acceptance
            instance.startup_process_identity = process_identity
            instance.startup_process_binding = lambda **kwargs: {'process': process_identity(), 'invocationId': format(state.starts, '032x')}
            instance.require_stopped = stopped
            instance.controller_hold = hold
            instance.verify_configuration = lambda: state.events.append('configuration')
            instance.retained_native = native
            patches.enter_context(patch.object(driver.subprocess, 'run', side_effect=systemctl))
            patches.enter_context(patch.object(driver.time, 'time_ns', side_effect=lambda: state.clock * 1_000_000_000))
            patches.enter_context(patch.object(driver.time, 'monotonic', side_effect=lambda: state.clock))
            patches.enter_context(patch.object(driver.time, 'clock_gettime', return_value=100))
            patches.enter_context(patch.object(driver.time, 'sleep', side_effect=lambda seconds: setattr(state, 'clock', state.clock + seconds)))
            patches.enter_context(patch.object(driver, 'saved_state', side_effect=lambda *args, **kwargs: stopped()))
            patches.enter_context(patch.object(driver.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 ** 12)))
            instance.service('start')
            yield instance, state, output, expected, version

    def test_target_and_rollback_qualify_delayed_native_cleanup_before_final_readiness(self):
        for restored in (False, True):
            with self.subTest(restored=restored), self.fixture(restored) as (instance, state, output, expected, version):
                accepted = instance.settled_acceptance(expected, version, restored=restored, independent=None if restored else 4096)
                self.assertTrue(state.ready_only_rejected)
                self.assertEqual((state.proof['removedRows'], state.proof['retainedRows']), (1, 1))
                self.assertEqual(accepted['health']['startup'], 2)
                self.assertLess(state.events.index('native-cleanup-after-ready'), state.events.index('retention-verified'))
                self.assertLess(state.events.index('retention-verified'), state.events.index('readiness-2'))
                closed = json.loads((output / 'startup-1-closed.json').read_bytes())
                self.assertEqual(closed['candidateId'], expected)
                self.assertTrue((output / 'startup-2-ready.json').exists())
                self.assertFalse((output / 'startup-2-closed.json').exists())
                self.assertIsNone(instance.log_retention_window(), 'The final running process must not inherit the previous closure.')
                self.assertFalse((output / 'result.json').exists())

    def test_failed_shutdown_preserves_ready_evidence_without_retention_or_final_start(self):
        for restored in (False, True):
            with self.subTest(restored=restored), self.fixture(restored, 'shutdown') as (instance, state, output, expected, version):
                with self.assertRaises(subprocess.CalledProcessError):
                    instance.settled_acceptance(expected, version, restored=restored, independent=None if restored else 4096)
                self.assertTrue((output / 'startup-1-ready.json').exists())
                self.assertFalse((output / 'startup-1-closed.json').exists())
                self.assertIsNone(state.proof)
                self.assertEqual(state.starts, 1)
                self.assertTrue(state.running)
                self.assertFalse((output / 'result.json').exists())

    def test_final_restart_failure_keeps_verified_closed_receipt_but_returns_no_acceptance(self):
        for restored in (False, True):
            with self.subTest(restored=restored), self.fixture(restored, 'final-readiness') as (instance, state, output, expected, version):
                with self.assertRaisesRegex(RuntimeError, 'bounded readiness'):
                    instance.settled_acceptance(expected, version, restored=restored, independent=None if restored else 4096)
                self.assertTrue(state.ready_only_rejected)
                self.assertIsNotNone(state.proof)
                self.assertTrue((output / 'startup-1-closed.json').exists())
                self.assertTrue((output / 'startup-2-started.json').exists())
                self.assertFalse((output / 'startup-2-ready.json').exists())
                self.assertFalse((output / 'result.json').exists())


if __name__ == '__main__':
    unittest.main()
