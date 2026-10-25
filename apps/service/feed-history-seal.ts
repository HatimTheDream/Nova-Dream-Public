import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import {historySealContracts,historySealIntentSchema,type HistorySealIntent,type HistorySealOutcome} from '../../packages/domain/news-feed-history-seal.js';
import {deriveSealCandidate,deriveSealReservation} from './feed-history-seal-candidate.js';
import {historyStorageAad,type HistoryStoreLimits,type HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import {verifyHistoryInventory,type HistoryInventoryAccess} from './feed-history-inventory.js';
import {historyLogicalRow,rowCommitment,sealProtection,sealObject} from './feed-history-seal-records.js';
import {readSqlHistory} from './feed-history-sql.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {FeedHistoryOwnerFence,type FeedHistoryLease} from './feed-history-owner-fence.js';
import {workerNativeIdentity} from './worker-plugin/identity.js';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const requestSchema=z.object({id:z.string().uuid(),segmentId:z.string().uuid(),workspaceEpoch:z.string().uuid(),createdAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),deadlineAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),rowIds:z.array(z.string().min(1).max(300)).min(1).max(50)}).strict();
export type SealRequest=z.infer<typeof requestSchema>;
export type SealFaultPhase='before-intent'|'intent-readback'|'before-intent-commit'|'after-intent-commit'|'before-archive'|'archive-written'|'archive-readback'|'before-retirement'|'one-deleted'|'after-retirement'|'before-commit'|'after-commit'|'before-close-outcome'|'before-close-commit'|'after-close-commit';
type Context={store:object;db:DatabaseSync;open(aad:string,payload:Uint8Array):unknown;seal(aad:string,value:unknown):Buffer;
 epoch():string;limits:HistoryStoreLimits;now():number;recoveryHeld():boolean;fault?(phase:SealFaultPhase):void};
type Captured={rows:Map<string,string>;receipts:Map<string,string>;objects:Map<string,string>};
/** Private Store-owned source capability. It is never an app/provider route.
 * Store supplies its actual connection and crypto lexically, without exporting
 * either to a caller. Full service/native owner joins remain a separate gate. */
export class HistorySealRuntime {
 readonly owners:FeedHistoryOwnerFence;
 private generation=0;private lastClock=0;
 constructor(private readonly c:Context){this.owners=new FeedHistoryOwnerFence(c.store);}
 private token(){const own=this.c.db.prepare('SELECT total_changes() AS n').get() as any,other=this.c.db.prepare('PRAGMA data_version').get() as any;
  return canonical({generation:this.generation,changes:own.n,dataVersion:other.data_version});}
 private clock(){const now=this.c.now();need(Number.isSafeInteger(now)&&now>0&&now>=this.lastClock,'Seal clock moved backwards');this.lastClock=now;return now;}
 private read<T>(consume:(a:HistoryInventoryAccess)=>T){return readSqlHistory(this.c.db,this.c.open,this.c.limits,()=>this.token(),consume,62);}
 private checked<T>(consume:(a:HistoryInventoryAccess)=>T){return this.read(a=>{verifyHistoryInventory(a,this.c.limits,workerNativeIdentity);return consume(a);});}
 private passive<T>(read:()=>T){const owned=!this.c.db.isTransaction;if(owned)this.c.db.exec('BEGIN DEFERRED');try{const value=read();need(!(value&&typeof(value as any).then==='function'),'Seal read must be synchronous');if(owned)this.c.db.exec('COMMIT');return value;}
  catch(error){if(owned)this.c.db.exec('ROLLBACK');throw error;}}
 private mutation<T>(fn:()=>T,before:SealFaultPhase,after:SealFaultPhase,commitGuard:()=>void){need(!this.c.db.isTransaction,'Seal mutation cannot nest');this.c.db.exec('BEGIN IMMEDIATE');let committed=false;this.generation++;
  try{const value=fn();this.c.fault?.(before);commitGuard();this.c.db.exec('COMMIT');committed=true;this.generation++;this.c.fault?.(after);return value;}
  catch(error){if(!committed){try{this.c.db.exec('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'Seal rollback is uncertain; reconcile original');}}throw error;}
  finally{this.generation++;}}
 private guard(intent:Pick<HistorySealIntent,'workspaceEpoch'|'createdAt'|'deadlineAt'|'rows'|'limitsSha256'>,lease:FeedHistoryLease,expired=false){
  need(!this.c.recoveryHeld(),'Recovered history remains held');need(intent.workspaceEpoch===this.c.epoch(),'Seal workspace epoch changed');
  need(intent.limitsSha256===hash(canonical(this.c.limits)),'Seal original limits changed');this.owners.assert(lease,this.c.store,intent.rows.map(r=>r.id));
  const now=this.clock();need(now>=intent.createdAt&&(expired||now<=intent.deadlineAt),'Seal original deadline expired or clock rolled back');return now;
 }
 private put(value:HistoryStoredObject){historyJsonBytes(value,this.c.limits.objectBytes);const bytes=this.c.seal(historyStorageAad(value.kind,value.key),value);
  need(bytes.length===Buffer.byteLength(JSON.stringify(value))+28,'Unexpected encrypted history wrapper');
  this.c.db.prepare('INSERT INTO feed_history_objects VALUES (?,?,?,?,?)').run(value.kind,value.key,value.rangeKey,value.revision,bytes);}
 private status(a:HistoryInventoryAccess,id:string){const intent=a.object('intent',id),outcome=a.object('outcome',id);if(!intent)return {state:'not-found' as const,id};need(intent.kind==='intent','Wrong intent kind');
  return {state:outcome?.kind==='outcome'?outcome.value.state:'prepared' as const,intent:copy(intent.value),...(outcome?.kind==='outcome'?{outcome:copy(outcome.value)}:{})};}
 readOperation(id:string){z.string().uuid().parse(id);return this.passive(()=>this.checked(a=>this.status(a,id)));}
 project<T>(query:{rowIds:string[]},consume:(projection:{rows:unknown[];receipts:unknown[]})=>T):T{
  historyJsonBytes(query,32768);const ids=z.object({rowIds:z.array(z.string().min(1).max(300)).max(50)}).strict().parse(query);need(same(ids,query)&&new Set(ids.rowIds).size===ids.rowIds.length,'Exact projection selection required');
  return this.passive(()=>this.checked(a=>{const protection=ids.rowIds.length?sealProtection(a,ids.rowIds,this.c.limits):{receipts:[]};
   const value=consume({rows:ids.rowIds.map(id=>copy(historyLogicalRow(a,id))),receipts:protection.receipts.map(r=>copy(a.receipt(r.id)))});
   need(!(value&&typeof(value as any).then==='function'),'History projection must remain synchronous');return value;}));
 }
 private capacity(a:HistoryInventoryAccess,reservation:HistorySealIntent['reservation']){
  let count=0,input=0;for(const list of [a.objects(),a.activeRows(),a.receipts()])for(const row of list){count++;input+=historyJsonBytes(row,this.c.limits.objectBytes);}
  // The authenticated plaintext may contain valid extra JSON whitespace or
  // escapes. Count actual stored BLOB lengths, never normalized reserialization.
  // readSqlHistory already preflights these same complete scalar inventories.
  const encrypted=Number((this.c.db.prepare(`SELECT
   coalesce((SELECT sum(length(payload)) FROM feed_history_objects),0)+
   coalesce((SELECT sum(length(payload)) FROM receipts),0)+
   coalesce((SELECT sum(length(payload)) FROM service_records WHERE substr(id,1,?)=?),0) AS bytes`).get('news:semantic-'.length,'news:semantic-') as any).bytes);
  need([count+reservation.addedObjects,input+reservation.encodedBytes,encrypted+reservation.encryptedBytes].every(Number.isSafeInteger)
   &&count+reservation.addedObjects<=this.c.limits.objects&&input+reservation.encodedBytes<=this.c.limits.inputBytes&&encrypted+reservation.encryptedBytes<=this.c.limits.encryptedBytes,'Seal physical overlap reservation exceeds explicit fixture limits');
 }
 prepare(raw:SealRequest,lease:FeedHistoryLease){historyJsonBytes(raw,32768);const input=requestSchema.parse(raw);need(same(input,raw)&&new Set(input.rowIds).size===input.rowIds.length,'Exact seal request required');
  const previous=this.readOperation(input.id);if(previous.state!=='not-found'){const original=previous.intent!;need(same({id:original.id,segmentId:original.segmentId,workspaceEpoch:original.workspaceEpoch,createdAt:original.createdAt,deadlineAt:original.deadlineAt,rowIds:original.rows.map(r=>r.id)},input),'Original seal request changed');return previous;}
  let prepared!:HistorySealIntent;
  return this.mutation(()=>this.checked(a=>{
   need(![...a.objects('intent')].some(i=>!a.object('outcome',i.key)),'An original seal is already pending');need(!a.object('segment',input.segmentId)&&!a.object('operation',input.id)&&!a.object('outcome',input.id),'Seal target identity exists');
   const candidate=deriveSealCandidate(a,input.rowIds,input.segmentId,input.id),intent:HistorySealIntent={format:1,id:input.id,segmentId:input.segmentId,workspaceEpoch:input.workspaceEpoch,createdAt:input.createdAt,deadlineAt:input.deadlineAt,
    sourceTokenSha256:hash(a.token()),limitsSha256:hash(canonical(this.c.limits)),contracts:historySealContracts,
    rows:candidate.rows.map(row=>({ ...rowCommitment(row),descriptor:(a.object('row',row.id) as any).value})),protection:sealProtection(a,input.rowIds,this.c.limits),
    wireSha256:candidate.segment.wireSha256,catalogueSha256:candidate.operation.catalogueSha256,reservation:{addedObjects:4,encodedBytes:1,encryptedBytes:1}};
   for(let n=0;n<8;n++){const next=deriveSealReservation(a,intent,candidate,this.c.limits);if(same(next,intent.reservation))break;intent.reservation=next;}
   need(same(deriveSealReservation(a,intent,candidate,this.c.limits),intent.reservation),'Seal reservation did not converge');historyJsonBytes(intent,this.c.limits.objectBytes);historySealIntentSchema.parse(intent);
   prepared=intent;this.guard(intent,lease);this.capacity(a,intent.reservation);this.c.fault?.('before-intent');this.put(sealObject('intent',intent));this.c.fault?.('intent-readback');
   return this.checked(current=>{need(same(current.object('intent',intent.id)?.value,intent),'Actual inserted intent differs');this.guard(intent,lease);return this.status(current,intent.id);});
  }),'before-intent-commit','after-intent-commit',()=>this.guard(prepared,lease));
 }
 private capture(a:HistoryInventoryAccess):Captured{
  return {rows:new Map([...a.objects('row')].map(o=>[o.key,JSON.stringify(historyLogicalRow(a,o.key))])),receipts:new Map([...a.receipts()].map(r=>[r.requestId,JSON.stringify(r)])),objects:new Map([...a.objects()].map(o=>[o.kind+':'+o.key,canonical(o)]))};
 }
 private delta(before:Captured,after:HistoryInventoryAccess,expected:Map<string,HistoryStoredObject>){
  const current=this.capture(after);need(current.rows.size===before.rows.size&&current.receipts.size===before.receipts.size,'Seal logical inventory count changed');
  for(const [id,json] of before.rows)need(current.rows.get(id)===json,'Seal changed exact logical row serialization');
  for(const [id,json] of before.receipts)need(current.receipts.get(id)===json,'Seal changed actual original/control receipt');
  need(current.objects.size===before.objects.size+3,'Seal changed unrelated object inventory');
  for(const [key,json] of before.objects)need(current.objects.get(key)===(expected.has(key)?canonical(expected.get(key)):json),'Seal changed unrelated descriptor or operation');
  for(const [key,value] of expected)need(current.objects.get(key)===canonical(value),'Actual resulting custody differs from exact selected delta');
  for(const key of current.objects.keys())need(before.objects.has(key)||expected.has(key),'Unexpected seal object');
 }
 commit(id:string,lease:FeedHistoryLease){const old=this.readOperation(id);if(old.state==='completed'||old.state==='not-performed')return old;need(old.state==='prepared','Original seal not found');
  let intent!:HistorySealIntent;
  return this.mutation(()=>{
   let candidate!:ReturnType<typeof deriveSealCandidate>,before!:Captured;const originals=new Map<string,{revision:number;payload:Uint8Array}>(),expected=new Map<string,HistoryStoredObject>();
   this.checked(a=>{const actual=a.object('intent',id);need(actual?.kind==='intent'&&!a.object('outcome',id),'Original seal state changed');intent=actual.value;this.guard(intent,lease);
    candidate=deriveSealCandidate(a,intent.rows.map(r=>r.id),intent.segmentId,id);need(candidate.segment.wireSha256===intent.wireSha256&&candidate.operation.catalogueSha256===intent.catalogueSha256,'Original deterministic wire or catalogue changed');
    need(same(deriveSealReservation(a,intent,candidate,this.c.limits),intent.reservation),'Original exact reservation changed');
    const savedIntent=sealObject('intent',intent),intentInput=historyJsonBytes(savedIntent,this.c.limits.objectBytes),intentEncrypted=Buffer.byteLength(JSON.stringify(savedIntent))+28;
    this.capacity(a,{addedObjects:intent.reservation.addedObjects-1,encodedBytes:intent.reservation.encodedBytes-intentInput,encryptedBytes:intent.reservation.encryptedBytes-intentEncrypted});before=this.capture(a);
    candidate.operation.intentSha256=hash(canonical(intent));const outcome:HistorySealOutcome={format:1,id,intentSha256:hash(canonical(intent)),state:'completed',at:this.clock(),segmentId:intent.segmentId,wireSha256:intent.wireSha256,catalogueSha256:intent.catalogueSha256};
    for(const value of [sealObject('segment',candidate.segment),sealObject('operation',candidate.operation),sealObject('outcome',outcome)])expected.set(value.kind+':'+value.key,value);
    for(const row of candidate.descriptors){const prior=a.object('row',row.id)!;expected.set('row:'+row.id,{...prior,revision:prior.revision+1,value:row} as HistoryStoredObject);
     const raw=this.c.db.prepare('SELECT revision,payload FROM service_records WHERE id=?').get(row.id) as any;need(raw&&raw.revision===row.revision&&JSON.stringify({id:row.id,revision:raw.revision,value:this.c.open(`service:${row.id}`,raw.payload)})===before.rows.get(row.id),'Actual selected ciphertext changed');originals.set(row.id,{revision:raw.revision,payload:Buffer.from(raw.payload)});}
   });
   this.guard(intent,lease);this.c.fault?.('before-archive');
   for(const [key,value] of expected){if(value.kind==='row'){
     const raw=this.c.db.prepare("SELECT revision,payload FROM feed_history_objects WHERE kind='row' AND object_key=?").get(value.key) as any;
     const result=this.c.db.prepare("UPDATE feed_history_objects SET revision=?,payload=? WHERE kind='row' AND object_key=? AND revision=? AND payload=?").run(value.revision,this.c.seal(historyStorageAad('row',value.key),value),value.key,raw.revision,raw.payload);need(result.changes===1,'Exact selected catalogue update changed');
    }else this.put(value);}
   this.c.fault?.('archive-written');this.guard(intent,lease);
   this.read(actual=>{
    const selected=new Set(intent.rows.map(r=>r.id)),found=new Set<string>();
    // Independently enumerate every actual active row. Only exact authenticated
    // selected copies may be omitted from the private resulting-custody view.
    for(const row of actual.activeRows())if(selected.has(row.id)){need(!found.has(row.id)&&JSON.stringify(row)===before.rows.get(row.id),'Temporary active duplicate changed');found.add(row.id);}
    need(found.size===selected.size,'Selected active occurrence omitted');
    const resulting:HistoryInventoryAccess={...actual,activeRows:function*(){for(const row of actual.activeRows())if(!selected.has(row.id))yield row;},activeRow:key=>selected.has(key)?undefined:actual.activeRow(key)};
    verifyHistoryInventory(resulting,this.c.limits,workerNativeIdentity);this.delta(before,resulting,expected);
   });
   this.c.fault?.('archive-readback');this.guard(intent,lease);this.c.fault?.('before-retirement');
   for(const [rowId,raw] of originals){this.guard(intent,lease);const result=this.c.db.prepare('DELETE FROM service_records WHERE id=? AND revision=? AND payload=?').run(rowId,raw.revision,raw.payload);need(result.changes===1,'Exact original retirement changed');this.c.fault?.('one-deleted');}
   this.c.fault?.('after-retirement');this.guard(intent,lease);
   return this.checked(actual=>{this.delta(before,actual,expected);this.guard(intent,lease);return this.status(actual,id);});
  },'before-commit','after-commit',()=>this.guard(intent,lease));
 }
 closeUnperformed(id:string,lease:FeedHistoryLease){const previous=this.readOperation(id);if(previous.state==='completed'||previous.state==='not-performed')return previous;need(previous.state==='prepared','Original seal not found');
  let closing!:HistorySealIntent;
  return this.mutation(()=>this.checked(a=>{const raw=a.object('intent',id);need(raw?.kind==='intent'&&!a.object('outcome',id),'Original seal state changed');closing=raw.value;const now=this.guard(raw.value,lease,true);
   const outcome:HistorySealOutcome={format:1,id,intentSha256:hash(canonical(raw.value)),state:'not-performed',at:now,reason:now>raw.value.deadlineAt?'expired':'explicit-close'},object=sealObject('outcome',outcome);
   this.capacity(a,{addedObjects:1,encodedBytes:historyJsonBytes(object,this.c.limits.objectBytes),encryptedBytes:Buffer.byteLength(JSON.stringify(object))+28});
   this.c.fault?.('before-close-outcome');this.guard(raw.value,lease,true);this.put(object);
   return this.checked(current=>{need(same(current.object('outcome',id)?.value,outcome),'Actual closure outcome differs');this.guard(raw.value,lease,true);return this.status(current,id);});
  }),'before-close-commit','after-close-commit',()=>this.guard(closing,lease,true));
 }
}
