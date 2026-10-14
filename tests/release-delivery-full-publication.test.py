"""No-network regressions for actual immutable-publication children."""
import importlib.util,json,os,tempfile,unittest
from pathlib import Path as P
from unittest.mock import patch
S=P(__file__).resolve().parents[1]/'scripts'
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,S/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
F=module('full_publication_test','release-full-publication-primitives.py')
T=module('full_feed_test','release-full-feed-publication.py')
class Client:
 def __init__(self,data,fail=False):self.data=data;self.fail=fail;self.posts=0;self.present=False
 def releases(self):
  asset={'id':9,'name':'nova-2.4.0-operator-bundle.json','size':len(self.data),'state':'uploaded','digest':'sha256:'+F.sha(self.data),'url':'https://api.github.com/repos/HatimTheDream/Nova-Dream/releases/assets/9'}
  return {'Nova-Dream':{'repositoryId':1,'release':{'id':11,'assets':[asset] if self.present else []}},'Nova-Dream-Public':{'repositoryId':2,'release':{'id':22,'assets':[]}}}
 def upload(self,release,spec,out,plan):
  self.posts+=1
  if self.fail:raise TimeoutError('simulated lost POST')
  self.present=True;return self.download({},spec,out)
 def download(self,asset,spec,out):
  (out/spec['name']).write_bytes(self.data)
  return {'id':9,'name':spec['name'],'bytes':len(self.data),'sha256':F.sha(self.data),'authenticatedDownloadVerified':True}
class PublicationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=P(self.tmp.name).resolve();self.data=b'actual opaque bundle fixture'
  self.spec={'role':'bundle','name':'nova-2.4.0-operator-bundle.json','bytes':len(self.data),'sha256':F.sha(self.data)}
  self.plan={'operationId':'original-operation','sourceReleaseIds':{'Nova-Dream':11,'Nova-Dream-Public':22},'specs':[self.spec]}
  self.value={'sourceCommits':{'Nova-Dream':'a'*40,'Nova-Dream-Public':'b'*40}};self.client=Client(self.data)
  (self.root/'ledger').mkdir(mode=0o700)
 def tearDown(self):self.tmp.cleanup()
 def invoke(self,out,**kw):return F.publish(self.value,self.plan,self.root/out,self.client,ledger=self.root/'ledger',**kw)
 def test_lost_post_is_not_redispatched_even_when_asset_is_absent(self):
  self.client.fail=True
  with self.assertRaises(TimeoutError):self.invoke('first')
  self.client.fail=False
  with self.assertRaisesRegex(RuntimeError,'no-POST-replay'):self.invoke('observe',observe=True,original=self.root/'first')
  self.assertEqual(self.client.posts,1)
 def test_lost_response_with_existing_asset_is_read_back_without_post(self):
  self.client.fail=True
  with self.assertRaises(TimeoutError):self.invoke('first')
  self.client.fail=False;self.client.present=True
  value=self.invoke('observe',observe=True,original=self.root/'first')
  self.assertTrue(value['assets'][0]['adoptedExisting']);self.assertEqual(self.client.posts,1)
  self.assertEqual(P(value['assets'][0]['localPath']).read_bytes(),self.data)
 def test_conflicting_operation_cannot_evade_original_release_name_intent(self):
  self.client.fail=True
  with self.assertRaises(TimeoutError):self.invoke('first')
  self.client.fail=False;self.plan['operationId']='other-operation'
  with self.assertRaises(FileExistsError):self.invoke('other')
  self.assertEqual(self.client.posts,1)
 def test_changed_original_plan_refuses_observation(self):
  self.invoke('first');self.plan['specs']=[{**self.spec,'sha256':'0'*64}]
  with self.assertRaisesRegex(RuntimeError,'original-publication-plan-binding'):self.invoke('observe',observe=True,original=self.root/'first')
  self.assertEqual(self.client.posts,1)
 def test_private_asset_url_cannot_be_replaced_by_public_or_other_repo(self):
  self.client.present=True;a=self.client.releases()['Nova-Dream']['release']['assets'][0]
  for route in ['https://api.github.com/repos/HatimTheDream/Nova-Dream-Public/releases/assets/9','https://example.invalid/9']:
   with self.assertRaises(RuntimeError):F.check_asset({**a,'url':route},self.spec)
 def test_ledger_is_existing_external_and_never_falls_back_or_creates(self):
  self.assertEqual(F.ledger_directory(self.root/'ledger'),self.root/'ledger')
  with self.assertRaises(RuntimeError):F.ledger_directory(None)
  missing=self.root/'missing-ledger'
  with self.assertRaises(FileNotFoundError):F.ledger_directory(missing)
  self.assertFalse(missing.exists())
  for name in ('OneDrive','repository'):
   parent=self.root/name;parent.mkdir();child=parent/'ledger';child.mkdir(mode=0o700)
   if name=='repository':(parent/'.git').mkdir()
   with self.assertRaises(RuntimeError):F.ledger_directory(child)
  with patch.dict(os.environ,{'OneDrive':str(self.root)}):
   with self.assertRaises(RuntimeError):F.ledger_directory(self.root/'ledger')
class FeedTests(unittest.TestCase):
 def test_lost_push_observation_never_calls_push(self):
  with tempfile.TemporaryDirectory() as d:
   root=P(d).resolve();parent='a'*40;commit='b'*40;feed=b'opaque signed bytes';name='Nova-Dream'
   original={'repository':name,'sourceCommit':parent,'feedParentCommit':parent,'feedCommit':commit,'feedSha256':F.sha(feed),'sequence':33,'changedOnly':'edition3/updates/stable.json','pushed':False,'unrelatedIndexPreserved':True}
   request={'operationId':'op','key':'key','phase':'push','side':'private','sources':{'private':{'commit':parent}},'commit':original}
   intent={'format':1,'operationId':'op','key':'key','phase':'push','requestSha256':F.sha(F.enc(request)),'automaticReplayPermitted':False};F.save(root/'dispatch.json',intent)
   calls=[]
   def git(_r,*args,**kw):calls.append(args);return commit+'\trefs/heads/main'
   with patch.object(T,'inspect',return_value=(root,root,'edition3/updates/stable.json',feed,b'old',name)),patch.object(T,'local_commit',return_value=commit),patch.object(T,'git',side_effect=git):
    result=T.produce('observe',request)
   self.assertEqual(result['state'],'completed');self.assertTrue(result['output']['pushed']);self.assertEqual(len(calls),1);self.assertEqual(calls[0][0],'ls-remote')
 def test_missing_original_feed_dispatch_is_uncertain_without_mutation(self):
  with tempfile.TemporaryDirectory() as d:
   root=P(d).resolve();request={'operationId':'op','key':'key','phase':'commit'}
   with patch.object(T,'inspect',return_value=(root,root,'feed.json',b'feed',b'old','Nova-Dream')),patch.object(T,'git') as git:
    result=T.produce('observe',request)
   self.assertEqual(result['state'],'uncertain');git.assert_not_called();self.assertEqual(list(root.iterdir()),[])
if __name__=='__main__':unittest.main()
