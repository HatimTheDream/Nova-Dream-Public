import {Buffer} from 'node:buffer';
import type {DatabaseSync} from 'node:sqlite';
import {canonical,taskSchema,type Task} from '../../packages/domain/contracts.js';
import type {HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import {assertHistorySqlKey} from '../../packages/domain/news-feed-history-keys.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {DraftCapacityContext,type DraftStoredRow} from './feed-draft-capacity.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {prepareRawTaskSource} from './task-raw-commitment.js';

export const taskRelationCatalogueKey='tasks:relations:v1';
type Relation=readonly [string,number,1|readonly [string|null,readonly string[]]];
type Catalogue=Readonly<{format:1;epoch:string;revision:number;sourceSha256:string;rows:readonly Relation[]}>;
type Anchor=Readonly<{revision:number;payload:Uint8Array}>;
type Amount=Readonly<{previousBytes:number;nextBytes:number;absent:boolean}>;
declare const effectBrand:unique symbol;
export type TaskCatalogueEffect=Readonly<{readonly [effectBrand]:never}>;
const effects=new WeakMap<object,{consume:(db:DatabaseSync,budget:MutationPlanBudget)=>Amount}>();
const idPattern=/^task:[a-zA-Z0-9:_-]+$/;
const shaPattern=/^[a-f0-9]{64}$/;

/** The public shape is not authority: only one private prepared plan can
 * register and consume this separate derived-record effect. */
export function consumeTaskCatalogueEffect(effect:TaskCatalogueEffect,db:DatabaseSync,budget:MutationPlanBudget):Amount{
 const registered=effects.get(effect);if(!registered)return budget.fail(Error('Task catalogue effect is foreign or expired'));
 return registered.consume(db,budget);
}
function readCatalogue(c:DraftCapacityContext){
 const found=c.scalar("SELECT count(*) AS count,coalesce(sum(CASE WHEN typeof(id)='text' THEN 0 ELSE 1 END),0) AS bad FROM service_records WHERE CAST(id AS BLOB)=CAST(? AS BLOB)",[taskRelationCatalogueKey]);
 c.need(found.count<=1&&found.bad===0,'Task catalogue shadow identity refused');
 return c.row('service_records',taskRelationCatalogueKey);
}
function validId(value:unknown):value is string{return typeof value==='string'&&value.length<=100&&idPattern.test(value);}
function validate(value:any,epoch:string,revision:number,need:(ok:unknown,message:string)=>void,pay:(entries:number,bytes:number)=>void):asserts value is Catalogue{
 pay(2,128);need(value!==null&&typeof value==='object'&&!Array.isArray(value),'Task catalogue object malformed');
 const keys=Object.keys(value);need(keys.length===5&&keys.every(k=>k==='format'||k==='epoch'||k==='revision'||k==='sourceSha256'||k==='rows'),'Task catalogue fields malformed');
 need(value.format===1&&value.epoch===epoch&&value.revision===revision&&Number.isSafeInteger(revision)&&revision>=1&&typeof value.sourceSha256==='string'&&shaPattern.test(value.sourceSha256)&&Array.isArray(value.rows),'Task catalogue header malformed');
 let prior='';
 for(let i=0;i<value.rows.length;i++){
  pay(2,64);const row=value.rows[i];need(Array.isArray(row)&&row.length===3&&validId(row[0])&&row[0]>prior&&Number.isSafeInteger(row[1])&&row[1]>=1,'Task catalogue row malformed');prior=row[0];
  if(row[2]===1)continue;
  need(Array.isArray(row[2])&&row[2].length===2&&(row[2][0]===null||validId(row[2][0]))&&Array.isArray(row[2][1])&&row[2][1].length<=20&&(row[2][0]!==null||row[2][1].length>0),'Task catalogue sparse relation malformed');
  const dependencies=row[2][1];for(let j=0;j<dependencies.length;j++){need(validId(dependencies[j]),'Task catalogue dependency malformed');for(let k=0;k<j;k++)need(dependencies[k]!==dependencies[j],'Task catalogue duplicate dependency');}
 }
}
function relation(id:string,revision:number,value:Task,pay:(entries:number,bytes:number)=>void):Relation|undefined{
 if(!value.trashed&&!value.parentTaskId&&!value.dependencies?.length)return;
 pay(1,48);if(value.trashed)return Object.freeze([id,revision,1] as const);
 const dependencies=value.dependencies??[];pay(2+dependencies.length,64+dependencies.length*16);
 const copied:string[]=[];for(let i=0;i<dependencies.length;i++)copied.push(dependencies[i]!);
 return Object.freeze([id,revision,Object.freeze([value.parentTaskId??null,Object.freeze(copied)] as const)] as const);
}

type ImportedTasks={epoch:string;entities:readonly {id:string;kind:string;revision:number;value:unknown}[];
 services:readonly {id:string;revision:number;value:unknown}[]};
/** Pure backup validation. Historical sourceSha256 is format data, never a
 * commitment to the new key/epoch or permission to enroll a process owner. */
export function verifyImportedTaskCatalogue(input:ImportedTasks,limits?:HistoryStoreLimits):void{
 if(!input.services.some(row=>row.id===taskRelationCatalogueKey))return;
 if(!limits)throw Error('Task catalogue import requires retained-history bounds');
 verifyRestoredTaskSemantics(input,limits);
}
/** The explicit held restore also validates all Tasks when no catalogue was
 * present. One retained-global bound covers this entire pre-directory census. */
export function verifyRestoredTaskSemantics(input:ImportedTasks,limits:HistoryStoreLimits):void{
 function need(ok:unknown,message:string):asserts ok{if(!ok)throw Error(message);}
 let retained=0,inputBytes=0,cipherBytes=0,keyBytes=0,count=0,sparse=0;
 const retain=(entries:number,bytes:number)=>{
  const next=retained+entries*64+bytes;
  need(Number.isSafeInteger(entries)&&entries>=0&&Number.isSafeInteger(bytes)&&bytes>=0&&Number.isSafeInteger(next)&&next<=limits.inputBytes,'Task catalogue import retained derivation bound');retained=next;
 };
 retain(12,768);let before:{id:string;revision:number;value:unknown}|undefined;
 for(const row of input.services)if(row.id===taskRelationCatalogueKey){need(!before,'Task catalogue import duplicate');before=row;}
 if(before){
  const bytes=historyJsonBytes(before.value,limits.objectBytes);retain(4,512+8*bytes);
  validate(before.value,input.epoch,before.revision,need,retain);
 }
 for(const item of input.entities){
  if(item.kind!=='task')continue;
  need(++count<=limits.objects&&validId(item.id)&&Number.isSafeInteger(item.revision)&&item.revision>=1,'Task catalogue imported Task identity/revision unsupported');
  const bytes=historyJsonBytes(item.value,limits.objectBytes),keys=Buffer.byteLength(item.id);
  inputBytes+=bytes;cipherBytes+=bytes+28;keyBytes+=keys;
  need(Number.isSafeInteger(inputBytes)&&inputBytes<=limits.inputBytes&&Number.isSafeInteger(cipherBytes)&&cipherBytes<=limits.encryptedBytes&&Number.isSafeInteger(keyBytes)&&keyBytes+cipherBytes<=limits.inputBytes,'Task catalogue imported inventory bound');
  // Same complete schema/canonical and native-string allowance as actual
  // retained derivation, prepaid before creating the parsed representation.
  retain(16,4096+48*(bytes+28)+8*keys);
  const parsed=taskSchema.parse(item.value);
  need(canonical(item.value)===canonical(parsed),'Task catalogue imported Task would normalize');
  need(!parsed.origin||Number.isSafeInteger(parsed.origin.revision),'Task catalogue imported source revision invalid');
  need(!parsed.workLink||Number.isSafeInteger(parsed.workLink.assignmentRevision)&&Number.isSafeInteger(parsed.workLink.taskRevision),'Task catalogue imported work revision invalid');
  const tuple=relation(item.id,item.revision,parsed,retain);if(!tuple)continue;sparse++;
  if(before){
   const rows=(before.value as Catalogue).rows;let low=0,high=rows.length;
   while(low<high){const middle=low+Math.floor((high-low)/2);retain(0,2*(rows[middle]![0].length+item.id.length));if(rows[middle]![0]<item.id)low=middle+1;else high=middle;}
   need(low<rows.length&&rows[low]![0]===item.id,'Task catalogue imported relation missing');
   retain(4,512+8*historyJsonBytes(tuple,limits.objectBytes));
   need(canonical(rows[low])===canonical(tuple),'Task catalogue imported relation differs');
  }
 }
 if(before)need(sparse===(before.value as Catalogue).rows.length,'Task catalogue imported relation inventory differs');
}

/** Store-owned process anchor. It is established by complete held derivation,
 * never by adopting a caller's digest or parsed catalogue. */
class TaskCatalogueOwner{
 #active=false;#plan:TaskCataloguePlan|undefined;#next:Anchor|undefined;
 constructor(readonly db:DatabaseSync,readonly epoch:string,private anchor:Anchor){}
 mutation<T>(run:()=>T):T{
  if(this.#active||this.db.isTransaction)throw Error('Task catalogue original owner is already active');
  this.#active=true;this.#plan=undefined;this.#next=undefined;
  try{const result=run();if(this.#next)this.anchor=this.#next;return result;
  }finally{this.closePlan();this.#plan=undefined;this.#next=undefined;this.#active=false;}
 }
 private closePlan(){this.#plan?.close();}
 verifyBeforeCommit(){
  if(!this.#active)return;
  if(!this.db.isTransaction||this.#plan&&!this.#next)throw Error('Task catalogue original final verification missing');
 }
 prepare(context:DraftCapacityContext):TaskCataloguePlan{
  context.need(this.#active&&!this.#plan&&this.db.isTransaction,'Task catalogue owner is foreign or reused');
  const check=()=>context.need(this.#active&&this.db.isTransaction,'Task catalogue original transaction ended');
  context.slots(3,128);
  const plan=new TaskCataloguePlan(this.db,this.epoch,this.anchor,context,check,anchor=>{check();context.need(this.#plan===plan&&!this.#next,'Task catalogue completion repeated');this.#next=anchor;});
  this.#plan=plan;return plan;
 }
}
export type TaskCatalogueCustody=TaskCatalogueOwner;

class TaskCataloguePlan{
 readonly #raw:ReturnType<typeof prepareRawTaskSource>;readonly #before:DraftStoredRow;readonly #catalogue:Catalogue;
 #phase:'initial'|'prepared'|'admitted'|'written'|'final'|'closed'='initial';#effect?:TaskCatalogueEffect;#payload?:Buffer;#after?:Catalogue;
 constructor(private db:DatabaseSync,private epoch:string,anchor:Anchor,private c:DraftCapacityContext,private owner:()=>void,private completed:(anchor:Anchor)=>void){
  c.slots(9,512);this.#raw=c.taskRawSource(epoch);const source=this.#raw.initial();
  const before=readCatalogue(c);c.need(before&&before.raw.revision===anchor.revision&&Buffer.compare(before.raw.payload,anchor.payload)===0,'Task catalogue startup anchor changed');
  c.slots(0,before.raw.payload.byteLength*2+256);
  validate(before.value,epoch,before.raw.revision,(ok,message)=>c.need(ok,message),(entries,bytes)=>c.slots(entries,bytes));
  c.need(before.value.sourceSha256===source.sha256,'Task catalogue source commitment changed');this.#before=before;this.#catalogue=before.value;
 }
 assertTrash(id:string):'required'|'children'|undefined{
  this.c.guard();this.owner();this.c.need(this.#phase==='initial','Task catalogue relation phase ended');
  // Preserve maintained error precedence: dependency refusal before children.
  for(let i=0;i<this.#catalogue.rows.length;i++){const row=this.#catalogue.rows[i]!;if(row[2]!==1)for(let j=0;j<row[2][1].length;j++)if(row[2][1][j]===id)return 'required';}
  for(let i=0;i<this.#catalogue.rows.length;i++){const row=this.#catalogue.rows[i]!;if(row[2]!==1&&row[2][0]===id)return 'children';}
 }
 prepare(id:string,previousRevision:number,value:Task,payload:Buffer):TaskCatalogueEffect{
  return this.c.checked(()=>{this.owner();this.c.need(this.#phase==='initial'&&validId(id)&&this.#before.raw.revision<Number.MAX_SAFE_INTEGER,'Task catalogue prepare repeated');
   this.c.slots(2,128+Buffer.byteLength(id));const key=Buffer.from(id,'utf8'),source=this.#raw.prospective(key,previousRevision,payload);
   this.c.slots(4+this.#catalogue.rows.length,208+this.#catalogue.rows.length*16);
   const rows:Relation[]=[],replacement=relation(id,previousRevision+1,value,(entries,bytes)=>this.c.slots(entries,bytes));let inserted=false;
   for(let i=0;i<this.#catalogue.rows.length;i++){const old=this.#catalogue.rows[i]!;
    if(!inserted&&old[0]>=id){if(replacement)rows.push(replacement);inserted=true;}
    if(old[0]!==id)rows.push(old);else this.c.need(old[1]===previousRevision,'Task catalogue predecessor revision changed');
   }
   if(!inserted&&replacement)rows.push(replacement);
   this.#after=Object.freeze({format:1,epoch:this.epoch,revision:this.#before.raw.revision+1,sourceSha256:source.sha256,rows:Object.freeze(rows)});
   this.#payload=this.c.encrypted('service:'+taskRelationCatalogueKey,this.#after);
   this.c.slots(7,448);const effect=Object.freeze({}) as TaskCatalogueEffect;this.#effect=effect;this.#phase='prepared';
   const amount=Object.freeze({previousBytes:this.#before.raw.payload.byteLength,nextBytes:this.#payload.byteLength,absent:false});
   effects.set(effect,{consume:(db,budget)=>this.c.checked(()=>{this.owner();this.c.need(this.#phase==='prepared'&&this.c.originalOwner(db,budget),'Task catalogue effect owner or phase changed');this.#phase='admitted';return amount;})});
   return effect;
  });
 }
 applyAndVerify(){return this.c.checked(()=>{this.owner();this.c.need(this.#phase==='admitted'&&this.#payload&&this.#after,'Task catalogue effect was not admitted');
  const written=this.c.query('UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?').run(this.#after.revision,this.#payload,taskRelationCatalogueKey,this.#before.raw.revision,this.#before.raw.payload);
  this.c.need(written.changes===1,'Task catalogue predecessor changed');this.#phase='written';
  const actual=readCatalogue(this.c);this.c.need(actual&&actual.raw.revision===this.#after.revision&&Buffer.compare(actual.raw.payload,this.#payload)===0,'Task catalogue final ciphertext changed');
  this.c.slots(0,this.#payload.byteLength*2+256);
  validate(actual.value,this.epoch,actual.raw.revision,(ok,message)=>this.c.need(ok,message),(entries,bytes)=>this.c.slots(entries,bytes));
  const source=this.#raw.final();this.c.need(actual.value.sourceSha256===source.sha256,'Task catalogue final source changed');
  // Exact prepared ciphertext plus authenticated complete parse binds every
  // successor field without a second structural-copy comparison.
  this.c.slots(1,64);this.#phase='final';this.completed(Object.freeze({revision:actual.raw.revision,payload:actual.raw.payload}));
 });}
 close(){if(this.#effect)effects.delete(this.#effect);this.#raw.close();this.#phase='closed';}
}

type BootstrapPorts={db:DatabaseSync;limits:HistoryStoreLimits;context:DraftCapacityContext;budget:MutationPlanBudget;epoch:string;openText:(aad:string,payload:Uint8Array)=>string;guard:()=>void};
/** Held construction only. Its complete semantic census uses the existing
 * retained-inventory object/input/ciphertext limits, not a fresh budget per
 * Task or a reset command allowance. Actual startup qualification is separate. */
export function bootstrapTaskCatalogue(p:BootstrapPorts,admit:(amount:Amount)=>void):TaskCatalogueCustody{
 const c:DraftCapacityContext=p.context;c.guard();p.guard();
 const raw=prepareRawTaskSource(p.db,p.budget,p.limits.objectBytes,p.epoch,p.guard);let unchanged:ReturnType<typeof prepareRawTaskSource>|undefined;
 try{
 const initial=raw.initial();
 c.need(initial.rows<=p.limits.objects&&initial.cipherBytes<=p.limits.encryptedBytes&&initial.keyBytes+initial.cipherBytes<=p.limits.inputBytes,'Task catalogue retained inventory bound');
 const before=readCatalogue(c);let inputBytes=0,retainedBytes=0;
 const retain=(entries:number,bytes:number)=>{
  const next=retainedBytes+entries*64+bytes;c.need(Number.isSafeInteger(entries)&&entries>=0&&Number.isSafeInteger(bytes)&&bytes>=0&&Number.isSafeInteger(next)&&next<=p.limits.inputBytes,'Task catalogue global retained derivation bound');retainedBytes=next;
 };
 retain(4,256);const rows:Relation[]=[];
 // Native row/vector allocation is bounded before .all by the complete raw
 // census. Semantic parsing below consumes the one global retained-byte sum.
 retain(2+initial.rows*8,512+initial.keyBytes*6+initial.cipherBytes);p.budget.query();
 const actual=p.db.prepare("SELECT id,CAST(id AS BLOB) AS raw,revision,payload FROM entities WHERE CAST(kind AS BLOB)=X'7461736b' ORDER BY CAST(id AS BLOB)").all() as {id:string;raw:Uint8Array;revision:number;payload:Uint8Array}[];
 c.need(actual.length===initial.rows,'Task catalogue bootstrap inventory changed');
 for(let i=0;i<actual.length;i++){
  const item=actual[i]!;assertHistorySqlKey(item.id,item.raw);c.need(validId(item.id),'Task catalogue Task identity unsupported');
  // Native decrypt/text, complete parse/schema copies, canonical strings,
  // date/URL refinement scratch and per-record frames are reserved against
  // the original retained-global input limit before constructing them. This
  // is a startup lifecycle bound, not a reset command entry allowance.
  retain(16,4096+item.payload.byteLength*48+item.raw.byteLength*8);
  const text=p.openText('entity:'+item.id,item.payload);inputBytes+=Buffer.byteLength(text);c.need(Number.isSafeInteger(inputBytes)&&inputBytes<=p.limits.inputBytes,'Task catalogue semantic input bound');
  const value=JSON.parse(text),parsed=taskSchema.parse(value);c.need(canonical(value)===canonical(parsed),'Task catalogue retained Task would normalize');
  c.need(!value.origin||Number.isSafeInteger(value.origin.revision),'Task catalogue source revision invalid');
  c.need(!value.workLink||Number.isSafeInteger(value.workLink.assignmentRevision)&&Number.isSafeInteger(value.workLink.taskRevision),'Task catalogue work revision invalid');
  historyJsonBytes(value,p.limits.objectBytes);const tuple=relation(item.id,item.revision,value,retain);if(tuple)rows.push(tuple);p.guard();
 }
 retain(2,128);const expected:Catalogue={format:1,epoch:p.epoch,revision:before?.raw.revision??1,sourceSha256:initial.sha256,rows};
 let payload:Uint8Array;
 retain(4,512+historyJsonBytes(expected,p.limits.objectBytes)*8);
 if(before){validate(before.value,p.epoch,before.raw.revision,(ok,message)=>c.need(ok,message),retain);c.need(canonical(before.value)===canonical(expected),'Task catalogue full derivation differs');payload=before.raw.payload;admit({previousBytes:payload.byteLength,nextBytes:payload.byteLength,absent:false});}
 else{payload=c.encrypted('service:'+taskRelationCatalogueKey,expected);admit({previousBytes:0,nextBytes:payload.byteLength,absent:true});
  c.need(c.query('INSERT INTO service_records(id,revision,payload) VALUES (?,?,?)').run(taskRelationCatalogueKey,1,payload).changes===1,'Task catalogue bootstrap insertion changed');
  const saved=readCatalogue(c);c.need(saved&&saved.raw.revision===1&&Buffer.compare(saved.raw.payload,payload)===0&&canonical(saved.value)===canonical(expected),'Task catalogue bootstrap readback changed');
 }
 // Second complete source pass follows the actual derived-record effect.
 unchanged=prepareRawTaskSource(p.db,p.budget,p.limits.objectBytes,p.epoch,p.guard);const final=unchanged.initial();
 c.need(final.sha256===initial.sha256&&final.rows===initial.rows&&final.keyBytes===initial.keyBytes&&final.cipherBytes===initial.cipherBytes,'Task catalogue bootstrap source changed');
 c.slots(2,128);return new TaskCatalogueOwner(p.db,p.epoch,Object.freeze({revision:expected.revision,payload}));
 }finally{raw.close();unchanged?.close();}
}
