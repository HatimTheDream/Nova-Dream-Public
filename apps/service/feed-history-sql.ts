import type {DatabaseSync} from 'node:sqlite';
import {canonical} from '../../packages/domain/contracts.js';
import {historyStorageAad,historyStoreLimitsSchema,type HistoryStoreLimits,type HistoryStoredObject,type HistoryObjectKind} from '../../packages/domain/news-feed-history-storage.js';
import {assertHistorySqlKey,assertHistoryUtf8Key} from '../../packages/domain/news-feed-history-keys.js';
import {verifyHistoryObject,type HistoryInventoryAccess} from './feed-history-inventory.js';
import {historyJsonBytes} from './feed-history-bounds.js';

/** Source preparation only. No caller invokes this DDL on an existing Store. */
export const historyTableDdl=`CREATE TABLE feed_history_objects (
 kind TEXT NOT NULL COLLATE BINARY CHECK(kind IN ('segment','row','request','child','head','stop','span','revision','operation')),
 object_key TEXT NOT NULL COLLATE BINARY CHECK(length(object_key) BETWEEN 1 AND 2048),
 range_key TEXT COLLATE BINARY CHECK((kind='stop' AND range_key IS NOT NULL) OR (kind!='stop' AND range_key IS NULL)),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991), payload BLOB NOT NULL,
 PRIMARY KEY(kind,object_key));
 CREATE INDEX feed_history_range ON feed_history_objects(kind COLLATE BINARY,range_key COLLATE BINARY,object_key COLLATE BINARY);`;
/** Explicit isolated successor DDL; never run against an existing Store. */
export const historySealTableDdl=historyTableDdl.replace("'revision','operation'","'revision','operation','intent','outcome'");
function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
type Open=(aad:string,payload:Uint8Array)=>unknown;
const prefix='news:semantic-';
const objectColumns='kind,CAST(kind AS BLOB) AS kind_bytes,object_key,CAST(object_key AS BLOB) AS key_bytes,range_key,CAST(range_key AS BLOB) AS range_bytes,revision,payload';
const rowColumns='id,CAST(id AS BLOB) AS id_bytes,revision,payload';
const receiptColumns='request_id,CAST(request_id AS BLOB) AS id_bytes,device_id,CAST(device_id AS BLOB) AS device_bytes,digest,payload';

/** Must be called inside the Store-owned synchronous read snapshot. No port,
 * iterator or callback may escape its lexical verifier/export invocation. */
export function readSqlHistory<T>(db:DatabaseSync,open:Open,rawLimits:HistoryStoreLimits,token:()=>string,consume:(access:HistoryInventoryAccess)=>T,expectedSchema:61|62=61,beforeQuery?:()=>void):T{
 const query=(sql:string)=>{beforeQuery?.();return db.prepare(sql);};
 const limits=historyStoreLimitsSchema.parse(rawLimits);need(canonical(limits)===canonical(rawLimits),'Strict history limits required');
 need(db.isTransaction,'History requires a concrete SQLite read snapshot');
 need((query('PRAGMA encoding').get() as any).encoding==='UTF-8','History requires existing UTF-8 SQLite encoding');
 const schema=(query('PRAGMA user_version').get() as any).user_version;need(schema===expectedSchema,'Exact history schema required');
 const columns=query('PRAGMA table_info(feed_history_objects)').all() as any[];
 need(columns.length===5&&columns.every((x,i)=>x.name===['kind','object_key','range_key','revision','payload'][i]&&x.type===['TEXT','TEXT','TEXT','INTEGER','BLOB'][i]&&x.pk===[1,2,0,0,0][i]&&x.notnull===[1,1,0,1,1][i]),'History table schema missing or unsupported');
 const indexes=query('PRAGMA index_list(feed_history_objects)').all() as any[];
 const primary=indexes.find(x=>x.origin==='pk');need(primary,'History primary inventory index missing');
 need(indexes.some(x=>x.name==='feed_history_range'&&x.origin==='c'&&x.unique===0&&x.partial===0),'Complete history range index missing');
 const index=(name:string)=>query(`PRAGMA index_xinfo('${name.replaceAll("'","''")}')`).all() as any[];
 const pk=index(primary.name).filter(x=>x.key===1),range=index('feed_history_range').filter(x=>x.key===1);
 need(pk.length===2&&pk.every((x,i)=>x.name===['kind','object_key'][i]&&x.coll==='BINARY'&&x.desc===0),'History primary key ordering unsupported');
 need(range.length===3&&range.every((x,i)=>x.name===['kind','range_key','object_key'][i]&&x.coll==='BINARY'&&x.desc===0),'History range index missing or unsupported');
 // Bound bytes and keys before SQLite returns large payloads/BLOB keys to JS.
 let encrypted=0,count=0;
 for(const [table,where,args,keys] of [
  ['feed_history_objects','',[],['kind','object_key','range_key']],
  ['service_records',' WHERE substr(id,1,?)=?',[prefix.length,prefix],['id']],
  ['receipts','',[],['request_id','device_id']],
 ] as const){
  const stats=query(`SELECT count(*) AS count,coalesce(sum(length(payload)),0) AS bytes,coalesce(max(length(payload)),0) AS largest,
    coalesce(sum(CASE WHEN typeof(payload)!='blob' THEN 1 ELSE 0 END),0) AS bad FROM ${table}${where}`).get(...args) as any;
  need(Number.isSafeInteger(stats.count)&&Number.isSafeInteger(stats.bytes)&&!stats.bad&&stats.largest<=limits.objectBytes+28,'History encrypted payload type/size bound');
  count+=stats.count;encrypted+=stats.bytes;need(Number.isSafeInteger(encrypted)&&count<=limits.objects&&encrypted<=limits.encryptedBytes,'Complete encrypted history input bound');
  for(const key of keys){const bad=query(`SELECT count(*) AS count FROM ${table}${where}${where?' AND':' WHERE'} ${key} IS NOT NULL AND (typeof(${key})!='text' OR length(CAST(${key} AS BLOB))>8192)`).get(...args) as any;
   need(bad.count===0,'History raw key bound');}
  if(table==='receipts'){
   const bad=query("SELECT count(*) AS count FROM receipts WHERE typeof(digest)!='text' OR length(CAST(digest AS BLOB))!=64 OR length(digest)!=64 OR digest GLOB '*[^0-9a-f]*'").get() as any;
   need(bad.count===0,'History receipt digest metadata bound');
  }else{
   const bad=query(`SELECT count(*) AS count FROM ${table}${where}${where?' AND':' WHERE'} (typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991)`).get(...args) as any;
   need(bad.count===0,'History revision metadata bound');
  }
 }
 let alive=true;const active=()=>need(alive&&db.isTransaction,'History SQL snapshot has ended');
 function object(raw:any):HistoryStoredObject|undefined{active();if(!raw)return;
  assertHistorySqlKey(raw.kind,raw.kind_bytes);assertHistorySqlKey(raw.object_key,raw.key_bytes);
  if(raw.range_key!==null)assertHistorySqlKey(raw.range_key,raw.range_bytes);else need(raw.range_bytes===null,'History NULL range bytes changed');
  const value=verifyHistoryObject(open(historyStorageAad(raw.kind,raw.object_key),raw.payload),limits,schema);
  need(value.kind===raw.kind&&value.key===raw.object_key&&value.rangeKey===raw.range_key&&value.revision===raw.revision,'History authenticated metadata changed');return value;
 }
 function row(raw:any){active();if(!raw)return;assertHistorySqlKey(raw.id,raw.id_bytes);
  return {id:raw.id,revision:raw.revision,value:open(`service:${raw.id}`,raw.payload)};}
 function receipt(raw:any){active();if(!raw)return;assertHistorySqlKey(raw.request_id,raw.id_bytes);assertHistorySqlKey(raw.device_id,raw.device_bytes);
  return {requestId:raw.request_id,deviceId:raw.device_id,digest:raw.digest,value:open(`receipt:${raw.request_id}`,raw.payload)};}
 const access:HistoryInventoryAccess={schema,token:()=>{active();return token();},
  objects:function*(kind?:HistoryObjectKind){active();const q=kind===undefined?`SELECT ${objectColumns} FROM feed_history_objects ORDER BY kind COLLATE BINARY,object_key COLLATE BINARY`:
   `SELECT ${objectColumns} FROM feed_history_objects WHERE kind=? ORDER BY object_key COLLATE BINARY`;
   for(const raw of query(q).iterate(...(kind===undefined?[]:[kind])))yield object(raw)!;},
  object:(kind,key)=>{active();assertHistoryUtf8Key(key);return object(query(`SELECT ${objectColumns} FROM feed_history_objects WHERE kind=? AND object_key=?`).get(kind,key));},
  stops:function*(target){active();assertHistoryUtf8Key(target);for(const raw of query(`SELECT ${objectColumns} FROM feed_history_objects WHERE kind='stop' AND range_key=? ORDER BY object_key COLLATE BINARY`).iterate(target))yield object(raw)!;},
  activeRows:function*(){active();for(const raw of query(`SELECT ${rowColumns} FROM service_records WHERE substr(id,1,?)=? ORDER BY id COLLATE BINARY`).iterate(prefix.length,prefix))yield row(raw)!;},
  activeRow:id=>{active();assertHistoryUtf8Key(id);if(!id.startsWith(prefix))return;return row(query(`SELECT ${rowColumns} FROM service_records WHERE id=?`).get(id));},
  receipts:function*(){active();for(const raw of query(`SELECT ${receiptColumns} FROM receipts ORDER BY request_id COLLATE BINARY`).iterate())yield receipt(raw)!;},
  receipt:id=>{active();assertHistoryUtf8Key(id);return receipt(query(`SELECT ${receiptColumns} FROM receipts WHERE request_id=?`).get(id));}};
 try{
  // Whole wrapper accounting, including unrelated originals and all operations.
  let inputBytes=0;for(const list of [access.objects(),access.activeRows(),access.receipts()])for(const value of list){const size=historyJsonBytes(value,limits.objectBytes);inputBytes+=size;
   need(size<=limits.objectBytes&&Number.isSafeInteger(inputBytes)&&inputBytes<=limits.inputBytes,'Complete decrypted history wrapper bound');}
  const value=consume(access);need(!(value&&typeof(value as any).then==='function'),'History SQL consumer must remain synchronous');active();return value;
 }finally{alive=false;}
}
