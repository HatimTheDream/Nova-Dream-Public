import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from '../scripts/release-plan.mjs';
import {canonicalBrowser} from '../scripts/release-delivery-browser-primitives.mjs';
import {allowedRecoveryRequest,selectExistingRecoverySession,installRecoveryFence,RECOVERY_GAPS} from '../scripts/release-delivery-postinstall-browser-worker.mjs';
import {verifyPostinstallBrowserRecovery} from '../scripts/release-delivery-postinstall-browser.mjs';
import {postinstallReadinessFixture,postinstallAcceptanceFixture} from '../support/postinstall-browser-fixture.mjs';
const now=1000000,origin='http://127.0.0.1:4383',candidate='a'.repeat(64),device='00000000-0000-4000-8000-000000000001',token='existing-fixture-token',cookie={name:'e3_session_'+'b'.repeat(32),value:token,domain:'127.0.0.1',path:'/'};
const session={digest:sha256(token),deviceId:device,expiresAtMs:now+86400000},authority={startedAtMs:now,deadlineAtMs:now+600000};
const health={application:'nova-dream-edition-3',status:'ready',candidateId:candidate,processIdentity:'unchanged-process',serviceInputsSha256:'f'.repeat(64),epoch:'epoch',frontend:{source:'bundled',id:candidate,version:'2.28.39',buildVersion:'1.0.412'}};
const input={operationId:'00000000-0000-4000-8000-000000000005',installed:{installedHealth:health},fullTarget:{candidateId:candidate,version:'2.28.39',buildVersion:'1.0.412'},assistant:{conversationId:'00000000-0000-4000-8000-000000000006',nativeId:'native-existing',savedMessageId:'message-existing',replySha256:sha256('existing-reply')}};
const response=(value,status=200,headers={})=>({status:()=>status,headers:()=>headers,json:async()=>value,dispose:async()=>{}});
function rig({cookieList=[cookie],healthValue=health,snapshot={epoch:'epoch',deviceId:device},postHeaders={}}={}){
 const page={},other={},pages=[page],calls=[],records=[];let handler;
 const context={cookies:async()=>cookieList,pages:()=>pages,routeWebSocket:async()=>{},route:async(_url,fn)=>{handler=fn;}};
 const api={get:async url=>response(url.endsWith('/api/health')?healthValue:snapshot),fetch:async(url,args)=>{calls.push({url,...args});return response({deviceId:device,apiVersion:1},200,postHeaders);}};
 const route=(method='POST',pathname='/api/session',body='{}',owner=page)=>({request:()=>({url:()=>origin+pathname,method:()=>method,postData:()=>body,headers:()=>({'content-type':'application/json'}),isNavigationRequest:()=>false,frame:()=>({page:()=>owner})}),abort:async()=>{},fulfill:async()=>{}});
 return{page,other,context,api,calls,records,route,invoke:(...args)=>handler(route(...args))};
}
async function fence(r){return installRecoveryFence(r.context,r.api,input,authority,[session],(name,detail)=>r.records.push({name,detail}),{clock:()=>now,priorCandidateId:'0'.repeat(64)});}
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
