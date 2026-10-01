"""Real Linux fork/exec and /proc evidence; only systemctl is synthetic.

Run with NODE_BINARY and QA_PROTECTED_PARENT in the privileged fixture step.
No actual service, network, workspace, or production process is accessed.
"""
import contextlib
import importlib.util
import json
import os
import pathlib
import select
import signal
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('startup_exec_driver', ROOT / 'deploy/update-runner/install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


@unittest.skipUnless(sys.platform == 'linux', 'Requires real Linux fork/exec and /proc.')
class StartupExecTests(unittest.TestCase):
    def setUp(self):
        parent = pathlib.Path(os.environ['QA_PROTECTED_PARENT']).resolve(strict=True)
        driver.protected(parent, True)
        self.temporary = tempfile.TemporaryDirectory(prefix='startup-exec-fixture-', dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        output = self.root / 'receipts'; output.mkdir(mode=0o700)
        self.instance = driver.Driver(output / 'request.json')
        item = self.instance
        item.prior, item.target, item.data = (self.root / name for name in ('prior', 'target', 'workspace'))
        for folder in (item.prior, item.target, item.data):
            folder.mkdir(mode=0o700)
        item.current = item.target
        item.node = pathlib.Path(os.environ['NODE_BINARY']).resolve(strict=True)
        item.prior_id, item.target_id = 'a' * 64, 'b' * 64
        item.active_engine = '2026.9.6'
        item.before = {'epoch': 'fixture-epoch', 'accounts': []}
        item.job_id = 'fork-exec-fixture'
        item.settings = {'serviceName': 'fixture-only.service'}
        self.children, self.gates = [], {}
        self.pid, self.invocation, self.restarts = 0, 'a' * 32, '0'
        self.starts, self.strict_failures, self.binding_reads = 0, 0, 0
        self.missing_first = False
        self.after_refusal = self.release
        self.child_cwd, self.child_data = item.current, item.data
        self.addCleanup(self.clean_children)
        self.enterContext(patch.object(driver, 'STARTUP_EXEC_TIMEOUT_SECONDS', 5))
        self.enterContext(patch.object(driver.subprocess, 'run', side_effect=self.systemctl))
        self.enterContext(patch.object(driver.subprocess, 'check_output', side_effect=self.show))
        real_identity = item.startup_process_identity

        def strict_identity():
            try:
                return real_identity()
            except (RuntimeError, OSError):
                self.strict_failures += 1
                self.after_refusal()
                raise
        item.startup_process_identity = strict_identity

    def spawn(self):
        gate_read, gate_write = os.pipe()
        ack_read, ack_write = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(gate_write); os.close(ack_read)
                os.write(ack_write, b'forked'); os.close(ack_write)
                if os.read(gate_read, 1) != b'x':
                    os._exit(80)
                os.close(gate_read)
                os.chdir(self.child_cwd)
                environment = dict(os.environ, E3_UPDATE_SOCKET=driver.SOCKET, E3_DATA_DIR=str(self.child_data))
                os.execve(str(self.instance.node), [str(self.instance.node), '-e', 'setInterval(()=>{},1000)'], environment)
            except BaseException:
                os._exit(81)
        os.close(gate_read); os.close(ack_write)
        self.children.append(pid); self.gates[pid] = gate_write
        try:
            self.assertTrue(select.select([ack_read], [], [], 5)[0], 'Forked child did not reach its pre-exec boundary.')
            self.assertEqual(os.read(ack_read, 6), b'forked')
        finally:
            os.close(ack_read)
        return pid

    def release(self):
        gate = self.gates.pop(self.pid, None)
        if gate is not None:
            os.write(gate, b'x'); os.close(gate)

    def clean_children(self):
        for descriptor in self.gates.values():
            os.close(descriptor)
        self.gates.clear()
        for pid in self.children:
            # A child PID cannot be recycled before this parent reaps it. Only
            # exact fixture children are signalled; no discovery/broad kill.
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)

    def systemctl(self, command, **kwargs):
        self.assertEqual(command, ['/usr/bin/systemctl', 'start', 'fixture-only.service'])
        self.assertEqual(kwargs, {'check': True, 'timeout': 120})
        self.starts += 1
        self.assertEqual(self.starts, 1, 'Exec observation must never start twice.')
        self.pid = self.spawn()

    def show(self, command, **kwargs):
        self.assertEqual(command[:3], ['/usr/bin/systemctl', 'show', 'fixture-only.service'])
        self.assertGreater(kwargs['timeout'], 0)
        self.assertLessEqual(kwargs['timeout'], 10)
        if command[3:] == ['--property=MainPID', '--value']:
            return str(self.pid) + '\n'
        self.assertEqual(command[3:], ['--property=MainPID,NRestarts,InvocationID'])
        self.binding_reads += 1
        pid = 0 if self.missing_first and self.binding_reads == 1 else self.pid
        return f'MainPID={pid}\nNRestarts={self.restarts}\nInvocationID={self.invocation}\n'

    def receipt(self, phase):
        return self.instance.output / ('startup-1-' + phase + '.json')

    def assert_no_success(self):
        self.assertEqual(self.starts, 1)
        self.assertTrue(self.receipt('started').exists())
        for phase in ('process', 'ready', 'closed'):
            self.assertFalse(self.receipt(phase).exists())
        self.assertIsNone(self.instance.log_retention_window())

    def test_real_same_pid_crosses_fork_exec_for_target_and_retained_prior(self):
        # Two independently owned starts, one per target/prior fixture, preserve
        # the actual kernel PID and start ticks across the executable change.
        for restored in (False, True):
            with self.subTest(restored=restored):
                if restored:
                    self.instance.output = self.root / 'prior-receipts'
                    self.instance.output.mkdir(mode=0o700)
                    self.instance.current = self.instance.prior
                    self.child_cwd = self.instance.prior
                    self.instance.startup_attempt = 0; self.starts = 0
                self.missing_first = True; self.binding_reads = 0
                failures = self.strict_failures
                self.instance.service('start')
                self.assertGreater(self.strict_failures, failures, 'The actual pre-exec predicate must refuse before exec.')
                observed = json.loads(self.receipt('fork-observed').read_bytes())
                process = json.loads(self.receipt('process').read_bytes())
                self.assertEqual(observed['process'], process['process'])
                self.assertEqual(process['process']['pid'], self.pid)
                self.assertEqual(process['candidateId'], self.instance.prior_id if restored else self.instance.target_id)
                self.assertEqual(process['bindingReceiptSha256'], driver.digest(self.receipt('fork-observed')))
                self.instance.startup_ready(process['candidateId'], self.instance.before['epoch'])
                self.assertTrue(self.receipt('ready').exists())
                self.assertIsNone(self.instance.log_retention_window())

    def test_actual_replacement_child_is_rejected_not_adopted(self):
        def replace():
            self.after_refusal = lambda: None
            self.pid = self.spawn(); self.release()
        self.after_refusal = replace
        with self.assertRaisesRegex(RuntimeError, 'process or invocation changed'):
            self.instance.service('start')
        self.assertEqual(len(self.children), 2)
        self.assert_no_success()

    def test_single_immediate_probe_reproduces_original_preexec_refusal(self):
        # The former service-start implementation called this same exact strict
        # predicate once immediately after systemctl returned. The pipe forces
        # the real fork-before-exec interleaving rather than hoping to hit it.
        self.instance.wait_startup_exec = lambda selected: self.instance.startup_process_identity()
        with self.assertRaisesRegex(RuntimeError, 'reviewed application and Node pair'):
            self.instance.service('start')
        self.assertEqual(self.strict_failures, 1)
        self.assert_no_success()

    def test_same_pid_changed_invocation_and_restart_are_refused(self):
        for field, value in (('invocation', 'b' * 32), ('restarts', '1')):
            with self.subTest(field=field):
                self.instance.output = self.root / field; self.instance.output.mkdir(mode=0o700)
                self.instance.startup_attempt = 0; self.starts = 0
                self.invocation, self.restarts = 'a' * 32, '0'
                self.after_refusal = lambda: setattr(self, field, value)
                with self.assertRaises(RuntimeError):
                    self.instance.service('start')
                self.assert_no_success()

    def test_real_wrong_executable_times_out_without_success_receipts(self):
        self.after_refusal = lambda: None  # Real child remains Python before exec.
        with patch.object(driver, 'STARTUP_EXEC_TIMEOUT_SECONDS', 0.4):
            began = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, 'exceeded its bound'):
                self.instance.service('start')
        self.assertLess(time.monotonic() - began, 2)
        self.assertGreater(self.strict_failures, 0)
        self.assert_no_success()

    def test_real_node_with_wrong_workspace_or_cwd_is_never_accepted(self):
        for field in ('child_data', 'child_cwd'):
            with self.subTest(field=field):
                self.instance.output = self.root / field; self.instance.output.mkdir(mode=0o700)
                self.instance.startup_attempt = 0; self.starts = 0
                self.child_data, self.child_cwd = self.instance.data, self.instance.current
                setattr(self, field, self.root)
                with patch.object(driver, 'STARTUP_EXEC_TIMEOUT_SECONDS', 0.7):
                    with self.assertRaisesRegex(RuntimeError, 'exceeded its bound'):
                        self.instance.service('start')
                self.assertEqual((pathlib.Path('/proc') / str(self.pid) / 'exe').resolve(), self.instance.node)
                self.assert_no_success()

    def test_late_success_cannot_cross_monotonic_deadline(self):
        strict = self.instance.startup_process_identity
        def slow_success():
            result = strict()
            time.sleep(1.1)
            return result
        self.instance.startup_process_identity = slow_success
        with patch.object(driver, 'STARTUP_EXEC_TIMEOUT_SECONDS', 1):
            with self.assertRaisesRegex(RuntimeError, 'exceeded its bound'):
                self.instance.service('start')
        self.assert_no_success()


if __name__ == '__main__':
    unittest.main()
