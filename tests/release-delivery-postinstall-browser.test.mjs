import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from '../scripts/release-plan.mjs';
import {canonicalBrowser} from '../scripts/release-delivery-browser-primitives.mjs';
import {allowedRecoveryRequest,selectExistingRecoverySession,installRecoveryFence,prepareSingleRecoveryPage,recoveryRequestDiagnostic,recoveryFailureDiagnostics,RECOVERY_GAPS,RECOVERY_MAIL_POLICY,recoveryMailPolicy} from '../scripts/release-delivery-postinstall-browser-worker.mjs';
import {verifyPostinstallBrowserRecovery,observePostinstallRecoveryPredecessor} from '../scripts/release-delivery-postinstall-browser.mjs';
import {postinstallReadinessFixture,postinstallAcceptanceFixture} from '../support/postinstall-browser-fixture.mjs';
const now=1000000,origin='http://127.0.0.1:4383',candidate='a'.repeat(64),device='00000000-0000-4000-8000-000000000001',token='existing-fixture-token',cookie={name:'e3_session_'+'b'.repeat(32),value:token,domain:'127.0.0.1',path:'/'};
const session={digest:sha256(token),deviceId:device,expiresAtMs:now+86400000},authority={startedAtMs:now,deadlineAtMs:now+600000};
const health={application:'nova-dream-edition-3',status:'ready',candidateId:candidate,processIdentity:'unchanged-process',serviceInputsSha256:'f'.repeat(64),epoch:'epoch',frontend:{source:'bundled',id:candidate,version:'2.28.39',buildVersion:'1.0.412'}};
const input={operationId:'00000000-0000-4000-8000-000000000005',installed:{installedHealth:health},fullTarget:{candidateId:candidate,version:'2.28.39',buildVersion:'1.0.412'},assistant:{conversationId:'00000000-0000-4000-8000-000000000006',nativeId:'native-existing',savedMessageId:'message-existing',replySha256:sha256('existing-reply')}};
const response=(value,status=200,headers={})=>({status:()=>status,headers:()=>headers,json:async()=>value,dispose:async()=>{}});
function rig({cookieList=[cookie],healthValue=health,snapshot={epoch:'epoch',deviceId:device},postHeaders={},accountsState={accounts:[]}}={}){
 const page={},other={},pages=[page],calls=[],records=[];let handler;
 const context={cookies:async()=>cookieList,pages:()=>pages,routeWebSocket:async()=>{},route:async(_url,fn)=>{handler=fn;}};
 const api={get:async url=>response(url.endsWith('/api/health')?healthValue:url.endsWith('/api/accounts')?accountsState:snapshot),fetch:async(url,args)=>{calls.push({url,...args});return response({deviceId:device,apiVersion:1},200,postHeaders);}};
 const route=(method='POST',pathname='/api/session',body='{}',owner=page)=>({request:()=>({url:()=>origin+pathname,method:()=>method,postData:()=>body,headers:()=>({'content-type':'application/json'}),isNavigationRequest:()=>false,frame:()=>({page:()=>owner})}),abort:async()=>{},fulfill:async()=>{}});
 return{page,other,context,api,calls,records,route,invoke:(...args)=>handler(route(...args))};
}
async function fence(r,grant=authority){return installRecoveryFence(r.context,r.api,input,grant,[session],(name,detail)=>r.records.push({name,detail}),{clock:()=>now,priorCandidateId:'0'.repeat(64)});}
test('recovery allowlist excludes installation, Assistant dispatch, foreign origins and changed bootstrap body',()=>{
 assert.equal(allowedRecoveryRequest('POST',origin+'/api/session','{}',input.assistant.conversationId),true);
 for(const [method,url,body]of [['POST',origin+'/api/session','{"renew":true}'],['POST',origin+'/api/assistant/request','{}'],['POST',origin+'/api/software-update/install','{}'],['GET','http://example.invalid/',''],['POST',origin+'/api/session?x=1','{}'],['GET',origin+'/api/assistant/history/other','']])assert.equal(allowedRecoveryRequest(method,url,body,input.assistant.conversationId),false);
 assert.equal(allowedRecoveryRequest('GET',origin+'/__bundled/'+candidate+'/assets/app.js','',input.assistant.conversationId),true);
});
test('only one authoritative copied token valid beyond the whole fixed window qualifies',()=>{
 assert.equal(selectExistingRecoverySession([cookie],[session],authority.deadlineAtMs).row.digest,session.digest);
 for(const [cookies,rows]of [[[cookie],[{...session,expiresAtMs:authority.deadlineAtMs+30000}]],[[{...cookie,value:'rotated'}],[session]],[[cookie,{...cookie,name:'e3_session'}],[session]],[[cookie],[{...session,deviceId:'bad'}]]])assert.throws(()=>selectExistingRecoverySession(cookies,rows,authority.deadlineAtMs));
});
test('forwarding is disarmed until exactly one designated page exists',async()=>{
 const r=rig(),f=await fence(r);await r.invoke();assert.equal(r.calls.length,0);f.arm(r.page);await r.invoke('POST','/api/session','{}',r.other);assert.equal(r.calls.length,0);await r.invoke();assert.equal(r.calls.length,1);assert.equal(f.summary().sessionPosts,1);
});
test('concurrent bootstrap requests cannot exceed the fixed five-attempt budget',async()=>{
 const r=rig(),f=await fence(r);f.arm(r.page);await Promise.all(Array.from({length:12},()=>r.invoke()));assert.equal(f.summary().sessionAttempts,5);assert.ok(r.calls.length<=5);assert.equal(f.summary().failure,'browser-recovery-session-post-budget-exhausted');
});
test('sixth bootstrap is rejected before forwarding and token rotation cannot qualify',async()=>{
 const r=rig(),f=await fence(r);f.arm(r.page);for(let n=0;n<6;n++)await r.invoke();assert.equal(r.calls.length,5);assert.equal(f.summary().sessionPosts,5);assert.equal(f.summary().sessionAttempts,5);
 const rotated=rig({postHeaders:{'set-cookie':'e3_session_new=secret'}}),rf=await fence(rotated);rf.arm(rotated.page);await rotated.invoke();assert.equal(rf.summary().sessionPosts,0);assert.equal(rf.summary().failure,'browser-recovery-token-created-or-rotated');
});
test('installed process, epoch or authenticated device drift refuses before any bootstrap',async()=>{
 for(const r of [rig({healthValue:{...health,processIdentity:'other'}}),rig({snapshot:{epoch:'other',deviceId:device}}),rig({snapshot:{epoch:'epoch',deviceId:'other'}})]){await assert.rejects(fence(r));assert.equal(r.calls.length,0);}
});
test('connected or refreshing mail is refused before navigation or any session POST',async()=>{
 for(const state of ['connected','refreshing']){const r=rig({accountsState:{accounts:[{state,capabilities:{mailRead:true}}]}});await assert.rejects(fence(r),/connected-mail-not-admitted/);assert.equal(r.calls.length,0);assert.equal(r.records.length,0);}
 const r=rig({accountsState:{accounts:[{state:'disconnected',capabilities:{mailRead:true}}]}}),f=await fence(r);assert.equal(f.summary().connectedMailReadAccounts,0);assert.equal(r.records[0].detail.backendObservationSemantics,'maintained-get-projections-with-existing-housekeeping');
});
test('expired fixed authority cannot acquire a new clock or dispatch',async()=>{
 const r=rig();await assert.rejects(installRecoveryFence(r.context,r.api,input,authority,[session],()=>{},{clock:()=>authority.deadlineAtMs,priorCandidateId:'0'.repeat(64)}));assert.equal(r.calls.length,0);
});
test('file-backed recovery evidence preserves explicit original-transition gap and exact authority',()=>{
 const directory=mkdtempSync(join(tmpdir(),'nova-postinstall-proof-'));const save=(name,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n'),path=join(directory,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 try{
  input.prepared=save('prepared.json',{draft:'original draft'});input.original=save('original.json',{binding:{priorCandidateId:'0'.repeat(64)}});
  const readiness=save('readiness.json',postinstallReadinessFixture(input,{sessionId:'00000000-0000-4000-8000-000000000007',now,requestSha256:'e'.repeat(64)}));
  const grant={...authority,kind:'nova-postinstall-browser-observation-authority',operationId:input.operationId,sessionId:'00000000-0000-4000-8000-000000000007',browserInputSha256:sha256(canonicalBrowser(input)),browserReadiness:readiness,installationPermitted:false,assistantDispatchPermitted:false,automaticRenewal:false,acceptanceScope:'current-installed-browser-crash-recovery',originalTransitionCoverage:'unverified',transitionCoverageGaps:[...RECOVERY_GAPS]};const grantRef=save('authority.json',grant),output=postinstallAcceptanceFixture(save,input,grant,grantRef);
  assert.equal(verifyPostinstallBrowserRecovery(output,input),output);
  for(const changed of [{...output,originalTransitionCoverage:'verified'},{...output,transitionCoverageGaps:[]},{...output,sessionId:'replacement'},{...output,completedAtMs:grant.deadlineAtMs+1},{...output,newAssistantMessages:1},{...output,installationDispatched:true},{...output,checks:output.checks.slice(1)},{...output,draftScreenshot:output.screenshot},{...output,fence:{...output.fence,sessionAttempts:6}}])assert.throws(()=>verifyPostinstallBrowserRecovery(changed,input));
  for(const [name,detail]of [['copied-draft-after-reload',{draftSha256:'0'.repeat(64)}],['existing-saved-reply-visible',{...output.checks[8].detail,savedMessageId:'different'}],['current-stale-client-get-rejected',{...output.checks[4].detail,status:200}]]){const altered=structuredClone(output),index=altered.checks.findIndex(c=>c.name===name);altered.checks[index].detail=detail;altered.checkReceipts[index]=save('tampered-'+index+'.json',altered.checks[index]);assert.throws(()=>verifyPostinstallBrowserRecovery(altered,input));}
  assert.throws(()=>verifyPostinstallBrowserRecovery(output,{...input,operationId:'other'}));
  writeFileSync(output.checkReceipts[0].path,'{}');assert.throws(()=>verifyPostinstallBrowserRecovery(output,input));
 }finally{rmSync(directory,{recursive:true,force:true});}
});


test('required startup Home Tasks and saved Assistant read producers fit the narrow contract',()=>{
 const source=name=>readFileSync(new URL('../apps/client/src/'+name,import.meta.url),'utf8');
 const initial=source('prepared-views.ts'),inbox=source('OriginalInbox.tsx'),assistant=source('useAssistant.ts'),home=source('HomeLibrary.tsx'),taskCalendar=source('useTaskCalendar.ts'),groups=source('useAssistantGroups.ts');
 const group=initial.match(/Promise\.all\(\[([^\]]+)\]\.map/);assert.ok(group,'actual initial-view request list changed; audit it');
 const paths=[...group[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);assert.ok(group[1].includes('calendarReadPath(range)'));assert.match(initial,/addDays\(from, 42\)/);assert.match(initial,/calendarReadPath.*calendar\/state\?/);
 const inboxRead=inbox.match(/const accounts = await request<AccountsState>\('([^']+)'\)/);assert.ok(inboxRead);paths.push(inboxRead[1]);
 for(const m of assistant.matchAll(/read: signal => request<[^>]+>\('([^']+)', undefined, signal\)/g))paths.push(m[1]);
 const homeRead=home.match(/request<unknown>\('([^']+)'\)/);assert.ok(homeRead);paths.push(homeRead[1]);assert.match(groups,/request\(`assistant\/groups\$\{/);paths.push('assistant/groups');assert.match(taskCalendar,/to: addDays\(from, 60\)/);
 paths.push('calendar/state?from=2026-10-25&to=2026-12-06&timezone=America%2FLos_Angeles','calendar/state?from=2026-10-25&to=2026-12-24&timezone=America%2FLos_Angeles');
 assert.deepEqual([...new Set(paths)].sort(),['accounts','agents/hub?archived=false','assistant/groups','assistant/models','assistant/outputs','assistant/state','home/library','calendar/state?from=2026-10-25&to=2026-12-06&timezone=America%2FLos_Angeles','calendar/state?from=2026-10-25&to=2026-12-24&timezone=America%2FLos_Angeles','profile/progress'].sort());
 for(const p of paths){assert.equal(allowedRecoveryRequest('GET',origin+'/api/'+p,'',input.assistant.conversationId),true,p);assert.equal(allowedRecoveryRequest('POST',origin+'/api/'+p,'{}',input.assistant.conversationId),false,p);assert.equal(allowedRecoveryRequest('GET','http://127.0.0.1:4384/api/'+p,'',input.assistant.conversationId),false,p);}
 for(const p of ['accounts?extra=1','profile/progress?extra=1','agents/hub?archived=true','agents/hub?archived=false&before=x','calendar/state?from=2026-10-25&to=2026-12-06&timezone=UTC&extra=1','calendar/state?from=2026-02-30&to=2026-04-13&timezone=UTC','calendar/state?from=2026-10-25&to=2026-12-07&timezone=UTC','calendar/state?from=2026-10-25&to=2026-12-23&timezone=UTC','calendar/state?from=2026-10-25&to=2026-12-25&timezone=UTC','calendar/state?from=2026-10-25&to=2026-12-26&timezone=UTC','calendar/state?from=2026-10-25&to=2026-12-24&timezone=UTC&from=2026-10-25','home/library?extra=1','assistant/groups?after='+device,'assistant/account','assistant/goal/'+input.assistant.conversationId,'assistant/outputs?extra=1','assistant/conversations','mail/read','mail/index'])assert.equal(allowedRecoveryRequest('GET',origin+'/api/'+p,'',input.assistant.conversationId),false,p);
});


test('persistent recovery creates its replacement before closing old pages and arms only the sole survivor',async()=>{
 const events=[],pages=[];const make=name=>({closed:false,isClosed(){return this.closed;},async close(){events.push('close:'+name);this.closed=true;pages.splice(pages.indexOf(this),1);}});const first=make('first'),second=make('second'),replacement=make('replacement');pages.push(first,second);
 const context={pages:()=>pages,async newPage(){events.push('create');assert.equal(first.isClosed(),false);assert.equal(second.isClosed(),false);pages.push(replacement);return replacement;}};
 const page=await prepareSingleRecoveryPage(context,{arm:p=>{events.push('arm');assert.equal(p,replacement);assert.deepEqual(pages,[replacement]);}});assert.equal(page,replacement);assert.deepEqual(events,['create','close:first','close:second','arm']);
});
test('unexpected new page, failed replacement or failed old-page closure never arms recovery',async()=>{
 for(const fault of ['create','close','extra']){const old={isClosed:()=>false,close:async()=>{if(fault==='close')throw Error('close failed');pages.splice(pages.indexOf(old),1);}},replacement={isClosed:()=>false},pages=[old];let armed=false;const context={pages:()=>pages,async newPage(){if(fault==='create')throw Error('create failed');pages.push(replacement);if(fault==='extra')pages.push({isClosed:()=>false});return replacement;}};await assert.rejects(prepareSingleRecoveryPage(context,{arm:()=>{armed=true;}}));assert.equal(armed,false);if(fault==='create')assert.deepEqual(pages,[old]);}
 let created=false;await assert.rejects(prepareSingleRecoveryPage({pages:()=>[],newPage:async()=>{created=true;}},{arm:()=>assert.fail('must not arm')}),/original-window-required/);assert.equal(created,false);
});

test('failure query diagnostics expose only bounded calendar fields and hashes',()=>{
 const diagnostic=recoveryRequestDiagnostic(origin+'/api/calendar/state?from=2026-10-25&to=2026-12-24&timezone=America%2FLos_Angeles&token=do-not-record');
 assert.deepEqual(diagnostic.calendarQuery,{from:'2026-10-25',to:'2026-12-24',timezone:'America/Los_Angeles'});assert.match(diagnostic.querySha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(diagnostic).includes('do-not-record'),false);
 const other=recoveryRequestDiagnostic(origin+'/api/assistant/history/'+input.assistant.conversationId+'?messageId=private-message&token=do-not-record');assert.deepEqual(Object.keys(other).sort(),['path','querySha256']);assert.equal(JSON.stringify(other).includes('private-message'),false);
 assert.deepEqual(recoveryRequestDiagnostic(origin+'/api/calendar/state?from=2026-10-25&from=2026-10-26&timezone='+encodeURIComponent('x'.repeat(101))).calendarQuery,{});assert.equal(recoveryRequestDiagnostic(origin+'/'+'x'.repeat(400)).path.length,192);
});
test('failure screenshot and DOM collection refusal stays secondary to the original error',async()=>{
 const original=Error('original-tasks-click-failure'),before=original.message;const diagnostics=await recoveryFailureDiagnostics({isClosed:()=>false,evaluate:async()=>{throw Error('context closed');},screenshot:async()=>{throw Error('screenshot unavailable');}},'/unused');
 assert.deepEqual(diagnostics,{pageAvailable:true,stateUnavailable:true,screenshotUnavailable:true});assert.equal(original.message,before);assert.deepEqual(await recoveryFailureDiagnostics({isClosed:()=>true},'/unused'),{pageAvailable:false});
});


test('Mail exclusion accepts truthful connected accounts only under the explicit correction policy',async()=>{
 const accounts=[{provider:'google',state:'connected',capabilities:{mailRead:true}},{provider:'microsoft',state:'refreshing',capabilities:{mailRead:true}},{provider:'google',state:'disconnected',capabilities:{mailRead:true}}],accountsState={accounts},before=JSON.stringify(accountsState),r=rig({accountsState}),f=await fence(r,{...authority,...RECOVERY_MAIL_POLICY});
 assert.equal(f.summary().connectedMailReadAccounts,2);assert.equal(r.records[0].detail.connectedMailReadAccounts,2);assert.equal(r.records[0].detail.mailFunctionalityCoverage,'unverified');assert.equal(JSON.stringify(accountsState),before);f.arm(r.page);await r.invoke();assert.equal(r.calls.length,1);assert.equal(r.calls[0].url,origin+'/api/session');
 for(const policy of [{mailActivityPolicy:'blocked'},{mailFunctionalityCoverage:'unverified'},{mailActivityPolicy:'forward',mailFunctionalityCoverage:'unverified'}])await assert.rejects(fence(rig(),{...authority,...policy}),/mail-policy-invalid/);
 assert.deepEqual(recoveryMailPolicy(authority),{});
});
test('Mail-excluded account observations reject malformed or unbounded projections',async()=>{
 const valid={provider:'google',state:'connected',capabilities:{mailRead:true}};
 for(const accounts of [null,Array(257).fill(valid),[null],[{...valid,provider:'other'}],[{...valid,state:'unknown'}],[{...valid,capabilities:{mailRead:'true'}}]]){const r=rig({accountsState:{accounts}});await assert.rejects(fence(r,{...authority,...RECOVERY_MAIL_POLICY}),/account-projection-invalid/);assert.equal(r.calls.length,0);}
});
test('all Mail methods remain denied and counters survive bounded trace saturation',async()=>{
 const r=rig({accountsState:{accounts:[{provider:'google',state:'connected',capabilities:{mailRead:true}}]}}),f=await fence(r,{...authority,...RECOVERY_MAIL_POLICY});f.arm(r.page);
 for(let i=0;i<80;i++)await r.invoke('GET','/api/not-allowed','');
 const paths=['/api/mail','/api/mail/index/read','/api/mail/index/command','/api/mail/read','/api/mail/images'];
 for(const path of paths)for(const method of ['GET','HEAD','POST','PUT','DELETE']){assert.equal(allowedRecoveryRequest(method,origin+path,'{}',input.assistant.conversationId),false);await r.invoke(method,path,'{}');}
 assert.equal(r.calls.length,0);assert.equal(f.summary().blocked.length,64);assert.equal(f.summary().mailRequestsBlocked,paths.length*5);assert.equal(f.summary().mailRequestsForwarded,0);
});
test('Mail-excluded durable proof cannot lose its limitation or admit Mail forwarding',()=>{
 const directory=mkdtempSync(join(tmpdir(),'nova-mail-excluded-proof-'));const save=(name,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n'),path=join(directory,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 try{
  const originalInput={...input,prepared:save('prepared.json',{draft:'original retained draft'}),original:save('original.json',{binding:{priorCandidateId:'0'.repeat(64)}})},request=save('request.json',{correction:{kind:'nova-postinstall-connected-mail-correction',...RECOVERY_MAIL_POLICY}});
  const readiness=save('readiness.json',postinstallReadinessFixture(originalInput,{sessionId:'00000000-0000-4000-8000-000000000007',now,requestSha256:'e'.repeat(64),mailPolicy:RECOVERY_MAIL_POLICY}));
  const grant={...authority,...RECOVERY_MAIL_POLICY,kind:'nova-postinstall-browser-observation-authority',operationId:input.operationId,sessionId:'00000000-0000-4000-8000-000000000007',browserInputSha256:sha256(canonicalBrowser(originalInput)),browserReadiness:readiness,request,installationPermitted:false,assistantDispatchPermitted:false,automaticRenewal:false,acceptanceScope:'current-installed-browser-crash-recovery',originalTransitionCoverage:'unverified',transitionCoverageGaps:[...RECOVERY_GAPS]},grantRef=save('authority.json',grant),output=postinstallAcceptanceFixture(save,originalInput,grant,grantRef);
  assert.equal(verifyPostinstallBrowserRecovery(output,originalInput),output);assert.equal(output.checks[0].detail.connectedMailReadAccounts,2);
  for(const changed of [{...output,mailFunctionalityCoverage:'verified'},{...output,mailFunctionalityCoverage:undefined},{...output,mailActivityPolicy:'forward'},{...output,fence:{...output.fence,mailRequestsForwarded:1}},{...output,fence:{...output.fence,mailRequestsBlocked:undefined}},{...output,fence:{...output.fence,connectedMailReadAccounts:-1}}])assert.throws(()=>verifyPostinstallBrowserRecovery(changed,originalInput));
  for(const count of [-1,257,'2']){const altered=structuredClone(output);altered.checks[0].detail.connectedMailReadAccounts=count;altered.checkReceipts[0]=save('count-'+String(count)+'.json',altered.checks[0]);assert.throws(()=>verifyPostinstallBrowserRecovery(altered,originalInput));}
  const stripped=structuredClone(output);delete stripped.checks[0].detail.mailFunctionalityCoverage;stripped.checkReceipts[0]=save('stripped-check.json',stripped.checks[0]);assert.throws(()=>verifyPostinstallBrowserRecovery(stripped,originalInput));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('predecessor observer uses only original status even after its deadline',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'nova-predecessor-status-'));const save=(name,value)=>{const path=join(directory,name);mkdirSync(dirname(path),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 try{
  const transport=save('transport.json',{format:1,hostAlias:'isolated',sshConfig:save('ssh-config',Buffer.from('synthetic read-only transport'))}),options={mode:'remote',baseUrl:origin,playwright:save('closure.json',{}),directoryRoot:'/opt/browser-tests'},binding={operationId:input.operationId,sessionId:'00000000-0000-4000-8000-000000000003',route:'full',epoch:'epoch',options,transport,fullTarget:input.fullTarget};
  const browserInput={...input,original:save('original.json',{binding}),prepared:save('prepared.json',{bindingSha256:sha256(canonicalBrowser(binding)),draft:'retained'}),installed:{...input.installed,route:'full'},assistant:{...input.assistant,savedReplyAccepted:true,browserUiVerified:false}};
  const request={operationId:input.operationId,sessionId:'00000000-0000-4000-8000-000000000004',durationMs:600000,capacity:{diskReserveBytes:2147483648,workingAllowanceBytes:536870912},failure:{failed:save('failed-original.json',{operationId:input.operationId,reason:'browser-dom-or-transport-check-failed'}),closed:save('closed-original.json',{operationId:input.operationId,browserClosed:true,tunnelClosed:true}),memory:save('memory-original.json',{events:'oom_kill 1\n'})}};
  const grant={...authority,operationId:input.operationId,sessionId:request.sessionId,browserInputSha256:sha256(canonicalBrowser(browserInput)),request:save('predecessor-request.json',request),browserReadiness:save('readiness.json',{sessions:[]})},authorityRef=save('authority.json',grant),context={journal:{directory},descriptor:{operation:{id:input.operationId},target:save('target.json',{browserTools:options,transport,full:{host:{hostConfiguration:save('host.json',{})}}})},request,browserInput,authority:grant,authorityRef};
  const intentPath=save('browser-current-recovery/'+request.sessionId+'/launch-intent.json',{authority:authorityRef,inputSha256:grant.browserInputSha256}).path,status={state:'observed',operationId:input.operationId,sessionId:request.sessionId,files:{failed:{reason:'browser-recovery-connected-mail-not-admitted',completedChecks:[],diagnostics:{pageAvailable:false}},closed:{browserClosed:true}},checks:[],unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[],originalProfileUnchanged:null,hostWrites:false};let calls=0;
  const run=async(_config,program)=>{calls++;const encoded=program.match(/DATA=json.loads\(base64.b64decode\('([^']+)'/);assert.ok(encoded);const data=JSON.parse(Buffer.from(encoded[1],'base64'));assert.equal(data.mode,'status');assert.deepEqual(data.authority,grant);assert.deepEqual(data.authorityRef,authorityRef);return{exitCode:0,stdout:JSON.stringify(status),stderr:'',uncertain:false,diagnosticsTruncated:false};};
  const observed=await observePostinstallRecoveryPredecessor(context,{run,clock:()=>grant.deadlineAtMs+1000});assert.deepEqual(observed.status,status);assert.deepEqual(JSON.parse(readFileSync(observed.statusRef.path)),status);assert.equal(JSON.parse(readFileSync(observed.transportReceipt.path)).mode,'status');assert.equal(calls,1);
  await assert.rejects(observePostinstallRecoveryPredecessor({...context,request:{...request,durationMs:request.durationMs+1}},{run}),/predecessor-binding-changed/);assert.equal(calls,1);
  writeFileSync(intentPath,'{}');await assert.rejects(observePostinstallRecoveryPredecessor(context,{run}),/predecessor-intent-changed/);assert.equal(calls,1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
