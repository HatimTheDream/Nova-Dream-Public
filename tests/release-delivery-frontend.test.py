"""Offline boundary tests. Fake GitHub effects; actual maintained ledger/readback flow."""
from pathlib import Path as P
import ast,hashlib,importlib.util,json,tempfile,unittest,uuid
from unittest.mock import patch
ROOT=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('delivery_frontend',ROOT/'scripts/release-delivery-frontend.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)

# Function identities captured from the independently reviewed predecessor,
# whose source SHA256 is be5735ab393d4154fb68b426fcb1d06c0ebf56ab657d9cb13c7c1188cc9dcd4d.
# Only semantic hashes are retained here; CI needs no private operator files.
MAINTAINED_AST_SHA256 = {
    'need': 'd385de03a13cb4ad1b5a827269ce036584de229941242a22856aa4f11da951c0',
    'sha': '330a6dfefaf46e635ebfa5eef791cc46d454332b2996f40c438895de524a6e7d',
    'enc': '0e52bad9f92867e406c0112e09ec2a6b9f545888d3b51d57c7aad73a9c552a0d',
    'raw': '14850c31fadef872b24d0b2bdb6409c81162da77a9ca07d437a975990c7d682b',
    'save': '8bdc7dfa51f828a479ac74351e3bc0bfbfcb6f4e5a6d0595b5aa8d94c400c869',
    'check_asset': 'a0b15fa9bcc733db0dde9a5f821387da42e7cc15bfaf2cdc2f0d594433e09bf9',
    'download_verified': '0b411466f88c96b8bf8d7b3b5b9f5612fd5b4fcab73fa824c4a81d966c982146',
    'publish': '5947fcd9fe1b72720611f8e2ef6598ae843e23320ce678aeb40ed95e61e659a4',
    'NoRedirect': 'bdfff71db143f62630a6809c98eba136d1bd910dc0cf51061043773bf707a72e',
}

def semantic_sha256(node):
    # Explicit fields avoid ast.dump's version-dependent empty-field display.
    def normalize(value):
        if isinstance(value, ast.AST):
            return {'node': type(value).__name__,
                    'fields': {name: normalize(item) for name, item in ast.iter_fields(value)}}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value
    encoded = json.dumps(normalize(node), sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    return hashlib.sha256(encoded.encode()).hexdigest()

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
        temporary=tempfile.TemporaryDirectory(prefix='nova-frontend-publication-')
        self.addCleanup(temporary.cleanup)
        folder=P(temporary.name).resolve()
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
        source=ROOT/'scripts/release-frontend-publication-primitives.py'
        current={n.name:n for n in ast.parse(source.read_bytes()).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        for name, expected in MAINTAINED_AST_SHA256.items():
            self.assertEqual(semantic_sha256(current[name]),expected,name)
    def test_semantic_identity_keeps_guards_and_ignores_formatting(self):
        original=ast.parse('def need(value):\n if not value: raise RuntimeError("refused")\n').body[0]
        formatted=ast.parse('# formatting only\ndef need(value):\n    if not value:\n        raise RuntimeError("refused")\n').body[0]
        weakened=ast.parse('def need(value):\n if value: raise RuntimeError("refused")\n').body[0]
        self.assertEqual(semantic_sha256(original),semantic_sha256(formatted))
        self.assertNotEqual(semantic_sha256(original),semantic_sha256(weakened))

if __name__=='__main__':unittest.main()
