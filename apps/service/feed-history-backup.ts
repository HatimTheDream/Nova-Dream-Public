import {canonical} from '../../packages/domain/contracts.js';
import {historyInventorySchema,historyInventory62Schema,historyStoreLimitsSchema,type HistoryStoreLimits,type HistoryStoredObject} from '../../packages/domain/news-feed-history-storage.js';
import {assertHistoryUtf8Key,compareHistoryKeys} from '../../packages/domain/news-feed-history-keys.js';
import {verifyHistoryInventory,type HistoryInventoryAccess} from './feed-history-inventory.js';
import type {HistoryBackupSnapshot,SealingBackupSnapshot} from '../../packages/domain/workspace-backup.js';
import {workerNativeIdentity} from './worker-plugin/identity.js';
import {historyJsonBytes} from './feed-history-bounds.js';
function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
/** Complete offline validation precedes output-directory creation. This is a
 * held import/readback source path, not a history sealing/retirement writer. */
export function verifyHistoryBackupInventory(value:HistoryBackupSnapshot|SealingBackupSnapshot,rawLimits:HistoryStoreLimits){
 const limits=historyStoreLimitsSchema.parse(rawLimits);need(canonical(limits)===canonical(rawLimits),'Strict history limits required');
 const bytes=(value:unknown)=>historyJsonBytes(value,limits.objectBytes);
 need(value.schema===61||value.schema===62,'Exact supported history backup schema required');
 const raw=value.feedHistory;need(raw.objects.length<=limits.objects,'Backup history object count bound');
 let inputBytes=0,count=0;for(const list of [raw.objects,value.services.filter(r=>r.id.startsWith('news:semantic-')),value.receipts])for(const row of list){
  count++;const size=bytes(row);inputBytes+=size;need(size<=limits.objectBytes&&Number.isSafeInteger(inputBytes)&&inputBytes<=limits.inputBytes&&count<=limits.objects,'Backup complete history wrapper bound');}
 // Account the fresh AES-GCM payload for every wrapped history object, active
 // row value and receipt value. Directory/DB/WAL peak allocation is a later gate.
 let encrypted=0;for(const item of raw.objects)encrypted+=bytes(item)+28;
 for(const row of value.services)if(row.id.startsWith('news:semantic-'))encrypted+=bytes(row.value)+28;
 for(const r of value.receipts)encrypted+=bytes(r.value)+28;
 need(Number.isSafeInteger(encrypted)&&encrypted<=limits.encryptedBytes,'Backup encrypted history bound');
 // Validate every imported SQL key, including unrelated workspace records,
 // before the caller creates a directory or inserts any source row.
 for(const row of value.entities){assertHistoryUtf8Key(row.id);assertHistoryUtf8Key(row.deviceId);}
 for(const row of value.history)assertHistoryUtf8Key(row.entityId);
 for(const row of value.services)assertHistoryUtf8Key(row.id);
 for(const row of value.receipts){assertHistoryUtf8Key(row.requestId);assertHistoryUtf8Key(row.deviceId);}
 for(const row of value.files){assertHistoryUtf8Key(row.id);assertHistoryUtf8Key(row.deviceId);}
 for(const row of value.references){assertHistoryUtf8Key(row.entityId);assertHistoryUtf8Key(row.fileId);}
 const objects=(value.schema===62?historyInventory62Schema:historyInventorySchema).parse(raw).objects;need(canonical(objects)===canonical(raw.objects),'History backup inventory changed while parsing');
 const pair=(a:HistoryStoredObject,b:{kind:string;key:string})=>compareHistoryKeys(a.kind,b.kind)||compareHistoryKeys(a.key,b.key);
 function exact<T>(items:T[],key:string,get:(v:T)=>string):T|undefined{let low=0,high=items.length;while(low<high){const mid=(low+high)>>>1;if(compareHistoryKeys(get(items[mid]),key)<0)low=mid+1;else high=mid;}return items[low]&&get(items[low])===key?items[low]:undefined;}
 // Original backup order is retained; do not sort malformed inputs into validity.
 const rows=value.services.filter(r=>r.id.startsWith('news:semantic-'));
 const access:HistoryInventoryAccess={schema:value.schema,token:()=>`offline:${value.id}`,
  objects:function*(kind){for(const row of objects)if(kind===undefined||row.kind===kind)yield row;},
  object:(kind,key)=>{let low=0,high=objects.length;while(low<high){const mid=(low+high)>>>1;if(pair(objects[mid],{kind,key})<0)low=mid+1;else high=mid;}return objects[low]&&pair(objects[low],{kind,key})===0?objects[low]:undefined;},
  stops:function*(target){for(const row of objects)if(row.kind==='stop'&&row.rangeKey===target)yield row;},
  activeRows:()=>rows,activeRow:id=>exact(rows,id,r=>r.id),receipts:()=>value.receipts,receipt:id=>exact(value.receipts,id,r=>r.requestId)};
 return verifyHistoryInventory(access,limits,workerNativeIdentity);
}
