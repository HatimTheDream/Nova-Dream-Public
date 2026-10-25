import {z} from 'zod';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {canonical} from '../../packages/domain/contracts.js';
import {assertHistorySqlKey,assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {HistoryRemovalCompositionLimits} from './feed-history-removal-composition.js';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const historyRemovalLimitsSchema=z.object({qualification:z.literal('unqualified'),inventoryRows:positive,selectedRows:positive,
 keyBytes:positive,recordBytes:positive,readCipherBytes:positive,retainedLogicalBytes:positive,retainedEntries:positive,
 predecessorCipherBytes:positive,outgoingCipherBytes:positive,queries:positive,writes:positive}).strict();
export type HistoryRemovalLimits=z.infer<typeof historyRemovalLimitsSchema>;
export const historyRemovalLimits:Readonly<HistoryRemovalLimits>=Object.freeze({qualification:'unqualified',inventoryRows:10000,selectedRows:4096,
 keyBytes:8192,recordBytes:1048576,readCipherBytes:67108864,retainedLogicalBytes:67108864,retainedEntries:100000,
 predecessorCipherBytes:33554432,outgoingCipherBytes:16777216,queries:100000,writes:10000});
export const historyRemovalCompositionLimits:HistoryRemovalCompositionLimits=Object.freeze({qualification:'unqualified',contextBytes:1048576,contextEntries:10000,
 outputBytes:8388608,outputEntries:10000,closure:Object.freeze({qualification:'unqualified',entries:20000,bytes:2097152,queries:40000}),
 plan:Object.freeze({qualification:'unqualified',visited:40000,candidates:2000,receiptBytes:1048576,bytes:16777216,entries:20000})});
type Table='service_records'|'entities'|'history'|'receipts'|'blob_refs';
const keys:Record<Table,readonly string[]>={service_records:['id'],entities:['id','kind','device_id','updated_at'],history:['entity_id'],receipts:['request_id','digest','device_id'],blob_refs:['entity_id','blob_id']};
const identities:Record<Table,readonly string[]>={service_records:['id','revision'],entities:['id','kind','revision','device_id','updated_at'],history:['cursor','entity_id','revision'],receipts:['request_id','digest','device_id'],blob_refs:['entity_id','blob_id']};
export type RemovalRow={table:Table;raw:Record<string,any>;value:any};
type Change={sql:string;args:SQLInputValue[]};
export class HistoryRemovalError extends Error{constructor(public code:string,message:string,public status=409){super(message);}}

/** Private to one Store phase. These counters bound logical data and actual
 * ciphertext copies, not native heap, codec, SQLite or WAL allocation. */
export class HistoryRemovalContext{
 readonly limits:Readonly<HistoryRemovalLimits>;
 private alive=true;private failure?:unknown;private failed=false;private applied=false;
 private counts:Record<string,number>={queries:0,dispositionReserved:8,dispositionExecuted:0};
 private dispositions=new Set<string>();private changes:Change[]=[];private selected=new Set<string>();
 constructor(private db:DatabaseSync,limits:HistoryRemovalLimits,private open:(aad:string,payload:Uint8Array)=>any,private seal:(aad:string,value:unknown)=>Buffer){
  historyJsonBytes(limits,4096);const parsed=historyRemovalLimitsSchema.parse(limits);
  if(canonical(parsed)!==canonical(limits)||parsed.queries<8)throw new HistoryRemovalError('history_removal_bound','Exact removal limits and disposition reservation required',507);
  this.limits=Object.freeze(parsed);this.entry(4);this.logical(8);
 }
 fail(error:unknown):never{if(!this.failed){this.failed=true;this.failure=error;}throw this.failure;}
 guard(){if(!this.alive)throw new HistoryRemovalError('history_removal_expired','Original removal phase has ended');if(this.failed)throw this.failure;}
 checked<T>(run:()=>T):T{this.guard();try{return run();}catch(error){return this.fail(error);}}
 need(value:unknown,message:string,code='history_removal_bound'):asserts value{if(!value)this.fail(new HistoryRemovalError(code,message,code==='history_removal_bound'?507:409));}
 charge(name:string,amount:number,limit:number){this.guard();const next=(this.counts[name]??0)+amount;this.need(Number.isSafeInteger(amount)&&amount>=0&&Number.isSafeInteger(next)&&next<=limit,'Removal '+name+' bound');this.counts[name]=next;}
 entry(n=1){this.charge('entries',n,this.limits.retainedEntries);}
 logical(n:number){this.charge('logicalBytes',n,this.limits.retainedLogicalBytes);}
 query(){this.charge('queries',1,this.limits.queries-8);}
 disposition(kind:'begin'|'commit'|'rollback'){
  // Disposition is a reserved one-shot path: neither exhausted work nor its
  // first failure may prevent the original owner from attempting rollback.
  if(!this.alive||this.dispositions.has(kind))throw new HistoryRemovalError('history_removal_disposition','Removal disposition was already attempted');
  this.dispositions.add(kind);this.counts.dispositionExecuted++;
 }
 stats(){return {...this.counts};}
 close(){this.alive=false;}
 sql(text:string){this.query();return this.db.prepare(text);}
 key(value:string){this.need(typeof value==='string'&&Buffer.byteLength(value,'utf8')<=this.limits.keyBytes,'Removal key bound');assertHistoryUtf8Key(value);this.logical(Buffer.byteLength(value,'utf8'));}
 copy<T>(value:T):T{return this.checked(()=>{
  const bytes=historyJsonBytes(value,this.limits.recordBytes);this.logical(bytes*2);this.entry();const stack:unknown[]=[value];
  while(stack.length){const item=stack.pop();this.entry();if(item&&typeof item==='object')for(const key in item)if(Object.hasOwn(item,key)){this.entry(3);stack.push((item as any)[key]);}}
  return JSON.parse(JSON.stringify(value));
 });}
 reserveComposition(){const l=historyRemovalCompositionLimits;this.logical(l.contextBytes+l.outputBytes+l.closure.bytes+l.plan.bytes);this.entry(l.contextEntries+l.outputEntries+l.closure.entries+l.plan.entries);}
 encrypted(aad:string,value:unknown){return this.checked(()=>{
  const bytes=historyJsonBytes(value,this.limits.recordBytes);this.logical(bytes*2);this.entry();this.charge('outgoingCipherBytes',(bytes+28)*2,this.limits.outgoingCipherBytes);
  const payload=this.seal(aad,value);this.need(payload.length===bytes+28,'Removal outgoing ciphertext length changed');return payload;
 });}
 reserveReceipt(receipt:{requestId:string;deviceId:string;digest:string;value:unknown}){const whole=historyJsonBytes(receipt,this.limits.recordBytes),bytes=historyJsonBytes(receipt.value,this.limits.recordBytes);this.logical(whole*2+bytes);this.entry(whole);this.charge('outgoingCipherBytes',(bytes+28)*2,this.limits.outgoingCipherBytes);}
 /** Fixed SQL selections only; callers are private Store helpers. Scalar
  * lengths/types precede payload allocation and every iterator result. */
 scan(table:Table,where:string,args:SQLInputValue[]=[]):RemovalRow[]{return this.checked(()=>{
  this.need(!this.applied&&this.db.isTransaction,'Removal inventory needs its original transaction','history_removal_context');
  this.entry(24);this.logical(2);const output:RemovalRow[]=[];const encrypted=table!=='blob_refs';
  const keyCheck=keys[table].map(key=>`typeof(${key})!='text' OR length(CAST(${key} AS BLOB))>?`).join(' OR ');
  const metadata=this.sql(`SELECT count(*) AS count,coalesce(sum(CASE WHEN ${keyCheck}${encrypted?" OR typeof(payload)!='blob' OR length(payload)<28 OR length(payload)>?":''}${['service_records','entities','history'].includes(table)?" OR typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991":''}${table==='history'?" OR typeof(cursor)!='integer' OR cursor<1 OR cursor>9007199254740991":''} THEN 1 ELSE 0 END),0) AS bad${encrypted?',coalesce(sum(length(payload)),0) AS bytes':''},coalesce(sum(${keys[table].map(key=>'length(CAST('+key+' AS BLOB))').join('+')}),0) AS keyBytes FROM ${table} WHERE ${where}`).get(...keys[table].map(()=>this.limits.keyBytes),...(encrypted?[this.limits.recordBytes+28]:[]),...args) as any;
  this.need(!metadata.bad&&Number.isSafeInteger(metadata.count)&&metadata.count>=0,'Removal inventory metadata bound');this.charge('inventoryRows',metadata.count,this.limits.inventoryRows);this.need(Number.isSafeInteger(metadata.keyBytes)&&metadata.keyBytes>=0,'Removal aggregate key bound');this.logical(metadata.keyBytes*3);this.entry(metadata.count*(3+keys[table].length));
  if(encrypted){this.need(Number.isSafeInteger(metadata.bytes)&&metadata.bytes>=0,'Removal ciphertext total bound');this.charge('readCipherBytes',metadata.bytes,this.limits.readCipherBytes);this.charge('predecessorCipherBytes',metadata.bytes*2,this.limits.predecessorCipherBytes);this.logical(metadata.bytes*4);this.entry(metadata.bytes);}
  const rawKeys=keys[table].map((key,i)=>`CAST(${key} AS BLOB) AS _key${i}`).join(',');
  this.entry(4);const iterator=this.sql(`SELECT ${identities[table].join(',')}${encrypted?',payload':''},${rawKeys} FROM ${table} WHERE ${where} ORDER BY ${identities[table].join(',')}`).iterate(...args)[Symbol.iterator]();
  try{for(;;){this.entry(2);const next=iterator.next();if(next.done)break;const raw=next.value as Record<string,any>;
   for(let i=0;i<keys[table].length;i++){const key=keys[table][i];assertHistorySqlKey(raw[key],raw['_key'+i]);delete raw['_key'+i];this.logical(Buffer.byteLength(raw[key],'utf8'));}
   if('revision'in raw)this.need(Number.isSafeInteger(raw.revision)&&raw.revision>=1,'Removal revision invalid','history_removal_changed');
   const aad=table==='service_records'?'service:'+raw.id:table==='entities'?'entity:'+raw.id:table==='history'?'history:'+raw.entity_id+':'+raw.revision:'receipt:'+raw.request_id;
   const value=encrypted?this.open(aad,raw.payload):null;if(encrypted)historyJsonBytes(value,this.limits.recordBytes);
   this.entry();output.push({table,raw,value});
  }}finally{iterator.return?.();}return output;
 });}
 service(id:string){this.key(id);return this.scan('service_records','id=?',[id])[0];}
 prefix(prefix:string){this.key(prefix);this.need(prefix.endsWith(':'),'Fixed removal prefix required','history_removal_context');const upper=prefix.slice(0,-1)+';';return this.scan('service_records','id>=? AND id<?',[prefix,upper]);}
 receipt(id:string){this.key(id);return this.scan('receipts','request_id=?',[id])[0];}
 private stage(id:string,sql:string,args:SQLInputValue[]){this.need(!this.applied&&!this.selected.has(id),'Duplicate or applied removal selection','history_removal_changed');this.charge('selectedRows',1,this.limits.selectedRows);this.charge('writes',1,this.limits.writes);this.entry(3+args.length);this.logical(Buffer.byteLength(sql));this.selected.add(id);this.changes.push({sql,args});}
 delete(row:RemovalRow){const cols=identities[row.table],encrypted=row.table!=='blob_refs';this.stage(row.table+':'+JSON.stringify(cols.map(k=>row.raw[k])),`DELETE FROM ${row.table} WHERE ${cols.map(k=>k+'=?').join(' AND ')}${encrypted?' AND payload=?':''}`,[...cols.map(k=>row.raw[k]),...(encrypted?[row.raw.payload]:[])]);}
 writeService(id:string,value:unknown){const prior=this.service(id),payload=this.encrypted('service:'+id,value);this.entry();
  if(prior){this.need(prior.raw.revision<Number.MAX_SAFE_INTEGER,'Removal revision exhausted');this.stage('service-write:'+id,'UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?',[prior.raw.revision+1,payload,id,prior.raw.revision,prior.raw.payload]);}
  else this.stage('service-write:'+id,'INSERT INTO service_records(id,revision,payload) VALUES (?,1,?)',[id,payload]);
 }
 redact(row:RemovalRow,replacement:unknown){this.need(row.table==='receipts','Exact receipt row required','history_removal_context');const payload=this.encrypted('receipt:'+row.raw.request_id,replacement);this.stage('receipt:'+row.raw.request_id,'UPDATE receipts SET payload=? WHERE request_id=? AND digest=? AND device_id=? AND payload=?',[payload,row.raw.request_id,row.raw.digest,row.raw.device_id,row.raw.payload]);}
 metaText(key:'epoch'|'workspace-cursor'){return this.checked(()=>{
  this.need(this.db.isTransaction,'Removal metadata needs its original transaction','history_removal_context');
  this.entry(8);this.logical(128);
  const metadata=this.sql('SELECT typeof(value) AS type,length(CAST(value AS BLOB)) AS bytes FROM meta WHERE key=?').get(key) as {type:string;bytes:number}|undefined;
  if(!metadata)return undefined;
  this.need(metadata.type==='text'&&Number.isSafeInteger(metadata.bytes)&&metadata.bytes>=0&&metadata.bytes<=this.limits.keyBytes,'Removal metadata scalar bound');
  this.logical(metadata.bytes*3);this.entry(3);
  const row=this.sql('SELECT value,CAST(value AS BLOB) AS raw FROM meta WHERE key=?').get(key) as {value:string;raw:Uint8Array};
  this.need(!!row&&row.raw.byteLength===metadata.bytes,'Removal metadata changed','history_removal_changed');assertHistorySqlKey(row.value,row.raw);return {value:row.value};
 });}
 cursor(steps=1){const a=this.metaText('workspace-cursor');this.entry(8);this.logical(128);
  // CASE never returns a variable-size malformed seq value to JavaScript.
  const b=this.sql("SELECT typeof(seq) AS type,CASE WHEN typeof(seq)='integer' AND seq>=0 AND seq<=9007199254740991 THEN seq ELSE NULL END AS seq FROM sqlite_sequence WHERE name='history'").get() as {type:string;seq:number|null}|undefined;
  this.need(!b||b.type==='integer'&&b.seq!==null,'Removal sequence scalar bound');
  const old=Number(a?.value??0),sequence=Number(b?.seq??0);this.need(Number.isSafeInteger(old)&&old>=0&&Number.isSafeInteger(sequence)&&sequence>=0,'Removal cursor invalid');
  const next=Math.max(old,sequence)+steps;this.need(Number.isSafeInteger(steps)&&steps>0&&Number.isSafeInteger(next),'Removal cursor exhausted');this.entry(2);this.logical(String(next).length+(a?.value?.length??0));
  if(a)this.stage('cursor',"UPDATE meta SET value=? WHERE key='workspace-cursor' AND value=?",[String(next),a.value]);else this.stage('cursor',"INSERT INTO meta(key,value) VALUES ('workspace-cursor',?)",[String(next)]);
 }
 apply(){this.checked(()=>{this.need(!this.applied&&this.db.isTransaction,'Removal apply needs original transaction','history_removal_context');this.applied=true;
  for(const change of this.changes){const result=this.sql(change.sql).run(...change.args);this.need(result.changes===1,'Removal predecessor changed','history_removal_changed');}
 });}
}
