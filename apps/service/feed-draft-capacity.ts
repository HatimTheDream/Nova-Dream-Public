import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {types} from 'node:util';
import {prepareRawTaskSource} from './task-raw-commitment.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {assertHistorySqlKey,assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import type {HistorySequenceLimits} from './feed-history-write-sequence.js';

type Table='entities'|'service_records'|'receipts'|'blobs';
const columns={entities:['id','kind','device_id','updated_at'],service_records:['id'],receipts:['request_id','digest','device_id'],blobs:['id','device_id']} as const;
export type DraftStoredRow={raw:Record<string,any>;value:any};
type Ports={db:DatabaseSync;budget:MutationPlanBudget;limits:HistorySequenceLimits;recordBytes:number;
 guard:()=>void;openText:(aad:string,payload:Uint8Array)=>string;seal:(aad:string,value:unknown)=>Buffer};

/** One private typed draft transaction. No arbitrary callback receives this
 * context or its database. Logical allocation bounds are not physical limits. */
export class DraftCapacityContext{
 private alive=true;private readBytes=0;private outgoingBytes=0;
 readonly #budget:MutationPlanBudget;
 constructor(private p:Ports){this.#budget=p.budget;this.slots(3,160);}
 guard(){if(!this.alive)throw Error('Draft capacity context ended');this.p.guard();this.#budget.checked(()=>undefined);}
 checked<T>(fn:()=>T):T{return this.#budget.checked(()=>{this.guard();const result=fn();this.guard();return result;});}
 need(ok:unknown,message:string):asserts ok{if(!ok)this.#budget.fail(Error(message));}
 slots(count=1,bytes=32){for(let i=0;i<count;i++)this.#budget.entry();this.#budget.reserveBytes(bytes);}
 key(value:string){return this.checked(()=>{this.need(typeof value==='string'&&value.length<=8192,'Draft key bound');this.slots(3,32+value.length*12);assertHistoryUtf8Key(value);return value;});}
 query(sql:string){this.guard();this.#budget.query();this.slots(2,64);return this.p.db.prepare(sql);}
 scalar(sql:string,args:SQLInputValue[]=[]):any{this.slots(16,768);return this.query(sql).get(...args);}
 /** Capture the JSON-visible input before any schema sees it. Proxy detection
  * itself invokes no traps. Descriptors, work slots, keys and copied values are
  * charged before retention; getters and conversion hooks never execute.
  * Inert non-enumerable/symbol-keyed metadata is outside this raw JSON view. */
 capture(input:unknown):unknown{return this.checked(()=>{
  this.slots(3,128);const live=new Set<object>(),stack:{source:object;target:any;keys:Generator<string>;count:number;length?:number}[]=[];
  const keys=function*(value:object){for(const key in value)if(Object.hasOwn(value,key))yield key;};
  const take=(value:unknown):any=>{
   if(value===null||typeof value!=='object'){this.slots(1,16);this.#budget.bytes(value);return value;}
   this.need(!types.isProxy(value),'Draft Proxy input unsupported');
   this.slots(7,256);const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
   this.need(!live.has(value)&&(prototype===(array?Array.prototype:Object.prototype)||prototype===null),'Draft JSON object unsupported');
   for(let target:object|null=value;target;target=Object.getPrototypeOf(target)){
    this.slots(1,64);const hook=Object.getOwnPropertyDescriptor(target,'toJSON');
    if(hook){this.need('value'in hook&&typeof hook.value!=='function','Draft JSON conversion hook unsupported');break;}
   }
   const target=array?[]:Object.create(null);live.add(value);
   stack.push({source:value,target,keys:keys(value),count:0,...(array?{length:(value as unknown[]).length}:{})});return target;
  };
  const result=take(input);
  while(stack.length){const top=stack[stack.length-1]!;this.slots(2,64);const next=top.keys.next();
   if(next.done){this.need(top.length===undefined||top.count===top.length,'Draft JSON sparse array unsupported');Object.freeze(top.target);live.delete(top.source);stack.pop();continue;}
   const key=next.value;this.#budget.bytes(key);this.slots(2,96);const descriptor=Object.getOwnPropertyDescriptor(top.source,key);
   this.need(descriptor&&'value'in descriptor,'Draft JSON accessor unsupported');
   if(top.length!==undefined)this.need(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<top.length,'Draft JSON array property unsupported');
   top.count++;const child=take(descriptor.value);Object.defineProperty(top.target,key,{value:child,enumerable:true,writable:true,configurable:true});
  }
  return result;
 });}
 child<T>(input:unknown,produce:()=>T):T{return this.checked(()=>{
  this.slots(1,8);const stack:unknown[]=[input];let fields=0;
  while(stack.length){const v=stack.pop();if(v!==null&&typeof v==='object'){
   this.need(!types.isProxy(v),'Draft Proxy input unsupported');this.slots(2,48);fields++;for(const k in v)if(Object.hasOwn(v,k)){this.slots(2,64);fields++;const descriptor=Object.getOwnPropertyDescriptor(v,k);this.need(descriptor&&'value'in descriptor,'Draft JSON accessor unsupported');const child=descriptor.value;if(child!==null&&typeof child==='object'){this.slots(1,8);stack.push(child);}}
  }}
  // Parse/validation/canonical callers use at most four input representations
  // and four field/container copies, plus their fixed metadata wrappers.
  const bytes=this.#budget.bytes(input);this.slots(fields*4+32,bytes*4+2048);const value=produce();this.guard();return value;
 });}
 private parse(text:string){
  // Same lexical token reservation as the reviewed completion reader: strings
  // count once regardless of text length; no JSON nodes exist before this pass.
  this.#budget.reserveBytes(text.length*2+32);
  for(let i=0;i<text.length;i++){
   const c=text.charCodeAt(i);
   if(c===34){this.slots();for(i++;i<text.length;i++){if(text.charCodeAt(i)===92){i++;continue;}if(text.charCodeAt(i)===34)break;}continue;}
   if(c===123||c===91){this.slots();continue;}
   if(c===125||c===93||c===44||c===58||c===32||c===10||c===13||c===9)continue;
   this.slots();while(i+1<text.length){const n=text.charCodeAt(i+1);if(n===44||n===93||n===125||n===32||n===10||n===13||n===9)break;i++;}
  }
  return JSON.parse(text);
 }
 row(table:Table,id:string,expectedKind?:string):DraftStoredRow|undefined{return this.checked(()=>{
  this.key(id);const cols=columns[table],identity=table==='receipts'?'request_id':'id';
  const revision=table==='entities'||table==='service_records';
  this.slots(16,2048);
  const bad=cols.map(k=>`typeof(${k})!='text' OR length(CAST(${k} AS BLOB))>8192`).join(' OR ');
  const meta=this.scalar(`SELECT CASE WHEN ${bad} OR typeof(payload)!='blob' OR length(payload)<28 OR length(payload)>?${revision?" OR typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991":''}${table==='blobs'?" OR typeof(bytes)!='integer' OR bytes<0 OR bytes>8388608":''} THEN 1 ELSE 0 END AS bad,length(payload) AS bytes,${cols.map(k=>'length(CAST('+k+' AS BLOB))').join('+')} AS keys${table==='entities'&&expectedKind!==undefined?',CASE WHEN kind=? THEN 1 ELSE 0 END AS kindOk':''} FROM ${table} WHERE ${identity}=?`,[this.p.recordBytes+28,...(table==='entities'&&expectedKind!==undefined?[expectedKind]:[]),id]);
  if(!meta)return;
  this.need(expectedKind===undefined||meta.kindOk===1,'Draft entity kind collision');
  this.need(meta.bad===0&&Number.isSafeInteger(meta.bytes)&&Number.isSafeInteger(meta.keys)&&meta.keys>=0,'Draft stored row metadata bound');
  this.need(Number.isSafeInteger(this.readBytes+meta.bytes)&&this.readBytes+meta.bytes<=this.p.limits.predecessorCipherBytes,'Draft predecessor ciphertext bound');this.readBytes+=meta.bytes;
  // Fetch/copy, decrypt update+concat and UTF8 text are reserved before loading.
  this.slots(16+cols.length*3,meta.bytes*6+meta.keys*4+512);
  const raw=this.query(`SELECT ${cols.join(',')}${revision?',revision':''}${table==='blobs'?',bytes AS stored_bytes':''},payload,${cols.map((k,i)=>'CAST('+k+' AS BLOB) AS _k'+i).join(',')} FROM ${table} WHERE ${identity}=?`).get(id) as Record<string,any>;
  this.need(!!raw&&raw[identity]===id&&raw.payload.byteLength===meta.bytes,'Draft stored row changed');
  for(let i=0;i<cols.length;i++)assertHistorySqlKey(raw[cols[i]],raw['_k'+i]);
  const aad=table==='entities'?'entity:':table==='service_records'?'service:':table==='blobs'?'blob-meta:':'receipt:';
  const text=this.p.openText(aad+id,raw.payload);this.guard();const value=this.parse(text);historyJsonBytes(value,this.p.recordBytes);
  this.slots(1,64);return {raw,value};
 });}
 meta(key:'epoch'|'workspace-cursor'){return this.checked(()=>{
  const facts=this.scalar("SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=128 THEN 0 ELSE 1 END AS bad,length(CAST(value AS BLOB)) AS bytes FROM meta WHERE key=?",[key]);
  if(!facts)return;
  this.need(facts.bad===0&&Number.isSafeInteger(facts.bytes)&&facts.bytes>=0,'Draft metadata text bound');this.slots(6,facts.bytes*4+128);
  const row=this.query('SELECT value,CAST(value AS BLOB) AS raw FROM meta WHERE key=?').get(key) as {value:string;raw:Uint8Array};
  this.need(!!row&&row.raw.byteLength===facts.bytes,'Draft metadata changed');assertHistorySqlKey(row.value,row.raw);return row.value;
 });}
 cursor(){return this.checked(()=>{
  const meta=this.meta('workspace-cursor');this.need(meta===undefined||/^(0|[1-9][0-9]*)$/.test(meta),'Draft cursor text invalid');
  const sequence=this.scalar("SELECT count(*) AS count,coalesce(sum(CASE WHEN typeof(seq)='integer' AND seq>=0 AND seq<=9007199254740991 THEN 0 ELSE 1 END),0) AS bad,MAX(CASE WHEN typeof(seq)='integer' AND seq>=0 AND seq<=9007199254740991 THEN seq ELSE NULL END) AS value FROM sqlite_sequence WHERE name='history'");
  const maximum=this.scalar('SELECT MAX(cursor) AS value FROM history');
  this.need(sequence.count<=1&&sequence.bad===0&&(sequence.count===0||Number.isSafeInteger(sequence.value)&&sequence.value>=0),'Draft history sequence invalid');
  this.need(maximum.value===null||Number.isSafeInteger(maximum.value)&&maximum.value>=1,'Draft history cursor invalid');
  const old=meta===undefined?0:Number(meta),seq=sequence?.value??0,max=maximum.value??0;
  this.need(Number.isSafeInteger(old)&&old>=0&&old<Number.MAX_SAFE_INTEGER&&seq<Number.MAX_SAFE_INTEGER&&max<Number.MAX_SAFE_INTEGER,'Draft cursor exhausted');
  const history=Math.max(seq,max)+1,next=Math.max(Math.max(old,seq)+1,history);this.slots(1,128);return {meta,sequence:seq,maximum:max,history,next};
 });}
 refs(id:string):string[]{return this.checked(()=>{
  this.key(id);const meta=this.scalar("SELECT count(*) AS count,coalesce(sum(length(CAST(entity_id AS BLOB))+length(CAST(blob_id AS BLOB))),0) AS bytes,coalesce(sum(CASE WHEN typeof(entity_id)!='text' OR typeof(blob_id)!='text' OR length(CAST(entity_id AS BLOB))>8192 OR length(CAST(blob_id AS BLOB))>8192 THEN 1 ELSE 0 END),0) AS bad FROM blob_refs WHERE entity_id=?",[id]);
  this.need(meta.bad===0&&Number.isSafeInteger(meta.count)&&meta.count>=0&&Number.isSafeInteger(meta.bytes)&&meta.bytes>=0,'Draft references malformed');
  this.slots(3+meta.count*6,meta.bytes*4+128+meta.count*96);
  const rows=this.query('SELECT entity_id,blob_id,CAST(entity_id AS BLOB) AS a,CAST(blob_id AS BLOB) AS b FROM blob_refs WHERE entity_id=? ORDER BY blob_id COLLATE BINARY').all(id) as any[];
  this.need(rows.length===meta.count,'Draft reference inventory changed');const result:string[]=[];
  for(const row of rows){assertHistorySqlKey(row.entity_id,row.a);assertHistorySqlKey(row.blob_id,row.b);this.need(row.entity_id===id,'Draft reference identity changed');result.push(row.blob_id);}return result;
 });}
 /** Closed focus identity inventory. Only prepaid keys leave this method;
  * authenticated payloads are consumed individually through row(). BLOB
  * lookalikes participate in the probe and fail instead of being omitted. */
 focusKeys():readonly string[]{return this.checked(()=>{
  this.slots(2,96);
  const meta=this.scalar("SELECT count(*) AS count,coalesce(sum(length(CAST(id AS BLOB))),0) AS bytes,coalesce(sum(CASE WHEN typeof(id)!='text' OR length(CAST(id AS BLOB))>8192 OR typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991 OR typeof(payload)!='blob' OR length(payload)<28 OR length(payload)>? THEN 1 ELSE 0 END),0) AS bad FROM service_records WHERE substr(CAST(id AS BLOB),1,12)=CAST(? AS BLOB)",[this.p.recordBytes+28,'tasks:focus:']);
  this.need(!!meta&&meta.bad===0&&Number.isSafeInteger(meta.count)&&meta.count>=0&&Number.isSafeInteger(meta.bytes)&&meta.bytes>=meta.count*12,'Task focus inventory metadata malformed');
  const slots=4+meta.count*7,bytes=256+meta.bytes*6+meta.count*160;
  this.need(Number.isSafeInteger(slots)&&Number.isSafeInteger(bytes),'Task focus inventory allocation overflow');
  // Count and raw UTF8 bytes pay for all SQL wrappers, raw bytes, strings,
  // both vectors and per-row validation before the first key is fetched.
  this.slots(slots,bytes);
  const rows=this.query("SELECT id,CAST(id AS BLOB) AS raw FROM service_records WHERE substr(CAST(id AS BLOB),1,12)=CAST(? AS BLOB) ORDER BY CAST(id AS BLOB)").all('tasks:focus:') as {id:string;raw:Uint8Array}[];
  this.need(rows.length===meta.count,'Task focus inventory count changed');
  const result:string[]=[];let consumedBytes=0;let previous:Uint8Array|undefined;
  for(const row of rows){
   assertHistorySqlKey(row.id,row.raw);
   this.need(row.id.startsWith('tasks:focus:')&&row.raw.byteLength<=8192,'Task focus inventory identity changed');
   this.need(!previous||Buffer.compare(previous,row.raw)<0,'Task focus inventory order changed');
   consumedBytes+=row.raw.byteLength;this.need(Number.isSafeInteger(consumedBytes)&&consumedBytes<=meta.bytes,'Task focus inventory bytes changed');
   result.push(row.id);previous=row.raw;
  }
  this.need(consumedBytes===meta.bytes,'Task focus inventory bytes changed');return Object.freeze(result);
 });}
 encrypted(aad:string,value:unknown){return this.checked(()=>{
  this.key(aad);const bytes=historyJsonBytes(value,this.p.recordBytes)+28;
  this.need(Number.isSafeInteger(this.outgoingBytes+bytes)&&this.outgoingBytes+bytes<=this.p.limits.outgoingCipherBytes,'Draft outgoing ciphertext bound');this.outgoingBytes+=bytes;
  this.slots(12,bytes*5+256);const payload=this.p.seal(aad,value);this.guard();this.need(payload.byteLength===bytes,'Draft ciphertext length changed');return payload;
 });}
 taskRawSource(epoch:string){this.guard();return prepareRawTaskSource(this.p.db,this.#budget,this.p.recordBytes,epoch,()=>this.guard());}
 originalOwner(db:DatabaseSync,budget:MutationPlanBudget){this.guard();return db===this.p.db&&budget===this.#budget;}
 close(){this.alive=false;}
}
