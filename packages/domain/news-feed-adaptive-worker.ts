import {z} from 'zod';
import {captureAdaptiveOriginal,adaptivePrompt,readAdaptiveOutput,adaptiveWorkerBounds,type AdaptiveCaptured,type AdaptiveAuthority,type AdaptiveNativePolicy} from './news-feed-adaptive-capture.js';
import {adaptiveHash} from './news-feed-adaptive.js';
import {feedStartV3Schema,feedStopV3Schema,type FeedStartV3} from './news-feed-semantic-protocol.js';
import type {FeedStory} from './news-feed.js';
import {workerReceiptSchema,type WorkerIdentity,type WorkerReceipt} from './worker.js';
import {evidenceLimits,evidenceDigest,terminalProofSchema,deriveFeedTerminal,type TerminalProof} from './news-feed-adaptive-worker-evidence.js';

export const feedWorkerPrefix='news:semantic-adaptive-worker:';
export const feedWorkerLimits={records:512,bytes:8*1024*1024,reservedResultBytes:evidenceLimits.reservationBytes,
 deadlineMs:180000,rpcMs:90000,inputBytes:131072,resultBytes:32768,serializedOutputBytes:65536,receiptBytes:4096} as const;
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),instant=z.number().int().positive();
const text=z.string().min(1).max(200);
export const routeSchema=z.object({accountKey:text,provider:text,model:text}).strict();
export const commandSchema=feedStartV3Schema;
export type Command=FeedStartV3;
export const ownerStopCommandSchema=feedStopV3Schema;
export type OwnerStopCommand=z.infer<typeof ownerStopCommandSchema>;
export const feedWorkerIntent=(command:Command)=>({type:'feed-semantic-worker',command});
export const feedStopIntent=(command:OwnerStopCommand)=>({type:'feed-semantic-stop',...command});
export const feedWorkerOriginal=(v:FeedWorkerSaved)=>({id:v.id,deviceId:v.deviceId,command:v.command,capture:v.capture,policy:v.policy,
 route:v.route,generation:v.generation,createdAt:v.createdAt,deadlineAt:v.deadlineAt,prompt:v.prompt,inputHash:v.inputHash});
export const feedWorkerReceipt=(value:FeedWorkerSaved,hash:(text:string)=>string)=>({type:'feed-semantic-worker' as const,format:3 as const,id:value.id,
 epoch:value.command.epoch,inputHash:value.inputHash,originalSha256:evidenceDigest(feedWorkerOriginal(value),hash),requestSha256:evidenceDigest({kind:'start',command:value.command},hash)});
export const feedStopReceipt=(command:OwnerStopCommand,at:number,hash:(text:string)=>string)=>({type:'feed-semantic-stop' as const,format:3 as const,id:command.requestId,epoch:command.epoch,operationId:command.id,at,requestSha256:evidenceDigest({kind:'stop',command},hash)});
export type Route=z.infer<typeof routeSchema>;
export type FeedWorkerAuthority=AdaptiveAuthority;
export type Capture=AdaptiveCaptured;
export interface FeedWorkerSources {current(deviceId:string):AdaptiveAuthority;story(id:string):FeedStory|undefined;}
export type State='prepared'|'dispatching'|'running'|'unknown'|'completed'|'failed'|'cancelled'|'withdrawn'|'rejected';
export type Stop={reason:'owner'|'deadline'|'context';requestId:string;requestedAt:number;
 attemptedAt?:number;state:'requested'|'dispatching'|'acknowledged'|'unknown';abort?:{attemptedAt:number;state:'dispatching'|'acknowledged'|'unknown'}};
export type FeedWorkerSaved={format:3;revision:number;id:string;deviceId:string;command:Command;capture:Capture;policy:AdaptiveNativePolicy;route:Route;generation:string;
 createdAt:number;deadlineAt:number;prompt:string;inputHash:string;state:State;reason:string;
 originalReceipt?:WorkerReceipt;latestReceipt?:WorkerReceipt;hostId?:string;runtimeVersion?:string;runId?:string;sessionKey?:string;dispatchAt?:number;stop?:Stop;
 ownerStops:{command:OwnerStopCommand;deviceId:string;at:number}[];
 output?:{text?:string;sha256:string;bytes:number};terminal?:TerminalProof;
 events:{kind:string;at:number}[]};
const stopSchema=z.object({reason:z.enum(['owner','deadline','context']),requestId:uuid,requestedAt:instant,
 attemptedAt:instant.optional(),state:z.enum(['requested','dispatching','acknowledged','unknown']),
 abort:z.object({attemptedAt:instant,state:z.enum(['dispatching','acknowledged','unknown'])}).strict().optional()}).strict();
const savedSchema=z.object({format:z.literal(3),revision:z.number().int().positive(),id:uuid,deviceId:text,command:commandSchema,capture:z.unknown(),policy:z.object({route:routeSchema,generation:text,qualificationId:text,configurationRevision:text}).strict(),route:routeSchema,
 generation:text,createdAt:instant,deadlineAt:instant,prompt:z.string().min(1).max(200000),inputHash:digest,
 state:z.enum(['prepared','dispatching','running','unknown','completed','failed','cancelled','withdrawn','rejected']),reason:text,
 originalReceipt:workerReceiptSchema.optional(),latestReceipt:workerReceiptSchema.optional(),hostId:uuid.optional(),runtimeVersion:text.optional(),runId:uuid.optional(),sessionKey:text.optional(),dispatchAt:instant.optional(),
 stop:stopSchema.optional(),output:z.object({text:z.string().max(32768).optional(),sha256:digest,bytes:z.number().int().min(0)}).strict().optional(),
 ownerStops:z.array(z.object({command:ownerStopCommandSchema,deviceId:text,at:instant}).strict()).max(16),
 terminal:terminalProofSchema.optional(),
 events:z.array(z.object({kind:z.string().min(1).max(48).regex(/^[a-z:-]+$/),at:instant}).strict()).min(1).max(32)}).strict();
export type FeedWorkerSummary={id:string;kind:Command['kind'];state:State;reason:string;createdAt:number;deadlineAt:number;resultText?:string};
export const terminal=(value:FeedWorkerSaved)=>['completed','failed','cancelled','withdrawn','rejected'].includes(value.state);
export const json=(value:unknown)=>JSON.stringify(value);
export const size=(value:unknown)=>new TextEncoder().encode(json(value)).byteLength;
function stable(value:unknown):unknown{
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,stable(v)]));
 return value;
}
export const same=(a:unknown,b:unknown)=>json(stable(a))===json(stable(b));
export const summary=(v:FeedWorkerSaved):FeedWorkerSummary=>({id:v.id,kind:v.command.kind,state:v.state,reason:v.reason,
 createdAt:v.createdAt,deadlineAt:v.deadlineAt,...(v.state==='completed'&&v.output?.text?{resultText:v.output.text}:{})});
export function unwrap<T>(value:{ok:true;value:T}|{ok:false;reason:string}):T{if(!value.ok)throw new Error(value.reason);return value.value;}
export const promptFor=(capture:Capture,hash:(text:string)=>string)=>adaptivePrompt(capture,hash);

/** Pure record consistency and bounded terminal derivation. The separate graph
 * validator joins original Store admissions/reviews; current authority, native
 * honesty and actual startup/import integration remain separate gates. */
export function validateFeedWorkerRecord(raw:FeedWorkerSaved,digestText:(text:string)=>string,
 nativeIdentity:(identity:WorkerIdentity)=>{runId:string;sessionKey:string}):FeedWorkerSaved{
  const value=savedSchema.parse(raw) as FeedWorkerSaved;
  const source=value.capture?.source;
  if(!same(value,raw)||size(value)>adaptiveWorkerBounds.recordBytes||value.id!==value.command.requestId||value.command.kind!==value.capture?.kind||
   value.command.epoch!==source?.context.epoch||value.deviceId!==source.context.deviceId||value.command.expectedRevision!==source.context.profile.revision||
   value.createdAt<value.command.expectation.preparedAt||value.createdAt>=value.deadlineAt||value.deadlineAt!==value.command.expectation.deadlineAt||
   value.deadlineAt-value.command.expectation.preparedAt!==feedWorkerLimits.deadlineMs||
   value.inputHash!==digestText(value.prompt)||value.prompt!==promptFor(value.capture,digestText)||new TextEncoder().encode(value.prompt).byteLength>feedWorkerLimits.inputBytes||
   !same(value.policy.route,value.route)||value.policy.generation!==value.generation||adaptiveHash(value.policy,digestText)!==value.command.expectation.nativePolicySha256)
   throw new Error('Invalid retained adaptive intent');
  const captured=captureAdaptiveOriginal(value.command,source,value.capture.basis,value.capture.kind==='classify'?value.capture.preview.story:undefined,value.command.expectation.preparedAt,digestText);
  if(!same(captured,value.capture)||adaptiveHash(value.capture,digestText)!==value.command.expectation.captureSha256||value.inputHash!==value.command.expectation.modelInputSha256)throw new Error('Original adaptive capture changed');
  if(value.dispatchAt){const identity={epoch:value.command.epoch,hostId:uuid.parse(value.hostId),attemptId:value.id,inputHash:value.inputHash},native=nativeIdentity(identity);
   if(native.runId!==value.runId||native.sessionKey!==value.sessionKey||!value.runtimeVersion)throw new Error('Invalid retained Feed worker identity');}
  else if(value.hostId||value.runId||value.sessionKey||value.runtimeVersion)throw new Error('Unqualified Feed dispatch identity');
  for(const receipt of [value.originalReceipt,value.latestReceipt])if(receipt){
   if(size(receipt)>feedWorkerLimits.receiptBytes||!value.dispatchAt||receipt.epoch!==value.command.epoch||receipt.hostId!==value.hostId||receipt.attemptId!==value.id||receipt.inputHash!==value.inputHash||
    receipt.runId!==value.runId||receipt.sessionKey!==value.sessionKey||receipt.toolMode!==undefined||receipt.nativeTools!==undefined||
    receipt.deadlineAt!==value.deadlineAt&&!(value.stop?.attemptedAt&&receipt.state==='cancelled'&&receipt.stopRequested&&receipt.deadlineAt===undefined))throw new Error('Invalid retained native receipt');
  }
  if(terminal(value)!==!!value.terminal||value.terminal?.kind==='not-sent'&&!!value.dispatchAt)throw new Error('Unqualified Feed terminal state');
  if(value.dispatchAt&&(value.dispatchAt<value.createdAt||value.dispatchAt>=value.deadlineAt)||
   ['dispatching','running','unknown'].includes(value.state)&&!value.dispatchAt||value.state==='prepared'&&!!value.dispatchAt)
   throw new Error('Unqualified dispatch phase');
  if(value.terminal){const derived=deriveFeedTerminal(value,value.terminal.basis,value.output,digestText);
   if(!same(derived,{state:value.state,reason:value.reason,terminal:value.terminal}))throw new Error('Unqualified terminal derivation');}
  if(value.stop&&((value.stop.state==='requested')!==!value.stop.attemptedAt||!value.dispatchAt&&!(value.state==='cancelled'&&value.terminal?.kind==='not-sent')||
   value.stop.abort&&!value.stop.attemptedAt))throw new Error('Unqualified original stop phase');
  const ownerIds=new Set<string>();for(const owner of value.ownerStops){
   if(owner.deviceId!==value.deviceId||owner.command.id!==value.id||owner.command.epoch!==value.command.epoch||owner.command.requestId===value.id||
    ownerIds.has(owner.command.requestId)||owner.at<value.createdAt)throw new Error('Invalid original owner stop');ownerIds.add(owner.command.requestId);}
  if(value.stop?.reason==='owner'&&!ownerIds.has(value.stop.requestId)||value.stop&&value.stop.reason!=='owner'&&value.stop.requestId!==value.id)
   throw new Error('Missing exact original stop command');
  if(value.stop?.reason==='owner'&&value.ownerStops.find(owner=>owner.command.requestId===value.stop!.requestId)?.at!==value.stop.requestedAt)
   throw new Error('Original owner stop time changed');
  if(value.output&&(size(value.output)>feedWorkerLimits.serializedOutputBytes||value.output.text!==undefined&&(digestText(value.output.text)!==value.output.sha256||new TextEncoder().encode(value.output.text).byteLength!==value.output.bytes)||
   value.output.text!==undefined&&value.output.bytes>feedWorkerLimits.resultBytes))throw new Error('Invalid retained Feed output');
  if(value.state==='completed'){
   if(value.terminal?.kind!=='reply'||value.output?.text===undefined)throw new Error('Missing completed result');
   const parsed=readAdaptiveOutput(value.output.text,value.capture,digestText);
   if(!parsed.ok)throw new Error('Unqualified completed result');
  }
  return value;
 }
