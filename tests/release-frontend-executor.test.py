from pathlib import Path as P
import importlib.util,json,subprocess,tempfile,unittest,uuid
from types import SimpleNamespace
from unittest.mock import patch
ROOT=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('executor',ROOT/'scripts/release-frontend-executor.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class Tests(unittest.TestCase):
    def fixture(self):
        op=str(uuid.uuid4());run=str(uuid.uuid4());v={'operationId':op,'runId':run,'planInput':{'operation':{'path':'/var/lib/nova-update/frontend/operator-inputs/'+op+'/operation.json'}},'workerPlan':{},'workerIntent':{},'executor':{'path':'/fixed/executor.py'}}
        state={k:'' for k in M.PROPERTIES};state.update(LoadState='loaded',ActiveState='active',MainPID='123',ControlPID='0',ExecMainPID='123',Result='success',ExecMainStatus='0',InvocationID='a'*32,ControlGroup='/system.slice/'+M.unit_name(v,'execute'),Type='exec',RuntimeMaxUSec='2min',TimeoutStopUSec='15s',Restart='no',KillMode='control-group',MemoryMax=str(M.MEMORY),MemorySwapMax='0',CPUQuotaPerSecUSec='500ms',NoNewPrivileges='yes',ProtectSystem='strict',ReadWritePaths='/opt/nova/frontend /var/lib/nova-update/frontend',User='root')
        return v,state
    def test_effective_profile_rejects_each_resource_and_identity_mutation(self):
        v,state=self.fixture();self.assertEqual(M.effective_profile(v,state,123,'a'*32)['RuntimeMaxUSec'],120000000)
        changes={'Type':'simple','Restart':'always','KillMode':'process','MemoryMax':'infinity','MemorySwapMax':'100','NoNewPrivileges':'no','ProtectSystem':'no','RuntimeMaxUSec':'3min','TimeoutStopUSec':'30s','CPUQuotaPerSecUSec':'1s','User':'nobody','MainPID':'124','ExecMainPID':'124','InvocationID':'b'*32,'ReadWritePaths':'/opt/nova/frontend /var/lib/nova-update/frontend /'}
        for k,value in changes.items():
            with self.subTest(k=k),self.assertRaises(RuntimeError):M.effective_profile(v,state|{k:value},123,'a'*32)
    def test_closed_requires_zero_processes_and_empty_original_cgroup(self):
        v,state=self.fixture();quiet=state|{'ActiveState':'inactive','MainPID':'0','ControlGroup':''};self.assertTrue(M.closed(quiet))
        for change in ({'MainPID':'123'},{'ControlPID':'2'},{'ActiveState':'active'},{'LoadState':'masked'},{'ControlGroup':'/../../x'}):
            with self.assertRaises(RuntimeError):M.closed(quiet|change)
        with patch.object(M.P,'exists',return_value=True),patch.object(M.P,'rglob',return_value=[SimpleNamespace(read_text=lambda:'234\n')]),self.assertRaisesRegex(RuntimeError,'cgroup-not-empty'):
            M.closed(quiet|{'ControlGroup':state['ControlGroup']})
    def test_dispatch_is_durable_before_lost_launch_and_never_repeated(self):
        v,state=self.fixture();files={};calls=[];plan={'actual':'plan'};helper=SimpleNamespace(plan=lambda x:{'plan':plan})
        def save(path,data):files[str(path)]=data
        def run(args,**kwargs):
            calls.append(args);self.assertIn(str(M.paths(v,'execute')['dispatch.json']),files);raise subprocess.TimeoutExpired(args,20)
        absent=state|{'LoadState':'not-found','ActiveState':'inactive','MainPID':'0','ControlGroup':''}
        with patch.object(M.P,'exists',lambda p:str(p) in files),patch.object(M.P,'read_text',return_value='boot-id'),patch.object(M,'save',side_effect=save),patch.object(M,'ref',return_value=json.dumps(plan).encode()),patch.object(M,'system_state',return_value=absent),patch.object(M.subprocess,'run',side_effect=run),patch.object(M,'observe',return_value={'state':'uncertain','reason':'observed-original'}) as observe:
            first=M.launch(v,helper,P('/request'),'f'*64,'execute');self.assertEqual(first['state'],'uncertain')
            second=M.launch(v,helper,P('/request'),'f'*64,'execute');self.assertEqual(second['reason'],'observed-original');self.assertEqual(len(calls),1);observe.assert_called_once()
        args=calls[0];self.assertIn('--property=RuntimeMaxSec=120',args);self.assertIn('--property=TimeoutStopSec=15',args);self.assertIn('--property=KillMode=control-group',args)
        binding=files[str(M.paths(v,'execute')['dispatch.json'])];self.assertEqual(binding['deadlineAtMs']-binding['createdAtMs'],135000)
    def test_resume_requires_original_closed_started_native_operation_before_any_dispatch(self):
        v,state=self.fixture();quiet=state|{'ActiveState':'inactive','MainPID':'0','ControlGroup':''}
        for blocked in ('closed','verify_started','native_journal'):
            with self.subTest(blocked=blocked),patch.object(M.P,'exists',return_value=False),patch.object(M,'original_dispatch',return_value={}),patch.object(M,'system_state',return_value=quiet),patch.object(M,'closed',return_value=True),patch.object(M,'verify_started',return_value={}),patch.object(M,'native_journal',return_value=(None,{},b'')),patch.object(M,blocked,side_effect=RuntimeError('blocked-original')),patch.object(M,'save') as save,patch.object(M.subprocess,'run') as run:
                with self.assertRaisesRegex(RuntimeError,'blocked-original'):M.launch(v,None,P('/request'),'f'*64,'resume')
                save.assert_not_called();run.assert_not_called()
    def test_original_dispatch_and_started_refuse_rebound_run_and_unit(self):
        v,state=self.fixture();digest='f'*64;binding=M.dispatch_binding(v,digest,'execute')|{'createdAtMs':1000,'deadlineAtMs':136000,'bootId':'boot','monotonicDeadlineNs':999}
        with patch.object(M,'read',return_value=M.encoded(binding)):self.assertEqual(M.original_dispatch(v,digest,'execute'),binding)
        for change in ({'runId':str(uuid.uuid4())},{'requestSha256':'a'*64},{'deadlineAtMs':136001},{'unit':'other.service'}):
            with patch.object(M,'read',return_value=M.encoded(binding|change)),self.assertRaisesRegex(RuntimeError,'original-dispatch-changed'):M.original_dispatch(v,digest,'execute')
        started={'binding':binding,'pid':123,'invocationId':'a'*32,'unitProperties':state,'effectiveProfile':M.effective_profile(v,state,123,'a'*32)}
        with patch.object(M,'original_dispatch',return_value=binding),patch.object(M,'read',return_value=M.encoded(started)),self.assertRaisesRegex(RuntimeError,'unit-invocation-changed'):M.verify_started(v,digest,'execute',state|{'InvocationID':'b'*32})
    def test_readonly_observation_cannot_accept_changed_original_result(self):
        v,state=self.fixture();quiet=state|{'ActiveState':'inactive','MainPID':'0','ControlGroup':''};binding={'runId':v['runId']};started={'binding':binding,'invocationId':'a'*32};result={'binding':binding,'invocationId':'b'*32}
        with patch.object(M.P,'exists',lambda p:'resume.' not in str(p)),patch.object(M,'original_dispatch',return_value=binding),patch.object(M,'system_state',return_value=quiet),patch.object(M,'verify_started',return_value=started),patch.object(M,'read',return_value=M.encoded(result)),patch.object(M.subprocess,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'closed-worker-identity-changed'):M.observe(v,None,'f'*64)
            run.assert_not_called()
    def test_unloaded_original_unit_needs_recorded_start_and_checks_recorded_cgroup(self):
        v,state=self.fixture();digest='f'*64;binding={'requestSha256':digest};started={'binding':binding,'pid':123,'invocationId':'a'*32,'unitProperties':state,'effectiveProfile':M.effective_profile(v,state,123,'a'*32)}
        gone=state|{'LoadState':'not-found','ActiveState':'inactive','MainPID':'0','InvocationID':'','ControlGroup':''}
        with patch.object(M,'original_dispatch',return_value=binding),patch.object(M,'read',return_value=M.encoded(started)),patch.object(M,'closed',return_value=True) as closed:
            self.assertEqual(M.verify_started(v,digest,'execute',gone),started);self.assertEqual(closed.call_args.args[0]['ControlGroup'],state['ControlGroup'])
    def test_systemctl_accepts_only_zero_or_absent_four_with_complete_properties(self):
        v,state=self.fixture();raw='\n'.join(k+'='+x for k,x in state.items()).encode()
        for code in (0,4):
            with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=raw)):self.assertEqual(M.system_state('exact.service'),state)
        for code,data in ((1,raw),(0,b'LoadState=not-found')):
            with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=code,stdout=data)),self.assertRaises(RuntimeError):M.system_state('exact.service')
    def test_delayed_worker_start_keeps_original_deadline_and_closure_reserve(self):
        binding={'monotonicDeadlineNs':135000000000}
        self.assertEqual(M.remaining_child_timeout(binding,now=0),115)
        self.assertEqual(M.remaining_child_timeout(binding,now=100000000000),20)
        self.assertEqual(M.remaining_child_timeout(binding,now=119500000000),0.5)
        for now in (120000000000,134000000000,135000000000,136000000000):
            with self.assertRaisesRegex(RuntimeError,'deadline-expired'):M.remaining_child_timeout(binding,now=now)
        self.assertEqual(binding,{'monotonicDeadlineNs':135000000000})
    def test_worker_passes_reduced_budget_to_actual_native_child(self):
        v,state=self.fixture();v['planInput']['worker']={'path':'/fixed/frontend.py'};binding={'bootId':'boot-id','monotonicDeadlineNs':135000000000};helper=SimpleNamespace(worker_arguments=lambda *a:['/usr/bin/python3','-B','/fixed/frontend.py','--resume','/original-operation','--config','/original-config'])
        def read_text(path):return '0::'+state['ControlGroup'] if path.as_posix()=='/proc/self/cgroup' else 'boot-id'
        with patch.object(M,'original_dispatch',return_value=binding),patch.object(M,'system_state',return_value=state),patch.dict(M.os.environ,{'INVOCATION_ID':'a'*32}),patch.object(M.os,'getpid',return_value=123),patch.object(M.P,'read_text',read_text),patch.object(M.time,'monotonic_ns',return_value=100000000000),patch.object(M,'save'),patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'{}',stderr=b'')) as run:
            self.assertEqual(M.worker(v,helper,P('/original-request'),'f'*64,'resume'),0);self.assertEqual(run.call_args.kwargs['timeout'],20);self.assertIn('--resume',run.call_args.args[0]);self.assertNotIn('--execute',run.call_args.args[0])
if __name__=='__main__':unittest.main()
