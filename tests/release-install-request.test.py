"""Synthetic, effect-free tests of the maintained one-request client."""
import copy
import contextlib
import importlib.util
import io as streams
import json
import pathlib
import unittest

SPEC = importlib.util.spec_from_file_location('release_install_request', pathlib.Path(__file__).resolve().parents[1] / 'deploy/update-runner/request_install.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

UUIDS = [f'{i:08d}-1111-4111-8111-111111111111' for i in range(1, 6)]


class FakeIO:
    def __init__(self):
        self.time = 0
        self.deadline = 60
        self.calls, self.reads, self.writes = [], [], []
        self.directories = {'/var/lib/example-update', '/var/lib/example-update/release-coordinator', '/var/lib/example-update/release-coordinator/inputs'}
        self.config = {'format': 1, 'stateDirectory': '/var/lib/example-update', 'agentDirectory': '/opt/example/runtime/openclaw',
                       'runtimeDirectory': '/opt/example/runtime', 'socketGroup': 'nova'}
        self.operation = {'format': 1, 'operationId': UUIDS[0], 'candidateId': 'a' * 64, 'priorCandidateId': 'b' * 64,
            'workspaceEpoch': UUIDS[1], 'version': '9.0.2', 'buildVersion': '1.0.2', 'priorVersion': '9.0.1',
            'priorBuildVersion': '1.0.1', 'schemaVersion': 55, 'apiVersion': 1, 'agentVersion': '2026.9.8',
            'priorAgentVersion': '2026.9.6', 'bundleSha256': 'c' * 64, 'rehearsalLeaseId': UUIDS[2],
            'rehearsalProofSha256': None, 'idempotencyKey': UUIDS[3]}
        self.proof = {'format': 1, 'kind': 'operator-maintenance-acceptance', 'outcome': 'rehearsed',
            'leaseId': UUIDS[2], 'candidateId': 'b' * 64, 'workspaceEpoch': UUIDS[1],
            'savedWorkVerified': True, 'accountsVerified': True, 'recoveryVerified': True, 'healthVerified': True}
        self.operation['rehearsalProofSha256'] = M.sha(M.canonical(self.proof))
        self.lease = {'format': 1, 'id': UUIDS[2], 'candidateId': 'b' * 64, 'workspaceEpoch': UUIDS[1],
            'phase': 'released', 'releaseKind': 'rehearsed', 'stopMarked': True,
            'proofSha256': self.operation['rehearsalProofSha256']}
        self.health = {'status': 'ready', 'candidateId': 'b' * 64, 'version': '9.0.1', 'buildVersion': '1.0.1',
                       'schemaVersion': 55, 'apiVersion': 1, 'secret': 'do-not-publish'}
        self.view = {'availability': 'available', 'release': {'candidateId': 'a' * 64, 'releaseId': 'c' * 64,
            'novaVersion': '9.0.2', 'agentVersion': '2026.9.8', 'notes': ['private-message']},
            'installation': {'supported': True}, 'holdFor': None}
        self.journal = {'format': 1, 'currentId': None, 'jobs': []}
        self.operation_path = '/var/lib/example-update/release-coordinator/inputs/' + UUIDS[0] + '.json'
        self.audit = '/var/lib/example-update/release-coordinator/' + UUIDS[0]
        self.files = {self.operation_path: M.canonical(self.operation), M.CONFIG: M.canonical(self.config)}
        self.install_mode = 'record'
        self.stale_until = 0
        self.before_install = None

    def sync_sources(self):
        self.files[self.operation_path] = M.canonical(self.operation)
        self.files[M.CONFIG] = M.canonical(self.config)

    def read_bytes(self, path, maximum=65536, private=True):
        self.reads.append((path, maximum, private))
        dynamic = {
            '/var/lib/example-update/jobs/journal.json': self.journal,
            '/var/lib/example-update/operator-maintenance/current.json': self.lease,
            '/var/lib/example-update/operator-maintenance/' + UUIDS[2] + '/acceptance.json': self.proof,
        }
        result = M.canonical(dynamic[path]) if path in dynamic else self.files[path]
        if len(result) > maximum:
            raise M.Refusal('record-too-large')
        return result

    def protect(self, path, directory=False, private=True):
        if directory and path not in self.directories:
            raise M.Refusal('authority-not-private')

    def exists(self, path):
        return path in self.files or path in self.directories

    def mkdir(self, path):
        if self.exists(path):
            raise FileExistsError()
        self.directories.add(path)

    def save(self, path, value):
        if self.exists(path):
            raise FileExistsError()
        self.writes.append(path)
        self.files[path] = M.canonical(value)

    def runtime_version(self, _config):
        return '2026.9.6'

    def get_json(self, endpoint):
        return copy.deepcopy(self.health if endpoint == 'health' else {'workspaceEpoch': self.operation['workspaceEpoch']})

    def make_job(self):
        o = self.operation
        return {'id': UUIDS[4], 'idempotencyKey': o['idempotencyKey'], 'candidateId': o['candidateId'],
            'fromCandidateId': o['priorCandidateId'], 'releaseId': o['bundleSha256'], 'epoch': o['workspaceEpoch'],
            'when': 'now', 'state': 'checking', 'hold': True,
            'release': {'candidateId': o['candidateId'], 'fromCandidateId': o['priorCandidateId'],
                'bundle': {'sha256': o['bundleSha256']}, 'novaVersion': o['version'], 'agentVersion': o['agentVersion'],
                'compatibility': {'reviewed': True, 'gatewayProtocol': 4, 'fromNovaVersion': o['priorVersion'],
                    'fromAgentVersion': o['priorAgentVersion'], 'fromSchemaVersion': 55, 'toSchemaVersion': 55}}}

    def control(self, action, body, _group):
        if self.time >= self.deadline:
            raise M.DeadlineExpired('invocation-deadline')
        self.calls.append((action, copy.deepcopy(body)))
        if action == 'install':
            assert self.audit + '/intent.json' in self.files, 'dispatch preceded durable intent'
            if self.before_install:
                self.before_install()
            if self.install_mode != 'lost-no-record':
                job = self.make_job()
                self.journal['jobs'].append(job)
                self.journal['currentId'] = job['id']
                self.view['job'] = {key: job[key] for key in ('id', 'state', 'candidateId', 'releaseId')}
                self.view['holdFor'] = job['id']
            if self.install_mode.startswith('lost'):
                raise TimeoutError('must-not-print-transport-details')
        view = copy.deepcopy(self.view)
        if action in {'status', 'check'} and self.time < self.stale_until:
            view['blocker'] = {'code': 'workspace_unknown'}
        return 200, view

    def now_ms(self):
        return int(self.time * 1000)

    def monotonic(self):
        return self.time

    def sleep(self, seconds):
        self.time = min(self.deadline, self.time + seconds)

    def client(self):
        self.sync_sources()
        return M.InstallRequest(self.operation_path, self)


class InstallRequestTests(unittest.TestCase):
    def test_one_dispatch_after_exclusive_intent_and_no_private_output(self):
        io = FakeIO()
        result = io.client().execute()
        self.assertEqual(result['state'], 'checking')
        self.assertEqual(result['jobId'], UUIDS[4])
        self.assertTrue(result['currentJobMatches'])
        self.assertEqual(sum(a == 'install' for a, _ in io.calls), 1)
        self.assertFalse(result['automaticResubmissionPermitted'])
        self.assertTrue(result['finalAcceptanceRequired'])
        emitted = M.canonical(result) + b''.join(io.files[p] for p in io.writes)
        for text in (b'do-not-publish', b'private-message', b'must-not-print'):
            self.assertNotIn(text, emitted)

    def test_lost_reply_with_committed_job_is_observed_without_replay(self):
        io = FakeIO(); io.install_mode = 'lost-record'
        client = io.client(); result = client.execute()
        self.assertEqual(result['state'], 'checking')
        self.assertIn(io.audit + '/response-uncertain.json', io.files)
        io.calls.clear(); client.observe()
        self.assertEqual([a for a, _ in io.calls], ['status'])
        with self.assertRaisesRegex(M.Refusal, 'intent-exists'):
            client.execute()

    def test_lost_reply_without_job_stays_uncertain_and_does_not_retry(self):
        io = FakeIO(); io.install_mode = 'lost-no-record'
        client = io.client(); result = client.execute(20)
        self.assertEqual(result['state'], 'uncertain')
        self.assertIsNone(result['jobId'])
        self.assertEqual(sum(a == 'install' for a, _ in io.calls), 1)
        self.assertLessEqual(io.time, 60)
        with self.assertRaisesRegex(M.Refusal, 'intent-exists'):
            client.execute()

    def test_existing_partial_intent_directory_refuses_before_feed_check(self):
        io = FakeIO(); io.directories.add(io.audit)
        with self.assertRaisesRegex(M.Refusal, 'intent-exists'):
            io.client().execute()
        self.assertEqual(io.calls, [])

    def test_changed_identity_and_incomplete_rehearsal_never_reserve(self):
        for mutate in (lambda io: io.health.update(buildVersion='1.0.9'),
                       lambda io: io.lease.update(releaseKind='unchanged'),
                       lambda io: io.proof.update(accountsVerified=False),
                       lambda io: io.view['release'].update(releaseId='d' * 64)):
            with self.subTest(mutate=mutate):
                io = FakeIO(); mutate(io)
                with self.assertRaises(M.Refusal):
                    io.client().execute()
                self.assertFalse(io.exists(io.audit))
                self.assertFalse(any(a == 'install' for a, _ in io.calls))

    def test_actual_fresh_heartbeat_is_required_without_fake_heartbeat(self):
        io = FakeIO(); io.stale_until = 30
        result = io.client().execute()
        self.assertEqual(result['state'], 'checking')
        self.assertEqual(io.time, 30)
        self.assertFalse(any(a == 'heartbeat' for a, _ in io.calls))
        io = FakeIO(); io.stale_until = 100
        with self.assertRaisesRegex(M.Refusal, 'fresh-real-heartbeat'):
            io.client().execute()
        self.assertFalse(io.exists(io.audit))

    def test_mismatched_idempotency_job_is_never_adopted(self):
        io = FakeIO(); client = io.client(); client.execute()
        io.journal['jobs'][0]['epoch'] = UUIDS[0]
        io.calls.clear(); result = client.observe()
        self.assertEqual(result['state'], 'uncertain')
        self.assertEqual(result['reason'], 'original-request-identity-mismatch')
        self.assertIsNone(result['jobId'])
        self.assertFalse(any(a in {'check', 'install'} for a, _ in io.calls))

    def test_existing_controller_key_blocks_new_reservation(self):
        io = FakeIO(); io.journal['jobs'].append(io.make_job())
        with self.assertRaisesRegex(M.Refusal, 'idempotency-already-recorded'):
            io.client().execute()
        self.assertEqual(io.calls, [])

    def test_observe_binds_exact_input_bytes_and_ignores_changed_offer(self):
        io = FakeIO(); io.client().execute(); io.view['release']['candidateId'] = 'e' * 64
        io.calls.clear(); self.assertEqual(io.client().observe()['state'], 'checking')
        self.assertEqual([a for a, _ in io.calls], ['status'])
        io.operation['buildVersion'] = '1.0.3'
        with self.assertRaisesRegex(M.Refusal, 'saved-intent-identity-changed'):
            io.client().observe()

    def test_controller_job_difference_is_visible_not_final_acceptance(self):
        io = FakeIO(); client = io.client(); client.execute()
        io.journal['jobs'][0].update(state='completed', hold=False)
        io.view['job']['id'] = UUIDS[0]; io.view['holdFor'] = None
        result = client.observe()
        self.assertEqual(result['state'], 'completed')
        self.assertFalse(result['currentJobMatches'])
        self.assertTrue(result['finalAcceptanceRequired'])

    def test_strict_operation_rejects_paths_commands_and_unknown_fields(self):
        for key in ('socket', 'command', 'url', 'executable'):
            io = FakeIO(); io.operation[key] = 'must-not-run'
            with self.assertRaisesRegex(M.Refusal, 'invalid-operation-shape'):
                io.client()
            self.assertEqual(io.calls, [])

    def test_cli_requires_explicit_operation_absolute_path_and_bounded_wait(self):
        args = M.parse_args(['--observe', '--operation', '/private/example.json', '--wait-seconds', '60'])
        self.assertTrue(args.observe); self.assertFalse(args.execute)
        for path in ('relative.json', '/private/../other.json', '//server/share.json', '/private/secret\0.json'):
            with self.assertRaisesRegex(M.Refusal, 'operation-path-invalid'):
                M.parse_args(['--execute', '--operation', path])
        with self.assertRaisesRegex(M.Refusal, 'wait-outside-bound'):
            M.parse_args(['--observe', '--operation', '/private/example.json', '--wait-seconds', '61'])

    def test_whole_invocation_budget_does_not_resubmit_after_install_timeout(self):
        io = FakeIO(); io.install_mode = 'lost-no-record'
        io.before_install = lambda: setattr(io, 'time', 60)
        result = io.client().execute(60)
        self.assertEqual(result['state'], 'uncertain')
        self.assertEqual(result['reason'], 'observation-deadline')
        self.assertEqual(sum(a == 'install' for a, _ in io.calls), 1)
        self.assertFalse(result['automaticResubmissionPermitted'])

    def test_invalid_cli_prints_bounded_json_without_untrusted_argument(self):
        output = streams.StringIO()
        with contextlib.redirect_stdout(output):
            code = M.main(['--execute', '--command', 'NEVER-PRINT-THIS'])
        value = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(value['reason'], 'invalid-arguments')
        self.assertNotIn('NEVER-PRINT-THIS', output.getvalue())


class MigrationIO(FakeIO):
    """Synthetic complete three-scenario proof; never actual qualification."""
    def __init__(self):
        super().__init__()
        self.operation.update(schemaVersion=60, priorAgentVersion='2026.9.8')
        helpers = {name: M.sha(name.encode()) for name in ('install.py', 'recovery.py', 'operator_rehearsal.py',
            'app_dependencies.py', 'codex_log_retention.py', 'workspace_key.py', 'verify-session-bindings.mjs',
            'hosted_retained_configuration.py', 'local-retained-configuration.mjs', 'hosted_retained_catalog.py', 'hosted-retained-catalog.mjs')}
        transition = {'format':1,'kind':'schema-55-to-60-same-runtime','fromSchemaVersion':55,'toSchemaVersion':60,
            'apiVersion':1,'fromAgentVersion':'2026.9.8','toAgentVersion':'2026.9.8'}
        binding = {'format':1,'kind':'same-runtime-startup-candidate-binding','applicationTransition':transition,
            'workspaceEpoch':UUIDS[1], 'prior':{'candidateId':'b'*64,'version':'9.0.1'},
            'targets':{'private':{'candidateId':'a'*64,'version':'9.0.2','buildVersion':'1.0.2','packageLockSha256':'7'*64},
                'public':{'candidateId':'6'*64,'packageLockSha256':'7'*64}},
            'dependencyGraphSha256':'8'*64,'runtime':{'agentVersion':'2026.9.8'},'helpers':helpers}
        self.startup = {'format':1,'kind':'actual-retained-startup-qualification-observation',
            'scope':'retained-same-runtime-startup-restart-restoration','readOnly':True,'hostEffects':False,
            'productionAdmission':False,'qualificationBinding':binding,'scenarios':[],'references':{}}
        for key in ('actualSettledQualification','independentOriginalRestored','completeMaintainedSavedAndNativeState',
            'heldBootstrapVerified','workerClosed','freshFullRehearsalStillRequired','liveAcceptanceStillRequired'):
            self.startup[key] = True
        for i,name in enumerate(('target-first-start','target-restart','pristine-prior-restoration')):
            ref = {'path':f'/fixture/{name}/preservation.json','sha256':'f'*64}
            self.startup['scenarios'].append({'scenario':name,'candidateId':('b' if i==2 else 'a')*64,
                'startedAtSeconds':100+i*20,'closedAtSeconds':110+i*20,'preservation':ref})
            self.startup['references'][name+'/preservation'] = {**ref,'bytes':123}
        self.pair = {'format':1,'candidateId':'a'*64,'priorCandidateId':'b'*64,'helpers':helpers,
            'applicationTransition':transition,'startupQualification':{'binding':binding},
            'applicationDependencies':{'dependencyGraphSha256':'8'*64,'packageLockSha256':'7'*64}}
        self.sidecar = self.operation_path.removesuffix('.json') + '.qualification'
        self.directories.add(self.sidecar)
        self.bind_sidecars()

    def bind_sidecars(self):
        proof = M.canonical(self.startup)
        self.pair['startupQualification']['projection'] = {'path':'startup-qualification.json','sha256':M.sha(proof)}
        pair = M.canonical(self.pair)
        self.operation['applicationQualification'] = {'priorSchemaVersion':55,'reviewedPairSha256':M.sha(pair),'projectionSha256':M.sha(proof)}
        self.files[self.sidecar+'/reviewed-pair.json'] = pair
        self.files[self.sidecar+'/startup-qualification.json'] = proof

    def runtime_version(self, _config):
        return '2026.9.8'

    def make_job(self):
        job = super().make_job()
        job['release']['compatibility']['toSchemaVersion'] = 60
        return job


class ApplicationMigrationTests(unittest.TestCase):
    def test_qualified_migration_keeps_prior55_and_target60_and_original_wire(self):
        io = MigrationIO(); client = io.client(); result = client.execute()
        self.assertEqual(result['state'], 'checking')
        self.assertEqual(set(next(body for action,body in io.calls if action=='install')),
            {'epoch','candidateId','releaseId','currentCandidateId','idempotencyKey','when'})
        self.assertLess(len(M.canonical(io.operation)),8192)
        io.journal['jobs'][0].update(state='completed',hold=False)
        io.view['job']['state']='completed'; io.view['holdFor']=None
        io.health['schemaVersion']=60
        io.calls.clear(); self.assertEqual(io.client().observe()['state'],'completed')
        self.assertEqual([action for action,_ in io.calls],['status'])
        self.assertEqual(client.application_qualification()['pair'],io.pair)

    def test_unqualified_or_changed_prior_schema_never_dispatches(self):
        for change in (lambda io: io.operation.pop('applicationQualification'),
            lambda io: io.operation['applicationQualification'].update(priorSchemaVersion=60),
            lambda io: io.operation.update(priorAgentVersion='2026.9.6'),
            lambda io: io.health.update(schemaVersion=60)):
            io=MigrationIO(); change(io)
            with self.assertRaises(M.Refusal): io.client().execute()
            self.assertFalse(any(action=='install' for action,_ in io.calls))

    def test_incomplete_or_different_proof_is_rejected_even_when_rehashed(self):
        for change in (lambda io: io.startup.update(workerClosed=False),
            lambda io: io.startup['scenarios'].pop(),
            lambda io: io.pair['helpers'].pop('hosted-retained-catalog.mjs'),
            lambda io: io.startup['qualificationBinding'].update(workspaceEpoch=UUIDS[0]),
            lambda io: io.startup['qualificationBinding']['targets']['private'].update(version='9.0.9')):
            io=MigrationIO(); change(io); io.bind_sidecars()
            with self.assertRaises(M.Refusal): io.client().execute()
            self.assertFalse(any(action=='install' for action,_ in io.calls))

    def test_sidecar_change_and_same_schema_job_cannot_be_adopted(self):
        io=MigrationIO(); client=io.client(); client.execute()
        io.journal['jobs'][0]['release']['compatibility']['toSchemaVersion']=55
        self.assertEqual(client.observe()['reason'],'original-request-identity-mismatch')
        io.files[io.sidecar+'/startup-qualification.json'] += b' '
        with self.assertRaisesRegex(M.Refusal,'application-qualification-bytes-changed'): client.observe()

    def test_lost_reply_migration_observes_original_without_second_install(self):
        io=MigrationIO(); io.install_mode='lost-record'; client=io.client()
        self.assertEqual(client.execute()['state'],'checking')
        self.assertEqual(client.observe()['state'],'checking')
        self.assertEqual(sum(action=='install' for action,_ in io.calls),1)
        with self.assertRaisesRegex(M.Refusal,'intent-exists'): client.execute()


if __name__ == '__main__':
    unittest.main()
