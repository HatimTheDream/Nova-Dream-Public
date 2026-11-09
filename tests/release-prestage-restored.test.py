"""Exact original restored predecessor, with inert network/filesystem boundaries."""
import copy, json, pathlib, runpy, stat, unittest
from types import SimpleNamespace
from unittest.mock import patch

B = runpy.run_path(str(pathlib.Path(__file__).with_name('release-prestage-no-start.test.py')))
G, F, P, H, ENC = (B[k] for k in ('G','F','P','H','ENC'))
JOB, OLD, EPOCH = (B[k] for k in ('JOB','OLD','EPOCH'))


class RestoredFacts(unittest.TestCase):
    def fixture(self):
        spec, records, job, view, identity, names, pin = B['UnchangedFacts'].unchanged_fixture(self)
        def put(path, value, raw=False):
            data = value if raw else ENC(value)
            records[path] = data
            return dict(path=path, sha256=H(data))
        f=spec['failure'];attempt=str(P(f['result']['path']).parent)
        spec['kind']='explicit-restored-prior-facts';job['state']='restored';view['job']['state']='restored'
        records['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[job]))
        f['result']=put(f['result']['path'],dict(format=1,jobId=JOB,candidateId='a'*64,priorCandidateId='b'*64,
            outcome='restored',savedWorkVerified=True,accountsVerified=True,recoveryVerified=True,healthVerified=True))
        f['failure']=put(f['failure']['path'],dict(errorType='RuntimeError',reason='The previously attested complete Zod dependency closure is required.'))
        f['runnerLog']=put(f['runnerLog']['path'],b''.join(ENC(dict(stage=s))+b'\n' for s in ('preparing','installing','restarting','checking','restarting','checking')),True)
        f['runnerConfiguration']=put(f['runnerConfiguration']['path'],dict(format=1,recoveryDirectory='/var/lib/nova-update-recovery',serviceName='nova.service'))
        recovery='/var/lib/nova-update-recovery/update-'+JOB
        f['retainedRoles']={key:dict(path=recovery+suffix,device=1,inode=i+1,uid=0 if i==0 else 999,gid=999,mode=0o700,nlink=2) for i,(key,suffix) in enumerate((('recovery',''),('workspace','/workspace'),('failedWorkspace','/failed-workspace')))}
        f['snapshotManifest']=put(recovery+'/snapshot-manifest.json',{'saved':{'kind':'file','size':1,'sha256':'1'*64}})
        f['snapshotVerified']=put(recovery+'/snapshot-verified.json',{'manifestSha256':f['snapshotManifest']['sha256']})
        prior=spec['prior'];health=dict(status='ready',apiVersion=1,**{k:prior[k] for k in ('candidateId','version','buildVersion','schemaVersion')})
        f['restoredAcceptance']=put(recovery+'/acceptance.json',dict(health=health,agentVersion=prior['agentVersion']))
        f['attemptFiles']=[put(attempt+'/'+n,{}) for n in ('capacity.json','closed-capacity.json')]
        for number in (1,2,3):
            prefix=attempt+'/startup-'+str(number)+'-'
            started=dict(format=1,jobId=JOB,candidateId='a'*64 if number==1 else 'b'*64,attempt=number,
                epoch=EPOCH,agentVersion='2026.9.8',service='nova.service',startedAtSeconds=100*number,notBeforeTicks=2)
            sr=put(prefix+'started.json',started)
            binding=dict(process=dict(pid=1000+number,startTicks=500),invocationId='1'*32)
            fork=dict(format=1,jobId=JOB,attempt=number,**binding,observedAtSeconds=100*number+1,startedReceiptSha256=sr['sha256'])
            fr=put(prefix+'fork-observed.json',fork)
            process=dict(started,processBinding=binding,bindingReceiptSha256=fr['sha256'],process=binding['process'],processObservedAtSeconds=100*number+2)
            pr=put(prefix+'process.json',process)
            ready=dict(process,processReceiptSha256=pr['sha256'],readyAtSeconds=100*number+10)
            rr=put(prefix+'ready.json',ready)
            f['attemptFiles'] += [sr,fr,pr,rr]
            if number<3:
                f['attemptFiles'].append(put(prefix+'closed.json',dict(ready,readyReceiptSha256=rr['sha256'],closedAtSeconds=100*number+20,owningServiceFullyStopped=True)))
        names += [P(r['path']).name for r in f['attemptFiles']]
        return spec,records,job,view,identity,sorted(names),pin

    def observe(self,fixture,*,names=None,roles=None,reader=None):
        spec,records,job,view,identity,expected,pin=fixture
        def read(path,bound):
            raw=records[str(path)];self.assertLessEqual(len(raw),bound);return raw
        def prior(_c,_p,normal_access=False):
            self.assertTrue(normal_access);return copy.deepcopy(identity)
        with patch.dict(G,P=P,read=reader or read,controller_view=lambda:copy.deepcopy(view),
                members=lambda _p:list(expected if names is None else names),prior_identity=prior,
                restored_roles=roles or (lambda *_args: [('protected-original-roles',)]),RESTORED_INSTALLER=pin),patch.object(G['os'],'geteuid',return_value=0,create=True):
            return F['collect'](spec)

    def change(self,fixture,role,mutate):
        spec,records,*_=fixture;ref=spec['failure'][role];value=json.loads(records[ref['path']])
        mutate(value);records[ref['path']]=ENC(value);ref['sha256']=H(records[ref['path']])

    def test_restored_retains_failed_target_and_distinct_accepted_prior(self):
        facts=self.observe(self.fixture())
        self.assertEqual(facts['currentJob']['state'],'restored')
        self.assertEqual(facts['resultValue']['jobId'],OLD)
        self.assertTrue(facts['restoredFailure']['pairedRestorationVerified'])
        self.assertEqual(len(facts['restoredFailure']['attemptMembers']),24)
        self.assertEqual(len(facts['restoredFailure']['retainedRecoveryRoles']),3)
        self.assertNotIn('unchangedFailure',facts)

    def test_all_preservation_flags_require_true_not_integer(self):
        for field in ('savedWorkVerified','accountsVerified','healthVerified','recoveryVerified'):
            for value in (False,1,None):
                f=self.fixture();self.change(f,'result',lambda result:result.update({field:value}))
                with self.subTest(field=field,value=value),self.assertRaises(RuntimeError):self.observe(f)
        for field,value in (('outcome','unchanged'),('candidateId','c'*64),('priorCandidateId','c'*64),('jobId',OLD)):
            f=self.fixture();self.change(f,'result',lambda result:result.update({field:value}))
            with self.subTest(field=field),self.assertRaises(RuntimeError):self.observe(f)

    def test_hold_identity_and_original_state_mismatch_refuse(self):
        for field,value in (('hold',True),('state','failed'),('state','completed'),('started',False),('started',1),('prepared',False),
                            ('idempotencyKey',OLD),('candidateId','c'*64),('fromCandidateId','c'*64),('epoch',OLD),('releaseId','c'*64)):
            f=self.fixture();f[2][field]=value;f[3]['job']={k:f[2][k] for k in ('id','state','candidateId','releaseId')}
            f[1]['/var/lib/nova-update/jobs/journal.json']=ENC(dict(currentId=JOB,jobs=[f[2]]))
            with self.subTest(field=field,value=value),self.assertRaises(RuntimeError):self.observe(f)
        f=self.fixture();f[3]['holdFor']=JOB
        with self.assertRaises(RuntimeError):self.observe(f)

    def test_original_hash_and_member_changes_refuse(self):
        for role in ('operation','intent','request','result','failure','installer','bundle','runnerConfiguration','snapshotManifest','snapshotVerified','restoredAcceptance'):
            f=self.fixture();ref=f[0]['failure'][role];f[1][ref['path']]+=b' '
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.observe(f)
        for name in ('recovery-failure.json','unexpected'):
            f=self.fixture()
            with self.subTest(name=name),self.assertRaises(RuntimeError):self.observe(f,names=f[5]+[name])
        f=self.fixture()
        with self.assertRaises(RuntimeError):self.observe(f,names=f[5][1:])
        f=self.fixture();f[0]['failure']['attemptFiles'][0]=copy.deepcopy(f[0]['failure']['attemptFiles'][1])
        with self.assertRaises(RuntimeError):self.observe(f)

    def test_snapshot_acceptance_and_closed_startup_mismatch_refuse(self):
        for role,mutate in (
            ('snapshotVerified',lambda v:v.update(manifestSha256='f'*64)),
            ('restoredAcceptance',lambda v:v['health'].update(candidateId='a'*64)),
            ('restoredAcceptance',lambda v:v.update(agentVersion='2026.9.6')),
            ('failure',lambda v:v.update(reason='Unknown failure'))):
            f=self.fixture();self.change(f,role,mutate)
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.observe(f)
        for name,field,value in (('startup-1-ready.json','candidateId','b'*64),('startup-2-closed.json','owningServiceFullyStopped',False),
                                ('startup-3-fork-observed.json','startedReceiptSha256','f'*64)):
            f=self.fixture();ref=next(r for r in f[0]['failure']['attemptFiles'] if r['path'].endswith(name))
            v=json.loads(f[1][ref['path']]);v[field]=value;f[1][ref['path']]=ENC(v);ref['sha256']=H(f[1][ref['path']])
            with self.subTest(name=name),self.assertRaises(RuntimeError):self.observe(f)

    def test_preserved_roles_missing_or_racing_refuse(self):
        def missing(*_args):raise RuntimeError('original recovery role missing')
        with self.assertRaises(RuntimeError):self.observe(self.fixture(),roles=missing)
        count=iter((1,2))
        with self.assertRaisesRegex(RuntimeError,'restored-role-raced'):self.observe(self.fixture(),roles=lambda *_args:next(count))

    def test_original_evidence_changes_during_live_identity_read_refuse(self):
        f=self.fixture();path=f[0]['failure']['result']['path'];count=0
        def read(p,bound):
            nonlocal count
            raw=f[1][str(p)]
            if str(p)==path:
                count+=1
                if count>1:return raw+b' '
            return raw
        with self.assertRaises(RuntimeError):self.observe(f,reader=read)

    def test_real_role_predicate_accepts_application_owned_copies_and_refuses_aliases_or_redirects(self):
        recovery='/var/lib/nova-update-recovery/update-'+JOB;workspace='/var/lib/nova/workspace'
        paths={recovery:1,recovery+'/workspace':2,recovery+'/failed-workspace':3,workspace:4}
        def invoke(change=None):
            class NativePath(P):
                def resolve(self,strict=False):return NativePath('/redirected' if change=='redirect' and str(self).endswith('failed-workspace') else str(self))
                def lstat(self):
                    inode=paths[str(self)]
                    if change=='alias' and str(self).endswith('failed-workspace'):inode=4
                    return SimpleNamespace(st_dev=2 if change=='device' and str(self).endswith('failed-workspace') else 1,
                        st_ino=inode,st_mode=stat.S_IFDIR|0o700,st_uid=0 if str(self)==recovery else 999,st_gid=999,st_nlink=2)
            names=['workspace','failed-workspace','snapshot-manifest.json','snapshot-verified.json','acceptance.json']
            if change=='missing':names.remove('failed-workspace')
            with patch.dict(G,members=lambda _p:names,absent_role=lambda *_args:None):
                expected={key:dict(path=recovery+suffix,device=1,inode=i+1,uid=0 if i==0 else 999,gid=999,mode=0o700,nlink=2) for i,(key,suffix) in enumerate((('recovery',''),('workspace','/workspace'),('failedWorkspace','/failed-workspace')))}
                if change=='replaced':expected['failedWorkspace']['inode']=99
                return F['restored_roles'](NativePath(recovery),NativePath(workspace+'.restore-'+JOB),NativePath(workspace),expected)
        self.assertEqual([row[4] for row in invoke()],[0,999,999])
        for change in ('redirect','alias','device','missing','replaced'):
            with self.subTest(change=change),self.assertRaises(RuntimeError):invoke(change)


if __name__=='__main__':unittest.main()
