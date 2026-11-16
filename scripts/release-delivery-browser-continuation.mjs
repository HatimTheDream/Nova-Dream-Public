/** A linked browser attempt preserves the expired predecessor and never rewrites its clock. */
import {resolve,join} from 'node:path';
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
 return{...base,sessionId:browser.successorSessionId,browserPredecessor:{original:browser.predecessor,status:browser.status},publicationContinuation:{request:grant.request,issuedAtMs:grant.issuedAtMs,expiresAtMs:grant.expiresAtMs}};
}
export function verifyLinkedBrowserRecord(original){
 const b=original.binding;if(!b.sessionId)return original;
 const {sessionId,browserPredecessor,publicationContinuation,...base}=b;
 need(exact(browserPredecessor,['original','status'])&&exact(publicationContinuation,['request','issuedAtMs','expiresAtMs'])&&ref(publicationContinuation.request),'browser-successor-record-invalid');
 const {prior}=verifyBrowserPredecessor({predecessor:browserPredecessor.original,status:browserPredecessor.status,successorSessionId:sessionId},base);
 need(Number.isSafeInteger(original.startedAtMs)&&original.startedAtMs>=prior.deadlineAtMs&&original.startedAtMs>=publicationContinuation.issuedAtMs&&original.deadlineAtMs===original.startedAtMs+b.options.timeoutMs&&original.deadlineAtMs<=publicationContinuation.expiresAtMs,'browser-successor-attempt-clock-changed');
 readEvidenceFile(publicationContinuation.request);return original;
}
