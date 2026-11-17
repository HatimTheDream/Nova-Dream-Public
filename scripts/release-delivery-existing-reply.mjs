/** Explicit reobservation of one previously accepted reply; never sends a prompt. */
import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {verifyAssistantReady,verifySavedAssistantReply} from './release-delivery-assistant.mjs';
const need=(v,r)=>{if(!v)throw Error(r);};
const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().min(1).max(4096),sha256:hash}).strict();
export const EXISTING_REPLY_MODE='existing-saved-reply-observation';
export const existingAssistantReplySchema=z.object({kind:z.literal('nova-existing-saved-reply-observation'),originalReceipt:ref,originalInstallation:ref,originalBrowserInput:ref,session:ref,conversation:ref,submission:ref,savedReply:ref}).strict();
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>sha256(canonical(v));
const read=r=>JSON.parse(readEvidenceFile(ref.parse(r),{maximum:2*1024**2}));
export function existingReplyOriginal(raw,{profile=null}={}){
 const request=existingAssistantReplySchema.parse(raw),accepted=read(request.originalReceipt),browser=read(request.originalBrowserInput),installed=read(request.originalInstallation);
 need(z.uuid().safeParse(accepted.key).success&&z.uuid().safeParse(browser.operationId).success,'existing-reply-original-identity-invalid');
 const session=read(request.session),conversation=read(request.conversation).conversation,submission=read(request.submission),saved=read(request.savedReply);
 need(accepted.kind==='nova-delivery-saved-assistant-reply'&&!accepted.acceptanceMode&&same(browser.assistant,accepted)&&browser.installed.route==='full','existing-reply-original-acceptance-required');
 need(installed.kind==='maintained-installed-acceptance-identity'&&installed.operationId===browser.operationId&&same(installed.health,browser.installed.installedHealth),'existing-reply-original-installation-changed');
 need(accepted.inputSha256===digest(browser.installed)&&Number.isSafeInteger(accepted.originalDeadlineAtMs)&&accepted.originalDeadlineAtMs>0,'existing-reply-original-input-changed');
 const proof=verifySavedAssistantReply(saved.evidence,{input:browser.installed,session,conversation,submission:submission.requestBody,expectedReply:'Nova verification '+accepted.key+' passed.',originalOperationId:submission.operationId});
 need(same(saved,{...proof,evidence:saved.evidence})&&same(accepted,{format:1,kind:'nova-delivery-saved-assistant-reply',operationId:browser.operationId,key:accepted.key,inputSha256:digest(browser.installed),originalDeadlineAtMs:accepted.originalDeadlineAtMs,...proof}),'existing-reply-original-proof-changed');
 const operation=saved.evidence.operation,currentConversation=saved.evidence.ready.state.conversations.find(c=>c.id===proof.conversationId);
 need(currentConversation&&typeof operation.accountSelection?.profileId==='string'&&operation.accountSelection.profileId.length>0&&typeof operation.accountSelection.label==='string'&&operation.accountSelection.label.length>0&&same(currentConversation.accountSelection,operation.accountSelection),'existing-reply-original-account-required');
 need(session.sessionReference?.sha256===session.sessionSha256,'existing-reply-original-session-changed');
 if(profile)need(profile.previousDelivery?.operationId===browser.operationId&&same(profile.previousDelivery.assistantReceipt,request.originalReceipt)&&same(profile.accepted.identity,request.originalInstallation),'existing-reply-profile-lineage-changed');
 return {request,accepted,browser,installed,session,conversation:currentConversation,submission,operation,history:saved.evidence.history};
}
export function verifyExistingReplyEvidence(evidence,input,{parentKey,observationKey,startedAtMs,deadlineAtMs}){
 const original=existingReplyOriginal(input.existingAssistantReply);
 need(input.route==='full'&&input.installedHealth.epoch===original.browser.installed.installedHealth.epoch&&input.installedHealth.candidateId!==original.installed.candidateId,'existing-reply-new-installation-required');
 need(evidence?.format===1&&evidence.kind==='nova-existing-reply-observation'&&evidence.operationId===input.operationId&&evidence.parentKey===parentKey&&evidence.observationKey===observationKey&&evidence.inputSha256===digest(input)&&evidence.deadlineAtMs===deadlineAtMs,'existing-reply-observation-binding-changed');
 need(Number.isSafeInteger(evidence.startedAtMs)&&Number.isSafeInteger(evidence.finishedAtMs)&&evidence.startedAtMs>=startedAtMs&&evidence.finishedAtMs>=evidence.startedAtMs&&evidence.finishedAtMs<deadlineAtMs,'existing-reply-observation-time-invalid');
 need(evidence.sessionSha256===original.session.sessionSha256&&evidence.deviceId===original.session.deviceId&&evidence.httpMethods?.length===1&&evidence.httpMethods[0]==='GET'&&evidence.sessionCreated===false&&evidence.inferenceDispatched===false,'existing-reply-observation-effects-invalid');
 const retained=verifyAssistantReady(evidence.before,input,null,{initial:true,full:true});verifyAssistantReady(evidence.after,input,retained,{initial:true,full:true});
 for(const ready of [evidence.before,evidence.after]){
  const ops=ready.state.operations.filter(o=>o.id===original.operation.id),conversations=ready.state.conversations.filter(c=>c.id===original.conversation.id);
  need(ops.length===1&&same(ops[0],original.operation),'existing-reply-historical-operation-changed');
  need(conversations.length===1&&['id','nativeId','nativeKey','revision','connectionGeneration','permissionMode','projectId','state','accountSelection'].every(k=>same(conversations[0][k],original.conversation[k]))&&!conversations[0].archived&&!conversations[0].deleted&&!conversations[0].pendingSettings,'existing-reply-conversation-changed');
 }
 const account=evidence.accounts,selection=original.operation.accountSelection;
 need(account?.state==='available'&&Array.isArray(account.accounts)&&account.accounts.length<=100&&account.profileCount===account.accounts.length&&new Set(account.accounts.map(a=>a.profileId)).size===account.accounts.length&&Number.isSafeInteger(account.checkedAt)&&account.checkedAt<=evidence.finishedAtMs&&evidence.finishedAtMs-account.checkedAt<30000,'existing-reply-fresh-accounts-required');
 const matching=account.accounts.filter(a=>a.profileId===selection.profileId);need(matching.length===1&&matching[0].label===selection.label&&matching[0].health!=='reconnect'&&!matching[0].duplicateOf,'existing-reply-account-changed');
 const historyCoverage=verifyExistingReplyHistory(evidence.history,original);
 return {original,connectionGeneration:retained.connectionGeneration,accountProfileId:selection.profileId,accountCheckedAt:account.checkedAt,historyCoverage};
}
/** Retained history proves saved content, never a current native idle state. */
export function verifyExistingReplyHistory(history,original){
 const accepted=original.accepted;
 need(history?.conversationId===accepted.conversationId&&history.nativeId===accepted.nativeId&&Array.isArray(history.messages)&&!history.inFlightRun&&!history.messages.some(m=>m.role==='tool'),'existing-reply-current-history-invalid');
 const matches=history.messages.filter(m=>m.id===accepted.savedMessageId);
 need(matches.length===1&&matches[0].role==='assistant'&&sha256(matches[0].text?.trim()??'')===accepted.replySha256,'existing-reply-exact-message-changed');
 if(history.activeRunIds===null){
  const transcript=history.transcript,bindings=transcript?.bindings?.filter(b=>b.nativeId===accepted.nativeId);
  need(history.retained?.complete===true&&transcript?.complete===true&&transcript.conflicts===0&&!transcript.bindingUnavailable&&bindings?.length===1&&bindings[0].complete===true&&bindings[0].status==='complete','existing-reply-retained-transcript-incomplete');
  need(matches[0].runId===accepted.nativeRunId&&matches[0].operationId===accepted.operationId,'existing-reply-retained-message-binding-changed');
  return {nativeRunActivityCoverage:'unverified-retained-history'};
 }
 need(Array.isArray(history.activeRunIds)&&history.activeRunIds.length===0,'existing-reply-current-history-not-idle');
 need(matches[0].runId===accepted.nativeRunId||matches[0].operationId===accepted.operationId,'existing-reply-exact-message-changed');return {};
}
export function existingReplyOutput(evidence,input,observationReceipt,clocks){
 const checked=verifyExistingReplyEvidence(evidence,input,clocks),old=checked.original.accepted;
 return {...old,acceptanceMode:EXISTING_REPLY_MODE,deliveryOperationId:input.operationId,observationInput:input,observationKey:clocks.parentKey,observationChildKey:clocks.observationKey,inputSha256:digest(input),originalDeadlineAtMs:clocks.deadlineAtMs,originalAcceptance:input.existingAssistantReply.originalReceipt,observationReceipt,observationStartedAtMs:clocks.startedAtMs,observedConnectionGeneration:checked.connectionGeneration,observedAccountProfileId:checked.accountProfileId,observedAccountCheckedAt:checked.accountCheckedAt,...checked.historyCoverage};
}
export function verifyExistingReplyAcceptance(output,input){
 need(output?.acceptanceMode===EXISTING_REPLY_MODE&&input.existingAssistantReply,'existing-reply-explicit-mode-required');
 const evidence=read(output.observationReceipt),expected=existingReplyOutput(evidence,input,output.observationReceipt,{parentKey:output.observationKey,observationKey:output.observationChildKey,startedAtMs:output.observationStartedAtMs,deadlineAtMs:output.originalDeadlineAtMs});
 need(same(output,expected),'existing-reply-acceptance-changed');return output;
}
export function existingReplyCoverage(output){return output?.acceptanceMode===EXISTING_REPLY_MODE?{assistantAcceptanceMode:EXISTING_REPLY_MODE,...(output.nativeRunActivityCoverage===undefined?{}:{nativeRunActivityCoverage:output.nativeRunActivityCoverage})}:{};}
