"""Operator orchestration over real disposable directories and byte-preserving copies.

Service/socket/native-verifier boundaries are fakes. Existing recovery suites
separately exercise real Linux rsync/cp, SQLite and derived-state verification.
These tests prove rename order, crash preservation and honest proof boundaries.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('operator_rehearsal', ROOT/'deploy/update-runner/operator_rehearsal.py')
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


def portable_inventory(root):
    entries, inodes = {}, {}
    for path in [root, *sorted(root.rglob('*'))]:
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            entries[relative] = {'kind': 'directory'}
        else:
            info = path.stat()
            entries[relative] = {'kind': 'file', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'size': info.st_size}
            inodes[relative] = {'device': info.st_dev, 'inode': info.st_ino, 'allocated': 4096}
    return entries, inodes


def exclusive_json(path, value):
    with path.open('x', encoding='utf8') as output:
        json.dump(value, output, sort_keys=True)


class RehearsalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-operator-fixture-', dir=os.environ.get('QA_PROTECTED_PARENT'))
        self.root = pathlib.Path(self.temporary.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.stack.close)

    def fake(self, name, value):
        return self.stack.enter_context(patch.object(operator, name, value))

    def fixture(self):
        instance = operator.Rehearsal(self.root/'review.json')
        instance.review_path.write_text('{}')
        instance.job_id = '11111111-1111-4111-8111-111111111111'
        instance.prior_id = instance.target_id = 'a'*64
        instance.expected_prior = {'candidateId': instance.prior_id, 'workspaceEpoch': '22222222-2222-4222-8222-222222222222'}
        instance.review = {'novaVersion': '2.0.2'}
        instance.output = self.root/'lab'
        instance.recovery_root = self.root/'recoveries'; instance.recovery_root.mkdir()
        instance.recovery = instance.recovery_root/'new'
        instance.baseline = instance.recovery_root/'old'; instance.baseline.mkdir()
        instance.data = self.root/'workspace'; instance.data.mkdir()
        (instance.data/'owner-record').write_bytes(b'original saved data')
        shutil.copytree(instance.data, instance.baseline/'workspace')
        instance.restore, instance.original, instance.trial = [instance.output/name for name in ('restored-workspace','original-workspace','trial-workspace')]
        instance.roles = {'live':instance.data,'original':instance.original,'restore':instance.restore,'trial':instance.trial}
        instance.active_engine = instance.from_engine = '2026.9.6'
        instance.workspace_key_credential = self.root/'credential'
        instance.node = self.root/'node'
        instance.prior = instance.target = self.root/'prior'
        instance.current = self.root/'current'
        instance.config_files = []; instance.config_hashes = {}
        instance.runtime_node_hash = 'b'*64
        instance.source_process = {'pid':123,'startTicks':456}
        instance.process_identity = lambda: dict(instance.source_process)
        instance.host = {'stateDirectory': str(self.root/'state')}
        self.events = events = []
        self.lease_phase = 'held'
        self.key = bytearray(b'k'*32)
        self.healthy = {'health':{'candidateId':instance.prior_id,'version':'2.0.2'},'epoch':instance.expected_prior['workspaceEpoch'],'accounts':[['account','provider','connected',['read']]]}
        instance.validate_operator = lambda: events.append('validate')
        instance.wait_for_fresh_admission = lambda: events.append('new-real-heartbeat')
        instance.controller_hold = lambda: {'held':True,'lease':{'id':instance.job_id,'phase':self.lease_phase}}
        instance.mark = lambda phase: (events.append('mark:'+phase), setattr(self,'lease_phase',phase))[-1]
        def call(action, value=None):
            events.append('operator:'+action)
            return {'format':1,'held':True,'lease':{'id':instance.job_id,'candidateId':instance.prior_id,
                'workspaceEpoch':instance.expected_prior['workspaceEpoch'],'phase':self.lease_phase,'stopMarked':instance.stop_attempted}}
        instance.operator = call
        instance.service = lambda action: events.append('service:'+action)
        instance.require_stopped = lambda: events.append('closed')
        instance.guarded_stop = lambda **kw: events.append('guarded-stop')
        instance.stop_for_retention = lambda **kw: events.append('close-startup')
        instance.verify_configuration = lambda: events.append('config-verified')
        instance.retained_native = lambda: events.append('native-retention-verified')
        instance.wait_acceptance = lambda *args, **kw: (events.append('held-acceptance'),dict(self.healthy))[-1]
        def proof(outcome, accepted):
            events.append('proof:'+outcome)
            self.lease_phase = 'released'
            instance.release_publication_started = instance.release_confirmed = True
        instance.proof = proof
        self.fake('protected', lambda *args, **kwargs: None)
        self.fake('inventory', portable_inventory)
        self.fake('write_json', exclusive_json)
        self.fake('sync_dir', lambda path: events.append('fsync:'+path.name))
        self.fake('allocated_metadata', lambda path: 8192)
        self.fake('saved_state', lambda *args, **kwargs: events.append('saved-verified'))
        self.fake('native_saved_state', lambda *args, **kwargs: events.append('native-verified'))
        self.fake('read_workspace_key', lambda *args: self.key)
        self.fake('verification_scratch', lambda path: contextlib.nullcontext())
        self.fake('capacity', lambda *args: {'freeBytes':10**12,'requiredFreeBytes':1,'independentRestoreBytes':4096})
        self.stack.enter_context(patch.object(operator.shutil, 'disk_usage', lambda p: types.SimpleNamespace(free=10**12)))
        def snapshot(source, target, baseline, stopped):
            stopped(); events.append('snapshot')
            shutil.copytree(source,target)
            exclusive_json(target.parent/'snapshot-manifest.json', portable_inventory(source)[0])
        def independent(snapshot, target, source, stopped):
            stopped(); events.append('independent-copy')
            shutil.copytree(snapshot,target)
            self.assertNotEqual((target/'owner-record').stat().st_ino,(source/'owner-record').stat().st_ino)
        self.fake('snapshot_closed', snapshot)
        self.fake('prepare_independent', independent)
        return instance

    def test_complete_trial_returns_original_inode_and_cleans_only_trial_after_release(self):
        instance = self.fixture()
        original = operator.root_identity(instance.data)
        instance.run_rehearsal()
        self.assertEqual(operator.root_identity(instance.data), original)
        self.assertEqual((instance.data/'owner-record').read_bytes(), b'original saved data')
        self.assertTrue((instance.recovery/'workspace/owner-record').exists())
        self.assertTrue((instance.baseline/'workspace/owner-record').exists())
        self.assertFalse(instance.trial.exists())
        self.assertEqual(self.events.count('service:start'),3)
        self.assertEqual(self.events.count('close-startup'),2)
        self.assertEqual(self.events.count('guarded-stop'),0)
        self.assertLess(self.events.index('validate'),self.events.index('new-real-heartbeat'))
        self.assertLess(self.events.index('new-real-heartbeat'),self.events.index('operator:enter'))
        self.assertLess(self.events.index('proof:rehearsed'), self.events.index('operator:status'))
        self.assertEqual(self.key, bytearray(32))
        phases = [json.loads(p.read_text())['phase'] for p in sorted(instance.output.glob('phase-*.json'))]
        self.assertEqual(phases[-2:], ['trial-cleanup-intent','complete'])

    def test_prior_acceptance_is_saved_before_service_stop_and_retained_on_failure(self):
        instance = self.fixture()
        def stop(action):
            self.assertEqual(action, 'stop')
            path = instance.output/'prior-acceptance.json'
            self.assertEqual(json.loads(path.read_text()), self.healthy)
            held = [json.loads(p.read_text()) for p in instance.output.glob('phase-*.json')
                    if json.loads(p.read_text())['phase'] == 'held']
            self.assertEqual(len(held), 1)
            self.assertEqual(held[0]['priorAcceptanceSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(held[0]['acceptanceProvenance'], 'actual-held-before-first-stop')
            self.assertEqual(held[0]['sourceProcess'], instance.source_process)
            raise OSError('interrupted first stop')
        instance.service = stop
        with self.assertRaisesRegex(OSError, 'interrupted first stop'):
            instance.run_rehearsal()
        self.assertEqual(json.loads((instance.output/'prior-acceptance.json').read_text()), self.healthy)
        self.assertTrue(instance.data.exists())
        self.assertFalse(instance.original.exists() or instance.restore.exists() or instance.trial.exists())
        self.assertFalse(any(event.startswith('proof:') for event in self.events))

    def test_crash_in_each_rename_preserves_every_workspace_and_never_releases(self):
        for failed_rename in range(1,5):
            with self.subTest(rename=failed_rename), contextlib.ExitStack() as local:
                # Each subcase owns a fresh complete fixture.
                case = RehearsalTests('runTest'); case.setUp(); local.callback(case.doCleanups)
                instance = case.fixture(); real_rename = os.rename; count = 0
                def crash(source,target):
                    nonlocal count
                    count += 1
                    if count == failed_rename:
                        raise OSError('synthetic interruption before rename')
                    return real_rename(source,target)
                with patch.object(operator.os,'rename',crash), self.assertRaises(OSError):
                    instance.run_rehearsal()
                self.assertFalse(any(event.startswith('proof:') for event in case.events))
                self.assertNotIn('operator:release',case.events)
                retained = [path for path in instance.roles.values() if path.exists()]
                self.assertGreaterEqual(len(retained),2)
                self.assertTrue(all((path/'owner-record').read_bytes()==b'original saved data' for path in retained))
                self.assertTrue((instance.recovery/'workspace/owner-record').exists())
                self.assertEqual(case.key,bytearray(32))

    def test_failure_after_first_rename_fsync_keeps_original_in_lab_without_guessing(self):
        instance = self.fixture()
        real = operator.sync_dir
        def interrupted(path):
            if path == instance.data.parent and instance.original.exists():
                raise OSError('synthetic directory fsync failure')
            real(path)
        self.fake('sync_dir',interrupted)
        with self.assertRaises(OSError):instance.run_rehearsal()
        self.assertFalse(instance.data.exists())
        self.assertTrue((instance.original/'owner-record').exists())
        self.assertTrue((instance.restore/'owner-record').exists())
        self.assertFalse(any(event.startswith('proof:') for event in self.events))

    def test_capacity_refusal_restarts_original_without_saved_work_or_recovery_claim(self):
        instance = self.fixture()
        self.fake('capacity',lambda *a: (_ for _ in ()).throw(operator.InsufficientStorage('capacity')))
        original = operator.root_identity(instance.data)
        instance.run_rehearsal()
        self.assertEqual(operator.root_identity(instance.data),original)
        self.assertEqual(self.events.count('service:start'),1)
        self.assertIn('proof:unchanged',self.events)
        self.assertNotIn('snapshot',self.events)
        self.assertFalse(instance.recovery.exists())
        self.assertFalse(instance.workspace_mutated)

    def startup_guard_fixture(self, allocated, free):
        instance = self.fixture(); instance.output.mkdir()
        instance.launched = {'attempt': 2}
        instance.closed_allocated = 4096; instance.startup_growth = 8192
        instance.startup_budget = {'attempt': 2, 'closedAllocatedBytes': 4096, 'startupGrowthBudgetBytes': 8192,
                                   'minimumFreeBytes': operator.RESERVE + 2 * operator.ALLOWANCE, 'receiptSha256': 'c'*64}
        self.fake('allocated_metadata', lambda path: allocated)
        self.stack.enter_context(patch.object(operator.shutil, 'disk_usage', lambda path: types.SimpleNamespace(free=free)))
        instance.qualify_started_barrier = lambda *args: self.events.append('qualified-startup')
        instance.acceptance = lambda *args, **kwargs: dict(self.healthy)
        instance.startup_ready = lambda *args: self.events.append('startup-ready')
        return instance

    def test_startup_refusal_records_each_actual_predicate_before_stop_changes_allocation(self):
        minimum = operator.RESERVE + 2 * operator.ALLOWANCE
        for allocated, free, reason in ((12289, minimum, 'growth_limit'),
                                       (12288, minimum - 1, 'reserve_limit'),
                                       (12289, minimum - 1, 'growth_and_reserve_limits')):
            with self.subTest(reason=reason), contextlib.ExitStack() as local:
                case = RehearsalTests('runTest'); case.setUp(); local.callback(case.doCleanups)
                instance = case.startup_guard_fixture(allocated, free)
                path = instance.output/'startup-2-capacity-refusal.json'
                def stop(action):
                    self.assertEqual(action, 'stop')
                    value = json.loads(path.read_text())
                    self.assertEqual((value['allocatedBytes'], value['freeBytes'], value['reason']), (allocated, free, reason))
                    self.assertTrue(value['observedBeforeStop']); self.assertFalse(value['stopConfirmed'])
                    self.assertLess(len(path.read_bytes()), 2048)
                    case.events.append('service:stop')
                instance.service = stop
                with self.assertRaisesRegex(RuntimeError, 'Observed startup growth'):
                    operator.Rehearsal.wait_acceptance(instance, instance.prior_id, '2.0.2')
                value = json.loads(path.read_text())
                self.assertEqual(value['growthLimitExceeded'], allocated > 12288)
                self.assertEqual(value['reserveLimitExceeded'], free < minimum)
                self.assertLess(case.events.index('qualified-startup'), case.events.index('service:stop'))
                self.assertEqual(case.events.count('service:stop'), 1)

    def test_startup_refusal_diagnostic_failure_does_not_skip_protective_stop(self):
        instance = self.startup_guard_fixture(12289, operator.RESERVE + 2 * operator.ALLOWANCE)
        self.fake('write_json', lambda *args: (_ for _ in ()).throw(OSError('diagnostic unavailable')))
        with self.assertRaisesRegex(OSError, 'diagnostic unavailable'):
            operator.Rehearsal.wait_acceptance(instance, instance.prior_id, '2.0.2')
        self.assertEqual(self.events.count('service:stop'), 1)
        self.assertLess(self.events.index('qualified-startup'), self.events.index('service:stop'))
        self.assertIn('closed', self.events)

    def test_startup_refusal_preserves_existing_observation_and_keeps_exact_boundaries(self):
        instance = self.startup_guard_fixture(12289, operator.RESERVE + 2 * operator.ALLOWANCE)
        path = instance.output/'startup-2-capacity-refusal.json'; path.write_bytes(b'previous observation')
        with self.assertRaises(FileExistsError):
            operator.Rehearsal.wait_acceptance(instance, instance.prior_id, '2.0.2')
        self.assertEqual(path.read_bytes(), b'previous observation')
        self.assertEqual(self.events.count('service:stop'), 1)
        with contextlib.ExitStack() as local:
            case = RehearsalTests('runTest'); case.setUp(); local.callback(case.doCleanups)
            exact = case.startup_guard_fixture(12288, operator.RESERVE + 2 * operator.ALLOWANCE)
            self.assertEqual(operator.Rehearsal.wait_acceptance(exact, exact.prior_id, '2.0.2')['epoch'], exact.expected_prior['workspaceEpoch'])
            self.assertFalse((exact.output/'startup-2-capacity-refusal.json').exists())
            self.assertNotIn('service:stop', case.events)

    def budget_fixture(self, phase, free, allocated=4096):
        instance = self.fixture(); instance.output.mkdir()
        instance.source_root = operator.root_identity(instance.data)
        instance.closed_allocated = 1000; instance.startup_growth = 2000
        instance.phase = phase
        if phase != 'capacity-refused':
            instance.recovery.mkdir()
            exclusive_json(instance.recovery/'snapshot-manifest.json', portable_inventory(instance.data)[0])
            if phase == 'trial-start-intent':
                os.rename(instance.data, instance.original)
                shutil.copytree(instance.original, instance.data)
                instance.trial_root = operator.root_identity(instance.data)
            else:
                shutil.copytree(instance.data, instance.trial)
                instance.trial_root = operator.root_identity(instance.trial)
        self.fake('allocated_metadata', lambda path: allocated)
        self.stack.enter_context(patch.object(operator.shutil, 'disk_usage', lambda path: types.SimpleNamespace(free=free)))
        return instance

    def test_each_stopped_lifecycle_budgets_only_actual_remaining_free_space(self):
        floor = operator.RESERVE + 2 * operator.ALLOWANCE
        for phase in ('capacity-refused','trial-start-intent','return-original-complete','returned-original-retention-verified'):
            with self.subTest(phase=phase), contextlib.ExitStack() as local:
                case=RehearsalTests('runTest');case.setUp();local.callback(case.doCleanups)
                instance=case.budget_fixture(phase, floor+10000)
                instance.prepare_startup_budget()
                budget=json.loads((instance.output/'startup-1-capacity.json').read_text())
                self.assertEqual(budget['startupGrowthBudgetBytes'],10000)
                self.assertEqual(budget['closedAllocatedBytes'],4096)
                self.assertEqual(budget['remainingCopyBytes'],0)
                self.assertEqual(budget['minimumFreeBytes'],floor)
                self.assertTrue(budget['permitted'])
                self.assertEqual(instance.closed_allocated,1000)
                self.assertEqual(instance.startup_growth,2000)
                self.assertNotIn('service:start',case.events)

    def test_later_start_has_fresh_baseline_and_does_not_reuse_consumed_space(self):
        floor=operator.RESERVE+2*operator.ALLOWANCE
        instance=self.budget_fixture('return-original-complete',floor+10000)
        instance.prepare_startup_budget();first=dict(instance.startup_budget)
        instance.startup_attempt=1;instance.phase='returned-original-retention-verified'
        self.fake('allocated_metadata',lambda path:9000)
        self.stack.enter_context(patch.object(operator.shutil,'disk_usage',lambda path:types.SimpleNamespace(free=floor+4000)))
        instance.prepare_startup_budget()
        self.assertEqual(instance.startup_budget['closedAllocatedBytes'],9000)
        self.assertEqual(instance.startup_budget['startupGrowthBudgetBytes'],4000)
        self.assertEqual(first['startupGrowthBudgetBytes'],10000)
        self.assertEqual(len(instance.startup_budgets),2)

    def test_low_space_refusal_is_durable_and_cannot_rebudget_same_attempt(self):
        floor=operator.RESERVE+2*operator.ALLOWANCE
        instance=self.budget_fixture('capacity-refused',floor)
        with self.assertRaisesRegex(RuntimeError,'Actual stopped free'):
            instance.prepare_startup_budget()
        path=instance.output/'startup-1-capacity.json';before=path.read_bytes()
        self.assertFalse(json.loads(before)['permitted'])
        self.stack.enter_context(patch.object(operator.shutil,'disk_usage',lambda path:types.SimpleNamespace(free=floor+10000)))
        with self.assertRaises(FileExistsError):instance.prepare_startup_budget()
        self.assertEqual(path.read_bytes(),before);self.assertIsNone(instance.startup_budget)
        self.assertNotIn('service:start',self.events)

    def test_unknown_phase_or_missing_allocated_fallback_refuses_before_budget(self):
        floor=operator.RESERVE+2*operator.ALLOWANCE
        instance=self.budget_fixture('return-original-complete',floor+10000)
        shutil.rmtree(instance.trial)
        with self.assertRaises((RuntimeError,FileNotFoundError)):instance.prepare_startup_budget()
        self.assertFalse((instance.output/'startup-1-capacity.json').exists())
        instance.phase='snapshot-verified'
        with self.assertRaisesRegex(RuntimeError,'No reviewed allocation phase'):instance.prepare_startup_budget()

    def test_initial_growth_estimate_is_not_reused_as_restart_cap(self):
        instance=self.startup_guard_fixture(12288,operator.RESERVE+2*operator.ALLOWANCE)
        instance.closed_allocated=1;instance.startup_growth=1
        accepted=operator.Rehearsal.wait_acceptance(instance,instance.prior_id,'2.0.2')
        self.assertEqual(accepted['epoch'],instance.expected_prior['workspaceEpoch'])
        self.assertNotIn('service:stop',self.events)
        self.assertEqual(instance.startup_allocations[-1]['growthBytes'],8192)

    def test_trial_retention_failure_keeps_original_trial_snapshot_and_lease(self):
        instance = self.fixture()
        instance.retained_native = lambda: (_ for _ in ()).throw(RuntimeError('native comparison failed'))
        with self.assertRaisesRegex(RuntimeError,'native comparison'):instance.run_rehearsal()
        self.assertTrue(instance.original.exists())
        self.assertTrue(instance.data.exists())
        self.assertTrue(instance.recovery.exists())
        self.assertNotIn('proof:rehearsed',self.events)

    def test_cleanup_failure_after_release_never_claims_a_retained_hold(self):
        instance=self.fixture()
        instance.cleanup_trial=lambda: (_ for _ in ()).throw(OSError('cleanup interrupted'))
        with self.assertRaises(OSError):instance.run_rehearsal()
        last=json.loads(sorted(instance.output.glob('phase-*.json'))[-1].read_text())
        self.assertEqual(last['phase'],'cleanup-failed-after-release')
        self.assertTrue(last['releaseConfirmed'])
        self.assertTrue(instance.data.exists());self.assertTrue(instance.trial.exists())

    def test_actual_unchanged_proof_has_only_narrow_claims_and_hash_bound_evidence(self):
        instance=self.fixture();instance.output.mkdir();instance.before=dict(self.healthy)
        instance.source_root=operator.root_identity(instance.data)
        instance.held_allocated=8192;instance.closed_allocated=4096;instance.startup_growth=operator.ALLOWANCE
        folder=self.root/'state/operator-maintenance'/instance.job_id;folder.mkdir(parents=True)
        self.lease_phase='checking'
        def call(action,value=None):
            if action=='release':self.lease_phase='released'
            return {'lease':{'id':instance.job_id,'phase':self.lease_phase}}
        instance.operator=call
        operator.Rehearsal.proof(instance,'unchanged',dict(self.healthy))
        proof=json.loads((folder/'acceptance.json').read_text())
        self.assertTrue(proof['unchangedVerified']);self.assertEqual(proof['reason'],'insufficient_storage')
        self.assertNotIn('savedWorkVerified',proof);self.assertNotIn('recoveryVerified',proof)
        for name,field in [('rehearsal.json','evidenceSha256'),('prior-acceptance.json','priorAcceptanceSha256'),('returned-acceptance.json','returnedAcceptanceSha256')]:
            self.assertEqual(hashlib.sha256((folder/name).read_bytes()).hexdigest(),proof[field])

    def test_proof_release_timeout_does_not_reclassify_as_safe_to_replay(self):
        instance=self.fixture()
        def uncertain(outcome,accepted):
            instance.release_publication_started=True
            raise TimeoutError('response lost after release publication')
        instance.proof=uncertain
        with self.assertRaises(TimeoutError):instance.run_rehearsal()
        last=json.loads(sorted(instance.output.glob('phase-*.json'))[-1].read_text())
        self.assertEqual(last['phase'],'release-uncertain')
        self.assertFalse(last['releaseConfirmed'])
        self.assertTrue(instance.data.exists());self.assertTrue(instance.trial.exists())

    def test_ambiguous_root_identity_refuses_rename(self):
        instance = self.fixture(); instance.output.mkdir(); instance.recovery.mkdir()
        (instance.recovery/'snapshot-manifest.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError,'identity is ambiguous'):
            instance.move_role(instance.data,instance.original,{'device':0,'inode':0},'test')
        self.assertTrue(instance.data.exists()); self.assertFalse(instance.original.exists())

    def test_cleanup_rejects_unreleased_lease_and_wrong_trial_identity(self):
        instance = self.fixture(); instance.output.mkdir(); shutil.copytree(instance.data,instance.trial)
        instance.source_root=operator.root_identity(instance.data); instance.trial_root=operator.root_identity(instance.trial)
        with self.assertRaisesRegex(RuntimeError,'settled native'):instance.cleanup_trial()
        self.lease_phase='released'; instance.trial_root={'device':0,'inode':0}
        with self.assertRaisesRegex(RuntimeError,'exact newly created'):instance.cleanup_trial()
        self.assertTrue(instance.trial.exists()); self.assertTrue(instance.data.exists())

    def test_typed_systemd_guard_requires_exact_nonnegated_nontrigger_path(self):
        for name,trigger,negate,path,passes in [('ConditionPathIsDirectory',False,False,'/workspace',True),
            ('ConditionPathIsDirectory',False,True,'/workspace',False),('ConditionPathIsDirectory',True,False,'/workspace',False),
            ('ConditionPathExists',False,False,'/workspace',False),('ConditionPathIsDirectory',False,False,'/workspace-other',False)]:
            with self.subTest(trigger=trigger,negate=negate,path=path,name=name):
                values=[json.dumps({'type':'o','data':['/org/freedesktop/systemd1/unit/test']}),
                        json.dumps({'type':'a(sbbsi)','data':[[name,trigger,negate,path,0]]})]
                with patch.object(operator.subprocess,'check_output',side_effect=values):
                    if passes:operator.loaded_workspace_guard('nova.service',pathlib.PurePosixPath('/workspace'))
                    else:
                        with self.assertRaisesRegex(RuntimeError,'exact-workspace'):operator.loaded_workspace_guard('nova.service',pathlib.PurePosixPath('/workspace'))

    def test_status_reports_physical_roles_without_changing_or_inventing_recovery(self):
        instance=self.fixture(); instance.output.mkdir(); instance.source_root=operator.root_identity(instance.data)
        instance.record('preflight-passed')
        host=self.root/'host.json';host.write_text(json.dumps({'workspaceDirectory':str(instance.data)}))
        instance.review_path.write_text(json.dumps({'leaseId':instance.job_id,'candidateId':instance.prior_id,
            'workspaceEpoch':instance.expected_prior['workspaceEpoch'],'labParent':str(self.root),'hostConfiguration':str(host)}))
        # Status follows the fixed lease-namespaced lab, not a caller path.
        target=self.root/('rehearsal-'+instance.job_id);os.rename(instance.output,target)
        value=operator.rehearsal_status(instance.review_path)
        self.assertFalse(value['automaticRecoveryPermitted'])
        self.assertEqual(value['roles']['live'],instance.source_root)
        self.assertIsNone(value['roles']['original'])
        self.assertEqual((instance.data/'owner-record').read_bytes(),b'original saved data')

    def socket_reply(self, instance, status, payload=None, failure=None):
        """Real protocol/receipt code; fake only protected socket and transport."""
        calls=[]
        class Reply:
            def read(self, maximum):return payload[:maximum]
        response=Reply();response.status=status
        class Socket:
            def request(self, method, path, **kwargs):calls.append(path)
            def getresponse(self):
                if failure:raise failure
                return response
            def close(self):pass
        lstat=pathlib.Path.lstat;is_socket=pathlib.Path.is_socket
        self.stack.enter_context(patch.object(pathlib.Path,'lstat',lambda path,*a,**kw:
            types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=0o600) if path==pathlib.Path(operator.OPERATOR_SOCKET) else lstat(path,*a,**kw)))
        self.stack.enter_context(patch.object(pathlib.Path,'is_socket',lambda path:
            True if path==pathlib.Path(operator.OPERATOR_SOCKET) else is_socket(path)))
        self.fake('OperatorSocket',lambda *args,**kwargs:Socket())
        instance.operator=types.MethodType(operator.Rehearsal.operator,instance)
        return calls

    def test_controller_rejection_retains_safe_http_reason_before_reconciliation(self):
        instance=self.fixture();instance.output.mkdir()
        calls=self.socket_reply(instance,409,b'{"message":"A fresh idle workspace identity is required."}')
        with self.assertRaisesRegex(RuntimeError,'fresh_idle_identity_required'):
            instance.operator('enter',{'leaseId':instance.job_id,**instance.expected_prior})
        path=instance.output/'operator-request-failure.json';original=path.read_bytes()
        value=json.loads(original)
        self.assertEqual((value['action'],value['httpStatus'],value['outcome'],value['reason']),
                         ('enter',409,'rejected','fresh_idle_identity_required'))
        with self.assertRaises(RuntimeError):instance.operator('status')
        self.assertEqual(path.read_bytes(),original)
        self.assertEqual(calls,['/v1/enter','/v1/status'])

    def test_dynamic_rejection_and_server_failure_cannot_claim_known_refusal(self):
        for status in (409,500):
            with self.subTest(status=status),contextlib.ExitStack() as local:
                case=RehearsalTests('runTest');case.setUp();local.callback(case.doCleanups)
                instance=case.fixture();instance.output.mkdir()
                case.socket_reply(instance,status,b'{"message":"private-token and /private/owner/path"}')
                with self.assertRaises(RuntimeError) as failure:instance.operator('enter')
                record=(instance.output/'operator-request-failure.json').read_text()
                self.assertNotIn('private-token',record+str(failure.exception))
                self.assertNotIn('/private/owner/path',record+str(failure.exception))
                self.assertEqual(json.loads(record)['outcome'],'uncertain')

    def test_lost_operator_response_records_uncertain_without_repeating_request(self):
        instance=self.fixture();instance.output.mkdir()
        calls=self.socket_reply(instance,None,failure=TimeoutError('response lost'))
        with self.assertRaises(TimeoutError):instance.operator('enter')
        value=json.loads((instance.output/'operator-request-failure.json').read_text())
        self.assertIsNone(value['httpStatus']);self.assertEqual(value['outcome'],'uncertain')
        self.assertEqual(value['reason'],'transport_failure');self.assertEqual(calls,['/v1/enter'])

    def test_lost_enter_only_reconciles_exact_unstopped_lease_without_replay(self):
        for changed in (None,'candidateId','workspaceEpoch','stopMarked'):
            with self.subTest(changed=changed),contextlib.ExitStack() as local:
                case=RehearsalTests('runTest');case.setUp();local.callback(case.doCleanups)
                instance=case.fixture();calls=[]
                lease={'id':instance.job_id,**instance.expected_prior,'phase':'entered','stopMarked':False}
                if changed:lease[changed]=True if changed=='stopMarked' else 'wrong'
                def call(action,value=None):
                    calls.append(action)
                    if action=='enter':raise TimeoutError('lease persisted, reply lost')
                    return {'format':1,'lease':dict(lease)}
                instance.operator=call
                with self.assertRaises(TimeoutError):instance.run_rehearsal()
                self.assertEqual(calls,['enter','status']+(['cancel'] if changed is None else []))
                self.assertFalse(instance.stop_attempted)
                self.assertFalse(any(event.startswith('service:') for event in case.events))
                self.assertTrue(instance.data.exists());self.assertFalse(instance.recovery.exists())

    def freshness_boundary(self, instance, replies):
        clock=[0.0];seen=[]
        self.stack.enter_context(patch.object(operator.time,'monotonic',lambda:clock[0]))
        self.stack.enter_context(patch.object(operator.time,'sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)))
        def call(action,value=None):
            self.assertEqual(action,'status')
            fresh,latency=replies[min(len(seen),len(replies)-1)]
            seen.append(fresh);clock[0]+=latency
            return {'format':1,'held':False,'freshHeartbeat':fresh,'lease':None}
        instance.operator=call
        instance.wait_for_fresh_admission=types.MethodType(operator.Rehearsal.wait_for_fresh_admission,instance)
        return seen,clock

    def test_freshness_requires_new_observed_transition_not_initial_true(self):
        instance=self.fixture();instance.output.mkdir()
        seen,clock=self.freshness_boundary(instance,[(True,0),(True,0),(False,0),(True,0)])
        instance.wait_for_fresh_admission()
        self.assertEqual(seen,[True,True,False,True])
        self.assertEqual(clock[0],1.5)
        self.assertFalse((instance.output/'operator-request-failure.json').exists())
        self.assertFalse(instance.stop_attempted)

    def test_slow_status_reply_cannot_supply_freshness_transition(self):
        instance=self.fixture();instance.output.mkdir()
        seen,clock=self.freshness_boundary(instance,[(False,0),(True,3),(False,0),(True,0)])
        instance.wait_for_fresh_admission()
        self.assertEqual(seen,[False,True,False,True])
        self.assertLess(clock[0],45)

    def test_pause_between_fast_replies_does_not_supply_freshness_margin(self):
        instance=self.fixture();instance.output.mkdir()
        seen,clock=self.freshness_boundary(instance,[(False,0),(True,0),(False,0),(True,0)])
        sleeps=[]
        def paused(seconds):
            clock[0]+=4 if not sleeps else seconds
            sleeps.append(seconds)
        self.stack.enter_context(patch.object(operator.time,'sleep',paused))
        instance.wait_for_fresh_admission()
        self.assertEqual(seen,[False,True,False,True])
        self.assertLess(clock[0],45)

    def test_no_observed_transition_refuses_before_enter_or_service_action(self):
        for fresh in (False,True):
            with self.subTest(fresh=fresh),contextlib.ExitStack() as local:
                case=RehearsalTests('runTest');case.setUp();local.callback(case.doCleanups)
                instance=case.fixture()
                seen,clock=case.freshness_boundary(instance,[(fresh,0)])
                with self.assertRaisesRegex(RuntimeError,'newly observed idle heartbeat'):instance.run_rehearsal()
                self.assertEqual(clock[0],45)
                self.assertGreater(len(seen),1)
                self.assertFalse(any(event.startswith('service:') for event in case.events))
                proof=json.loads((instance.output/'operator-request-failure.json').read_text())
                self.assertEqual((proof['action'],proof['outcome'],proof['reason']),
                                 ('admission','not_attempted','new_heartbeat_not_observed'))
                self.assertFalse(instance.stop_attempted or instance.leased)

    def test_source_process_change_refuses_before_freshness_observation(self):
        instance=self.fixture();instance.output.mkdir()
        seen,_=self.freshness_boundary(instance,[(False,0),(True,0)])
        instance.process_identity=lambda:{'pid':999,'startTicks':999}
        with self.assertRaisesRegex(RuntimeError,'restarted before operator entry'):instance.wait_for_fresh_admission()
        self.assertEqual(seen,[])

    def test_active_lease_or_malformed_status_cannot_admit(self):
        for state in ({'held':False,'freshHeartbeat':True,'lease':{'phase':'entered'}},
                      {'held':False,'freshHeartbeat':1,'lease':None}):
            with self.subTest(state=state),contextlib.ExitStack() as local:
                case=RehearsalTests('runTest');case.setUp();local.callback(case.doCleanups)
                instance=case.fixture();instance.output.mkdir()
                instance.operator=lambda *args,**kwargs:state
                with self.assertRaisesRegex(RuntimeError,'unchanged idle controller'):
                    operator.Rehearsal.wait_for_fresh_admission(instance)
                proof=json.loads((instance.output/'operator-request-failure.json').read_text())
                self.assertEqual(proof['reason'],'admission_status_not_idle')

    def test_invalid_or_oversized_response_never_claims_refusal(self):
        for payload in (b'not-json',b'[]',b'x'*8193):
            with self.subTest(size=len(payload)),contextlib.ExitStack() as local:
                case=RehearsalTests('runTest');case.setUp();local.callback(case.doCleanups)
                instance=case.fixture();instance.output.mkdir()
                calls=case.socket_reply(instance,200,payload)
                with self.assertRaises((RuntimeError,ValueError)):instance.operator('enter')
                proof=json.loads((instance.output/'operator-request-failure.json').read_text())
                self.assertEqual((proof['outcome'],proof['reason']),('uncertain','invalid_response'))
                self.assertEqual(calls,['/v1/enter'])


if __name__=='__main__':unittest.main()
