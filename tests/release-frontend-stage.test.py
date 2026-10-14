from pathlib import Path as P
import base64,importlib.util,json,unittest,uuid
from types import SimpleNamespace
from unittest.mock import patch
ROOT=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('stage',ROOT/'scripts/release-frontend-stage.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class Tests(unittest.TestCase):
    def packet(self):
        op=str(uuid.uuid4());root=P('/var/lib/nova-update/frontend/operator-inputs')/op
        files={'operation.json':M.enc({'format':1,'operationId':op,'manifestPath':str(root/'frontend.json'),'signaturePath':str(root/'frontend.sig'),'archivePath':str(root/'frontend.tgz')}),'frontend.json':b'{}','frontend.sig':b's'*64,'frontend.tgz':b'archive','frontend-plan.py':(ROOT/'scripts/release-frontend-plan.py').read_bytes(),'frontend-executor.py':(ROOT/'scripts/release-frontend-executor.py').read_bytes()}
        packet={'format':1,'operationId':op,'runId':str(uuid.uuid4()),'baseVersion':'2.3.0','baseCandidateId':'a'*64,'serviceInputsSha256':'b'*64,'frontendId':'c'*64,'sourceRevision':'d'*40,'version':'2.3.1','buildVersion':'1.0.288','workspaceEpoch':str(uuid.uuid4()),'worker':{'path':'/opt/nova-updater-2.3.0-aaaaaaaaaaaa/deploy/update-runner/frontend.py','sha256':M.WORKER_SHA},'config':{'path':'/etc/nova-update/frontend.json','sha256':'e'*64},'files':{name:{'base64':base64.b64encode(raw).decode(),'bytes':len(raw),'sha256':M.sha(raw)} for name,raw in files.items()}}
        return packet,root,files
    def test_packet_accepts_only_exact_files_and_bound_helpers(self):
        packet,root,files=self.packet();self.assertEqual(M.files_for(packet),(root,files))
        for change in ('extra','helper','operation','config'):
            p,root,files=self.packet()
            if change=='extra':p['files']['/etc/key']=p['files']['frontend.sig']
            elif change=='helper':p['files']['frontend-plan.py']=p['files']['frontend.json']
            elif change=='operation':p['operationId']=str(uuid.uuid4())
            else:p['config']['path']='/other/config'
            with self.subTest(change=change),self.assertRaises(RuntimeError):M.files_for(p)
    def test_explicit_tool_installation_is_independent_and_strict(self):
        packet,root,files=self.packet();packet.update(format=2,baseVersion='2.3.1',workerInstallation={'version':'2.3.0','candidateId':'e'*64})
        packet['worker']['path']='/opt/nova-updater-2.3.0-eeeeeeeeeeee/deploy/update-runner/frontend.py'
        self.assertEqual(M.files_for(packet),(root,files))
        for name in ('legacy','missing','wrong-release','wrong-hash'):
            value=json.loads(json.dumps(packet))
            if name=='legacy':value['format']=1
            elif name=='missing':del value['workerInstallation']
            elif name=='wrong-release':value['workerInstallation']['candidateId']='f'*64
            else:value['worker']['sha256']='f'*64
            with self.subTest(name=name),self.assertRaises(RuntimeError):M.files_for(value)
    def test_overlay_is_exact_four_packet_paths_and_cannot_replace_authorities(self):
        packet,root,files=self.packet();calls=[]
        class IO:
            def read(self,path,maximum,private=False):calls.append((str(path),maximum,private));return b'actual-authority'
        io=M.overlay_io(SimpleNamespace(FileIO=IO),root,files)
        for name in ('operation.json','frontend.json','frontend.sig','frontend.tgz'):self.assertEqual(io.read(root/name,100000,True),files[name])
        for path in ['/etc/nova-update/frontend.json','/etc/nova-update/public-key.pem','/usr/bin/node','/opt/nova/frontend/selector.json','/var/lib/nova-update/frontend/current.json',str(root/'frontend-plan.py'),str(root/'nested/frontend.json')]:
            self.assertEqual(io.read(path,99,True),b'actual-authority')
        self.assertEqual(len(calls),7);self.assertTrue(all(x[2] for x in calls))
        for method in ('write','remove','mkdir'):
            with self.assertRaisesRegex(RuntimeError,'forbidden'):getattr(io,method)('/any')
        with self.assertRaisesRegex(RuntimeError,'overlay-bound'):io.read(root/'frontend.sig',63)
    def cap(self,same=True,free=10*1024**3,inodes=10000,staged=False):
        packet,root,files=self.packet();worker=SimpleNamespace(manifest={'files':[{'path':'index.html','bytes':100},{'path':'assets/a.js','bytes':5000}]});io=SimpleNamespace(protect=lambda *a,**k:None)
        def stats(path):return SimpleNamespace(st_dev=1 if same or str(path).replace('\\','/').startswith('/var') else 2)
        with patch.object(M.os,'statvfs',return_value=SimpleNamespace(f_frsize=4096,f_bavail=free//4096,f_favail=inodes),create=True),patch.object(M.P,'stat',stats):return M.capacity(packet,root,files,worker,io,staged)
    def test_capacity_groups_shared_filesystem_and_preserves_reserves_without_double_count(self):
        one=self.cap();two=self.cap(same=False);self.assertEqual(len(one['filesystemGroups']),1);self.assertEqual(len(two['filesystemGroups']),2)
        self.assertEqual(one['filesystemGroups'][0]['newBytes'],sum(x['newBytes'] for x in two['filesystemGroups']))
        for group in two['filesystemGroups']:self.assertEqual(group['requiredFreeBytes'],group['newBytes']+M.RESERVE+M.ALLOWANCE)
        staged=self.cap(staged=True);self.assertLess(staged['filesystemGroups'][0]['newBytes'],one['filesystemGroups'][0]['newBytes']);self.assertEqual(staged['newRecoveryCopies'],0);self.assertEqual(staged['expectedReclaimBytes'],0)
    def test_insufficient_bytes_or_inodes_refuse_before_stage(self):
        for kwargs in ({'free':M.RESERVE+M.ALLOWANCE},{'inodes':1024}):
            with self.assertRaisesRegex(RuntimeError,'capacity-insufficient'):self.cap(**kwargs)
    def test_wrong_stage_intent_stops_before_creating_any_file(self):
        packet,root,files=self.packet();plan={'identity':{'packet':'exact'},'readOnly':True};io=SimpleNamespace()
        with patch.object(M,'pre_stage',return_value=(plan,io)),patch.object(M,'directories') as directories,patch.object(M,'exclusive') as write:
            with self.assertRaisesRegex(RuntimeError,'intent-changed'):M.stage(packet,plan,{})
            directories.assert_not_called();write.assert_not_called()
    def test_original_stage_observation_cannot_create_missing_directory(self):
        packet,root,files=self.packet();helper=SimpleNamespace(read=lambda *a:b'source');io=SimpleNamespace();module=SimpleNamespace(FileIO=lambda:io)
        actual_load=M.load
        with patch.object(M,'load',side_effect=[actual_load('frontend_plan',str(root/'frontend-plan.py'),files['frontend-plan.py']),helper,module]),patch.object(M.os.path,'lexists',return_value=False),patch.object(M,'exclusive') as write:
            self.assertEqual(M.stage_observe(packet)['state'],'uncertain');write.assert_not_called()
    def test_real_installed_worker_source_is_pinned_to_previous_review(self):
        source=(ROOT/'deploy/update-runner/frontend.py').read_bytes();self.assertEqual(M.sha(source),M.WORKER_SHA)
        self.assertEqual(M.sha((ROOT/'scripts/release-frontend-plan.py').read_bytes()),M.PLAN_SHA);self.assertEqual(M.sha((ROOT/'scripts/release-frontend-executor.py').read_bytes()),M.EXECUTOR_SHA)
if __name__=='__main__':unittest.main()
