"""Offline boundary tests. Fake GitHub effects; actual maintained ledger/readback flow."""
from pathlib import Path as P
import ast,hashlib,importlib.util,json,unittest,uuid
from unittest.mock import patch
ROOT=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('delivery_frontend',ROOT/'scripts/release-delivery-frontend.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)

class FakeClient:
    def __init__(self,request,content):self.request=request;self.content=content;self.assets=[];self.uploads=0;self.lose=False;self.wrong=False
    def releases(self):return {'Nova-Dream':{'repositoryId':11,'release':{'id':1}},'Nova-Dream-Public':{'repositoryId':22,'release':{'id':2,'assets':self.assets}}}
    def upload(self,release,spec,out,plan):
        self.uploads+=1
        self.assets=[{'id':30,'name':spec['name'],'size':spec['bytes'],'state':'uploaded','digest':'sha256:'+spec['sha256'],'url':'https://api.github.com/repos/'+M.F.PUBLIC+'/releases/assets/30'}]
        if self.lose:raise TimeoutError('lost upload response')
        return self.download(self.assets[0],spec,out)
    def download(self,asset,spec,out):
        M.F.check_asset(asset,spec);data=b'corrupt' if self.wrong else self.content
        (out/spec['name']).write_bytes(data)
        return {'id':asset['id'],'name':spec['name'],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'authenticatedDownloadVerified':True}

class Tests(unittest.TestCase):
    def fixture(self):
        folder=ROOT/'support/fixtures'/('frontend-publication-'+str(uuid.uuid4()));folder.mkdir(parents=True)
        content=b'bounded synthetic frontend archive';key=str(uuid.uuid4());role='archive'
        asset={'role':role,'name':'nova-2.3.1-frontend.tgz','path':str(folder/'archive'),'sha256':M.sha(content),'bytes':len(content)}
        P(asset['path']).write_bytes(content)
        request={'key':key,'operationId':str(uuid.uuid4()),'inputSha256':'a'*64,'releaseIds':{'private':1,'public':2},'sourceCommits':{'private':'b'*40,'public':'c'*40},'spec':asset,'version':'2.3.1','ledgerDirectory':str(folder/'ledger')}
        root=folder/('frontend-publication-'+key+'-'+role);request['outputDirectory']=str(root)
        return request,root,asset,FakeClient(request,content)
    def produce(self,mode,r,root,spec,client):
        # Isolate publication lifecycle from crypto/input checks already covered
        # by JS negatives and existing package/sign tests; never fake production proof.
        with patch.object(M,'inspect',return_value=(root,spec)):return M.produce(mode,r,client)
    def test_first_publication_and_observation_never_duplicate(self):
        r,root,s,c=self.fixture();first=self.produce('execute',r,root,s,c)
        self.assertEqual(first['state'],'completed');self.assertEqual(c.uploads,1)
        second=self.produce('observe',r,root,s,c);self.assertEqual(second['state'],'completed');self.assertEqual(c.uploads,1)
        self.assertEqual(first['output']['asset']['id'],second['output']['asset']['id'])
    def test_lost_post_response_observes_original_asset(self):
        r,root,s,c=self.fixture();c.lose=True
        self.assertEqual(self.produce('execute',r,root,s,c)['state'],'uncertain')
        self.assertEqual(self.produce('observe',r,root,s,c)['state'],'completed');self.assertEqual(c.uploads,1)
    def test_uncertain_missing_asset_never_reposts(self):
        r,root,s,c=self.fixture();c.lose=True;self.produce('execute',r,root,s,c);c.assets=[]
        value=self.produce('observe',r,root,s,c)
        self.assertEqual(value['reason'],'missing-asset-uncertain-no-post-replay');self.assertEqual(c.uploads,1)
    def test_different_operation_cannot_escape_release_name_ledger(self):
        r,root,s,c=self.fixture();c.lose=True;self.produce('execute',r,root,s,c);c.assets=[]
        newer=dict(r,key=str(uuid.uuid4()),operationId=str(uuid.uuid4()));other=root.parent/('frontend-publication-'+newer['key']+'-archive');newer['outputDirectory']=str(other)
        self.assertEqual(self.produce('execute',newer,other,s,c)['state'],'uncertain');self.assertEqual(c.uploads,1)
    def test_duplicate_dispatch_and_changed_original_refused(self):
        r,root,s,c=self.fixture();self.produce('execute',r,root,s,c)
        with self.assertRaises(FileExistsError):self.produce('execute',r,root,s,c)
        changed=dict(r,inputSha256='d'*64)
        with self.assertRaisesRegex(RuntimeError,'original-dispatch-changed'):self.produce('observe',changed,root,s,c)
        self.assertEqual(c.uploads,1)
    def test_conflicting_metadata_and_corrupt_readback_refused(self):
        for case in ('metadata','readback'):
            with self.subTest(case=case):
                r,root,s,c=self.fixture();self.produce('execute',r,root,s,c)
                if case=='metadata':c.assets[0]['digest']='sha256:'+'f'*64
                else:c.wrong=True
                self.assertEqual(self.produce('observe',r,root,s,c)['state'],'uncertain');self.assertEqual(c.uploads,1)
    def test_absence_is_uncertain_not_recreated(self):
        r,root,s,c=self.fixture();self.assertEqual(self.produce('observe',r,root,s,c)['reason'],'frontend-original-dispatch-not-recorded')
        self.assertFalse(root.exists());self.assertEqual(c.uploads,0)
    def test_actual_source_release_contract_rejects_wrong_source(self):
        r,root,s,c=self.fixture();client=object.__new__(M.Client);client.request=r;client.token='unused'
        def api(path,token):
            private='/Nova-Dream/' in path or path.endswith('/Nova-Dream');side='private' if private else 'public';repo='HatimTheDream/Nova-Dream'+('' if private else '-Public')
            if '/git/ref/' in path:return 200,{'object':{'type':'commit','sha':r['sourceCommits'][side],'url':'https://api.github.com/repos/'+repo+'/git/commits/'+r['sourceCommits'][side]}}
            if '/releases/' in path:return 200,{'id':r['releaseIds'][side],'tag_name':('nova-v' if private else 'v')+'2.3.1','target_commitish':'wrong','draft':False,'prerelease':False,'assets':[]}
            return 200,{'id':1,'full_name':repo,'private':private}
        with patch.object(M.G,'api',api):
            with self.assertRaisesRegex(RuntimeError,'source-release-changed'):client.releases()
    def test_maintained_primitives_unchanged(self):
        original=ROOT.parent/'frontend-path/frontend-operator-acceptance.py'
        def definitions(path):return {n.name:ast.dump(n,include_attributes=False) for n in ast.parse(path.read_text()).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        prior=definitions(original);current=definitions(ROOT/'scripts/release-frontend-publication-primitives.py')
        for name in ('need','sha','enc','raw','save','check_asset','download_verified','publish','NoRedirect'):self.assertEqual(current[name],prior[name],name)

if __name__=='__main__':unittest.main()
