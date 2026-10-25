import {z} from 'zod';
import {canonical} from './contracts.js';
import {captureAdaptiveOriginal,readAdaptiveOutput,adaptiveWorkerBounds,type AdaptiveSource,type AdaptiveWritingSource,type AdaptiveAuthority} from './news-feed-adaptive-capture.js';
import {adaptiveHash} from './news-feed-adaptive.js';
import {workerReceiptSchema,workerStatusSchema,isSettledWorkerObservation,type WorkerStatus,type WorkerReceipt} from './worker.js';
import type {FeedWorkerSaved,FeedWorkerAuthority} from './news-feed-adaptive-worker.js';
import type {FeedStory} from './news-feed.js';

const digest=z.string().regex(/^[a-f0-9]{64}$/),instant=z.number().int().positive(),uuid=z.string().uuid();
const label=z.string().min(1).max(200),bytes=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const route=z.object({accountKey:label,provider:label,model:label}).strict();
export const evidenceLimits={basisBytes:adaptiveWorkerBounds.terminalBasisBytes,statusBytes:16384,currentContextBytes:adaptiveWorkerBounds.currentBytes,outputBytes:65536,
 reservationBytes:adaptiveWorkerBounds.terminalGrowthBytes,receiptBytes:4096,eventBytes:4096,otherGrowthBytes:32768} as const;
export const outputSchema=z.object({text:z.string().max(32768).optional(),sha256:digest,bytes}).strict();
export type Output=z.infer<typeof outputSchema>;
const observedContextSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('captured'),value:z.unknown()}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
 z.object({kind:z.literal('omitted'),reason:z.literal('input-limit'),sha256:digest,bytes:bytes.refine(value=>value>evidenceLimits.currentContextBytes)}).strict(),
]);
const currentSchema=z.object({authorized:z.literal(true),deviceId:label,epoch:uuid,route,context:observedContextSchema,generation:label,
 policySha256:digest,storySha256:digest.nullable()}).strict();
export type CurrentEvidence=z.infer<typeof currentSchema>;
const responseSchema=z.object({sha256:digest,bytes}).strict();
const basisSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('not-sent'),at:instant,reason:z.enum(['not-dispatched','not-dispatched-after-restart','cancelled-before-dispatch'])}).strict(),
 z.object({kind:z.literal('barrier'),at:instant,receipt:workerReceiptSchema}).strict(),
 z.object({kind:z.literal('observation'),at:instant,status:workerStatusSchema,response:responseSchema,
  history:z.object({sessionKey:label,limit:z.literal(1),sessionId:uuid}).strict().optional(),current:currentSchema.optional()}).strict(),
]);
export type TerminalBasis=z.infer<typeof basisSchema>;
export const terminalProofSchema=z.object({kind:z.enum(['not-sent','barrier','error','reply']),at:instant,basisSha256:digest,basis:basisSchema}).strict();
export type TerminalProof=z.infer<typeof terminalProofSchema>;
const size=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export const evidenceDigest=(v:unknown,hash:(text:string)=>string)=>hash(canonical(v));

/** Local trusted-port observation only. This does not authenticate a native
 * account/profile or establish provider honesty. The graph verifies its joins. */
export function captureCurrentEvidence(authority:FeedWorkerAuthority,generation:string,kind:unknown,story:FeedStory|undefined,hash:(text:string)=>string):CurrentEvidence{
 const source=kind==='interpret'?authority.writing:authority.source;
 const sourceBytes=source?size(source):0,context=!source?{kind:'unavailable'}:sourceBytes<=evidenceLimits.currentContextBytes?{kind:'captured',value:source}:
  {kind:'omitted',reason:'input-limit',sha256:evidenceDigest(source,hash),bytes:sourceBytes};
 return currentSchema.parse({authorized:authority.authorized,deviceId:authority.deviceId,epoch:authority.epoch,route:authority.policy.route,context,generation,
  policySha256:adaptiveHash(authority.policy,hash),storySha256:story?evidenceDigest(story,hash):null});
}
export function currentEvidenceMatches(value:FeedWorkerSaved,current:CurrentEvidence,hash:(text:string)=>string){
 if(current.context.kind!=='captured'||current.policySha256!==value.command.expectation.nativePolicySha256||!same(current.route,value.route)||current.generation!==value.generation)return false;
 try{const captured=captureAdaptiveOriginal(value.command,current.context.value as AdaptiveSource|AdaptiveWritingSource,value.capture.basis,value.capture.kind==='classify'?value.capture.preview.story:undefined,value.command.expectation.preparedAt,hash);
  return adaptiveHash(captured,hash)===value.command.expectation.captureSha256&&(value.capture.kind==='classify'?current.storySha256===evidenceDigest(value.capture.preview.story,hash):current.storySha256===null);
 }catch{return false;}
}

export function captureObservedBasis(raw:WorkerStatus,at:number,history:{sessionKey:string;limit:1;sessionId:string}|undefined,
 current:CurrentEvidence|undefined,hash:(text:string)=>string):{basis:TerminalBasis;output?:Output}{
 const exact=workerStatusSchema.parse(raw),response={sha256:evidenceDigest(exact,hash),bytes:size(exact)},status=structuredClone(exact);
 const reply=status.observation?.terminalReply;let output:Output|undefined;
 if(reply?.disposition==='visible'&&status.observation?.status==='ok'){
  const text=reply.text;output={sha256:hash(text),bytes:new TextEncoder().encode(text).byteLength};
  if(output.bytes<=32768&&size({...output,text})<=evidenceLimits.outputBytes)output.text=text;
  reply.text=''; // Exact text is retained once in output; oversized text retains its digest/count.
 }
 if(size(status)>evidenceLimits.statusBytes)throw new Error('Original Feed status metadata exceeds its retained bound');
 const basis:TerminalBasis={kind:'observation',at,status,response,...(history?{history}:{}),...(current?{current}:{})};
 if(size(basis)>evidenceLimits.basisBytes)throw new Error('Original Feed terminal basis exceeds its retained bound');
 return {basis,...(output?{output}:{})};
}

/** Reconstructs the local decision from complete bounded decision fields.
 * Raw response digest/count are diagnostic when omitted oversized text cannot
 * be reconstructed; that case is never a completed semantic result. */
export function deriveFeedTerminal(value:FeedWorkerSaved,raw:TerminalBasis,output:Output|undefined,hash:(text:string)=>string){
 const basis=basisSchema.parse(raw);if(!same(basis,raw)||size(basis)>evidenceLimits.basisBytes||basis.at<value.createdAt)throw new Error('Invalid Feed terminal basis');
 if(output){outputSchema.parse(output);if(size(output)>evidenceLimits.outputBytes||output.text!==undefined&&
  (output.bytes>32768||new TextEncoder().encode(output.text).byteLength!==output.bytes||hash(output.text)!==output.sha256))throw new Error('Invalid Feed output evidence');}
 const result=(state:'completed'|'failed'|'cancelled'|'withdrawn'|'rejected',reason:string,kind:TerminalProof['kind'])=>({state,reason,
  terminal:{kind,at:basis.at,basisSha256:evidenceDigest(basis,hash),basis} satisfies TerminalProof});
 if(basis.kind==='not-sent'){
  if(value.dispatchAt||output||basis.reason==='cancelled-before-dispatch'&&value.stop?.reason!=='owner')throw new Error('Unqualified not-sent Feed evidence');
  return result(basis.reason==='cancelled-before-dispatch'?'cancelled':'failed',basis.reason,'not-sent');
 }
 if(!value.dispatchAt||!value.originalReceipt||!value.latestReceipt)throw new Error('Missing original native receipts');
 if(basis.kind==='barrier'){
  if(!same(basis.receipt,value.latestReceipt)||basis.receipt.state!=='cancelled'||!basis.receipt.stopRequested||output)throw new Error('Invalid cancellation barrier');
  return result('cancelled','worker-cancellation','barrier');
 }
 const status=basis.status,observation=status.observation;
 if(size(status)>evidenceLimits.statusBytes||!same(status.receipt,value.latestReceipt)||!observation||observation.runId!==value.runId||!isSettledWorkerObservation(observation))
  throw new Error('Unsettled or foreign terminal evidence');
 if(observation.status==='error'){
  if(output||basis.history||basis.current||basis.response.sha256!==evidenceDigest(status,hash)||basis.response.bytes!==size(status))throw new Error('Invalid error evidence');
  return result(value.stop?'cancelled':'failed','original-worker-error','error');
 }
 const receipt=observation.terminalReceipt!,reply=observation.terminalReply;
 if(!basis.history||basis.history.sessionKey!==value.sessionKey||basis.history.sessionId!==receipt.sessionId||!basis.current||
  basis.current.context.kind==='captured'&&size(basis.current.context.value)>evidenceLimits.currentContextBytes)throw new Error('Missing exact history/current evidence');
 if(basis.current.deviceId!==value.deviceId||basis.current.epoch!==value.command.epoch||basis.current.route.accountKey!==value.route.accountKey||basis.current.generation!==value.generation)
  throw new Error('Foreign current authority observation');
 if(reply?.disposition==='visible'){
  if(reply.text!==''||!output)throw new Error('Invalid retained visible reply');
  if(output.text!==undefined){const reconstructed=structuredClone(status);(reconstructed.observation!.terminalReply as {text:string}).text=output.text;
   if(basis.response.sha256!==evidenceDigest(reconstructed,hash)||basis.response.bytes!==size(reconstructed))throw new Error('Changed original reply response');}
 }else if(output||basis.response.sha256!==evidenceDigest(status,hash)||basis.response.bytes!==size(status))throw new Error('Changed original empty response');
 if(receipt.successfulToolNames.length||receipt.sourceReplyDelivered!==false||receipt.effective.provider!==value.route.provider||receipt.effective.model!==value.route.model)
  return result('rejected','tool-delivery-or-route-unqualified','reply');
 if(value.stop||!Number.isFinite(observation.endedAt)||observation.endedAt!<value.createdAt||observation.endedAt!>value.deadlineAt||basis.at>=value.deadlineAt||
  !currentEvidenceMatches(value,basis.current,hash))return result('withdrawn','original-result-no-longer-current','reply');
 if(!output?.text)return result('rejected','result-unusable','reply');
 const parsed=readAdaptiveOutput(output.text,value.capture,hash);
 return result(parsed.ok?'completed':'rejected',parsed.ok?(value.capture.kind==='interpret'?'review-required':value.capture.kind==='learn'?'learning-application-required':'captured-classification'):'result-contract-refused','reply');
}
