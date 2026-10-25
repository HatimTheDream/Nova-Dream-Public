import {z} from 'zod';
import {canonical} from '../../../packages/domain/contracts';
import {feedCommandSchema,feedRefreshSchema,feedSettingsSchema,feedSourceSchema,feedStorySchema,feedProfileSchema,feedEvidenceSchema,
 type FeedCommand,type FeedRefreshCommand,type FeedSettings,type FeedState,type FeedStory} from '../../../packages/domain/news-feed';

type StoragePort=Pick<Storage,'getItem'|'setItem'>;
type Scope={deviceId:string;epoch:string;windowId:string};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const limit=2*1024*1024;
const rawSettingsSchema=feedSettingsSchema.omit({interests:true,exclusions:true,sources:true}).extend({
 interestsText:z.string().max(4000),exclusionsText:z.string().max(4000),
 sources:z.array(feedSourceSchema.extend({title:z.string().max(150),url:z.string().max(2048)})).max(12),
}).strict();
export type FeedSettingsWriting=z.infer<typeof rawSettingsSchema>;
export const feedSettingsWriting=(value:FeedSettings):FeedSettingsWriting=>{
 const {interests,exclusions,...rest}=value;return {...structuredClone(rest),interestsText:interests.join('\n'),exclusionsText:exclusions.join('\n')};
};
export function parseFeedSettingsWriting(value:FeedSettingsWriting):FeedSettings{
 const {interestsText,exclusionsText,...rest}=rawSettingsSchema.parse(value);
 return feedSettingsSchema.parse({...rest,interests:interestsText.split(/\r?\n/u).map(v=>v.trim()).filter(Boolean),
  exclusions:exclusionsText.split(/\r?\n/u).map(v=>v.trim()).filter(Boolean)});
}
const draftSchema=z.object({baseRevision:z.number().int().positive(),base:feedSettingsSchema,writing:rawSettingsSchema}).strict();
export type FeedSettingsDraft=z.infer<typeof draftSchema>;
const draftBookSchema=z.object({format:z.literal(1),draft:draftSchema.nullable(),comparisons:z.array(z.object({local:draftSchema,saved:feedSettingsSchema}).strict()).max(12)}).strict();
class FeedBook<T>{
 raw:string|null=null;attempted?:string;value:T;invalid=false;error='';
 constructor(protected storage:StoragePort,readonly key:string,private schema:z.ZodType<T>,empty:T){
  this.value=empty;
  try{this.raw=storage.getItem(key);if(this.raw!==null){if(this.raw.length>limit)throw Error('The kept Feed record is too large. Its original is preserved.');this.value=schema.parse(JSON.parse(this.raw));}}
  catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'The kept Feed record could not be read.';}
 }
 keep(value:T){
  if(this.invalid)return false;
  try{
   const raw=JSON.stringify(this.schema.parse(value));
   if(new TextEncoder().encode(raw).length>limit)throw Error('Feed recovery is full. Copy the complete kept writing before leaving.');
   const actual=this.storage.getItem(this.key);
   if(actual!==this.raw&&actual!==this.attempted)throw Error('This Feed record changed in another window. Keep this writing open.');
   this.attempted=raw;this.storage.setItem(this.key,raw);
   if(this.storage.getItem(this.key)!==raw)throw Error('These Feed changes are kept only in this window. Keep it open and copy them.');
   this.raw=raw;this.attempted=undefined;this.value=JSON.parse(raw);this.error='';return true;
  }catch(error){this.error=error instanceof Error?error.message:'The latest Feed changes are kept only in this window.';return false;}
 }
 copy(){return JSON.stringify({saved:this.raw,attempted:this.attempted,current:this.value},null,2);}
}
export class FeedSettingsJournal extends FeedBook<z.infer<typeof draftBookSchema>>{
 constructor(storage:StoragePort,scope:Scope){super(storage,`e3:news-settings:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,draftBookSchema,{format:1,draft:null,comparisons:[]});}
 put(draft:FeedSettingsDraft){return this.keep({...this.value,draft});}
 prepare(local:FeedSettingsDraft,state:{value:{revision:number;profile:{settings:FeedSettings}}},useSaved:boolean){
  const saved=state.value.profile.settings;
  return this.keep({...this.value,draft:{baseRevision:state.value.revision,base:saved,writing:useSaved?feedSettingsWriting(saved):local.writing},
   comparisons:[...this.value.comparisons,{local,saved}]});
 }
}
const mutationRequest=z.object({kind:z.literal('mutation'),command:feedCommandSchema}).strict();
const refreshRequest=z.object({kind:z.literal('refresh'),command:feedRefreshSchema}).strict();
const pendingSchema=z.discriminatedUnion('kind',[mutationRequest,refreshRequest]);
export type FeedPending=z.infer<typeof pendingSchema>;
const receiptBase={format:z.literal(1),requestId:z.uuid(),epoch:z.uuid(),command:feedCommandSchema,at:z.string().datetime()};
const mutationReceiptSchema=z.discriminatedUnion('state',[
 z.object({...receiptBase,state:z.literal('saved'),revision:z.number().int().positive(),profileRevision:z.number().int().positive()}).strict(),
 z.object({...receiptBase,state:z.literal('rejected'),code:z.string().min(1).max(100),message:z.string().max(2000)}).strict(),
 z.object({state:z.literal('unknown'),command:feedCommandSchema}).strict(),
]);
const refreshReceiptSchema=z.union([
 z.object({format:z.literal(1),requestId:z.uuid(),epoch:z.uuid(),deviceId:z.uuid(),command:feedRefreshSchema,source:feedSourceSchema.nullable(),
  startedAt:z.string().datetime(),deadline:z.string().datetime(),finishedAt:z.string().datetime().nullable(),state:z.enum(['running','saved','failed','unknown','withdrawn','rejected','expired']),
  message:z.string().max(2000),acceptedCount:z.number().int().nonnegative().max(200),rejectedCount:z.number().int().nonnegative().max(200)}).strict(),
 z.object({state:z.literal('unknown'),command:feedRefreshSchema}).strict(),
]);
const keptReceiptSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('mutation'),value:mutationReceiptSchema}).strict(),
 z.object({kind:z.literal('refresh'),value:refreshReceiptSchema}).strict(),
]);
export type FeedKeptReceipt=z.infer<typeof keptReceiptSchema>;
const requestBookSchema=z.object({format:z.literal(1),pending:pendingSchema.nullable(),receipt:keptReceiptSchema.nullable()}).strict();
function validateReceipt(receipt:FeedKeptReceipt,scope:Scope){
 const value=receipt.value,command=value.command;
 if(command.epoch!==scope.epoch)throw Error('The receipt belongs to another workspace.');
 if('requestId'in value&&(value.requestId!==command.requestId||value.epoch!==command.epoch))throw Error('The receipt identity changed.');
 if(receipt.kind==='mutation'&&receipt.value.state==='saved'&&receipt.value.revision!==receipt.value.command.expectedRevision+1)throw Error('The saved Feed revision is not the requested version.');
 if(receipt.kind==='refresh'&&'deviceId'in receipt.value){
  const value=receipt.value;
  if(value.deviceId!==scope.deviceId||value.source&&value.source.id!==value.command.sourceId)throw Error('The source check identity changed.');
  if(value.state!=='rejected'&&!value.source)throw Error('The admitted source identity is missing.');
  if(Date.parse(value.deadline)<=Date.parse(value.startedAt)||Date.parse(value.deadline)-Date.parse(value.startedAt)>21000)throw Error('The source check deadline changed.');
  if(['saved','failed','withdrawn','rejected'].includes(value.state)&&!value.finishedAt)throw Error('The source check result is incomplete.');
 }
}
export class FeedRequestJournal extends FeedBook<z.infer<typeof requestBookSchema>>{
 constructor(storage:StoragePort,readonly scope:Scope){super(storage,`e3:news-request:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,requestBookSchema,{format:1,pending:null,receipt:null});
  if(this.value.pending?.command.epoch!==undefined&&this.value.pending.command.epoch!==scope.epoch){this.invalid=true;this.error='The original request belongs to another workspace.';}
  try{if(this.value.receipt)validateReceipt(this.value.receipt,scope);}catch(error){this.invalid=true;this.error=error instanceof Error?error.message:'The kept receipt cannot be verified.';}
 }
 begin(pending:FeedPending){
  if(pending.command.epoch!==this.scope.epoch||this.value.pending&&!same(this.value.pending,pending)){this.error='Reconcile the original Feed request before another change.';return false;}
  return this.keep({...this.value,pending});
 }
 acknowledge(original:FeedPending,raw:unknown){
  try{
   if(!same(original,this.value.pending))throw Error('This is not the original Feed request.');
   const receipt=keptReceiptSchema.parse({kind:original.kind,value:raw}),value=receipt.value;
   validateReceipt(receipt,this.scope);
   if(!same(value.command,original.command))throw Error('The response belongs to another Feed request.');
   if('requestId'in value&&(value.requestId!==original.command.requestId||value.epoch!==original.command.epoch))throw Error('The receipt identity changed.');
   if(receipt.kind==='mutation'&&receipt.value.state==='saved'&&receipt.value.revision!==(original.command as FeedCommand).expectedRevision+1)throw Error('The saved Feed revision is not the requested version.');
   if(receipt.kind==='refresh'&&'deviceId'in receipt.value&&receipt.value.deviceId!==this.scope.deviceId)throw Error('The source check belongs to another device.');
   const pending=['unknown','running'].includes(value.state)?original:null;
   return this.keep({format:1,pending,receipt});
  }catch(error){this.error=error instanceof Error?error.message:'The original Feed request remains unconfirmed.';return false;}
 }
}
const viewSchema=z.object({format:z.literal(1),following:z.boolean(),topic:z.string().max(240),profileRevision:z.number().int().nonnegative(),
 order:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100),anchor:z.object({id:z.string().max(64),offset:z.number().finite().min(-100000).max(100000)}).nullable(),
 reader:feedStorySchema.nullable()}).strict().refine(value=>new Set(value.order).size===value.order.length,'Keep each story once in the reading order.');
export type FeedReadingView=z.infer<typeof viewSchema>;
export class FeedReadingJournal extends FeedBook<FeedReadingView>{
 constructor(storage:StoragePort,scope:Scope){super(storage,`e3:news-reading:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,viewSchema,
  {format:1,following:false,topic:'',profileRevision:0,order:[],anchor:null,reader:null});}
}
export function stableFeedEdition<T extends {story:FeedStory}>(view:FeedReadingView,state:{stories:T[];value:{profile:{revision:number}}}){
 const eligible=new Map(state.stories.map(row=>[row.story.id,row])),sameProfile=view.profileRevision===state.value.profile.revision;
 const order=sameProfile&&view.order.length?view.order:state.stories.map(row=>row.story.id);
 const queued=sameProfile&&view.order.length?state.stories.filter(row=>!view.order.includes(row.story.id)):[];
 return {rows:order.flatMap(id=>eligible.has(id)?[eligible.get(id)!]:[]),queued,order};
}
/** Validate identities before a network result can replace the visible edition.
 * Deep server-only eligibility/evidence policy remains in the service. */
export function checkedFeedState(raw:FeedState,epoch:string){
 if(raw.epoch!==epoch||raw.value.format!==1||!Number.isSafeInteger(raw.value.revision)||raw.value.revision<1||raw.stories.length>100)throw Error('The Feed response cannot be verified. Keep the current reading.');
 feedProfileSchema.parse(raw.value.profile);
 if(!Array.isArray(raw.value.feedback)||raw.value.feedback.length>2000||raw.value.feedback.some(row=>!/^[a-f0-9]{64}$/u.test(row.storyId)||!['more','less','neutral'].includes(row.value))
  ||!Array.isArray(raw.value.hidden)||raw.value.hidden.length>2000||raw.value.hidden.some(id=>!/^[a-f0-9]{64}$/u.test(id))
  ||!Array.isArray(raw.hiddenStories)||raw.hiddenStories.some(row=>typeof row.id!=='string'||row.title!==null&&typeof row.title!=='string')
  ||!Array.isArray(raw.sources)||raw.sources.length>12||!['ready','pending','unconfigured'].includes(raw.interpretation.status)
  ||new Set(raw.stories.map(row=>row.story.id)).size!==raw.stories.length||raw.interpretation.profileRevision!==raw.value.profile.revision)
  throw Error('Feed preferences or source identities cannot be verified.');
 for(const row of raw.stories){feedStorySchema.parse(row.story);if(!row.eligibility.eligible||row.eligibility.profileRevision!==raw.value.profile.revision
  ||row.eligibility.storyId!==row.story.id||row.eligibility.storyRevision!==row.story.revision||!Array.isArray(row.eligibility.reasons)||!row.eligibility.reasons.length
  ||row.eligibility.reasons.some(reason=>typeof reason.topic!=='string'||!['written-topic','kept-interest','learned-interest'].includes(reason.kind)))
  throw Error('A story does not belong to this Feed profile.');}
 for(const row of raw.sources)feedSourceSchema.parse(row.source);
 if(!['not-connected','ready'].includes(raw.activity.status)||typeof raw.activity.message!=='string')throw Error('The learning source status cannot be verified.');
 const evidence=raw.activity.evidence??[];
 if(evidence.length>512)throw Error('The learning evidence exceeds its supported limit.');
 for(const row of evidence)feedEvidenceSchema.parse(row);
 if(!Array.isArray(raw.value.interests)||raw.value.interests.length>64)throw Error('The learned interests cannot be verified.');
 for(const interest of raw.value.interests){
  if(!['active','suggested'].includes(interest.status)||!Number.isFinite(interest.score)||interest.evidence.length>8)throw Error('The learned interest evidence cannot be verified.');
  for(const row of interest.evidence)if(!evidence.some(current=>same(current,row)))throw Error('A learned interest refers to unavailable evidence.');
 }
 for(const row of raw.stories)for(const reason of row.eligibility.reasons)
  if(reason.kind==='learned-interest'&&(!reason.evidenceIds.length||reason.evidenceIds.some(id=>!evidence.some(current=>current.id===id))))
   throw Error('A story refers to unavailable learning evidence.');
 return raw;
}
export const feedStoryGuard=(story:FeedStory)=>({id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest});
export const feedRefreshInput=(epoch:string,sourceId:string,profileRevision:number):FeedRefreshCommand=>({requestId:crypto.randomUUID(),epoch,sourceId,profileRevision});
