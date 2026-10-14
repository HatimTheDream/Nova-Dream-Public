"""Local contract models only. No host, network, credentials or production paths."""
import copy,importlib.util,io,json,pathlib,tempfile,time,unittest,urllib.error,uuid
from unittest.mock import patch
P=pathlib.Path
spec=importlib.util.spec_from_file_location('transport',P(__file__).parent.parent/'scripts/release-assistant-transport.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def uid():return str(uuid.uuid4())
class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='nova-assistant-model-');self.addCleanup(self.temp.cleanup);self.root=P(self.temp.name)
        def save(p,v):
            b=m.enc(v)+b'\n'
            with p.open('xb') as f:f.write(b)
            return {'path':str(p),'sha256':m.sha(b)}
        self.patches=[patch.object(m,'raw',lambda p,*args,**kwargs:P(p).read_bytes()),patch.object(m,'save',save)]
        for p in self.patches:p.start();self.addCleanup(p.stop)
        self.binding={'parentKey':uid(),'input':{'installedHealth':{'epoch':uid(),'candidateId':'a'*64}}}
        self.session={'deviceId':uid(),'sessionSha256':'b'*64};self.calls=[]
        self.body={'requestId':uid(),'epoch':self.binding['input']['installedHealth']['epoch'],'space':'chat','autoTitle':False,'title':'Nova deployment verification','projectId':None,'permissionMode':'read-only'}
        self.common={'session':self.session,'request':self.request('/api/assistant/conversations',self.body),'effectCapableContinuation':False}
        self.session['readiness']={'connectionGeneration':uid()};self.last_output=None
        class Api:
            def read(inner,path,body=None):
                if body is None:return {'conversations':[self.last_output]}
                self.calls.append((path,body))
                if not self.last_output:self.last_output={'id':uid(),'nativeId':uid(),'nativeKey':'original','connectionGeneration':self.session['readiness']['connectionGeneration'],'revision':1,'state':'ready'}
                return self.last_output
        self.api=Api()
    def request(self,endpoint,body):
        b=m.enc(body).decode();return {'endpoint':endpoint,'bodyBytes':b,'bodySha256':m.sha(b.encode()),'requestId':body['requestId'],'deviceId':self.session['deviceId'],'sessionSha256':self.session['sessionSha256'],'epoch':body['epoch']}
    def test_lost_output_after_response_saved_reuses_original(self):
        out=m.post_exact(self.api,self.root,self.binding,self.common)
        resumed={**self.common,'effectCapableContinuation':True}
        self.assertEqual(m.post_exact(self.api,self.root,self.binding,resumed),out);self.assertEqual(len(self.calls),1)
    def test_provisional_create_observes_same_ready_identity_without_another_post(self):
        self.last_output={'id':uid(),'nativeId':None,'nativeKey':'original','connectionGeneration':self.session['readiness']['connectionGeneration'],'revision':1,'state':'creating'}
        original=m.post_exact(self.api,self.root,self.binding,self.common)
        self.last_output={**original,'nativeId':uid(),'revision':2,'state':'ready'};self.common['effectCapableContinuation']=True
        actual=m.post_exact(self.api,self.root,self.binding,self.common)
        self.assertEqual(actual,self.last_output);self.assertEqual(len(self.calls),1)
        retained=json.loads((self.root/('result-'+self.body['requestId']+'.json')).read_bytes());self.assertEqual(retained,original)
    def test_cached_create_rejects_changed_native_or_generation(self):
        original=m.post_exact(self.api,self.root,self.binding,self.common);self.common['effectCapableContinuation']=True
        for key in ('nativeId','connectionGeneration','id'):
            self.last_output={**original,key:uid()}
            with self.assertRaises(RuntimeError):m.post_exact(self.api,self.root,self.binding,self.common)
    def test_create_lost_after_commit_retransmits_only_identical_key(self):
        original=m.save
        def interrupted(p,v):
            if p.name.startswith('result-'):raise RuntimeError('fixture-lost-local-write')
            return original(p,v)
        with patch.object(m,'save',interrupted):
            with self.assertRaisesRegex(RuntimeError,'fixture-lost'):m.post_exact(self.api,self.root,self.binding,self.common)
        with self.assertRaisesRegex(RuntimeError,'replay-refused'):m.post_exact(self.api,self.root,self.binding,self.common)
        self.common['effectCapableContinuation']=True;m.post_exact(self.api,self.root,self.binding,self.common)
        self.assertEqual(self.calls[0],self.calls[1])
    def test_submit_marker_never_reposts_after_loss(self):
        c={'id':uid(),'revision':1};body={'requestId':uid(),'epoch':self.body['epoch'],'conversationId':c['id'],'conversationRevision':1,'draftId':'draft:'+self.session['deviceId']+':'+c['id'],'draftRevision':1,'projectRevision':0}
        common={'session':self.session,'conversation':c,'request':self.request('/api/assistant/submit',body),'effectCapableContinuation':True}
        m.save(self.root/('request-'+body['requestId']+'.json'),common['request'])
        with self.assertRaisesRegex(RuntimeError,'replay-refused'):m.post_exact(self.api,self.root,self.binding,common)
        self.assertEqual(self.calls,[])
    def test_request_changes_and_arbitrary_endpoints_fail_before_post(self):
        for key,value in [('endpoint','/api/commands/delete'),('deviceId',uid()),('sessionSha256','c'*64),('epoch',uid()),('bodySha256','d'*64)]:
            c=copy.deepcopy(self.common);c['request'][key]=value
            with self.assertRaises(RuntimeError):m.post_exact(self.api,self.root,self.binding,c)
        self.assertEqual(self.calls,[])
    def test_original_session_response_loss_reads_saved_credentials_without_post(self):
        count=[];device=uid()
        class Api:
            def __init__(self,*args):pass
            def read(self,*args,**kwargs):count.append(args);return {'deviceId':device}
            def cookies(self):return [{'value':'synthetic-local-fixture'}]
        common={'childKey':uid(),'observeOnly':False}
        with patch.object(m,'Api',Api):
            saved,reference,_=m.original_session(self.binding,common,self.root,time.monotonic()+60)
            common['observeOnly']=True;again,other,_=m.original_session(self.binding,common,self.root,time.monotonic()+60)
        self.assertEqual(saved,again);self.assertEqual(reference,other);self.assertEqual(len(count),1)
    def test_uncertain_session_does_not_reauthenticate(self):
        common={'childKey':uid(),'observeOnly':False};m.save(self.root/'session-dispatch.json',{'childKey':common['childKey'],'bindingSha256':m.sha(m.enc(self.binding))})
        with patch.object(m,'Api') as api:
            for only in (True,False):
                common['observeOnly']=only
                with self.assertRaisesRegex(RuntimeError,'session-unavailable'):m.original_session(self.binding,common,self.root,time.monotonic()+60)
            api.assert_not_called()
    def test_state_projection_retains_entire_unknown_fingerprint(self):
        unknown={'id':uid(),'state':'unknown','conversationId':uid(),'text':'private retained text','arbitraryNested':{'uncommon':'one'}}
        state={'connection':{},'operations':[unknown,{'id':uid(),'state':'completed','text':'unrelated private reply'}],'conversations':[{'id':uid(),'title':'unrelated'}]}
        first=m.project_state(state,self.root);self.assertEqual(len(first['operations']),1);self.assertEqual(first['conversations'],[])
        self.assertNotIn('text',first['operations'][0]);self.assertEqual(first['operations'][0]['actualStateSha256'],m.sha(m.enc(unknown)))
        unknown['arbitraryNested']['uncommon']='two';self.assertNotEqual(m.project_state(state,self.root),first)
    def test_state_projection_keeps_actual_own_operation_and_conversation(self):
        request=self.common['request'];conversation={'id':uid(),'nativeId':uid(),'revision':1};operation={'id':uid(),'state':'completed','requestId':request['requestId'],'text':'saved reply'}
        m.save(self.root/('request-'+request['requestId']+'.json'),request);m.save(self.root/('result-'+request['requestId']+'.json'),conversation)
        self.assertEqual(m.project_state({'connection':{},'operations':[operation],'conversations':[conversation]},self.root),{'connection':{},'operations':[operation],'conversations':[conversation]})
class Boundaries(unittest.TestCase):
    def test_http_error_retains_exact_status_code_and_bounded_private_response(self):
        api=m.Api({'input':{'installedHealth':{'candidateId':'a'*64}}},time.monotonic()+60)
        api.client.open=lambda *a,**kw:(_ for _ in ()).throw(urllib.error.HTTPError('http://localhost',409,'Conflict',{},io.BytesIO(b'{"code":"epoch_changed","message":"fixture"}')))
        with self.assertRaises(RuntimeError) as error:api.read('/api/commands',b'{}')
        self.assertEqual(error.exception.api_code,'epoch_changed');self.assertEqual(error.exception.http_status,409)
        self.assertEqual(json.loads(m.base64.b64decode(error.exception.private_response['bodyBase64']))['code'],'epoch_changed')
    def test_deadline_blocks_even_read_before_http(self):
        api=m.Api({'input':{'installedHealth':{'candidateId':'a'*64}}},time.monotonic()-1)
        with patch.object(api.client,'open') as opened:
            with self.assertRaisesRegex(RuntimeError,'deadline-exhausted'):api.read('/api/health')
            opened.assert_not_called()
    def test_dynamic_runtime_uses_inventory_not_historical_hashes(self):
        root=P('/opt/nova/runtime/managed-updates/openclaw-2026.9.8-aaaaaaaaaaaa');companion=root/'companions/codex';node=root/'node/bin/node';binary=companion/'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
        pkg=companion/'node_modules/@openai/codex/package.json';lock=companion/'package-lock.json';data=m.enc({'version':'0.158.0'})
        # The maintained recovery.inventory returns a path-keyed dictionary.
        rows={str(p.relative_to('/opt/nova/runtime')).replace('\\','/'):{'kind':'file','sha256':h,'size':123} for p,h in [(node,'a'*64),(binary,'b'*64),(pkg,m.sha(data)),(lock,'c'*64)]}
        # Use host POSIX path semantics even when these local tests run on Windows.
        review={'format':1,'kind':'fresh-corrected-isolated-bootstrap-qualification','runtime':{'root':'/opt/nova/runtime','agent':str(root/'node_modules/openclaw'),'agentNode':str(node),'agentNodeSha256':'a'*64,'agentVersion':'2026.9.8','inventory':{'path':'inventory','sha256':'d'*64}}}
        # pathlib on Windows preserves backslashes; model with PurePosixPath.
        review['runtime']['agent']=review['runtime']['agent'].replace('\\','/');review['runtime']['agentNode']=review['runtime']['agentNode'].replace('\\','/')
        with patch.object(m,'P',pathlib.PurePosixPath),patch.object(m,'ref',side_effect=lambda r,*a:m.enc(rows if r['path']=='inventory' else review)),patch.object(m,'raw',return_value=data):
            result=m.runtime_inputs({'startupReview':{'path':'review'},'hostConfig':{'path':'config'}})
            self.assertEqual(result['nodeSha256'],'a'*64);self.assertEqual(result['codexSha256'],'b'*64)
            review['runtime']['agentNodeSha256']='e'*64
            with self.assertRaisesRegex(RuntimeError,'node-evidence-changed'):m.runtime_inputs({'startupReview':{'path':'review'},'hostConfig':{'path':'config'}})
    def test_fresh_native_guards_reject_changed_authorities(self):
        epoch=uid();generation=uid();binding={'input':{'installedHealth':{'epoch':epoch,'candidateId':'a'*64}}}
        value={'access':{'workspaceEpoch':epoch,'recovery':False,'recoveryLocal':False},'acceptance':{'candidateId':'a'*64,'epoch':epoch,'heldFor':None,'maintenanceHeld':False,'nativeSuspended':False},'service':{'id':'openclaw','state':'ready','version':'v'},'runtimeProof':{'openclawVersion':'v'},'appProcess':{'MainPID':'123'},'installationProof':{'id':'actual'},'state':{'operations':[],'conversations':[],'connection':{'state':'ready','modelAuthReady':True,'grantedScopes':['operator.read','operator.write'],'generation':generation}}}
        retained={**{k:value[k] for k in ('appProcess','runtimeProof','installationProof')},'connectionGeneration':generation,'oldUnknownHashes':{}}
        m.check_ready(value,binding,retained,initial=True)
        for mutate in [lambda v:v['access'].update(recovery=True),lambda v:v['acceptance'].update(maintenanceHeld=True),lambda v:v['state']['connection'].update(modelAuthReady=False),lambda v:v['state']['connection'].update(generation=uid()),lambda v:v['appProcess'].update(MainPID='124')]:
            changed=copy.deepcopy(value);mutate(changed)
            with self.assertRaises(RuntimeError):m.check_ready(changed,binding,retained)
if __name__=='__main__':unittest.main()
