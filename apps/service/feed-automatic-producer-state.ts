import {z} from 'zod';
import {createHash} from 'node:crypto';
import {feedStartPreparationSchema,feedStartV3Schema} from '../../packages/domain/news-feed-semantic-protocol.js';
import {adaptiveApplyCommandSchema} from '../../packages/domain/news-feed-adaptive-commands.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';

export const producerKey='news:automatic-producer:v1';
export const producerSlotBytes=16384,producerReceiptBytes=2048;
const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),positive=natural.min(1);
const kinds=['claim','save-preparation','intent-start','save-admission','intent-apply','release'] as const;
export type ProducerTransitionKind=typeof kinds[number];
const phase=z.enum(['preparing','prepared','starting','admitted','applying']);
export type ProducerPhase=z.infer<typeof phase>;
const story=z.object({id:sha,revision:positive,sourceId:z.string().min(1).max(200),sourceDigest:sha}).strict();
const candidate=z.object({inputSha256:sha,sourceSha256:sha,contextSha256:sha,basisSha256:sha,groupSha256:sha.optional(),story:story.optional()}).strict();
const ids=z.object({claim:uuid,savePreparation:uuid,intentStart:uuid,saveAdmission:uuid,intentApply:uuid,release:uuid}).strict();
const seedShape={jobId:uuid,deviceId:uuid,epoch:uuid,kind:z.enum(['learn','classify']),candidate,descriptor:feedStartPreparationSchema,
 transitionIds:ids,applicationId:uuid.optional()};
const seedSchema=z.object(seedShape).strict();
export type ProducerSeed=z.infer<typeof seedSchema>;
const admissionSchema=z.object({kind:z.enum(['worker','local-disposition']),requestId:uuid,receiptSha256:sha}).strict();
export type ProducerAdmission=z.infer<typeof admissionSchema>;
export const producerReleaseSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('local-disposition'),disposition:z.enum(['closed-before-admission','refused-before-admission']),originalId:uuid,requestSha256:sha,recordSha256:sha,receiptSha256:sha}).strict(),
 z.object({kind:z.literal('worker-terminal'),originalId:uuid,originalReceiptSha256:sha,terminalSha256:sha}).strict(),
 z.object({kind:z.literal('applied-learning'),originalId:uuid,originalReceiptSha256:sha,terminalSha256:sha,applicationId:uuid,applicationReceiptSha256:sha,beforeSha256:sha,afterSha256:sha}).strict(),
]);
export type ProducerRelease=z.infer<typeof producerReleaseSchema>;
const jobSchema=z.object({...seedShape,baseRevision:natural,claimPriorStateSha256:sha,phase,command:feedStartV3Schema.optional(),
 admission:admissionSchema.optional(),application:adaptiveApplyCommandSchema.optional()}).strict();
export type ProducerJob=z.infer<typeof jobSchema>;
const lastSchema=z.object({requestId:uuid,jobId:uuid,kind:z.enum(kinds)}).strict();
const stateSchema=z.object({format:z.literal(1),revision:positive,pending:jobSchema.nullable(),
 checkpoint:z.object({job:jobSchema,releaseFromPhase:phase,releaseProof:producerReleaseSchema}).strict().nullable(),lastTransition:lastSchema}).strict();
export type ProducerState=z.infer<typeof stateSchema>;
const base={format:z.literal(1),requestId:uuid,epoch:uuid,expectedRevision:natural,expectedSha256:sha};
export const producerTransitionSchema=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('claim'),seed:seedSchema}).strict(),
 z.object({...base,kind:z.literal('save-preparation'),command:feedStartV3Schema}).strict(),
 z.object({...base,kind:z.literal('intent-start'),command:feedStartV3Schema}).strict(),
 z.object({...base,kind:z.literal('save-admission'),command:feedStartV3Schema,admission:admissionSchema}).strict(),
 z.object({...base,kind:z.literal('intent-apply'),application:adaptiveApplyCommandSchema}).strict(),
 z.object({...base,kind:z.literal('release'),releaseFromPhase:phase,releaseProof:producerReleaseSchema}).strict(),
]);
export type ProducerTransition=z.infer<typeof producerTransitionSchema>;
export const producerReadSchema=z.object({format:z.literal(1),epoch:uuid}).strict();
export const producerReconcileSchema=z.object({...base,kind:z.enum(['save-admission','release'])}).strict();
export const producerReceiptSchema=z.object({format:z.literal(1),type:z.literal('feed-automatic-transition'),requestId:uuid,jobId:uuid,deviceId:uuid,epoch:uuid,
 kind:z.enum(kinds),fromPhase:z.enum(['idle','preparing','prepared','starting','admitted','applying']),toPhase:z.enum(['idle','preparing','prepared','starting','admitted','applying']),
 fromRevision:natural,toRevision:positive,beforeSha256:sha,afterSha256:sha,originalId:uuid,commandSha256:sha.optional(),releaseProof:producerReleaseSchema.optional()}).strict();
export type ProducerReceipt=z.infer<typeof producerReceiptSchema>;

/** Counts explicit logical allocations. Inputs here are already owned JSON:
 * Store captures raw descriptors, SQL reader parses after token reservation.
 * Three canonical representations plus key/projection slots precede children. */
export class ProducerWork{
 private readonly canonicalMemo:WeakMap<object,string>;
 constructor(readonly budget:MutationPlanBudget){this.slots(1,128);this.canonicalMemo=new WeakMap();}
 need(ok:unknown,message:string):asserts ok{if(!ok)this.budget.fail(Error(message));}
 slots(count=1,bytes=32){for(let i=0;i<count;i++)this.budget.entry();this.budget.reserveBytes(bytes);}
 child<T>(input:unknown,fn:()=>T):T{return this.budget.checked(()=>{
  this.slots(2,64);const stack:unknown[]=[input];let fields=1;
  while(stack.length){const value=stack.pop();if(value&&typeof value==='object')for(const key in value)if(Object.hasOwn(value,key)){
   this.slots(1,32);fields++;const child=(value as any)[key];if(child&&typeof child==='object'){this.slots(1,8);stack.push(child);}
  }}
  const bytes=historyJsonBytes(input,this.budget.limits.bytes);this.slots(fields*4+8,bytes*6+256);return fn();
 });}
 hash(input:unknown){return this.budget.checked(()=>{
  // The memo is private to this Work and original budget. A subtree enters it
  // only after every object in that subtree proved frozen during traversal.
  // Mutable wrappers still traverse; no reader facts or permissions are cached.
  this.slots(3,256);const hash=createHash('sha256');
  const scalar=(value:unknown)=>{let length=0;
   if(typeof value==='string'){length=2;for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);length+=n===34||n===92?2:n<32||n>=0xd800&&n<=0xdfff?6:1;}}
   else if(value===null)length=4;else if(typeof value==='boolean')length=5;else if(typeof value==='number'&&Number.isFinite(value))length=32;else this.need(false,'Producer hash requires JSON');
   this.slots(1,length*6+32);return JSON.stringify(value)!;
  };
  type Frame={value:any;keys:string[]|null;index:number;length:number;parts:string[];units:number;frozen:boolean};
  this.slots(1,32);const stack:Frame[]=[];let result='';
  const append=(text:string,frozen:boolean)=>{const parent=stack[stack.length-1];if(!parent){result=text;return;}
   this.slots(1,16);parent.parts.push(text);parent.units+=text.length;parent.frozen&&=frozen;
   this.need(Number.isSafeInteger(parent.units),'Producer canonical length overflow');};
  const enter=(value:any)=>{
   if(value===null||typeof value!=='object'){append(scalar(value),true);return;}
   const memo=this.canonicalMemo.get(value);if(memo!==undefined){this.slots(1,16);append(memo,true);return;}
   let count=0;const array=Array.isArray(value);if(array)count=value.length;else for(const key in value)if(Object.hasOwn(value,key))count++;
   this.slots(4+(array?0:count),192+count*16);const keys=array?null:Object.keys(value).sort((a,b)=>a.localeCompare(b));
   stack.push({value,keys,index:0,length:count,parts:[array?'[':'{'],units:1,frozen:Object.isFrozen(value)});
  };
  enter(input);
  while(stack.length){const top=stack[stack.length-1]!;if(top.index===top.length){
    this.slots(2,16+(top.units+1)*2+32);top.parts.push(top.keys?'}':']');const text=top.parts.join('');stack.pop();
    if(top.frozen){this.slots(1,96+text.length*2);this.canonicalMemo.set(top.value,text);}append(text,top.frozen);continue;}
   if(top.index){this.slots(1,16);top.parts.push(',');top.units++;}const index=top.index++;
   if(!top.keys)this.slots(1,64);const key=top.keys?top.keys[index]!:String(index);
   if(top.keys){const escaped=scalar(key);this.slots(2,32);top.parts.push(escaped,':');top.units+=escaped.length+1;}
   this.slots(1,96);const descriptor=Object.getOwnPropertyDescriptor(top.value,key);
   // A frozen accessor is not immutable data. It can compute a different
   // value later even when the containing object and returned child freeze.
   const data=descriptor!==undefined&&Object.hasOwn(descriptor,'value');top.frozen&&=data;
   enter(data?descriptor!.value:top.value[key]);
  }
  this.slots(1,result.length*3+64);hash.update(result);
  this.slots(1,128);return hash.digest('hex');
 });}
 equal(a:unknown,b:unknown){return this.budget.checked(()=>{
  this.slots(2,64);const left:unknown[]=[a],right:unknown[]=[b];
  const json=(x:unknown)=>x===null||typeof x==='object'||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x);
  while(left.length){const x=left.pop(),y=right.pop();this.need(json(x)&&json(y),'Producer equality requires JSON');
   if(x===null||y===null||typeof x!=='object'||typeof y!=='object'){if(x!==y)return false;continue;}
   const array=Array.isArray(x);if(array!==Array.isArray(y))return false;
   if(array){if((x as unknown[]).length!==(y as unknown[]).length)return false;
    for(let i=0;i<(x as unknown[]).length;i++){this.slots(2,16);left.push((x as any)[i]);right.push((y as any)[i]);}
   }else{let nx=0,ny=0;for(const key in x)if(Object.hasOwn(x,key)){nx++;if(!Object.hasOwn(y,key))return false;this.slots(2,16);left.push((x as any)[key]);right.push((y as any)[key]);}
    for(const key in y)if(Object.hasOwn(y,key))ny++;if(nx!==ny)return false;}
  }return true;
 });}
 intent(command:ProducerTransition){this.slots(1,64);return {type:'feed-automatic-transition' as const,command};}
 parseCommand(raw:unknown){const c=this.budget.copy(this.child(raw,()=>producerTransitionSchema.parse(raw)));
  if(c.kind==='claim')this.seed(c.seed);else if('command'in c)this.need(c.command.kind==='learn'||c.command.kind==='classify','Producer start kind unsupported');return c;}
 seed(s:ProducerSeed){
  this.need(s.kind===s.descriptor.kind&&s.jobId===s.descriptor.requestId&&s.epoch===s.descriptor.epoch,'Producer descriptor identity');
  this.need(s.kind==='learn'?!!s.applicationId&&!s.candidate.story&&!s.candidate.groupSha256:!s.applicationId&&!!s.candidate.story&&!!s.candidate.groupSha256,'Producer candidate kind');
  if(s.kind==='classify')this.need(this.equal(s.candidate.story,(s.descriptor as any).story),'Producer story identity');
  this.slots(8,320);const values=[s.jobId,s.transitionIds.claim,s.transitionIds.savePreparation,s.transitionIds.intentStart,s.transitionIds.saveAdmission,s.transitionIds.intentApply,s.transitionIds.release];
  if(s.applicationId){this.slots(1,40);values.push(s.applicationId);}
  for(let i=0;i<values.length;i++)for(let j=0;j<i;j++)this.need(values[i]!==values[j],'Producer IDs must be distinct');
 }
 job(j:ProducerJob){this.seed(j);
  this.need((j.phase==='preparing')===(j.command===undefined),'Producer phase command');
  this.need((j.phase==='admitted'||j.phase==='applying')===(j.admission!==undefined),'Producer phase admission');
  this.need((j.phase==='applying')===(j.application!==undefined),'Producer phase application');
  if(j.command){this.slots(9,512);const {expectedRevision,expectation,...descriptor}=j.command;this.need(this.equal(descriptor,j.descriptor),'Producer prepared descriptor changed');}
  if(j.admission)this.need(j.admission.requestId===j.jobId,'Producer admission original changed');
  if(j.application)this.need(j.kind==='learn'&&j.admission?.kind==='worker'&&j.application.requestId===j.applicationId&&j.application.operationId===j.jobId&&j.application.epoch===j.epoch,'Producer application identity');
 }
 state(raw:unknown):ProducerState{const s=this.budget.copy(this.child(raw,()=>stateSchema.parse(raw)));
  this.need((s.pending===null)!==(s.checkpoint===null),'Producer pending/checkpoint strict union');
  const job=s.pending??s.checkpoint!.job;this.job(job);
  if(s.checkpoint){this.need(s.checkpoint.releaseFromPhase===job.phase,'Producer release phase changed');this.release(job,s.checkpoint.releaseProof);}
  this.need(s.lastTransition.jobId===job.jobId&&s.lastTransition.requestId===transitionId(job,s.lastTransition.kind),'Producer last transition identity');
  const remaining=s.pending?remainingTransitions(s.pending.phase):0;this.need(s.revision<=Number.MAX_SAFE_INTEGER-remaining,'Producer revision exhausted');return s;
 }
 release(j:ProducerJob,p:ProducerRelease){this.need(j.command&&p.originalId===j.jobId,'Producer release original');
  if(p.kind==='local-disposition')this.need(j.phase==='prepared'||j.phase==='starting'||j.phase==='admitted'&&j.admission?.kind==='local-disposition','Producer local release phase');
  else if(p.kind==='worker-terminal')this.need(j.phase==='starting'||j.phase==='admitted'&&j.admission?.kind==='worker','Producer terminal release phase');
  else this.need(j.kind==='learn'&&j.phase==='applying'&&p.applicationId===j.applicationId,'Producer application release phase');
 }
 seedOf(j:ProducerJob):ProducerSeed{this.slots(16,768);const {phase,command,admission,application,baseRevision,claimPriorStateSha256,...seed}=j;return seed;}
 replay(raw:unknown,c:ProducerTransition,owner:string){
  const value=this.child(raw,()=>producerReceiptSchema.parse(raw));this.slots(18,1024);
  const jobId=c.kind==='claim'?c.seed.jobId:'command'in c?c.command.requestId:c.kind==='intent-apply'?c.application.operationId:c.releaseProof.originalId;
  const fromPhase=c.kind==='claim'?'idle':c.kind==='save-preparation'?'preparing':c.kind==='intent-start'?'prepared':c.kind==='save-admission'?'starting':c.kind==='intent-apply'?'admitted':c.releaseFromPhase;
  const toPhase=c.kind==='claim'?'preparing':c.kind==='save-preparation'?'prepared':c.kind==='intent-start'?'starting':c.kind==='save-admission'?'admitted':c.kind==='intent-apply'?'applying':'idle';
  this.need(c.expectedRevision<Number.MAX_SAFE_INTEGER,'Producer replay revision exhausted');
  const expected={format:1,type:'feed-automatic-transition',requestId:c.requestId,jobId,deviceId:owner,epoch:c.epoch,kind:c.kind,fromPhase,toPhase,
   fromRevision:c.expectedRevision,toRevision:c.expectedRevision+1,beforeSha256:c.expectedSha256,afterSha256:value.afterSha256,originalId:jobId,
   ...('command'in c?{commandSha256:this.hash(c.command)}:'application'in c?{commandSha256:this.hash(c.application)}:{}),...(c.kind==='release'?{releaseProof:c.releaseProof}:{})};
  this.need(this.equal(value,expected),'Producer replay result identity changed');
  // Without an evicted capsule afterSha256 is only the immutable historical
  // receipt's commitment. This result grants no current-slot/effect authority.
  return value;
 }
 reduce(before:ProducerState|undefined,c:ProducerTransition,owner:string):ProducerState{
  this.need(c.expectedRevision===(before?.revision??0)&&c.expectedSha256===this.hash(before??null),'Producer predecessor changed');
  const prior=before?.pending;let job:ProducerJob;this.slots(4,512);
  if(c.kind==='claim'){
   this.need(!prior&&c.seed.deviceId===owner&&c.seed.epoch===c.epoch&&c.requestId===c.seed.transitionIds.claim,'Producer claim owner or phase');
   job={...c.seed,baseRevision:c.expectedRevision,claimPriorStateSha256:c.expectedSha256,phase:'preparing'};
  }else{
   this.need(prior&&prior.deviceId===owner&&prior.epoch===c.epoch&&transitionId(prior,c.kind)===c.requestId,'Producer current job identity');job={...prior!};
   if(c.kind==='save-preparation'){this.need(job.phase==='preparing','Producer preparation phase');job={...job,phase:'prepared',command:c.command};}
   if(c.kind==='intent-start'){this.need(job.phase==='prepared'&&this.equal(job.command,c.command),'Producer start phase');job={...job,phase:'starting'};}
   if(c.kind==='save-admission'){this.need(job.phase==='starting'&&this.equal(job.command,c.command),'Producer admission phase');job={...job,phase:'admitted',admission:c.admission};}
   if(c.kind==='intent-apply'){this.need(job.phase==='admitted'&&job.kind==='learn'&&job.admission?.kind==='worker','Producer apply phase');job={...job,phase:'applying',application:c.application};}
   if(c.kind==='release'){this.need(job.phase===c.releaseFromPhase,'Producer release predecessor');this.release(job,c.releaseProof);}
  }
  this.need(c.expectedRevision<Number.MAX_SAFE_INTEGER,'Producer revision exhausted');this.job(job);
  const result:ProducerState={format:1,revision:c.expectedRevision+1,pending:c.kind==='release'?null:job,
   checkpoint:c.kind==='release'?{job,releaseFromPhase:job.phase,releaseProof:c.releaseProof}:null,lastTransition:{requestId:c.requestId,jobId:job.jobId,kind:c.kind}};
  this.need(result.revision<=Number.MAX_SAFE_INTEGER-(result.pending?remainingTransitions(job.phase):0),'Producer revision exhausted');historyJsonBytes(result,producerSlotBytes);return result;
 }
 receipt(before:ProducerState|undefined,after:ProducerState,c:ProducerTransition):ProducerReceipt{
  const job=after.pending??after.checkpoint!.job;this.slots(4,512);
  const value:ProducerReceipt={format:1,type:'feed-automatic-transition',requestId:c.requestId,jobId:job.jobId,deviceId:job.deviceId,epoch:job.epoch,kind:c.kind,
   fromPhase:before?.pending?.phase??'idle',toPhase:after.pending?.phase??'idle',fromRevision:c.expectedRevision,toRevision:after.revision,
   beforeSha256:c.expectedSha256,afterSha256:this.hash(after),originalId:job.jobId,
   ...('command'in c?{commandSha256:this.hash(c.command)}:'application'in c?{commandSha256:this.hash(c.application)}:{}),
   ...(c.kind==='release'?{releaseProof:c.releaseProof}:{})};historyJsonBytes(value,producerReceiptBytes);return value;
 }
}
export function transitionId(j:ProducerSeed,kind:ProducerTransitionKind):string{switch(kind){case'claim':return j.transitionIds.claim;case'save-preparation':return j.transitionIds.savePreparation;case'intent-start':return j.transitionIds.intentStart;case'save-admission':return j.transitionIds.saveAdmission;case'intent-apply':return j.transitionIds.intentApply;case'release':return j.transitionIds.release;}}
export function remainingTransitions(phase:ProducerPhase){switch(phase){case'preparing':return 5;case'prepared':return 4;case'starting':return 3;case'admitted':return 2;case'applying':return 1;}}
