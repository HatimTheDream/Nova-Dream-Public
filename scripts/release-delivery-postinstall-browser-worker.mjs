/** Current-installed recovery only; never claims survival of the original document. */
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonicalBrowser,sha256,writeBrowserOnce,verifyBrowserTool} from './release-delivery-browser-primitives.mjs';
import {verifyPlaywrightClosure,documentIdentity,verifyBrowserHealth,verifyDocumentIdentity,tasks,draft,ownedDraftCleanup} from './release-delivery-browser-checks.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},read=p=>JSON.parse(readFileSync(p,'utf8')),hash=v=>sha256(canonicalBrowser(v));
export const RECOVERY_READ_SEMANTICS='maintained-get-projections-with-existing-housekeeping';
export const RECOVERY_GAPS=Object.freeze(['old-document-retained','original-old-client-fence','actual-transition-observation']);
export const RECOVERY_CHECKS=Object.freeze(['existing-session-authenticated','current-document-identity','copied-draft-before-edit','copied-draft-after-reload','current-stale-client-get-rejected','current-ui-reload-reaction','copied-draft-after-client-reload','current-ui-behavior','existing-saved-reply-visible','owned-copy-draft-cleaned']);
export function selectExistingRecoverySession(cookies,sessions,deadlineAtMs,origin='http://127.0.0.1:4383'){
 const matches=cookies.filter(c=>/^e3_session_[a-f0-9]{32}$/.test(c.name)&&c.domain==='127.0.0.1'&&c.path==='/'&&typeof c.value==='string')
  .map(cookie=>({cookie,row:sessions.find(s=>s.digest===sha256(cookie.value))})).filter(v=>v.row);
 need(matches.length===1,'browser-recovery-single-existing-session-required');const selected=matches[0];
 need(Number.isSafeInteger(selected.row.expiresAtMs)&&selected.row.expiresAtMs>deadlineAtMs+30000&&/^[a-f0-9-]{36}$/.test(selected.row.deviceId),'browser-recovery-session-expiry-or-device-changed');
 need(!cookies.some(c=>(c.name==='e3_session'||/^e3_session_[a-f0-9]{32}$/.test(c.name))&&c.domain==='127.0.0.1'&&c.name!==selected.cookie.name),'browser-recovery-ambiguous-session-cookie');
 return {...selected,origin};
}
export function allowedRecoveryRequest(method,url,body,conversationId,origin='http://127.0.0.1:4383'){
 const parsed=new URL(url);if(parsed.origin!==origin||parsed.username||parsed.password)return false;
 if(method==='POST')return parsed.pathname==='/api/session'&&!parsed.search&&body==='{}';
 if(!['GET','HEAD'].includes(method))return false;
 if(!parsed.pathname.startsWith('/api/'))return parsed.pathname==='/'||/^\/(?:__bundled\/[a-f0-9]{64}\/|assets\/)[A-Za-z0-9_./-]+$/.test(parsed.pathname)||['/favicon.ico','/favicon.svg','/manifest.webmanifest'].includes(parsed.pathname);
 if(method!=='GET')return false;const params=parsed.searchParams,keys=[...params.keys()];
 if(parsed.pathname==='/api/agents/hub')return keys.length===1&&params.get('archived')==='false';
 if(parsed.pathname==='/api/calendar/state'){
  if(keys.length!==3||new Set(keys).size!==3||keys.some(k=>!['from','to','timezone'].includes(k)))return false;
  const from=params.get('from'),to=params.get('to'),zone=params.get('timezone'),date=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  return date(from)&&date(to)&&Date.parse(to)-Date.parse(from)===42*86400000&&typeof zone==='string'&&zone.length<=100&&/^[A-Za-z0-9_+/-]+$/.test(zone);
 }
 if(parsed.pathname==='/api/assistant/history/'+conversationId)return keys.length<=3&&new Set(keys).size===keys.length&&keys.every(k=>k==='offset'?/^(0|[1-9][0-9]{0,6})$/.test(params.get(k)):k==='resume'?params.get(k)==='1':k==='messageId'?/^[A-Za-z0-9_:.-]{1,200}$/.test(params.get(k)):false);
 return !parsed.search&&['/api/health','/api/access/context','/api/snapshot','/api/accounts','/api/profile/progress','/api/assistant/service','/api/assistant/state','/api/assistant/models','/api/assistant/outputs'].includes(parsed.pathname);
}
function verifyRecoveryAccounts(value){need(Array.isArray(value.accounts)&&!value.accounts.some(a=>['connected','refreshing'].includes(a.state)&&a.capabilities?.mailRead),'browser-recovery-connected-mail-not-admitted');}
export async function installRecoveryFence(context,api,input,authority,sessions,record,{clock=Date.now,priorCandidateId,origin='http://127.0.0.1:4383'}={}){
 need(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin),'browser-recovery-origin-invalid');
 const selected=selectExistingRecoverySession(await context.cookies(origin),sessions,authority.deadlineAtMs),expected=input.installed.installedHealth;
 const cookie=selected.cookie.name+'='+selected.cookie.value,headers={'cookie':cookie,'origin':origin,'x-edition3-client':'1','x-edition3-candidate':expected.candidateId};
 let staleArmed=false,staleObserved=false,sessionPosts=0,sessionAttempts=0,forwardedPosts=0,failure=null,designatedPage=null;const blocked=[];const blockedRecord=value=>{if(blocked.length<64)blocked.push({...value,path:value.path.slice(0,192)});};
 const current=()=>{need(!failure,failure??'browser-recovery-fence-failed');need(clock()>=authority.startedAtMs&&clock()<authority.deadlineAtMs,'browser-recovery-deadline-exhausted');};
 const guard=async()=>{
  current();const health=await api.get(origin+'/api/health',{headers,maxRedirects:0,timeout:15000});need(health.status()===200,'browser-recovery-health-unavailable');
  const h=await health.json();verifyBrowserHealth(h,expected,expected.epoch,{route:'full',target:input.fullTarget});
  const snapshot=await api.get(origin+'/api/snapshot',{headers,maxRedirects:0,timeout:15000});need(snapshot.status()===200&&!snapshot.headers()['set-cookie'],'browser-recovery-existing-session-unavailable');
  const s=await snapshot.json();await health.dispose();await snapshot.dispose();need(s.epoch===expected.epoch&&s.deviceId===selected.row.deviceId,'browser-recovery-session-workspace-changed');const accounts=await api.get(origin+'/api/accounts',{headers,maxRedirects:0,timeout:15000});need(accounts.status()===200&&!accounts.headers()['set-cookie'],'browser-recovery-accounts-unavailable');const accountState=await accounts.json();await accounts.dispose();verifyRecoveryAccounts(accountState);current();return{backendObservationSemantics:RECOVERY_READ_SEMANTICS,connectedMailReadAccounts:0,candidateId:h.candidateId,processIdentity:h.processIdentity,epoch:s.epoch,deviceId:s.deviceId,sessionDigest:selected.row.digest,expiresAtMs:selected.row.expiresAtMs,health:h};
 };
 const initial=await guard();record('existing-session-authenticated',initial);
 need(typeof context.routeWebSocket==='function','browser-recovery-websocket-fence-unavailable');
 await context.routeWebSocket('**',ws=>{blockedRecord({method:'WEBSOCKET',path:new URL(ws.url()).pathname});ws.close();});
 await context.route('**/*',async route=>{
  const request=route.request(),url=request.url(),method=request.method(),body=request.postData()??'';
  try{
   current();if(!designatedPage||request.frame().page()!==designatedPage){blockedRecord({method,path:new URL(url).pathname,reason:'browser-recovery-page-not-armed'});await route.abort('blockedbyclient');return;}if(!allowedRecoveryRequest(method,url,body,input.assistant.conversationId,origin)){
    blockedRecord({method,path:new URL(url).pathname,bodySha256:body?sha256(body):null});await route.abort('blockedbyclient');return;
   }
   const pathname=new URL(url).pathname;
   if(pathname.startsWith('/api/'))need(!request.isNavigationRequest(),'browser-recovery-api-navigation-refused');
   if(method==='POST'){
    need(pathname==='/api/session'&&body==='{}','browser-recovery-session-body-changed');need(sessionAttempts<5,'browser-recovery-session-post-budget-exhausted');sessionAttempts++;await guard();
    const cookies=await context.cookies(origin),live=selectExistingRecoverySession(cookies,sessions,authority.deadlineAtMs);
    need(live.row.digest===selected.row.digest&&live.cookie.name===selected.cookie.name,'browser-recovery-token-changed');
   }
   const forwarded={...request.headers(),...headers};delete forwarded['host'];delete forwarded['content-length'];delete forwarded['if-none-match'];
   const stale=staleArmed&&!staleObserved&&method==='GET'&&pathname==='/api/snapshot';
   if(stale){forwarded['x-edition3-candidate']=priorCandidateId;need(/^[a-f0-9]{64}$/.test(forwarded['x-edition3-candidate']??''),'browser-recovery-prior-candidate-required');}
   if(method==='POST')forwardedPosts++;
   const response=await api.fetch(url,{method,headers:forwarded,...(method==='POST'?{data:body}:{}),maxRedirects:0,timeout:15000});
   need(response.status()<300||response.status()>=400,'browser-recovery-redirect-refused');need(!response.headers()['set-cookie'],'browser-recovery-token-created-or-rotated');
   if(pathname==='/api/accounts')verifyRecoveryAccounts(await response.json());
   if(method==='POST'){const value=await response.json();need(response.status()===200&&value.deviceId===selected.row.deviceId&&value.apiVersion===1,'browser-recovery-session-response-changed');sessionPosts++;}
   if(stale){const value=await response.json();need(response.status()===409&&value.code==='client_update','browser-recovery-stale-client-not-rejected');staleObserved=true;record('current-stale-client-get-rejected',{status:409,code:value.code,priorCandidateId:forwarded['x-edition3-candidate'],currentCandidateId:expected.candidateId});}
   await route.fulfill({response});await response.dispose();
  }catch(error){blockedRecord({method,path:new URL(url).pathname,reason:error.message});failure=/^[a-z][a-z0-9-]{0,99}$/.test(error.message)?error.message:'browser-recovery-fence-failed';await route.abort('blockedbyclient').catch(()=>{});}
 });
 return{guard,arm:page=>{need(!designatedPage&&context.pages().length===1&&context.pages()[0]===page,'browser-recovery-single-page-required');designatedPage=page;},armStale:()=>{staleArmed=true;},staleObserved:()=>staleObserved,summary:()=>({backendObservationSemantics:RECOVERY_READ_SEMANTICS,connectedMailReadAccounts:0,sessionDigest:selected.row.digest,deviceId:selected.row.deviceId,sessionPosts,sessionAttempts,blocked,mutatingRequestsForwarded:forwardedPosts,onlyExistingSessionPost:true,failure,webSocketsForwarded:0,serviceWorkers:'block'})};
}
async function nav(page,label){const rail=page.locator('#main-navigation');if(!await rail.isVisible()){const b=page.getByRole('button',{name:'Show main navigation',exact:true});if(await b.isVisible())await b.click();}await page.locator('#main-navigation').getByRole('button',{name:label,exact:true}).click();}
async function checkUi(page){await tasks(page);const search=page.getByRole('textbox',{name:'Search tasks',exact:true});await search.fill('Nova acceptance search');await search.press('Escape');need(await search.inputValue()===''&&await search.evaluate(e=>document.activeElement===e),'browser-recovery-search-escape-failed');await search.fill('Nova acceptance search');await page.getByRole('button',{name:'Clear task search',exact:true}).click();need(await search.inputValue()===''&&await search.evaluate(e=>document.activeElement===e),'browser-recovery-search-clear-failed');await page.locator('.breadcrumb').click();await page.keyboard.press('/');need(await search.evaluate(e=>document.activeElement===e),'browser-recovery-search-shortcut-failed');}
export async function runCurrentBrowserChecks(context,page,request,record,fence){
 const {input,prepared,authority}=request,origin=request.fixtureOrigin??'http://127.0.0.1:4383',expected=input.installed.installedHealth,contract={route:'full',target:input.fullTarget};
 const current=async()=>{need(context.pages().length===1,'browser-recovery-single-page-required');await page.locator('.app-shell:not(.startup-handoff .app-shell)').waitFor({state:'visible',timeout:45000});const guarded=await fence.guard(),live={health:guarded.health,epoch:guarded.epoch,identity:await documentIdentity(page)};verifyBrowserHealth(live.health,expected,live.epoch,contract);verifyDocumentIdentity(live.identity,live.health,contract);return live;};
 await page.goto(origin,{waitUntil:'domcontentloaded'});const initial=await current();record('current-document-identity',initial.identity);
 await tasks(page);need(await(await draft(page)).inputValue()===prepared.draft,'browser-recovery-copied-draft-missing');const draftScreenshot=join(request.directory,'copied-draft-ui.png');await page.screenshot({path:draftScreenshot,fullPage:false});record('copied-draft-before-edit',{draftSha256:sha256(prepared.draft),screenshotSha256:sha256(readFileSync(draftScreenshot))});
 await page.reload({waitUntil:'domcontentloaded'});await current();await tasks(page);need(await(await draft(page)).inputValue()===prepared.draft,'browser-recovery-reloaded-draft-lost');record('copied-draft-after-reload',{draftSha256:sha256(prepared.draft)});
 fence.armStale();await page.getByRole('button',{name:'Reload app',exact:true}).waitFor({state:'visible',timeout:45000});need(fence.staleObserved(),'browser-recovery-real-stale-response-required');record('current-ui-reload-reaction',{realServerResponse:true});
 await page.getByRole('button',{name:'Reload app',exact:true}).click();await page.waitForLoadState('domcontentloaded');await current();await tasks(page);need(await(await draft(page)).inputValue()===prepared.draft,'browser-recovery-client-reload-draft-lost');record('copied-draft-after-client-reload',{draftSha256:sha256(prepared.draft)});
 await checkUi(page);record('current-ui-behavior',{suite:'tasks-search-focus'});
 const text='Nova verification '+input.assistant.key+' passed.';need(sha256(text)===input.assistant.replySha256,'browser-recovery-saved-reply-hash-changed');await nav(page,'Assistant');
 const show=page.getByRole('button',{name:'Show assistant sidebar',exact:true});if(await show.isVisible())await show.click();
 const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/assistant/history/'+input.assistant.conversationId&&r.ok(),{timeout:30000});
 await page.locator('[data-conversation-id="'+input.assistant.conversationId+'"] button.saved-draft').click();const history=await(await pending).json();
 need(history.nativeId===input.assistant.nativeId&&history.messages.filter(m=>m.id===input.assistant.savedMessageId&&m.role==='assistant'&&m.text?.trim()===text).length===1,'browser-recovery-original-message-missing');
 const message=page.getByRole('article',{name:'assistant message',exact:true}).filter({hasText:text});await message.waitFor({state:'visible'});need(await message.count()===1,'browser-recovery-original-message-not-unique');record('existing-saved-reply-visible',{conversationId:input.assistant.conversationId,nativeId:input.assistant.nativeId,savedMessageId:input.assistant.savedMessageId,replySha256:input.assistant.replySha256});
 const screenshot=join(request.directory,'accepted-ui.png');await page.screenshot({path:screenshot,fullPage:false});await ownedDraftCleanup(page,prepared.draft);record('owned-copy-draft-cleaned',{originalProfileUnchanged:true});await current();await fence.guard();
 need(Date.now()<authority.deadlineAtMs,'browser-recovery-deadline-exhausted');return {loadedDocument:initial.identity,draftScreenshot:{path:draftScreenshot,sha256:sha256(readFileSync(draftScreenshot))},screenshot:{path:screenshot,sha256:sha256(readFileSync(screenshot))},fence:fence.summary()};
}
export async function currentBrowserWorker(requestPath){
 const directory=dirname(resolve(requestPath)),request=read(requestPath),{authority,input}=request;request.directory=directory;
 need(authority.operationId===input.operationId&&Date.now()>=authority.startedAtMs&&Date.now()<authority.deadlineAtMs,'browser-recovery-authority-expired');
 const options=request.original.binding.options;verifyBrowserTool(options.node,{maximum:128*1024**2});verifyBrowserTool(options.executable,{maximum:512*1024**2});
 const entry=verifyPlaywrightClosure({path:join(directory,'playwright-closure.json'),sha256:options.playwright.sha256});const checks=[];
 const memory=name=>{const cgroup=readFileSync('/proc/self/cgroup','utf8').split('\n').find(l=>l.startsWith('0::'))?.slice(3);need(cgroup?.startsWith('/')&&!cgroup.split('/').includes('..'),'browser-recovery-cgroup-invalid');const root='/sys/fs/cgroup'+cgroup;const proof={atMs:Date.now(),currentBytes:Number(readFileSync(root+'/memory.current','utf8')),peakBytes:Number(readFileSync(root+'/memory.peak','utf8')),maxBytes:Number(readFileSync(root+'/memory.max','utf8')),events:readFileSync(root+'/memory.events','utf8')};writeBrowserOnce(join(directory,'memory-'+name+'.json'),proof);need(proof.maxBytes===2147483648&&!/^oom(?:_kill|_group_kill)? [1-9]/m.test(proof.events),'browser-recovery-memory-limit-failed');return proof;};
 const record=(name,detail)=>{need(!checks.some(c=>c.name===name),'browser-recovery-duplicate-check');const check={name,passed:true,atMs:Date.now(),detail};writeBrowserOnce(join(directory,'check-'+String(checks.length+1).padStart(2,'0')+'.json'),check);checks.push(check);};
 let context,api,result,timer,fence;
 try{
  memory('before-launch');const playwright=await import(pathToFileURL(entry).href);api=await playwright.request.newContext({baseURL:'http://127.0.0.1:4383',ignoreHTTPSErrors:false,timeout:15000});
  context=await playwright.chromium.launchPersistentContext(join(directory,'profile'),{executablePath:options.executable.path,headless:true,chromiumSandbox:true,serviceWorkers:'block',viewport:{width:1280,height:800},acceptDownloads:false,timeout:30000,args:['--proxy-server=http://nova-browser-recovery-deny.invalid:9','--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP nova-browser-recovery-deny.invalid ~NOTFOUND']});context.setDefaultTimeout(20000);
  fence=await installRecoveryFence(context,api,input,authority,request.sessions,record,{priorCandidateId:request.original.binding.priorCandidateId});
  for(const page of context.pages())await page.close();const page=await context.newPage();need(context.pages().length===1,'browser-recovery-single-page-required');fence.arm(page);
  timer=setTimeout(()=>context.close().catch(()=>{}),Math.max(1,authority.deadlineAtMs-Date.now()));
  result=await runCurrentBrowserChecks(context,page,request,record,fence);const peak=memory('accepted');need(peak.peakBytes<=Math.floor(2147483648*0.8),'browser-recovery-memory-headroom-insufficient');
 }catch(error){writeBrowserOnce(join(directory,'failed.json'),{operationId:input.operationId,reason:/^[a-z][a-z0-9-]{0,99}$/.test(error.message)?error.message:'browser-recovery-ui-check-failed',detail:String(error.message).slice(0,2000),atMs:Date.now(),completedChecks:checks.map(c=>c.name),fence:fence?.summary()??null});}
 finally{clearTimeout(timer);if(context)await context.close().catch(()=>{});if(api)await api.dispose().catch(()=>{});const closed={operationId:input.operationId,sessionId:authority.sessionId,browserClosed:!context||context.pages().length===0,atMs:Date.now()};writeBrowserOnce(join(directory,'closed.json'),closed);memory('closed');}
 if(result&&!existsSync(join(directory,'failed.json')))writeBrowserOnce(join(directory,'result.json'),{format:1,kind:'nova-postinstall-browser-recovery-acceptance',accepted:true,browserUiVerified:true,acceptanceScope:'current-installed-browser-crash-recovery',operationId:input.operationId,authority:request.authorityRef,inputSha256:hash(input),sessionId:authority.sessionId,startedAtMs:authority.startedAtMs,completedAtMs:Date.now(),originalTransitionCoverage:'unverified',transitionCoverageGaps:[...RECOVERY_GAPS],checks,...result,savedMessageId:input.assistant.savedMessageId,savedReplySha256:input.assistant.replySha256,newAssistantMessages:0,installationDispatched:false,sourceProfileInventorySha256:request.plan.profile.inventorySha256});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)currentBrowserWorker(process.argv[2]).catch(()=>{process.exitCode=1;});
