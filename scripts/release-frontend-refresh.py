"""Genuine app heartbeat through its existing authenticated check action.
No direct controller heartbeat, shell, credential persistence or host file write.
"""
import http.cookiejar,json,time,urllib.request,uuid
ORIGIN='http://127.0.0.1:4383'
def need(v,s):
    if not v:raise RuntimeError(s)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('frontend-refresh-redirect-refused')
def refresh(binding,client=None,clock=time.monotonic):
    need(set(binding)=={'candidateId','serviceInputsSha256','epoch','processIdentity'},'frontend-refresh-exact-binding-required')
    for key in ('epoch','processIdentity'):need(str(uuid.UUID(binding[key]))==binding[key],'frontend-refresh-uuid-invalid')
    for key in ('candidateId','serviceInputsSha256'):need(len(binding[key])==64 and set(binding[key])<=set('0123456789abcdef'),'frontend-refresh-hash-invalid')
    started=clock();deadline=started+25
    if client is None:client=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(path,body=None):
        need((path,body is not None) in {('/api/session',True),('/api/health',False),('/api/access/context',False),('/api/software-update/acceptance',False),('/api/software-update/check',True)},'frontend-refresh-endpoint-refused')
        remaining=deadline-clock();need(remaining>0,'frontend-refresh-deadline-exhausted')
        request=urllib.request.Request(ORIGIN+path,data=None if body is None else json.dumps(body,separators=(',',':')).encode(),headers={'Origin':ORIGIN,'X-Edition3-Client':'1','X-Edition3-Candidate':binding['candidateId'],'Content-Type':'application/json'})
        with client.open(request,timeout=min(20,remaining)) as response:
            need(response.status==200,'frontend-refresh-http-refused');raw=response.read(1024*1024+1)
        need(len(raw)<=1024*1024,'frontend-refresh-response-bound');return json.loads(raw)
    session=call('/api/session',{});need(str(uuid.UUID(session['deviceId']))==session['deviceId'] and session['apiVersion']==1,'frontend-refresh-session-invalid')
    def health():
        h=call('/api/health');a=call('/api/access/context');n=call('/api/software-update/acceptance')
        need(all(h.get(k)==binding[k] for k in ('candidateId','serviceInputsSha256','processIdentity')) and a.get('workspaceEpoch')==binding['epoch'] and a.get('recovery') is False and a.get('recoveryLocal') is False,'frontend-refresh-service-or-workspace-changed')
        need(n.get('candidateId')==binding['candidateId'] and n.get('epoch')==binding['epoch'] and n.get('heldFor') is None and n.get('maintenanceHeld') is False and n.get('nativeSuspended') is False,'frontend-refresh-held-or-suspended')
        need(not any(x.get('code') in {'recovery','workspace_switch'} for x in n.get('blockers',[])),'frontend-refresh-structural-blocker');return h
    before=health();status=call('/api/software-update/check',{'epoch':binding['epoch']});refreshed=clock()
    need(status.get('installed',{}).get('candidateId')==binding['candidateId'] and status.get('installation',{}).get('supported') is True and status.get('availability')!='error','frontend-refresh-not-acknowledged')
    after=health();need(all(after.get(k)==before.get(k) for k in ('candidateId','serviceInputsSha256','processIdentity','apiVersion','schemaVersion')),'frontend-refresh-process-changed')
    need(clock()<=deadline and clock()-refreshed<5,'frontend-refresh-execute-window-expired')
    return {'format':1,'kind':'actual-app-update-check-before-frontend-execute','candidateId':binding['candidateId'],'processIdentity':binding['processIdentity'],'epoch':binding['epoch'],'genuineAppHeartbeat':True,'directControllerHeartbeat':False,'elapsedMs':round((clock()-started)*1000),'afterCheckElapsedMs':round((clock()-refreshed)*1000),'credentialsRecorded':False}
