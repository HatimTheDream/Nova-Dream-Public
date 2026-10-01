"""Real admission/rollback orchestration over isolated synthetic host inputs.

No production service, socket, credentials, workspace or network is used.
Host discovery/API calls are boundary fakes; immutable-candidate/dependency and
configuration checks use real fixture bytes and POSIX guards under Linux root.
"""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    import types
    sys.modules['fcntl'] = types.SimpleNamespace()
import recovery
import app_dependencies
spec = importlib.util.spec_from_file_location('admission_driver', ROOT / 'deploy/update-runner/install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0,
                     'Real protected-path and symlink authority checks require isolated Linux root.')
class AdmissionDriverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-admission-fixture-',
            dir=os.environ.get('QA_PROTECTED_PARENT', '/opt'))
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.umask)
        self.temporary.cleanup()

    def preflight_fixture(self):
        request = self.root / 'request.json'
        request.write_text('{}'); request.chmod(0o600)
        instance = driver.Driver(request)
        epoch = '11111111-1111-4111-8111-111111111111'
        instance.prior_id = 'a'*64
        instance.request = {'preflightIdentity': {'candidateId': instance.prior_id, 'workspaceEpoch': epoch}}
        instance.release = {'manifestExpiresAt': 100_000, 'compatibility': {'fromNovaVersion': '2.0.2'}}
        instance.recovery_root = self.root
        calls = []
        instance.validate = lambda **kwargs: calls.append(('validate', kwargs))
        instance.archive_members = lambda: calls.append(('archive', {}))
        instance.verify_configuration = lambda: calls.append(('configuration', {}))
        health = {'status': 'ready', 'candidateId': instance.prior_id, 'version': '2.0.2', 'schemaVersion':55, 'apiVersion':1}
        context = {'workspaceEpoch':epoch}
        def api(path, session=False):
            self.assertFalse(session, 'Preflight must never obtain a mutating app session.')
            self.assertIn(path, {'health','access/context'})
            calls.append(('api',path))
            return copy.deepcopy(health if path == 'health' else context)
        instance.api = api
        return instance, calls, health, context

    def test_cli_preflight_reads_identity_without_session_lock_attempt_or_result(self):
        instance, calls, _, _ = self.preflight_fixture()
        before = {p.relative_to(self.root):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(sys, 'argv', ['install.py','--preflight',str(instance.request_path)]), \
             patch.object(driver, 'Driver', return_value=instance), patch.object(driver.time, 'time', return_value=1), \
             patch.object(driver.fcntl, 'flock', side_effect=AssertionError('Preflight cannot lock an installation')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            driver.main()
        proof = json.loads(output.getvalue())
        self.assertEqual(proof, {'format':1,'preflight':'passed',**instance.request['preflightIdentity']})
        self.assertEqual(calls[0], ('validate', {'preflight':True}))
        self.assertEqual([value for name,value in calls if name=='api'], ['health','access/context','health'])
        self.assertEqual(before, {p.relative_to(self.root):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_preflight_rejects_stale_epoch_candidate_expiry_and_changing_health_without_writes(self):
        mutations = ['epoch','expected-candidate','health-candidate','expired','health-changing']
        for kind in mutations:
            instance, calls, health, context = self.preflight_fixture()
            if kind=='epoch': context['workspaceEpoch']='22222222-2222-4222-8222-222222222222'
            if kind=='expected-candidate': instance.request['preflightIdentity']['candidateId']='b'*64
            if kind=='health-candidate': health['candidateId']='b'*64
            if kind=='expired': instance.release['manifestExpiresAt']=1000
            if kind=='health-changing':
                base=instance.api
                def changing(path, **kwargs):
                    result=base(path, **kwargs)
                    if path=='health' and sum(name=='api' and value=='health' for name,value in calls)>1:
                        result['candidateId']='b'*64
                    return result
                instance.api=changing
            with self.subTest(kind=kind), patch.object(driver.time, 'time', return_value=1), \
                 contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(RuntimeError):
                instance.preflight()
            self.assertEqual(output.getvalue(),'')
            self.assertEqual({p.name for p in self.root.iterdir()}, {'request.json'})
            self.assertFalse(instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_run_wipes_workspace_key_on_failure_success_and_validation_error(self):
        for kind in ['success','failure','validation']:
            instance=driver.Driver(self.root / 'request.json')
            instance.recovery_root=self.root
            key=bytearray(range(32))
            def validate():
                if kind=='validation':
                    instance.session_binding_key=key
                    raise RuntimeError('fixture validation failure')
            def run_validated():
                instance.session_binding_key=key
                if kind=='failure': raise RuntimeError('fixture post-key failure')
            instance.validate,instance.run_validated=validate,run_validated
            with self.subTest(kind=kind):
                if kind=='success': instance.run()
                else:
                    with self.assertRaises(RuntimeError): instance.run()
                self.assertEqual(key, b'\0'*32)
                self.assertIsNone(instance.session_binding_key)
                self.assertEqual(list(self.root.iterdir()), [])

    def adoption_fixture(self):
        releases=self.root/'releases'; releases.mkdir()
        original,rollback,target=[releases/name for name in ('original','rollback','target')]
        artifacts={'dist/client/index.html':b'fixture index','dist/service/apps/service/main.js':b'fixture main'}
        for directory in ('account-plugin','source-plugin','worker-plugin','module-plugin'):
            artifacts['dist/service/apps/service/'+directory+'/index.js']=b'fixture '+directory.encode()
        package={'name':'nova-dream-edition-3','version':'2.0.2','edition3':{'buildVersion':'1.0.266','schemaVersion':55,'apiVersion':1,'appId':'private.novadream.edition3.preview'}}
        manifest={'version':package['version'],**package['edition3'],'artifacts':[
            {'path':name,'sha256':hashlib.sha256(content).hexdigest()} for name,content in artifacts.items()]}
        for root in (original,rollback):
            root.mkdir()
            for name,content in {**artifacts,'package.json':json.dumps(package).encode(),
                                'dist/candidate.json':json.dumps(manifest).encode(),
                                'scripts/host.mjs':b'fixture host','scripts/candidate.mjs':b'fixture verifier'}.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)
        source=original/'node_modules';source.mkdir();(source/'library.js').write_bytes(b'original dependency')
        source.chmod(0o775);(source/'library.js').chmod(0o664)
        source_receipt=app_dependencies.inspect_retained_dependencies(source)
        deps=self.root/'dependencies'
        receipt=app_dependencies.stage_retained_dependencies(source,deps,source_receipt)['retained']
        (rollback/'node_modules').symlink_to(deps,target_is_directory=True)
        target.mkdir()
        instance=driver.Driver(self.root/'request.json')
        instance.releases=releases;instance.prior=original;instance.rollback_prior=rollback
        instance.adoption_source_prior=original;instance.dependencies=deps;instance.target=target
        instance.prior_id=hashlib.sha256((original/'package.json').read_bytes()+(original/'dist/candidate.json').read_bytes()).hexdigest()
        instance.prior_manifest=manifest;instance.release={'compatibility':{'fromNovaVersion':'2.0.2'},'novaVersion':'2.0.4'}
        instance.pair={'adoptPrior':{'sourceDependencies':source_receipt,'dependencies':receipt}}
        instance.adopting_prior=True
        return instance

    def test_adoption_accepts_independent_rollback_without_changing_running_paths(self):
        instance=self.adoption_fixture()
        before={p:recovery.digest(p) for p in instance.adoption_source_prior.rglob('*') if p.is_file()}
        instance.verify_prior_adoption()
        self.assertEqual(instance.prior,instance.adoption_source_prior)
        self.assertTrue((instance.prior/'node_modules').is_dir())
        self.assertFalse((instance.prior/'node_modules').is_symlink())
        self.assertNotEqual((instance.prior/'node_modules/library.js').stat().st_ino,(instance.dependencies/'library.js').stat().st_ino)
        self.assertEqual(before,{p:recovery.digest(p) for p in instance.adoption_source_prior.rglob('*') if p.is_file()})

    def test_adoption_rejects_changed_source_copy_startup_bytes_and_redirected_selector(self):
        instance=self.adoption_fixture()
        for kind,path,content in [('source',instance.prior/'node_modules/library.js',b'changed'),
                                  ('copy',instance.dependencies/'library.js',b'changed'),
                                  ('startup',instance.rollback_prior/'scripts/host.mjs',b'changed')]:
            original=path.read_bytes();path.write_bytes(content)
            with self.subTest(kind=kind),self.assertRaises(RuntimeError):instance.verify_prior_adoption()
            path.write_bytes(original)
        pointer=instance.rollback_prior/'node_modules';pointer.unlink();pointer.symlink_to(instance.prior/'node_modules')
        with self.assertRaises(RuntimeError):instance.verify_prior_adoption()

    def test_restored_adoption_compares_config_against_original_release_authority(self):
        instance=self.adoption_fixture()
        instance.prior=instance.rollback_prior
        instance.current=self.root/'current';instance.current.symlink_to(instance.rollback_prior)
        instance.recovery=self.root/'recovery';snapshot=instance.recovery/'workspace'
        instance.data=self.root/'data'
        plugin_dirs={'edition3-accounts':'account-plugin','edition3-sources':'source-plugin',
                     'edition3-worker':'worker-plugin','edition3-workspace':'module-plugin'}
        for workspace,release in ((snapshot,instance.adoption_source_prior),(instance.data,instance.rollback_prior)):
            config=workspace/'openclaw-runtime/openclaw.json';config.parent.mkdir(parents=True)
            paths={name:str(release/'dist/service/apps/service'/directory) for name,directory in plugin_dirs.items()}
            config.write_text(json.dumps({'plugins':{'load':{'paths':list(paths.values())},
                'entries':{name:{'enabled':True,'config':{'bundlePath':path}} for name,path in paths.items()}}}))
        instance.before={'epoch':'11111111-1111-4111-8111-111111111111'}
        instance.from_engine=instance.active_engine='2026.9.6';instance.log_retention_window=lambda:None
        def check_config(before,after,*args,**kwargs):
            recovery.native_runtime_configuration(before,after,pathlib.Path('.'),'2026.9.6','2026.9.6',
                                                   app_releases=kwargs['app_releases'])
        with patch.object(driver,'native_saved_state',side_effect=check_config):
            instance.retained_native()

    def test_workspace_change_after_preflight_cannot_seed_before_or_release_unchanged(self):
        instance=self.adoption_fixture()
        original_epoch='11111111-1111-4111-8111-111111111111'
        changed_epoch='22222222-2222-4222-8222-222222222222'
        identity={'candidateId':instance.prior_id,'workspaceEpoch':original_epoch}
        instance.request={'preflightIdentity':identity}
        instance.expected_prior=identity
        instance.current=self.root/'current';instance.current.symlink_to(instance.prior)
        instance.recovery_root=self.root;instance.target_id='b'*64
        instance.job_id='33333333-3333-4333-8333-333333333333'
        instance.active_engine='2026.9.6';instance.client_candidate=None
        instance.release.update(manifestExpiresAt=100_000,recovery={'readinessTimeoutSeconds':2})
        stage_calls=[];failures=[];changed=[False]
        instance.validate=lambda **kwargs: None
        instance.archive_members=lambda: []
        instance.verify_configuration=lambda: None
        instance.controller_hold=lambda: None
        instance.record_failure=lambda error: failures.append(type(error).__name__)
        instance.stage=lambda value: stage_calls.append(value)
        instance.stage_app=lambda: self.fail('A different workspace must never reach candidate staging.')
        instance.service=instance.switch=lambda *_: self.fail('No production mutation belongs in rejected admission.')
        health={'status':'ready','candidateId':instance.prior_id,'version':'2.0.2','schemaVersion':55,'apiVersion':1}
        def api(path, session=False):
            if path=='health': return copy.deepcopy(health)
            if path=='access/context': return {'workspaceEpoch':original_epoch}
            if path=='session': return {}
            if path=='software-update/acceptance':
                return {'candidateId':instance.prior_id,'heldFor':instance.job_id,'maintenanceHeld':True,
                    'nativeSuspended':True,'blockers':[],'epoch':changed_epoch if changed[0] else original_epoch,
                    'resumeReadinessRequired':True}
            if path=='assistant/service': return {'id':'openclaw','state':'ready','version':'2026.9.6'}
            if path=='assistant/state': return {'connection':{'state':'ready','grantedScopes':['operator.read','operator.write'],'modelAuthReady':True}}
            if path=='accounts': return {'accounts':[]}
            raise AssertionError('Unexpected fixture API')
        instance.api=api
        with patch.object(driver.time,'time',return_value=1),contextlib.redirect_stdout(io.StringIO()) as output:
            instance.preflight()
        self.assertEqual(json.loads(output.getvalue())['preflight'],'passed')
        changed[0]=True;clock=[0]
        with patch.object(driver.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(driver.time,'sleep',side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)), \
             self.assertRaises(RuntimeError):
            instance.run()
        self.assertIsNone(instance.before)
        self.assertEqual(stage_calls,[])
        self.assertTrue(failures)
        self.assertFalse((self.root/'result.json').exists())
        self.assertFalse(instance.result_publication_started or instance.stop_attempted or instance.switch_attempted or instance.workspace_mutated)

    def test_restored_acceptance_preserves_prior_target_receipt_then_replaces_atomically(self):
        instance=driver.Driver(self.root/'request.json')
        instance.recovery=self.root/'recovery';instance.recovery.mkdir()
        instance.prior_id='a'*64;instance.target_id='b'*64
        instance.from_engine=instance.to_engine='2026.9.6'
        target={'health':{'candidateId':instance.target_id,'version':'2.0.4','status':'ready'},'agentVersion':instance.to_engine}
        prior={'health':{'candidateId':instance.prior_id,'version':'2.0.2','status':'ready'}}
        recovery.write_json(instance.recovery/'acceptance.json',target)
        original=(instance.recovery/'acceptance.json').read_bytes()
        instance.publish_restored_acceptance(prior)
        self.assertEqual((instance.recovery/'target-acceptance-before-restoration.json').read_bytes(),original)
        self.assertEqual(json.loads((instance.recovery/'acceptance.json').read_bytes()),
                         {'health':prior['health'],'agentVersion':instance.from_engine})
        self.assertFalse((instance.recovery/'restored-acceptance.ready.json').exists())

    def test_unexpected_recovery_acceptance_is_preserved_and_never_overwritten(self):
        instance=driver.Driver(self.root/'request.json')
        instance.recovery=self.root/'recovery';instance.recovery.mkdir()
        instance.prior_id='a'*64;instance.target_id='b'*64
        instance.from_engine=instance.to_engine='2026.9.6'
        recovery.write_json(instance.recovery/'acceptance.json',
                            {'health':{'candidateId':'c'*64},'agentVersion':instance.to_engine})
        original=(instance.recovery/'acceptance.json').read_bytes()
        with self.assertRaisesRegex(RuntimeError,'unexpected recovery acceptance'):
            instance.publish_restored_acceptance({'health':{'candidateId':instance.prior_id}})
        self.assertEqual((instance.recovery/'acceptance.json').read_bytes(),original)
        self.assertEqual({p.name for p in instance.recovery.iterdir()},{'acceptance.json'})

    def publication_fixture(self):
        instance=self.adoption_fixture()
        instance.adopting_prior=False
        shutil.copytree(instance.prior,instance.target,dirs_exist_ok=True)
        package=json.loads((instance.target/'package.json').read_bytes());package['version']='2.0.4'
        (instance.target/'package.json').write_text(json.dumps(package))
        manifest=json.loads((instance.target/'dist/candidate.json').read_bytes());manifest['version']='2.0.4'
        (instance.target/'dist/candidate.json').write_text(json.dumps(manifest))
        instance.target_id=hashlib.sha256((instance.target/'package.json').read_bytes()+(instance.target/'dist/candidate.json').read_bytes()).hexdigest()
        instance.job_id='33333333-3333-4333-8333-333333333333'
        instance.current=self.root/'current';instance.current.symlink_to(instance.prior)
        instance.recovery_root=self.root/'recovery-root';instance.recovery_root.mkdir()
        instance.recovery=instance.recovery_root/'update-fixture'
        instance.baseline=instance.recovery_root/'baseline';instance.baseline.mkdir()
        instance.data=self.root/'workspace';instance.restore=self.root/'restore'
        instance.failed=instance.recovery/'failed-workspace'
        fixtures_spec=importlib.util.spec_from_file_location('publication_fixture_helpers',ROOT/'tests/update-runner.test.py')
        fixtures=importlib.util.module_from_spec(fixtures_spec);fixtures_spec.loader.exec_module(fixtures)
        fixtures.fixture_database(instance.data/'workspace.sqlite')
        shutil.copytree(instance.data,instance.baseline/'workspace')
        instance.release.update(manifestExpiresAt=9999999999999)
        instance.from_engine=instance.to_engine=instance.active_engine='2026.9.6'
        instance.config_files=[]
        instance.validate=instance.stage_app=instance.migrate_runtime=instance.verify_configuration=lambda:None
        instance.switch_runtime=lambda **kwargs:None
        instance.stage=lambda value:None
        instance.controller_hold=instance.retained_native=lambda:None
        running=[True]
        instance.service=lambda action:running.__setitem__(0,action=='start')
        instance.guarded_stop=lambda **kwargs:running.__setitem__(0,False)
        instance.require_stopped=lambda:self.assertFalse(running[0])
        def acceptance(expected,version,**kwargs):
            self.assertTrue(running[0])
            self.assertEqual(instance.current.resolve(),instance.prior if expected==instance.prior_id else instance.target)
            return {'health':{'candidateId':expected,'version':version,'status':'ready'},'accounts':[],
                    'epoch':'96b84a4e-172a-4481-8038-74663d28a6fc'}
        instance.wait_acceptance=acceptance
        return instance

    def test_post_target_acceptance_write_failures_complete_real_independent_rollback(self):
        base=self.root
        try:
            for failure in ('latest-created','completed-ready-created'):
                self.root=base/failure;self.root.mkdir()
                instance=self.publication_fixture()
                injected=[False]
                original_write=driver.write_json
                def write(path,value):
                    original_write(path,value)
                    if not injected[0] and ((failure=='latest-created' and path.name=='latest-'+instance.job_id+'.json')
                       or (failure=='completed-ready-created' and value.get('outcome')=='completed' and path.name.endswith('.ready.json'))):
                        injected[0]=True
                        raise OSError('synthetic durability failure after private file creation')
                with self.subTest(failure=failure),patch.object(driver,'write_json',side_effect=write):
                    instance.run()
                self.assertTrue(injected[0])
                self.assertEqual(instance.current.resolve(),instance.prior)
                self.assertEqual(json.loads((instance.output/'result.json').read_bytes())['outcome'],'restored')
                self.assertEqual(json.loads((instance.recovery/'acceptance.json').read_bytes())['health']['candidateId'],instance.prior_id)
                self.assertEqual(json.loads((instance.recovery/'target-acceptance-before-restoration.json').read_bytes())['health']['candidateId'],instance.target_id)
                self.assertEqual(json.loads((instance.recovery_root/'latest-update.json').read_bytes())['candidateId'],instance.prior_id)
                if failure=='completed-ready-created':
                    self.assertEqual(json.loads((instance.output/'result.completed.ready.json').read_bytes())['outcome'],'completed')
                self.assertTrue(instance.failed.is_dir())
                self.assertNotEqual((instance.data/'workspace.sqlite').stat().st_ino,
                                    (instance.recovery/'workspace/workspace.sqlite').stat().st_ino)
                self.assertNotEqual((instance.data/'workspace.sqlite').stat().st_ino,(instance.failed/'workspace.sqlite').stat().st_ino)
        finally:
            self.root=base

    def test_uncertain_final_result_publication_preserves_selected_target_without_rollback(self):
        instance=self.publication_fixture()
        original_replace=driver.os.replace
        def replace(source,destination):
            original_replace(source,destination)
            if pathlib.Path(destination)==instance.output/'result.json':
                raise OSError('synthetic uncertainty after final result became visible')
        with patch.object(driver.os,'replace',side_effect=replace), \
             patch.object(instance,'restore_prior',side_effect=AssertionError('Never restore after uncertain final publication')), \
             self.assertRaises(OSError):
            instance.run()
        self.assertTrue(instance.result_publication_started)
        self.assertEqual(instance.current.resolve(),instance.target)
        self.assertEqual(json.loads((instance.output/'result.json').read_bytes())['outcome'],'completed')
        self.assertFalse(instance.failed.exists())


if __name__=='__main__':
    unittest.main()
