/** A linked browser attempt preserves the expired predecessor and never rewrites its clock. */
import {resolve,join} from 'node:path';
import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {isDeepStrictEqual as same} from 'node:util';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {canonicalBrowser} from './release-delivery-browser-primitives.mjs';
import {browserBinding} from './release-delivery-browser.mjs';
const need=(v,r)=>{if(!v)throw Error(r);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...names].sort());
const ref=v=>exact(v,['path','sha256'])&&typeof v.path==='string'&&/^[0-9a-f]{64}$/.test(v.sha256);
const read=r=>JSON.parse(readEvidenceFile(r,{maximum:2097152}));
export function verifyBrowserPredecessor(browser,expectedBinding){
 need(exact(browser,['predecessor','status','successorSessionId'])&&ref(browser.predecessor)&&ref(browser.status)&&uuid(browser.successorSessionId),'browser-successor-lineage-invalid');
 const prior=read(browser.predecessor),status=read(browser.status),id=expectedBinding.operationId;
 need(browser.successorSessionId!==id&&prior.binding?.sessionId===undefined&&same(prior.binding,expectedBinding),'browser-successor-prior-binding-changed');
 need(Number.isSafeInteger(prior.startedAtMs)&&Number.isSafeInteger(prior.deadlineAtMs)&&prior.deadlineAtMs===prior.startedAtMs+prior.binding.options.timeoutMs,'browser-successor-prior-clock-changed');
 need(status.state==='observed'&&status.operationId===id&&status.originalSha256===browser.predecessor.sha256&&Number.isSafeInteger(status.observedAtMs),'browser-successor-status-changed');
 const failed=status.files?.failed,closed=status.files?.closed;
 need(failed?.operationId===id&&failed.reason==='browser-original-deadline-exhausted'&&Number.isSafeInteger(failed.atMs)&&failed.atMs>=prior.deadlineAtMs,'browser-successor-expired-failure-required');
 need(closed?.operationId===id&&closed.browserClosed===true&&closed.tunnelClosed===true&&Number.isSafeInteger(closed.atMs)&&closed.atMs>=failed.atMs&&closed.atMs<=status.observedAtMs,'browser-successor-closed-proof-required');
 need(!status.files.acceptance&&/ActiveState=(inactive|failed)\n/.test(status.unitState)&&status.unitState.includes('MainPID=0\n')&&Array.isArray(status.ownedPids)&&status.ownedPids.length===0,'browser-successor-owned-closure-required');
 return{prior,status};
}
export function verifyPublicationBrowserContinuation(browser,{descriptor,journal,now=Date.now()}){
 const id=descriptor.operation.id;
 need(resolve(browser?.predecessor?.path??'')===resolve(join(journal.directory,'browser-session','original.json')),'browser-successor-original-path-changed');
 const target=JSON.parse(readEvidenceFile(descriptor.target)),prior={};
 for(const name of ['route','sign']){const p=journal.deliveryPhase(id,name);need(p?.state==='completed'&&p.validation?.state!=='failed','browser-successor-prerequisite-required');prior[name]=p.current.output;}
 need(target.browserTools?.mode==='remote','browser-successor-remote-only');
 const expected=browserBinding({descriptor,prior},target.browserTools,target.transport);
 const records=verifyBrowserPredecessor(browser,expected);
 need(now>=records.prior.deadlineAtMs&&now>=records.status.observedAtMs,'browser-successor-prior-not-expired-or-status-future');
 return browser;
}
export function linkedBrowserBinding(base,browser,grant){
 verifyBrowserPredecessor(browser,base);
 need(grant.kind==='nova-expired-publication-continuation'&&same(grant.browser,browser)&&ref(grant.request)&&Number.isSafeInteger(grant.issuedAtMs)&&Number.isSafeInteger(grant.expiresAtMs)&&grant.expiresAtMs>grant.issuedAtMs,'browser-successor-grant-changed');
  if(grant.browserWindowRecovery)verifyBrowserWindowReservation(grant.browserReservation,{browser,issuedAtMs:grant.issuedAtMs,expiresAtMs:grant.expiresAtMs,timeoutMs:base.options.timeoutMs});
 else need(grant.browserReservation===undefined,'browser-window-reservation-without-recovery');
 return{...base,sessionId:browser.successorSessionId,browserPredecessor:{original:browser.predecessor,status:browser.status},publicationContinuation:{request:grant.request,issuedAtMs:grant.issuedAtMs,expiresAtMs:grant.expiresAtMs,...(grant.browserWindowRecovery?{browserReservation:grant.browserReservation}:{})}};
}
export function verifyLinkedBrowserRecord(original){
 const b=original.binding;if(!b.sessionId)return original;
 const {sessionId,browserPredecessor,publicationContinuation,...base}=b;
 need(exact(browserPredecessor,['original','status'])&&exact(publicationContinuation,['request','issuedAtMs','expiresAtMs',...(publicationContinuation?.browserReservation?['browserReservation']:[])])&&ref(publicationContinuation.request),'browser-successor-record-invalid');
 const {prior}=verifyBrowserPredecessor({predecessor:browserPredecessor.original,status:browserPredecessor.status,successorSessionId:sessionId},base);
 need(Number.isSafeInteger(original.startedAtMs)&&original.startedAtMs>=prior.deadlineAtMs&&original.startedAtMs>=publicationContinuation.issuedAtMs&&original.deadlineAtMs===original.startedAtMs+b.options.timeoutMs&&original.deadlineAtMs<=publicationContinuation.expiresAtMs,'browser-successor-attempt-clock-changed');
 const request=read(publicationContinuation.request);
 if(publicationContinuation.browserReservation){
  const browser={predecessor:browserPredecessor.original,status:browserPredecessor.status,successorSessionId:sessionId};
  need(request.browserWindowRecovery&&request.operationId===b.operationId&&same(request.browser,browser),'browser-window-reservation-request-changed');
  const reservation=verifyBrowserWindowReservation(publicationContinuation.browserReservation,{browser,issuedAtMs:publicationContinuation.issuedAtMs,expiresAtMs:publicationContinuation.expiresAtMs,timeoutMs:b.options.timeoutMs});
  need(original.startedAtMs===reservation.startedAtMs&&original.deadlineAtMs===reservation.deadlineAtMs,'browser-window-reservation-clock-changed');
 }else need(!request.browserWindowRecovery,'browser-window-reservation-required');
 return original;
}

/** A recovery owns one fixed thirty-minute browser reservation from the grant event. */
export function verifyBrowserWindowReservation(reservation,{browser,issuedAtMs,expiresAtMs,timeoutMs}){
 need(exact(reservation,['sessionId','startedAtMs','deadlineAtMs'])&&uuid(reservation.sessionId)
  &&reservation.sessionId===browser.successorSessionId&&timeoutMs===1800000
  &&Number.isSafeInteger(reservation.startedAtMs)&&reservation.startedAtMs>=0&&reservation.startedAtMs===issuedAtMs
  &&Number.isSafeInteger(reservation.deadlineAtMs)&&reservation.deadlineAtMs===reservation.startedAtMs+timeoutMs
  &&reservation.deadlineAtMs<=expiresAtMs,'browser-window-reservation-changed');
 return reservation;
}
export function assertBrowserWindowRecoveryUnmaterialized(journal,sessionId){
 need(uuid(sessionId),'browser-window-reservation-session-invalid');
 const parent=join(journal.directory,'browser-session'),name='successor-'+sessionId,directory=join(parent,name);
 if(existsSync(parent)){
  need(lstatSync(parent).isDirectory()&&!lstatSync(parent).isSymbolicLink(),'browser-window-recovery-session-parent-changed');
  need(readdirSync(parent).filter(entry=>entry.startsWith('successor-')).every(entry=>entry===name),'browser-window-recovery-other-session-present');
 }
 if(existsSync(directory))need(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink()&&readdirSync(directory).length===0,'browser-window-recovery-already-materialized');
 return directory;
}
/** This expired-clock probe is read-only. It never becomes an original record. */
export function browserWindowRecoveryProbe({descriptor,journal,request,now=Date.now()}){
 const id=descriptor.operation.id,marker=request?.browserWindowRecovery;
 need(marker&&request.operationId===id,'browser-window-recovery-request-required');
 const predecessor=journal.deliveryOperatorContinuationBySha256?.(id,marker.predecessorGrantSha256);
 need(predecessor?.sha256===marker.predecessorGrantSha256&&predecessor.proof?.successor&&!predecessor.proof.browserWindowRecovery
  &&predecessor.proof.operationId===id&&predecessor.proof.kind==='nova-expired-publication-continuation'
  &&now>=predecessor.proof.expiresAtMs&&same(predecessor.proof.browser,request.browser),'browser-window-recovery-predecessor-changed');
 const browser=verifyPublicationBrowserContinuation(request.browser,{descriptor,journal,now});
 const target=JSON.parse(readEvidenceFile(descriptor.target)),prior={};
 for(const name of ['route','sign'])prior[name]=journal.deliveryPhase(id,name).current.output;
 need(target.browserCapability==='available'&&target.browserTools?.mode==='remote'&&target.browserTools.timeoutMs===1800000,'browser-window-recovery-remote-window-required');
 const binding=linkedBrowserBinding(browserBinding({descriptor,prior},target.browserTools,target.transport),browser,predecessor.proof);
 const original={binding,startedAtMs:predecessor.proof.issuedAtMs,deadlineAtMs:predecessor.proof.issuedAtMs+target.browserTools.timeoutMs};
 verifyLinkedBrowserRecord(original);return original;
}
export function verifyBrowserWindowRecoveryReadiness(reference,{descriptor,journal,request,now=Date.now(),requireUnmaterialized=false}){
 const proof=read(reference),original=browserWindowRecoveryProbe({descriptor,journal,request,now}),response=proof.remote;
 need(exact(proof,['format','kind','operationId','descriptorSha256','requestSha256','observedAtMs','original','remote','hostWrites','localSessionAbsent'])
  &&proof.format===1&&proof.kind==='nova-browser-window-recovery-readiness'&&proof.operationId===descriptor.operation.id
  &&proof.descriptorSha256===sha256(canonicalBrowser(descriptor))&&proof.requestSha256===sha256(canonicalBrowser(request))
  &&same(proof.original,original)&&proof.hostWrites===false&&proof.localSessionAbsent===true
  &&Number.isSafeInteger(proof.observedAtMs)&&proof.observedAtMs<=now&&now-proof.observedAtMs<=900000,'browser-window-recovery-readiness-changed');
 const plan=response?.plan,options=original.binding.options;
 need(response?.state==='ready'&&response.hostWrites===false&&response.existingOperation===false&&response.sessionAbsent===true
  &&plan?.kind==='nova-remote-browser-plan'&&plan.operationId===descriptor.operation.id&&plan.sessionId===request.browser.successorSessionId
  &&plan.directory===options.directoryRoot+'/'+plan.sessionId&&plan.unit==='nova-browser-'+plan.sessionId
  &&plan.originalSha256===sha256(Buffer.from(canonicalBrowser(original)+'\n'))&&response.planSha256===sha256(canonicalBrowser(plan))
  &&same(plan.node,options.node)&&same(plan.executable,options.executable)&&plan.playwrightSha256===options.playwright.sha256
  &&plan.memoryMaxBytes===2*1024**3&&plan.hostReserveBytes===2147483648
  &&response.memoryAdmission?.requiredBytes===4*1024**3&&Number.isSafeInteger(response.memoryAdmission?.availableBytes)
  &&response.memoryAdmission.availableBytes>=response.memoryAdmission.requiredBytes,'browser-window-recovery-remote-readiness-changed');
 if(requireUnmaterialized)assertBrowserWindowRecoveryUnmaterialized(journal,request.browser.successorSessionId);
 return proof;
}
