"""No network. Real bounded archive streams and original uncertain upload."""
import base64,datetime,hashlib,importlib.util,json,os,tempfile,types,unittest
from pathlib import Path as P
from unittest.mock import patch
S=P(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('runtime_publication',S/'release-full-publication-primitives.py');F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
spec=importlib.util.spec_from_file_location('runtime_asset',S/'release-delivery-full-publication.py');A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)

class SignedRuntimeBinding(unittest.TestCase):
 def test_exact_runtime_pair_description_role_and_all_bytes_are_required(self):
  # Signature execution is separately qualified. Only that subprocess is
  # stubbed; the actual archive, signed-envelope and pair binding checks run.
  with tempfile.TemporaryDirectory() as d:
   root=P(d).resolve()
   def put(name,data):
    path=root/name;path.write_bytes(data);return {'path':str(path),'sha256':F.sha(data)}
   runtime=put('runtime.tgz',b'actual runtime bytes');app=put('app.tgz',b'app');deps=put('deps.tgz',b'deps');key=put('public.pem',b'disposable verifier input')
   desc={'format':1,'fromVersion':'2026.9.6','toVersion':'2026.9.8','nodeVersion':'24.21.0','companion':{'pluginVersion':'2026.9.8','codexVersion':'0.158.0'},'archiveBytes':len(b'actual runtime bytes'),'archiveSha256':runtime['sha256'],'expandedBytes':1000,'fileCount':3}
   prefix='https://github.com/HatimTheDream/Nova-Dream/releases/download/nova-v9.0.0/nova-9.0.0-'
   entries=lambda description:[{'name':'app.tgz','data':base64.b64encode(b'app').decode(),'sha256':app['sha256']},{'name':'reviewed-pair.json','data':base64.b64encode(F.enc({'runtime':description})).decode(),'sha256':F.sha(F.enc({'runtime':description}))}]
   bundle=put('bundle.json',F.enc({'files':entries(desc)}));release={'candidateId':'a'*64,'fromCandidateId':'b'*64,'novaVersion':'9.0.0','agentVersion':'2026.9.8',
    'bundle':{'url':prefix+'operator-bundle.json','bytes':len(P(bundle['path']).read_bytes()),'sha256':bundle['sha256']},'applicationDependenciesBundle':{'url':prefix+'app-dependencies.tgz','bytes':4,'sha256':deps['sha256']},'runtimeBundle':{'url':prefix+'runtime.tgz','bytes':desc['archiveBytes'],'sha256':runtime['sha256']}}
   now=datetime.datetime.now(datetime.timezone.utc)
   manifest={'channel':'stable','sequence':2,'createdAt':(now-datetime.timedelta(seconds=5)).isoformat(),'expiresAt':(now+datetime.timedelta(hours=1)).isoformat(),'releases':[release]}
   feed=put('feed.json',F.enc({'payload':base64.b64encode(F.enc(manifest)).decode(),'signature':base64.b64encode(b'disposable').decode()}))
   tools={name:put(name,b'fixed synthetic executable') for name in ('node','python','git')}
   signed={'signedFeed':feed,'publicKey':key,'channel':'stable','sequence':2,'candidateId':'a'*64,'release':release,'bundle':bundle,'dependencies':{'archive':deps},'runtime':{'archive':runtime,'description':desc},'sourceCommits':{'private':'c'*40,'public':'d'*40}}
   request={'signed':signed,'tools':tools,'trustedPublicKeySha256':key['sha256'],'version':'9.0.0','priorCandidateId':'b'*64,'sourceCommits':signed['sourceCommits'],'applicationArchive':app}
   with patch.object(A.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)):
    actual=A.verify_signed(request);self.assertEqual(set(actual),{'app','bundle','dependencies','manifest','runtime'});self.assertEqual(actual['runtime']['sha256'],runtime['sha256'])
    for field,value in [('fromVersion','2026.9.2'),('toVersion','2026.9.6'),('nodeVersion','22.23.2')]:
     original=desc[field];desc[field]=value
     with self.assertRaisesRegex(RuntimeError,'signed-transition'):A.verify_signed(request)
     desc[field]=original
    other=put('other-runtime.tgz',b'corrupt same length!');signed['runtime']['archive']=other
    with self.assertRaises(RuntimeError):A.verify_signed(request)
    signed['runtime']['archive']=runtime
    # A plausible separately supplied description cannot override the exact
    # description embedded in the signed bundle.
    desc['expandedBytes']=2000
    with self.assertRaisesRegex(RuntimeError,'pair-changed'):A.verify_signed(request)
    desc['expandedBytes']=1000
    P(runtime['path']).write_bytes(b'changed runtime bytes')
    with self.assertRaises(RuntimeError):A.verify_signed(request)

class RuntimeStreams(unittest.TestCase):
 def test_real_129_mib_archive_is_read_only_in_bounded_chunks(self):
  with tempfile.TemporaryDirectory() as d:
   path=P(d).resolve()/'runtime.tgz';block=b'x'*(1024**2);h=hashlib.sha256()
   with path.open('xb') as f:
    for _ in range(129):f.write(block);h.update(block)
   size=129*1024**2;digest=h.hexdigest();real=os.read;requests=[]
   def bounded(fd,n):requests.append(n);return real(fd,n)
   with patch.object(F.os,'read',side_effect=bounded):self.assertEqual(F.verify_runtime_file(path,size,digest),{'bytes':size,'sha256':digest})
   self.assertGreater(len(requests),129);self.assertEqual(max(requests),1024**2)
   with self.assertRaisesRegex(RuntimeError,'size-or-link'):F.verify_runtime_file(path,size-1,digest)
   with self.assertRaisesRegex(RuntimeError,'bounded-runtime'):F.verify_runtime_file(path,512*1024**2+1,digest)
   with self.assertRaisesRegex(RuntimeError,'content-changed'):F.verify_runtime_file(path,size,'0'*64)
   os.link(path,path.with_name('hardlink.tgz'))
   with self.assertRaisesRegex(RuntimeError,'size-or-link'):F.verify_runtime_file(path,size,digest)
 def test_changed_during_stream_and_unrelated_role_bound_refuse(self):
  with tempfile.TemporaryDirectory() as d:
   path=P(d).resolve()/'runtime.tgz';data=b'y'*(2*1024**2);path.write_bytes(data);digest=F.sha(data)
   iterator=F.stream_chunks(path,len(data),digest);self.assertEqual(len(next(iterator)),1024**2)
   path.write_bytes(b'z')
   with self.assertRaises(RuntimeError):list(iterator)
   with self.assertRaisesRegex(RuntimeError,'role-size-bound'):F.download_verified('unused',{},dict(role='bundle',bytes=129*1024**2),P(d))
 def test_lost_runtime_post_is_never_replayed_by_new_operation_or_observation(self):
  with tempfile.TemporaryDirectory() as d:
   root=P(d).resolve();ledger=root/'ledger';ledger.mkdir(mode=0o700);path=root/'runtime.tgz';data=b'r'*(2*1024**2);path.write_bytes(data)
   row={'role':'runtime','name':'nova-9.0.0-runtime.tgz','path':str(path),'bytes':len(data),'sha256':F.sha(data)}
   plan={'operationId':'original','sourceReleaseIds':{'Nova-Dream':12,'Nova-Dream-Public':13},'specs':[row]}
   value={'sourceCommits':{'Nova-Dream':'a'*40,'Nova-Dream-Public':'b'*40}};connections=[]
   class Connection:
    def __init__(self,host,timeout):self.host=host;self.sent=[];self.headers={};connections.append(self)
    def putrequest(self,method,path):self.method=method;self.path=path
    def putheader(self,k,v):self.headers[k]=v
    def endheaders(self):pass
    def send(self,b):self.sent.append(len(b))
    def getresponse(self):raise TimeoutError('lost original response')
    def close(self):pass
   class Client:
    def releases(self):return {'Nova-Dream':{'repositoryId':1,'release':{'id':12,'assets':[]}},'Nova-Dream-Public':{'repositoryId':2,'release':{'id':13,'assets':[]}}}
    def upload(self,release,spec,out,gate):return F.upload_runtime_verified('private-token-never-printed',gate,release,out,spec)
   with patch.object(F.http.client,'HTTPSConnection',Connection):
    with self.assertRaises(TimeoutError):F.publish(value,plan,root/'first',Client(),ledger=ledger)
    with self.assertRaisesRegex(RuntimeError,'no-POST-replay'):F.publish(value,plan,root/'observe',Client(),observe=True,original=root/'first',ledger=ledger)
    with self.assertRaises(FileExistsError):F.publish(value,{**plan,'operationId':'successor'},root/'successor',Client(),ledger=ledger)
   self.assertEqual(len(connections),1);c=connections[0];self.assertEqual(c.host,'uploads.github.com');self.assertEqual(c.method,'POST')
   self.assertEqual(c.headers['Content-Length'],str(len(data)));self.assertEqual(sum(c.sent),len(data));self.assertLessEqual(max(c.sent),1024**2)

if __name__=='__main__':unittest.main()
