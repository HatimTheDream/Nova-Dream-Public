"""Portable original-job facts regression; filesystem/network boundaries are inert."""
import base64, copy, hashlib, json, pathlib, runpy, stat, unittest
from types import SimpleNamespace
from unittest.mock import patch

F = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / 'scripts/full-host-primitives/install-facts.py'))
G = F['collect'].__globals__
P = pathlib.PurePosixPath
H = lambda b: hashlib.sha256(b).hexdigest()
ENC = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':')).encode()
OP = '10000000-0000-4000-8000-000000000001'
KEY = '10000000-0000-4000-8000-000000000002'
JOB = '10000000-0000-4000-8000-000000000003'
OLD = '10000000-0000-4000-8000-000000000004'
EPOCH = '10000000-0000-4000-8000-000000000005'
PF = 'preflight-10000000-0000-4000-8000-000000000006.json'


class NoStartFacts(unittest.TestCase):
    def fixture(self):
        authority = dict(operationId=OP, idempotencyKey=KEY, jobId=JOB,
                         candidateId='a'*64, priorCandidateId='b'*64, workspaceEpoch=EPOCH, bundleSha256='c'*64)
        config = {'format': 1, 'stateDirectory': '/var/lib/nova-update'}
        operation = {k:v for k,v in authority.items() if k != 'jobId'} | dict(format=1,
            priorVersion='1.2.3', priorBuildVersion='1.0.3', priorAgentVersion='2026.9.8',
            schemaVersion=60, applicationQualification={'priorSchemaVersion':55})
        release = {'candidateId':'a'*64, 'fromCandidateId':'b'*64, 'bundle':{'sha256':'c'*64}}
        job = dict(id=JOB, idempotencyKey=KEY, candidateId='a'*64, fromCandidateId='b'*64,
                   releaseId='c'*64, epoch=EPOCH, state='failed', prepared=True, started=False, hold=False, when='now', release=release)
        request = dict(epoch=EPOCH,candidateId='a'*64,releaseId='c'*64,currentCandidateId='b'*64,idempotencyKey=KEY,when='now')
        intent = dict(format=1,kind='nova-normal-install-intent',operationId=OP,operationSha256=H(ENC(operation)),
                      controllerConfigSha256=H(ENC(config)),request=request,requestSha256=H(ENC(request)),automaticResubmissionPermitted=False)
        preflight = dict(format=1,jobId=JOB,release=release,hostConfiguration='/etc/nova-update/config.json',
                         preflightIdentity=dict(candidateId='b'*64,workspaceEpoch=EPOCH))
        result = dict(format=1,jobId=OLD,candidateId='b'*64,priorCandidateId='d'*64,outcome='completed',
                      savedWorkVerified=True,accountsVerified=True,recoveryVerified=True,healthVerified=True)
        state='/var/lib/nova-update'
        records={}
        def put(path,value):
            raw=ENC(value);records[path]=raw;return dict(path=path,sha256=H(raw))
        config_ref=put('/etc/nova-update/config.json',config)
        op_ref=put(state+'/release-coordinator/inputs/'+OP+'.json',operation)
        intent_ref=put(state+'/release-coordinator/'+OP+'/intent.json',intent)
        pf_ref=put(state+'/staging/'+'c'*64+'/attempts/'+JOB+'/'+PF,preflight)
        accepted=put(state+'/staging/'+'e'*64+'/attempts/'+OLD+'/result.json',result)
        records[state+'/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[job]))
        prior=dict(candidateId='b'*64,version='1.2.3',buildVersion='1.0.3',agentVersion='2026.9.8',
                   workspaceEpoch=EPOCH,schemaVersion=55,appRoot='/opt/nova/releases/prior/app')
        spec=dict(kind='explicit-no-start-prior-facts',hostConfiguration=config_ref,acceptedInstallation=accepted,
                  priorJobId=OLD,prior=prior,failure=dict(operation=op_ref,intent=intent_ref,preflight=pf_ref,
                  coordinatorExport=dict(path='/private/export.json',sha256='f'*64),authority=authority))
        view=dict(holdFor=None,job={k:job[k] for k in ('id','state','candidateId','releaseId')})
        identity=dict(health=dict(candidateId='b'*64),workspaceEpoch=EPOCH,selectors={})
        return spec,records,job,view,identity

    def observe(self,spec,records,view,identity,names=None,reader=None):
        def read(path,bound):
            raw=records[str(path)];self.assertLessEqual(len(raw),bound);return raw
        with patch.dict(G, P=P,read=reader or read,controller_view=lambda:copy.deepcopy(view),
                        members=lambda _p:list(names if names is not None else [PF]),
                        prior_identity=lambda _c,p:copy.deepcopy(identity)), patch.object(G['os'],'geteuid',return_value=0,create=True):
            return F['collect'](spec)

    def test_separates_failed_current_job_from_authentic_accepted_prior(self):
        spec,records,job,view,identity=self.fixture()
        result=self.observe(spec,records,view,identity)
        self.assertEqual(result['currentJob'],job)
        self.assertEqual(result['currentJob']['state'],'failed')
        self.assertEqual(result['resultValue']['jobId'],OLD)
        self.assertEqual(result['resultValue']['outcome'],'completed')
        self.assertEqual(result['noStartFailure']['input'],spec)
        self.assertTrue(result['noStartFailure']['installerArtifactsAbsent'])

    def test_no_missing_result_fallback_without_explicit_scope(self):
        spec,records,_job,view,identity=self.fixture()
        with self.assertRaises(KeyError):self.observe(None,records,view,identity)

    def test_started_held_unprepared_nonfailed_and_wrong_job_are_refused(self):
        for field,value in [('started',True),('started',0),('prepared',False),('prepared',1),('hold',True),('state','restored'),('candidateId','d'*64),('fromCandidateId','d'*64),('epoch',OP),('idempotencyKey',OP)]:
            with self.subTest(field=field,value=value):
                spec,records,job,view,identity=self.fixture();job[field]=value
                records['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[job]))
                view['job']={k:job[k] for k in ('id','state','candidateId','releaseId')}
                with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)

    def test_any_installer_artifact_or_missing_preflight_refuses(self):
        for names in ([],[PF,'request.json'],[PF,'driver-attempt.json'],[PF,'result.json'],[PF,'runner.log']):
            with self.subTest(names=names):
                spec,records,_job,view,identity=self.fixture()
                with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity,names)

    def test_original_config_intent_preflight_or_accepted_bytes_cannot_change(self):
        for role in ('operation','intent','preflight','acceptedInstallation','hostConfiguration'):
            with self.subTest(role=role):
                spec,records,_job,view,identity=self.fixture()
                ref=spec[role] if role in spec else spec['failure'][role]
                records[ref['path']]+=b' '
                with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)

    def test_preflight_request_and_intent_identity_remain_positive_guards(self):
        for role,change in [('preflight',lambda v:v.update(jobId=OLD)),('preflight',lambda v:v.update(preflightIdentity={'candidateId':'d'*64,'workspaceEpoch':EPOCH})),('intent',lambda v:v.update(automaticResubmissionPermitted=True)),('intent',lambda v:v.update(controllerConfigSha256='0'*64))]:
            spec,records,_job,view,identity=self.fixture();ref=spec['failure'][role]
            value=json.loads(records[ref['path']]);change(value);records[ref['path']]=ENC(value);ref['sha256']=H(records[ref['path']])
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)

    def test_journal_race_and_controller_hold_refuse(self):
        spec,records,_job,view,identity=self.fixture();view['holdFor']=JOB
        with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity)
        spec,records,_job,view,identity=self.fixture();count=0
        def raced(path,bound):
            nonlocal count
            raw=records[str(path)]
            if str(path).endswith('/jobs/journal.json'):
                count+=1
                if count>1:return raw+b' '
            return raw
        with self.assertRaises(RuntimeError):self.observe(spec,records,view,identity,reader=raced)

    def test_ordinary_completed_current_result_is_unchanged(self):
        spec,records,job,view,identity=self.fixture();job.update(id=OLD,state='completed',candidateId='b'*64,releaseId='e'*64)
        records['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=OLD,jobs=[job]))
        view['job']={k:job[k] for k in ('id','state','candidateId','releaseId')}
        facts=self.observe(None,records,view,identity)
        self.assertEqual(facts['resultValue']['jobId'],OLD)
        self.assertNotIn('noStartFailure',facts)

    def test_real_prior_identity_predicate_checks_health_epoch_and_selectors(self):
        spec,_records,_job,_view,_identity=self.fixture();prior=spec['prior']
        config=dict(appCurrent='/opt/nova/current',releaseDirectory='/opt/nova/releases',
                    agentDirectory='/opt/nova/runtime/agent',runtimeDirectory='/opt/nova/runtime')
        baseline=dict(status='ready',candidateId='b'*64,version='1.2.3',buildVersion='1.0.3',schemaVersion=55,apiVersion=1)
        def invoke(change=None):
            health=copy.deepcopy(baseline);epoch=EPOCH;target=prior['appRoot'];agent_version='2026.9.8'
            if change:
                key,value=change
                if key=='epoch':epoch=value
                elif key=='selector':target=value
                elif key=='agentVersion':agent_version=value
                else:health[key]=value
            targets={config['appCurrent']:target,config['agentDirectory']:'/opt/nova/runtime/openclaw'}
            class NativePath(P):
                def resolve(self,strict=False):return NativePath(targets.get(str(self),str(self)))
                def lstat(self):return SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)
            class Response:
                status=200
                def __init__(self,value):self.value=value
                def __enter__(self):return self
                def __exit__(self,*_args):pass
                def read(self,bound):return ENC(self.value)
            class Opener:
                def open(self,request,timeout):
                    self_url=request.full_url
                    return Response({'workspaceEpoch':epoch} if self_url.endswith('/access/context') else health)
            with patch.dict(G,P=NativePath,read=lambda _p,_b:ENC({'name':'openclaw','version':agent_version})),patch.object(G['urllib'].request,'build_opener',return_value=Opener()):
                return F['prior_identity'](config,prior)
        self.assertEqual(invoke()['health'],baseline)
        for change in [('candidateId','d'*64),('version','9.9.9'),('buildVersion','9.9.9'),('schemaVersion',60),('apiVersion',2),('status','starting'),('epoch',OP),('selector','/opt/nova/releases/other/app'),('selector','/tmp/other/app'),('agentVersion','2026.9.6')]:
            with self.subTest(change=change),self.assertRaises(RuntimeError):invoke(change)


class UnchangedFacts(unittest.TestCase):
    # Reuse only the fixture builder: inherited no-start tests continue to run
    # against their original fixture and predicates in NoStartFacts.
    def unchanged_fixture(self):
        spec, records, job, view, identity = NoStartFacts.fixture(self)
        installer = b'portable frozen original installer boundary'
        pin = H(installer)
        pair = dict(format=1, candidateId='a'*64, priorCandidateId='b'*64, helpers={'install.py':pin})
        pair_raw=ENC(pair)
        bundle=ENC(dict(format=1,files=[dict(name=name,data=base64.b64encode(raw).decode(),sha256=H(raw))
                         for name,raw in [('install.py',installer),('reviewed-pair.json',pair_raw)]]))
        digest=H(bundle);state='/var/lib/nova-update';staging=state+'/staging/'+digest;attempt=staging+'/attempts/'+JOB
        def put(path,value,raw=False):
            data=value if raw else ENC(value);records[path]=data;return dict(path=path,sha256=H(data))
        f=spec['failure'];op=json.loads(records[f['operation']['path']]);op.update(bundleSha256=digest,version='1.3.0',agentVersion='2026.9.8')
        op['applicationQualification']['reviewedPairSha256']=H(pair_raw)
        f['operation']=put(f['operation']['path'],op)
        release=dict(candidateId='a'*64,fromCandidateId='b'*64,novaVersion='1.3.0',agentVersion='2026.9.8',bundle=dict(sha256=digest,runnerSha256=pin))
        job.update(started=True,releaseId=digest,release=release)
        f['authority']['bundleSha256']=digest
        intent=json.loads(records[f['intent']['path']]);intent['request']['releaseId']=digest
        intent.update(operationSha256=f['operation']['sha256'],requestSha256=H(ENC(intent['request'])))
        config=json.loads(records[spec['hostConfiguration']['path']]);config['workspaceDirectory']='/var/lib/nova/workspace'
        spec['hostConfiguration']=put(spec['hostConfiguration']['path'],config);intent['controllerConfigSha256']=spec['hostConfiguration']['sha256']
        f['intent']=put(f['intent']['path'],intent)
        expected=dict(format=1,jobId=JOB,release=release,hostConfiguration='/etc/nova-update/config.json')
        prior=dict(candidateId='b'*64,workspaceEpoch=EPOCH)
        f.pop('preflight');f.update(release=release,
            preflights=[put(attempt+'/'+n,dict(expected,preflightIdentity=prior)) for n in (PF,'preflight-10000000-0000-4000-8000-000000000007.json')],
            request=put(attempt+'/request.json',dict(expected,expectedPrior=prior)),
            result=put(attempt+'/result.json',dict(format=1,jobId=JOB,candidateId='a'*64,priorCandidateId='b'*64,outcome='unchanged',unchangedVerified=True,healthVerified=True,reasonCode='preflight_failed',reason='The update could not be prepared. The installed version is unchanged.')),
            failure=put(attempt+'/failure.json',dict(errorType='RuntimeError',reason='Source changed while its recovery identity was being captured.')),
            driverAttempt=put(attempt+'/driver-attempt.json',dict(jobId=JOB,candidateId='a'*64,priorCandidateId='b'*64)),
            runnerLog=put(attempt+'/runner.log',b'{"stage": "preparing"}\n',True),
            installer=put(staging+'/install.py',installer,True),bundle=put(staging+'/bundle.json',bundle,True),
            runnerConfiguration=put('/etc/nova-update/runner.json',dict(format=1,recoveryDirectory='/var/lib/nova-update-recovery')))
        records[attempt+'/driver.lock']=b'';records[state+'/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[job]))
        spec['kind']='explicit-unchanged-prior-facts';view['job']={k:job[k] for k in ('id','state','candidateId','releaseId')}
        names=sorted(['request.json','driver-attempt.json','result.json','failure.json','runner.log','driver.lock']+[P(r['path']).name for r in f['preflights']])
        return spec,records,job,view,identity,names,pin

    def observe_unchanged(self,fixture,*,names=None,absent=None,reader=None):
        spec,records,job,view,identity,expected,pin=fixture
        def read(path,bound):
            raw=records[str(path)];self.assertLessEqual(len(raw),bound);return raw
        def prior(_c,_p,normal_access=False):
            self.assertTrue(normal_access);return copy.deepcopy(identity)
        with patch.dict(G,P=P,read=reader or read,controller_view=lambda:copy.deepcopy(view),members=lambda _p:list(expected if names is None else names),prior_identity=prior,absent_role=absent or (lambda _p,*_roles:None),UNCHANGED_INSTALLER=pin),patch.object(G['os'],'geteuid',return_value=0,create=True):
            return F['collect'](spec)

    def test_started_unchanged_retains_failed_target_and_separate_accepted_prior(self):
        fixture=self.unchanged_fixture();facts=self.observe_unchanged(fixture)
        self.assertTrue(facts['currentJob']['started']);self.assertEqual(facts['currentJob']['state'],'failed')
        self.assertEqual(facts['resultValue']['jobId'],OLD);self.assertTrue(facts['unchangedFailure']['preStopUnchangedVerified'])
        self.assertNotIn('noStartFailure',facts);self.assertEqual(len(facts['unchangedFailure']['attemptMembers']),8)

    def test_started_unchanged_rejects_other_outcomes_and_boolean_lookalikes(self):
        for key,value in [('outcome','restored'),('unchangedVerified',False),('unchangedVerified',1),('healthVerified',False),('reasonCode','insufficient_storage'),('candidateId','d'*64),('jobId',OLD)]:
            f=self.unchanged_fixture();ref=f[0]['failure']['result'];v=json.loads(f[1][ref['path']]);v[key]=value;f[1][ref['path']]=ENC(v);ref['sha256']=H(f[1][ref['path']])
            with self.subTest(key=key,value=value),self.assertRaises(RuntimeError):self.observe_unchanged(f)

    def test_started_unchanged_requires_exact_attempt_members_and_empty_lock(self):
        f=self.unchanged_fixture()
        for extra in ('capacity.json','closed-capacity.json','startup-verified.json','recovery-failure.json','unexpected'):
            with self.subTest(extra=extra),self.assertRaises(RuntimeError):self.observe_unchanged(f,names=sorted(f[5]+[extra]))
        with self.assertRaises(RuntimeError):self.observe_unchanged(f,names=f[5][1:])
        lock=str(P(f[0]['failure']['result']['path']).parent/'driver.lock');f[1][lock]=b'claimed'
        with self.assertRaises(AssertionError):self.observe_unchanged(f)

    def test_started_unchanged_denies_hold_not_started_and_unprepared(self):
        for key,value in [('hold',True),('started',False),('prepared',False),('started',1),('state','completed')]:
            f=self.unchanged_fixture();f[2][key]=value;f[1]['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[f[2]]));f[3]['job']['state']=f[2]['state']
            with self.subTest(key=key),self.assertRaises(RuntimeError):self.observe_unchanged(f)

    def test_started_unchanged_denies_source_request_failure_and_runner_changes(self):
        for role in ('request','driverAttempt','result','failure','runnerLog','installer','bundle','runnerConfiguration'):
            f=self.unchanged_fixture();ref=f[0]['failure'][role];f[1][ref['path']]+=b' '
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.observe_unchanged(f)
        f=self.unchanged_fixture();ref=f[0]['failure']['runnerLog'];f[1][ref['path']]=b'{"stage":"stopping"}\n';ref['sha256']=H(f[1][ref['path']])
        with self.assertRaises(RuntimeError):self.observe_unchanged(f)

    def test_started_unchanged_recovery_role_presence_and_second_read_race_refuse(self):
        f=self.unchanged_fixture();seen=[]
        def absent(p,*_roles):
            seen.append(str(p));raise RuntimeError('present')
        with self.assertRaises(RuntimeError):self.observe_unchanged(f,absent=absent)
        self.assertEqual(seen,['/var/lib/nova-update-recovery/update-'+JOB])
        f=self.unchanged_fixture();target=f[0]['failure']['failure']['path'];reads=0
        def read(p,b):
            nonlocal reads
            raw=f[1][str(p)]
            if str(p)==target:
                reads+=1
                if reads>1:return raw+b' '
            return raw
        with self.assertRaises(RuntimeError):self.observe_unchanged(f,reader=read)




class UnchangedRoleBoundary(unittest.TestCase):
    def invoke(self,*,root_role=False,owner=999,redirect=False,symlink=False,device=7,present=False,race=False):
        base='/var/lib/nova';workspace=base+'/workspace';recovery='/var/lib/nova-update-recovery'
        selected=recovery if root_role else base
        count=0
        def info(name):
            nonlocal count
            user=owner if name in (base,workspace) else 0
            mode=(stat.S_IFLNK if symlink and name==base else stat.S_IFDIR)|0o700
            inode=100+len(name)
            if race and name==base:
                count+=1
                if count>6:inode+=1
            return SimpleNamespace(st_dev=device if name==workspace else 7,st_ino=inode,st_mode=mode,st_uid=user,st_gid=986 if user else 0)
        class RolePath(P):
            def resolve(self,strict=False):return RolePath('/elsewhere') if redirect and str(self)==base else self
            def lstat(self):return info(str(self))
        def child_stat(name,*,dir_fd,follow_symlinks):
            self.assertEqual(dir_fd,41);self.assertFalse(follow_symlinks)
            if present:return info(name)
            raise FileNotFoundError(name)
        def opened(path,flags):
            self.assertEqual(str(path),selected)
            self.assertTrue(flags&G['os'].O_NOFOLLOW);self.assertTrue(flags&G['os'].O_DIRECTORY)
            return 41
        with patch.object(G['os'],'O_DIRECTORY',0x10000,create=True),patch.object(G['os'],'O_NOFOLLOW',0x20000,create=True),patch.object(G['os'],'open',side_effect=opened),patch.object(G['os'],'fstat',side_effect=lambda _fd:info(selected)),patch.object(G['os'],'stat',side_effect=child_stat),patch.object(G['os'],'close'):
            return F['absent_role'](RolePath(selected)/('update-'+JOB if root_role else 'workspace.restore-'+JOB),
                None if root_role else RolePath(workspace),None if root_role else RolePath(recovery))

    def test_app_owned_workspace_parent_is_valid_but_recovery_stays_root_owned(self):
        identity=self.invoke();self.assertEqual(identity[1][3],999)
        self.assertEqual(self.invoke(root_role=True)[0][3],0)

    def test_workspace_redirect_symlink_device_presence_and_race_refuse(self):
        for kwargs in ({'redirect':True},{'symlink':True},{'device':8},{'present':True},{'race':True}):
            with self.subTest(kwargs=kwargs),self.assertRaises(RuntimeError):self.invoke(**kwargs)

    def test_recovery_parent_cannot_be_app_owned(self):
        class UntrustedRoot(P):
            def resolve(self,strict=False):return self
            def lstat(self):return SimpleNamespace(st_dev=7,st_ino=1,st_mode=stat.S_IFDIR|0o700,st_uid=999,st_gid=986)
        with self.assertRaisesRegex(RuntimeError,'unchanged-recovery-parent-unprotected'):
            F['absent_role'](UntrustedRoot('/var/lib/nova-update-recovery')/('update-'+JOB))


if __name__=='__main__':unittest.main()
