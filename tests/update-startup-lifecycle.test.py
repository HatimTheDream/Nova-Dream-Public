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


@unittest.skipUnless(sys.platform == 'linux', 'Requires no-follow Linux file descriptors.')
class PriorCaptureOriginTests(unittest.TestCase):
    def test_prior_lifetime_chain_survives_restart_and_rejects_changed_receipts(self):
        job = '006a596d-7c05-4b6e-be6b-e0b906bfd250'
        epoch = '7d527435-d0ed-4788-bd6f-a1519a9788d1'
        candidate = 'a' * 64
        service = 'fixture-nova.service'
        for count in (2, 3):
            with self.subTest(starts=count), tempfile.TemporaryDirectory() as temp:
                directory = pathlib.Path(temp)
                for attempt in range(1,count+1):
                    first = attempt * 100
                    prefix = 'startup-' + str(attempt) + '-'
                    def save(suffix, record):
                        path = directory / (prefix + suffix + '.json')
                        recovery.write_json(path, record)
                        return recovery.digest(path)
                    identity = {'format': 1, 'jobId': job, 'attempt': attempt}
                    start = {**identity, 'startedAtSeconds': first, 'notBeforeTicks': first * 100, 'candidateId': candidate,
                             'epoch': epoch, 'service': service, 'agentVersion': '2026.9.8'}
                    start_hash = save('started',start)
                    binding = {'process': {'pid': first+15, 'startTicks': first*100+1}, 'invocationId': format(attempt,'032x')}
                    fork_hash = save('fork-observed',{**identity, **binding, 'observedAtSeconds': first+1, 'startedReceiptSha256': start_hash})
                    process = {**start, 'processBinding': binding, 'bindingReceiptSha256': fork_hash,
                               'process': binding['process'], 'processObservedAtSeconds': first+2}
                    process_hash = save('process',process)
                    ready = {**process, 'processReceiptSha256': process_hash, 'readyAtSeconds': first+4}
                    ready_hash = save('ready',ready)
                    if attempt < count:
                        save('closed',{**ready, 'owningServiceFullyStopped': True,
                                       'closedAtSeconds': first+6, 'readyReceiptSha256': ready_hash})
                # Temporary directories belong to the test account. The real private-path
                # protection is checked separately by the Linux protected-fixture suite.
                with patch.object(driver, 'protected'):
                    def verify(bound=binding):
                        return driver.prior_capture_lifetimes(directory, job, candidate, epoch, service, bound, count)
                    intervals, refs = verify()
                    self.assertEqual(intervals,[[n*100,n*100+(6 if n<count else 4)] for n in range(1,count+1)])
                    self.assertEqual(len(refs), count*5-1)
                    with self.assertRaisesRegex(RuntimeError,'replaced'):
                        verify({**binding, 'invocationId': 'f'*32})
                    final_ready = directory / ('startup-' + str(count) + '-ready.json')
                    original = final_ready.read_bytes()
                    edited = json.loads(original)
                    edited['processReceiptSha256'] = '0' * 64
                    final_ready.write_text(json.dumps(edited))
                    with self.assertRaisesRegex(RuntimeError,'detached'):
                        verify()
                    final_ready.write_bytes(original)
                    (directory / ('startup-' + str(count) + '-closed.json')).write_text('{}')
                    with self.assertRaisesRegex(RuntimeError,'replaced'):
                        verify()

    def test_prior_route_uses_completed_job_or_the_verified_returned_source(self):
        job = '006a596d-7c05-4b6e-be6b-e0b906bfd250'
        resumed = '2ba2f854-e55a-46f5-8cac-5ab305d14ac4'
        epoch = '7d527435-d0ed-4788-bd6f-a1519a9788d1'
        candidate, release = 'a'*64, 'b'*64
        with tempfile.TemporaryDirectory() as tmp, patch.object(driver,'protected'):
            base = pathlib.Path(tmp).resolve()
            app = object.__new__(driver.Driver)
            app.data = base / 'workspace'
            app.data.mkdir()
            app.host = {'stateDirectory': str(base)}
            app.expected_prior = {'workspaceEpoch':epoch}
            app.prior_id, app.from_engine, app.recovery_root = candidate, '2026.9.8', base / 'recovery'
            process = {'pid':1234,'startTicks':234567}
            app.startup_process_identity = lambda: process
            def save(path, obj):
                path.parent.mkdir(parents=True, exist_ok=True)
                recovery.write_json(path,obj)
                return recovery.digest(path)
            save(app.recovery_root/'latest-update.json',{'candidateId':candidate,'agentVersion':app.from_engine,
                                                         'directory':str(app.recovery_root/('update-'+job))})
            operator = base/'operator-maintenance'
            save(operator/'current.json',{'phase':'entered','id':resumed,'candidateId':candidate,'workspaceEpoch':epoch})
            entry = {'id':job,'candidateId':candidate,'releaseId':release,'epoch':epoch,
                     'state':'completed','prepared':True,'started':True,'hold':False}
            save(base/'jobs/journal.json',{'currentId':resumed,'jobs':[entry,{'id':resumed}]})
            output = base/'staging'/release/'attempts'/job
            flags = dict.fromkeys(('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified'),True)
            save(output/'result.json',{'format':1, 'jobId':job,'candidateId':candidate,'outcome':'completed',**flags})
            self.assertEqual(app.prior_capture_route()[:3], (job,output,2))
            folder = operator/resumed
            returned_output = base/'lab'/('rehearsal-'+resumed)
            source = {'format':1,'candidateId':candidate,'leaseId':resumed,'epoch':epoch,'output':str(returned_output),
                      'returnedRoot':list(recovery.capture_physical_root(app.data)),'originalSource':None}
            source_sha = save(folder/'native-capture-source.json',source)
            rehearsal = save(folder/'rehearsal.json',{'nativeCaptureSourceSha256':source_sha})
            returned = save(folder/'returned-acceptance.json',{'epoch':epoch,'health':{'candidateId':candidate},'process':process})
            save(folder/'acceptance.json',{'kind':'operator-maintenance-acceptance','candidateId':candidate,'workspaceEpoch':epoch,
                                           'leaseId':resumed,'outcome':'rehearsed','evidenceSha256':rehearsal,
                                           'returnedAcceptanceSha256':returned,**flags})
            app.prior_capture_lease_before_enter = {'phase':'released','id':resumed,'candidateId':candidate,'workspaceEpoch':epoch}
            self.assertEqual(app.prior_capture_route()[:3], (resumed,returned_output,3))
            app.startup_process_identity = lambda: {**process,'startTicks':process['startTicks']+1}
            with self.assertRaisesRegex(RuntimeError,'replaced'):
                app.prior_capture_route()
            app.startup_process_identity = lambda: process
            (folder/'native-capture-source.json').write_text(json.dumps({**source,'output':str(base/'other')}))
            with self.assertRaisesRegex(RuntimeError,'detached'):
                app.prior_capture_route()

    def test_held_registry_refuses_a_different_writer_before_issuing_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp).resolve()
            driver_instance = object.__new__(driver.Driver)
            driver_instance.data = driver_instance.recovery_root = driver_instance.output = root
            driver_instance.before = {'epoch': 'source-epoch'}
            owner = ('job','candidate',0)
            role = pathlib.Path('state/tmp/plugin-captures/family/owner.sqlite')
            writer = {'roles': {str(role): {}}, 'owner': list(owner), 'epoch': 'source-epoch'}
            plugin = {'pluginId': 'codex', 'sourceAdmissions': {}}
            with patch.object(recovery, 'selected_capture_registry', return_value=(role,plugin)):
                wrong = {**writer, 'roles': {'some-other-owner': {}}}
                with self.assertRaisesRegex(RuntimeError,'current writer'):
                    driver_instance.write_held_capture_origin(pathlib.Path('.'), wrong, owner, 100, {}, {'ready':'example'})
                path, sha = driver_instance.write_held_capture_origin(pathlib.Path('.'), writer, owner, 100, {}, {'ready':'example'})
            self.assertEqual(recovery.digest(path),sha)
            recorded = json.loads(path.read_bytes())
            self.assertEqual(recorded['physicalRoot'],list(recovery.capture_physical_root(root)))
            self.assertEqual(recorded['selectedRole'],str(role))
            self.assertEqual(recorded['priorEvidence']['selectedCatalogSha256'],recovery.deferred_digest(plugin))


if __name__ == '__main__':
    unittest.main()
