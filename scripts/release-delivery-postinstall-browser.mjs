/** Separate current-installed observation; original transition remains unverified. */
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {runInstallTransport,releaseTransportSchema} from './release-adapters.mjs';
import {canonicalBrowser,writeBrowserOnce} from './release-delivery-browser-primitives.mjs';
import {verifyDocumentIdentity} from './release-delivery-browser-checks.mjs';
import {RECOVERY_CHECKS,RECOVERY_GAPS} from './release-delivery-postinstall-browser-worker.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},hash=v=>sha256(canonicalBrowser(v)),read=r=>JSON.parse(readEvidenceFile(r,{maximum:8*1024**2}));
const ref=p=>({path:p,sha256:sha256(readFileSync(p))});
const normalized=request=>{const {admission,...base}=request;return base;};
function save(context,name,value){const dir=join(context.journal.directory,'browser-current-recovery',context.request.sessionId);mkdirSync(dir,{recursive:true,mode:0o700});const p=join(dir,name+'-'+hash(value)+'.json');writeBrowserOnce(p,value);return ref(p);}
function inputs(context){
 const {browserInput:input,descriptor,request}=context,original=read(input.original),prepared=read(input.prepared),target=read(descriptor.target),options=original.binding.options;
 need(input.operationId===descriptor.operation.id&&request.operationId===input.operationId&&original.binding.operationId===input.operationId&&original.binding.route==='full'&&input.installed.route==='full','postinstall-browser-input-changed');
 need(same(options,target.browserTools)&&same(original.binding.transport,target.transport)&&same(input.fullTarget,original.binding.fullTarget)&&input.installed.installedHealth.epoch===original.binding.epoch,'postinstall-browser-target-changed');
 need(options.mode==='remote'&&options.baseUrl==='http://127.0.0.1:4383'&&request.sessionId!==original.binding.sessionId&&/^[a-f0-9-]{36}$/.test(request.sessionId),'postinstall-browser-session-invalid');
 need(input.assistant.savedReplyAccepted===true&&input.assistant.browserUiVerified===false&&prepared.bindingSha256===hash(original.binding),'postinstall-original-proof-required');
 const failed=read(request.failure.failed),closed=read(request.failure.closed),memory=read(request.failure.memory);
 need(failed.operationId===input.operationId&&failed.reason==='browser-dom-or-transport-check-failed'&&closed.operationId===input.operationId&&closed.browserClosed===true&&closed.tunnelClosed===true&&/^oom_kill [1-9]/m.test(memory.events),'postinstall-demonstrated-browser-oom-required');
 need(Number.isSafeInteger(request.capacity?.diskReserveBytes)&&request.capacity.diskReserveBytes>=2147483648&&Number.isSafeInteger(request.capacity.workingAllowanceBytes)&&request.capacity.workingAllowanceBytes>=536870912,'postinstall-browser-capacity-policy-required');
 const legacyNames=['release-delivery-browser-primitives.mjs','release-delivery-browser-checks.mjs','release-delivery-browser-remote-worker.mjs'];
 const source=n=>{const b=readFileSync(new URL(n,import.meta.url));return {base64:b.toString('base64'),sha256:sha256(b)};};
 return{input,original,prepared,options,transport:target.transport,base:{input,prepared,sessionId:request.sessionId,durationMs:request.durationMs,requestSha256:hash(normalized(request)),capacity:request.capacity,failure:request.failure,hostConfig:target.full.host.hostConfiguration,
  legacyHelper:source('release-delivery-browser-remote.py'),legacy:{mode:'status',original,sources:Object.fromEntries(legacyNames.map(n=>[n,source(n)])),closure:readEvidenceFile(options.playwright,{maximum:2*1024**2}).toString('base64')},
  sources:Object.fromEntries(['release-delivery-browser-primitives.mjs','release-delivery-browser-checks.mjs','release-delivery-postinstall-browser-worker.mjs'].map(n=>[n,source(n)]))}};
}
async function invoke(context,data,{run=runInstallTransport,clock=Date.now}={}){
 const {transport}=inputs(context),config=releaseTransportSchema.parse(read(transport));readEvidenceFile(config.sshConfig,{maximum:65536});
 const program="import base64,json\nDATA=json.loads(base64.b64decode('"+Buffer.from(JSON.stringify(data)).toString('base64')+"',validate=True))\n"+readFileSync(new URL('release-delivery-postinstall-browser.py',import.meta.url),'utf8');
 const response=await run(config,program,{captureDiagnostics:true}),receipt=save(context,'transport-'+data.mode,{mode:data.mode,observedAtMs:clock(),programSha256:sha256(program),...response});
 need(!response.uncertain&&response.exitCode===0&&!response.diagnosticsTruncated&&typeof response.stdout==='string'&&!response.stderr,'postinstall-browser-response-unavailable');const output=JSON.parse(response.stdout);need(output.state!=='gap',output.reason??'postinstall-browser-response-refused');return{output,receipt};
}
export function verifyPostinstallReadiness(value,context,now=Date.now()){
 const {input,original,base}=inputs(context),r=value.resources;
 need(value.kind==='nova-postinstall-browser-readiness'&&value.operationId===input.operationId&&value.sessionId===context.request.sessionId&&value.inputSha256===hash(input)&&value.requestSha256===base.requestSha256&&value.originalClosed===true&&value.remoteRecoveryAbsent===true&&value.hostWrites===false,'postinstall-browser-readiness-changed');
 need(Number.isSafeInteger(value.observedAtMs)&&value.observedAtMs<=now+30000&&now-value.observedAtMs<=120000,'postinstall-browser-readiness-stale');
 need(value.profile.path===original.binding.options.directoryRoot+'/'+original.binding.sessionId+'/profile'&&/^[a-f0-9]{64}$/.test(value.profile.inventorySha256)&&value.profile.entryCount>0&&value.profile.entryCount<=20000,'postinstall-browser-profile-changed');
 need(r.browserMaxBytes===2147483648&&r.hostReserveBytes===2147483648&&r.availableBytes>=r.browserMaxBytes+r.hostReserveBytes&&r.tmpAllowanceBytes===134217728&&r.filesystemAvailableBytes>=r.cloneAllocationBytes+r.workingAllowanceBytes+r.diskReserveBytes+(r.tmpSameFilesystem?r.tmpAllowanceBytes:0)&&(r.tmpSameFilesystem||r.tmpAvailableBytes>=r.tmpAllowanceBytes+r.diskReserveBytes)&&r.filesystemFreeInodes>value.profile.entryCount+128&&r.diskReserveBytes===context.request.capacity.diskReserveBytes&&r.workingAllowanceBytes===context.request.capacity.workingAllowanceBytes,'postinstall-browser-capacity-changed');
 need(same(value.health,input.installed.installedHealth)&&value.sessionDatabase?.readOnly===true&&value.sessionDatabase.queryOnly===true&&Array.isArray(value.sessions)&&value.sessions.length>0&&value.sessions.length<=256,'postinstall-browser-current-session-map-invalid');return value;
}
export async function planPostinstallBrowserRecovery(context,options={}){
 const {base}=inputs(context),{output}=await invoke(context,{...base,mode:'plan'},options);verifyPostinstallReadiness(output,context,(options.clock??Date.now)());return save(context,'readiness',output);
}
export async function verifyPostinstallBrowserRecoveryPlan(reference,context,options={}){
 const retained=read(reference),old=verifyPostinstallReadiness(retained,context,retained.observedAtMs);const fresh=await planPostinstallBrowserRecovery(context,options),current=read(fresh);
 for(const key of ['profile','sessions','sessionDatabase','health','inputSha256','requestSha256'])need(same(current[key],old[key]),'postinstall-browser-readiness-binding-changed');return fresh;
}
export function verifyPostinstallBrowserRecovery(output,input){
 const authority=read(output.authority),plan=read(authority.browserReadiness);
 need(authority.kind==='nova-postinstall-browser-observation-authority'&&authority.operationId===input.operationId&&authority.browserInputSha256===hash(input)&&authority.installationPermitted===false&&authority.assistantDispatchPermitted===false&&authority.automaticRenewal===false,'postinstall-browser-authority-changed');
 need(output.accepted===true&&output.browserUiVerified===true&&output.kind==='nova-postinstall-browser-recovery-acceptance'&&output.acceptanceScope==='current-installed-browser-crash-recovery'&&output.originalTransitionCoverage==='unverified'&&same(output.transitionCoverageGaps,RECOVERY_GAPS)&&authority.acceptanceScope===output.acceptanceScope&&authority.originalTransitionCoverage==='unverified'&&same(authority.transitionCoverageGaps,RECOVERY_GAPS),'postinstall-browser-coverage-changed');
 need(output.operationId===input.operationId&&output.inputSha256===hash(input)&&output.sessionId===authority.sessionId&&output.startedAtMs===authority.startedAtMs&&Number.isSafeInteger(output.completedAtMs)&&output.completedAtMs>=output.startedAtMs&&output.completedAtMs<=authority.deadlineAtMs&&authority.deadlineAtMs-authority.startedAtMs<=1800000,'postinstall-browser-fixed-window-changed');
 need(output.savedMessageId===input.assistant.savedMessageId&&output.savedReplySha256===input.assistant.replySha256&&output.newAssistantMessages===0&&output.installationDispatched===false,'postinstall-browser-existing-reply-changed');
 need(same(output.checks.map(c=>c.name),RECOVERY_CHECKS)&&output.checkReceipts.length===RECOVERY_CHECKS.length,'postinstall-browser-required-check-missing');
 for(const [i,check]of output.checks.entries()){need(check.passed===true&&Number.isSafeInteger(check.atMs)&&check.atMs>=authority.startedAtMs&&check.atMs<=output.completedAtMs&&same(read(output.checkReceipts[i]),check),'postinstall-browser-check-receipt-changed');}
 const prepared=read(input.prepared),original=read(input.original),draftHash=sha256(prepared.draft),check=name=>output.checks.find(c=>c.name===name).detail;
 for(const name of ['copied-draft-before-edit','copied-draft-after-reload','copied-draft-after-client-reload'])need(check(name).draftSha256===draftHash,'postinstall-browser-draft-check-changed');
 need(same(check('existing-saved-reply-visible'),{conversationId:input.assistant.conversationId,nativeId:input.assistant.nativeId,savedMessageId:input.assistant.savedMessageId,replySha256:input.assistant.replySha256}),'postinstall-browser-saved-reply-check-changed');
 need(same(check('current-stale-client-get-rejected'),{status:409,code:'client_update',priorCandidateId:original.binding.priorCandidateId,currentCandidateId:input.installed.installedHealth.candidateId})&&check('current-ui-reload-reaction').realServerResponse===true,'postinstall-browser-stale-client-check-changed');
 const session=output.checks[0].detail;need(plan.sessions.some(r=>r.digest===session.sessionDigest&&r.deviceId===session.deviceId&&r.expiresAtMs===session.expiresAtMs&&r.expiresAtMs>authority.deadlineAtMs+30000),'postinstall-browser-session-authority-changed');
 verifyDocumentIdentity(output.loadedDocument,input.installed.installedHealth,{route:'full'});readEvidenceFile(output.screenshot,{maximum:16*1024**2});readEvidenceFile(output.draftScreenshot,{maximum:16*1024**2});need(output.checks[2].detail.screenshotSha256===output.draftScreenshot.sha256,'postinstall-browser-draft-screenshot-changed');
 const closed=read(output.closed),unit=read(output.unitCloseout),copy=read(output.profileCopy),memory=read(output.memory);
 need(closed.operationId===input.operationId&&closed.sessionId===authority.sessionId&&closed.browserClosed===true&&unit.operationId===input.operationId&&unit.sessionId===authority.sessionId&&unit.originalProfileUnchanged===true&&unit.ownedPids?.length===0&&/ActiveState=(inactive|failed)\n/.test(unit.unitState)&&unit.unitState.includes('MainPID=0\n'),'postinstall-browser-process-closeout-incomplete');
 need(copy.sourceUnchanged===true&&same(copy.source,plan.profile)&&output.sourceProfileInventorySha256===plan.profile.inventorySha256&&copy.excludedSingletonLinks.every(n=>['SingletonLock','SingletonCookie','SingletonSocket'].includes(n)),'postinstall-browser-source-profile-changed');
 need(memory.maxBytes===2147483648&&Number.isSafeInteger(memory.peakBytes)&&memory.peakBytes<=Math.floor(2147483648*0.8)&&!/^oom(?:_kill|_group_kill)? [1-9]/m.test(memory.events),'postinstall-browser-memory-proof-changed');
 const fence=output.fence;need(fence.failure===null&&fence.onlyExistingSessionPost===true&&Number.isSafeInteger(fence.sessionPosts)&&fence.sessionPosts>=1&&fence.sessionPosts<=5&&fence.sessionAttempts===fence.sessionPosts&&fence.mutatingRequestsForwarded===fence.sessionPosts&&fence.webSocketsForwarded===0&&fence.serviceWorkers==='block'&&fence.sessionDigest===session.sessionDigest&&fence.deviceId===session.deviceId,'postinstall-browser-request-fence-changed');return output;
}
export async function observePostinstallBrowserRecovery(context,options={}){
 const {authority,authorityRef}=context,{base,input}=inputs(context),clock=options.clock??Date.now;
 need(authority&&authorityRef&&same(read(authorityRef),authority)&&authority.operationId===input.operationId&&authority.sessionId===context.request.sessionId&&authority.browserInputSha256===hash(input),'postinstall-browser-authority-required');
 const plan=read(authority.browserReadiness),dir=join(context.journal.directory,'browser-current-recovery',authority.sessionId);mkdirSync(dir,{recursive:true,mode:0o700});const intentPath=join(dir,'launch-intent.json'),intent={authority:authorityRef,inputSha256:hash(input)},data={...base,authority,authorityRef,plan};
 try{
  if(!existsSync(intentPath)){
   need(clock()>=authority.startedAtMs&&clock()<authority.deadlineAtMs,'postinstall-browser-authority-expired');need(typeof context.beforeNewEffect==='function','postinstall-browser-native-gate-required');await context.beforeNewEffect();writeBrowserOnce(intentPath,intent);await invoke(context,{...data,mode:'start'},options);
  }else need(same(JSON.parse(readFileSync(intentPath)),intent),'postinstall-browser-original-intent-changed');
  const {output:status,receipt}=await invoke(context,{...data,mode:'status'},options);
  if(status.files.failed)return{state:'gap',reason:status.files.failed.reason,output:null,receipt,externalId:input.operationId};
  if(!status.files.result)return{state:'uncertain',reason:clock()<authority.deadlineAtMs?'postinstall-browser-original-running':'postinstall-browser-original-deadline-exhausted',output:null,receipt,externalId:input.operationId};
  need(status.files.closed&&status.originalProfileUnchanged===true&&!status.ownedPids.length&&status.unitState.includes('MainPID=0\n'),'postinstall-browser-closeout-required');
  const screens={};for(const [name,file]of [['screenshot','accepted-ui.png'],['draftScreenshot','copied-draft-ui.png']]){
   const chunks=[];let offset=0,total,digest;do{const {output:p}=await invoke(context,{...data,mode:'screenshot',screen:name,offset},options);need(p.offset===offset&&Number.isSafeInteger(p.bytes)&&p.bytes<=16*1024**2&&(!digest||digest===p.sha256)&&(!total||total===p.bytes),'postinstall-browser-screenshot-changed');total=p.bytes;digest=p.sha256;const b=Buffer.from(p.base64,'base64');need(b.length>0&&b.length<=49152,'postinstall-browser-screenshot-bound');chunks.push(b);offset+=b.length;}while(offset<total);
   const bytes=Buffer.concat(chunks),destination=join(dir,file);need(sha256(bytes)===digest&&digest===status.files.result[name].sha256,'postinstall-browser-screenshot-hash-changed');if(!existsSync(destination))writeFileSync(destination,bytes,{flag:'wx',mode:0o600});else need(sha256(readFileSync(destination))===digest,'postinstall-browser-screenshot-local-changed');screens[name]=ref(destination);
  }
  const output={...status.files.result,...screens,checkReceipts:status.checks.map((c,i)=>save(context,'check-'+i,c)),closed:save(context,'closed',status.files.closed),unitCloseout:save(context,'unit-closeout',{operationId:input.operationId,sessionId:authority.sessionId,unitState:status.unitState,ownedPids:status.ownedPids,originalProfileUnchanged:status.originalProfileUnchanged}),profileCopy:save(context,'profile-copy',status.files['profile-copy']),memory:save(context,'memory-accepted',status.files['memory-accepted'])};
  verifyPostinstallBrowserRecovery(output,input);const accepted=save(context,'accepted',output);return{state:'completed',reason:'current-installed-browser-crash-recovery-verified',output,receipt:accepted,externalId:input.operationId};
 }catch(error){return{state:'uncertain',reason:/^[a-z][a-z0-9-]{0,99}$/.test(error.message)?error.message:'postinstall-browser-observation-unavailable',output:null,receipt:null,externalId:input.operationId};}
}
