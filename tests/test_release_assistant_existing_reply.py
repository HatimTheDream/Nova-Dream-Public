import hashlib,json,pathlib,tempfile,types,unittest,sys,os,time
from unittest.mock import patch
SOURCE=pathlib.Path(__file__).resolve().parents[1]/'scripts/release-assistant-existing-reply.py'
class ExistingReplyTransport(unittest.TestCase):
 def run_observation(self,attack=None,protection_failure=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);old_id='11111111-1111-4111-8111-111111111111';key='22222222-2222-4222-8222-222222222222';child='33333333-3333-4333-8333-333333333333';conversation='44444444-4444-4444-8444-444444444444';message='55555555-5555-4555-8555-555555555555'
   now=int(time.time()*1000);calls=[];writes={};cookie=[{'name':'opaque-fixture','value':'not-a-real-token'}]
   old={'key':key,'operationId':'66666666-6666-4666-8666-666666666666','conversationId':conversation,'savedMessageId':message}
   session={'sessionSha256':'a'*64,'sessionReference':{'path':'/var/lib/nova-update/release-coordinator/'+old_id+'/assistant-'+key+'/session-'+child+'.json','sha256':'a'*64},'deviceId':child}
   request={'kind':'fixture'};original={'accepted':old,'session':session,'browser':{'operationId':old_id},'request':request}
   binding={'operationId':old_id,'parentKey':key,'inputSha256':'b'*64,'deadlineAtMs':now+100000,'input':{'route':'full','existingAssistantReply':request}}
   common={**binding,'observationKey':child,'original':original};payload={'mode':'existing-reply','binding':binding,'common':common}
   def need(value,reason):
    if not value:raise RuntimeError(reason)
   def encode(v):return (json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()
   class Api:
    def __init__(self,*a):pass
    def cookies(self):return cookie
    def read(self,path,body=None,session=False):calls.append((path,body,session));return {'fixture':True}
   opened=[];closed=[]
   def open_fd(*args):
    fd=os.open(*args);opened.append(fd);return fd
   def close_fd(fd):os.close(fd);closed.append(fd)
   def protected(*args,**kwargs):
    if protection_failure:raise RuntimeError('fixture-protection-refused')
   def ready(api,*args):
    if attack:api.read(*attack)
    api.read('/api/health');return {'fixture':True}
   ns={'sys':types.SimpleNamespace(platform='linux'),'os':types.SimpleNamespace(geteuid=lambda:0,umask=lambda n:None,open=open_fd,close=close_fd,O_WRONLY=os.O_WRONLY,O_CREAT=os.O_CREAT,O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0)),
    'P':pathlib.Path,'re':__import__('re'),'json':json,'time':time,'signal':types.SimpleNamespace(alarm=lambda n:None),'need':need,'uid':lambda v:isinstance(v,str) and len(v)==36,
    'sha':lambda b:hashlib.sha256(b).hexdigest(),'enc':encode,'raw':lambda p,*a:encode({'bindingSha256':'original'}),'ref':lambda r,*a:encode({'bindingSha256':'original','deviceId':child,'cookies':cookie}),
    'root_for':lambda b:root,'installation':lambda b:None,'checked_anchor':lambda b,c:(root,{},time.monotonic()+100),'protected':protected,
    'save':lambda p,v:writes.setdefault(p.name,v),'READS':set(),'Api':Api,'ready':ready,'check_ready':lambda *a,**kw:None}
   exec(compile(SOURCE.read_bytes(),str(SOURCE),'exec'),ns)
   try:
    with patch.dict(sys.modules,{'fcntl':types.SimpleNamespace(LOCK_EX=1,LOCK_NB=2,flock=lambda *a:None)}):result=ns['existing_reply_main'](payload)
   finally:self.assertEqual(opened,closed)
   return result,calls,writes
 def test_actual_observer_uses_only_fixed_gets_and_retains_original_session(self):
  result,calls,writes=self.run_observation();self.assertEqual(result['httpMethods'],['GET']);self.assertFalse(result['sessionCreated']);self.assertFalse(result['inferenceDispatched'])
  self.assertTrue(calls);self.assertTrue(all(body is None and session is False for _,body,session in calls));self.assertTrue(any('/history/' in p for p,_,_ in calls));self.assertTrue(any(p=='/api/assistant/account?refresh=1' for p,_,_ in calls));self.assertEqual(len(writes),2)
 def test_failed_protection_closes_the_exact_opened_lock(self):
  with self.assertRaisesRegex(RuntimeError,'fixture-protection-refused'):self.run_observation(protection_failure=True)
 def test_session_post_submit_and_unselected_history_are_denied_before_api(self):
  for attack in [('/api/session',b'{}',True),('/api/assistant/submit',b'{}'),('/api/assistant/conversations',b'{}'),('/api/commands',b'{}'),('/api/assistant/history/unselected',)]:
   with self.subTest(route=attack[0]),self.assertRaisesRegex(RuntimeError,'existing-reply-get-only'):self.run_observation(attack)
if __name__=='__main__':unittest.main()
