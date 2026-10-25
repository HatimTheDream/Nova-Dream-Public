import {Buffer,isUtf8} from 'node:buffer';
import {createHash,type Hash} from 'node:crypto';
import type {DatabaseSync,StatementSync} from 'node:sqlite';
import {types} from 'node:util';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';

type ArrayStatement=StatementSync&{setReturnArrays(value:boolean):void};
type RawRow=[Uint8Array,number,Uint8Array];
type Meta=[number,number,number,number,number];
type Phase='new'|'initial'|'prospective'|'final'|'failed'|'closed';
export type RawTaskCommitment=Readonly<{format:1;sha256:string;rows:number;keyBytes:number;cipherBytes:number}>;

// Exact selected contracts.ts/workspace-records.ts kinds. Checking their raw
// ASCII encodings rejects BLOB, NUL and malformed-UTF8 kind lookalikes before
// any Task-only predicate runs. This is not a permissive CAST-based selector.
const META_SQL=`SELECT count(*),coalesce(sum(CASE WHEN
 typeof(kind)!='text' OR CAST(kind AS BLOB) NOT IN
 (X'6c61796f7574',X'7461736b',X'6472616674',X'70726f6a656374',X'726f7574696e65',
  X'636f6e74616374',X'636f6e74656e74',X'6167656e74',X'61737369676e6d656e74',X'70726f66696c65')
 OR typeof(id)!='text' OR length(CAST(id AS BLOB))<1 OR length(CAST(id AS BLOB))>8192
 OR instr(CAST(id AS BLOB),X'00')!=0
 OR typeof(revision)!='integer' OR revision<1 OR revision>9007199254740991
 OR typeof(payload)!='blob' OR length(payload)<28 OR length(payload)>?
 THEN 1 ELSE 0 END),0),
 coalesce(sum(CASE WHEN CAST(kind AS BLOB)=X'7461736b' THEN 1 ELSE 0 END),0),
 coalesce(sum(CASE WHEN CAST(kind AS BLOB)=X'7461736b' THEN length(CAST(id AS BLOB)) ELSE 0 END),0),
 coalesce(sum(CASE WHEN CAST(kind AS BLOB)=X'7461736b' THEN length(payload) ELSE 0 END),0)
 FROM entities`;
const ROWS_SQL="SELECT CAST(id AS BLOB),revision,payload FROM entities WHERE CAST(kind AS BLOB)=X'7461736b' ORDER BY CAST(id AS BLOB)";
const DOMAIN=Buffer.from('nova-task-raw-source-v1\0','ascii');
const typed=Object.getPrototypeOf(Uint8Array.prototype);
const byteLength=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!;
const arrayBuffer=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!;
const setBytes=Uint8Array.prototype.set;
const compare=Buffer.compare;
const noop=()=>undefined;

/** Read-only feasibility primitive. A digest is data, never permission to
 * write, bootstrap, adopt a catalogue or omit either semantic derivation.
 * The private Store must supply its original transaction/token guard and
 * shared budget. No caller callback executes between a metadata aggregate
 * and its complete native row read. Exact Node22.23.2 SQLite ownership is a
 * qualification dependency; other runtimes are not admitted by this source.
 */
class RawTaskSource {
 readonly #db:DatabaseSync;readonly #budget:MutationPlanBudget;
 readonly #current:()=>void;readonly #recordBytes:number;readonly #epoch:Buffer;
 readonly #frame:Buffer;
 #phase:Phase='new';#busy=false;
 #rows:RawRow[]=[];#meta:Meta|undefined;#change:RawRow|undefined;#index=-1;#insert=false;
 #expected:RawTaskCommitment|undefined;
 constructor(db:DatabaseSync,budget:MutationPlanBudget,recordBytes:number,epoch:string,current:()=>void){
  this.#db=db;this.#budget=budget;this.#recordBytes=recordBytes;this.#current=current;
  // Class/retained fields, initial vector, operation intrinsics, two buffers
  // and immutable port retention. Hash setup is charged per hash below.
  this.#pay(24,1536);
  this.#need(Number.isSafeInteger(recordBytes)&&recordBytes>0&&recordBytes<=Number.MAX_SAFE_INTEGER-28,'Raw Task record limit invalid');
  this.#need(typeof epoch==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(epoch),'Raw Task epoch invalid');
  this.#epoch=Buffer.from(epoch,'ascii');this.#frame=Buffer.alloc(16);
  try{this.#check();Object.freeze(this);}catch(error){this.#abort(error);}
 }
 #need(value:unknown,message:string):asserts value {if(!value)this.#budget.fail(Error(message));}
 #pay(entries:number,bytes:number){
  this.#need(Number.isSafeInteger(entries)&&entries>=0&&Number.isSafeInteger(bytes)&&bytes>=0,'Raw Task reservation overflow');
  for(let n=0;n<entries;n++)this.#budget.entry();this.#budget.reserveBytes(bytes);
 }
 #check(){
  this.#budget.checked(noop);this.#need(this.#db.isTransaction,'Raw Task original transaction ended');
  const phase=this.#phase,busy=this.#busy;this.#current();this.#budget.checked(noop);
  this.#need(this.#db.isTransaction&&this.#phase===phase&&this.#busy===busy,'Raw Task original owner changed');
 }
 #enter(phase:Phase){this.#budget.checked(noop);this.#need(!this.#busy&&this.#phase===phase,'Raw Task phase or reentry refused');this.#busy=true;this.#check();}
 #exit(phase:Phase){this.#check();this.#phase=phase;this.#busy=false;}
 #abort(error:unknown):never{this.#phase='failed';this.#busy=false;this.#rows.length=0;this.#change=undefined;this.#expected=undefined;return this.#budget.fail(error);}
 #statement(sql:string){
  this.#pay(4,512+sql.length*2);this.#budget.query();
  const statement=this.#db.prepare(sql) as ArrayStatement;
  statement.setReadBigInts(false);statement.setReturnArrays(true);return statement;
 }
 #read():{meta:Meta;rows:RawRow[]}{
  // Same private synchronous transaction span: no callback between aggregate,
  // prepayment and .all(). Native ordinary entities table/builtins only.
  // Metadata result array, five conservative numeric-value slots and scratch.
  this.#pay(7,768);
  const meta=this.#statement(META_SQL).get(this.#recordBytes+28) as unknown as Meta;
  this.#need(Array.isArray(meta)&&meta.length===5,'Raw Task metadata shape invalid');
  for(let n=0;n<5;n++)this.#need(Number.isSafeInteger(meta[n])&&meta[n]!>=0,'Raw Task metadata integer invalid');
  this.#need(meta[1]===0&&meta[2]<=meta[0]&&meta[3]>=meta[2]&&meta[4]>=meta[2]*28,'Raw Task full source metadata refused');
  // Eight per row: row array; each BLOB view+ArrayBuffer; returned-array
  // reference; native aggregate reference; conservative revision-number slot.
  // Two fixed slots cover outer rows array and its native vector. Payload/key
  // storage is owned by the pinned SQLite bridge, not a borrowed sqlite view.
  this.#pay(meta[2]*8+2,meta[3]+meta[4]+meta[2]*256+256);
  const rows=this.#statement(ROWS_SQL).all() as unknown as RawRow[];
  this.#need(rows.length===meta[2],'Raw Task source count changed');
  let keys=0,ciphers=0;let previous:Uint8Array|undefined;
  for(let index=0;index<rows.length;index++){
   const row=rows[index]!;
   this.#need(Array.isArray(row)&&row.length===3,'Raw Task native row shape invalid');
   this.#key(row[0]);this.#cipher(row[2]);
   this.#need(Number.isSafeInteger(row[1])&&row[1]>=1,'Raw Task revision invalid');
   this.#need(!previous||compare(previous,row[0])<0,'Raw Task raw identity order invalid');
   keys+=row[0].byteLength;ciphers+=row[2].byteLength;
   this.#need(Number.isSafeInteger(keys)&&Number.isSafeInteger(ciphers)&&keys<=meta[3]&&ciphers<=meta[4],'Raw Task source bytes changed');
   previous=row[0];
  }
  this.#need(keys===meta[3]&&ciphers===meta[4],'Raw Task source totals changed');
  this.#pay(1,64);return {meta,rows};
 }
 #view(value:unknown):asserts value is Uint8Array{
  this.#need(types.isUint8Array(value)&&!types.isProxy(value),'Raw Task native bytes required');
  this.#need(types.isAnyArrayBuffer(arrayBuffer.call(value))&&!types.isSharedArrayBuffer(arrayBuffer.call(value)),'Raw Task owned ordinary buffer required');
 }
 #key(value:unknown):asserts value is Uint8Array{
  this.#view(value);const size=byteLength.call(value);
  this.#need(size>=1&&size<=8192&&isUtf8(value),'Raw Task strict UTF8 identity required');
  for(let n=0;n<size;n++)this.#need(value[n]!==0,'Raw Task NUL identity refused');
 }
 #cipher(value:unknown):asserts value is Uint8Array{
  this.#view(value);const size=byteLength.call(value);
  this.#need(size>=28&&size<=this.#recordBytes+28,'Raw Task ciphertext bound');
 }
 #word(value:number,offset:number){
  this.#need(Number.isSafeInteger(value)&&value>=0,'Raw Task framing integer invalid');
  this.#frame.writeUInt32BE(Math.floor(value/0x100000000),offset);
  this.#frame.writeUInt32BE(value%0x100000000,offset+4);
 }
 #hash(rows:number):Hash{
  this.#pay(4,512);const hash=createHash('sha256');hash.update(DOMAIN);hash.update(this.#epoch);
  this.#word(rows,0);this.#word(0,8);hash.update(this.#frame);return hash;
 }
 #feed(hash:Hash,row:RawRow){
  this.#word(row[0].byteLength,0);this.#word(row[1],8);hash.update(this.#frame);hash.update(row[0]);
  this.#word(row[2].byteLength,0);this.#word(0,8);hash.update(this.#frame);hash.update(row[2]);
 }
 #fact(hash:Hash,rows:number,keys:number,ciphers:number):RawTaskCommitment{
  this.#pay(3,256);return Object.freeze({format:1,sha256:hash.digest('hex'),rows,keyBytes:keys,cipherBytes:ciphers});
 }
 initial():RawTaskCommitment{
  try{
   this.#enter('new');const source=this.#read();this.#rows=source.rows;this.#meta=source.meta;
   this.#pay(0,source.meta[3]+source.meta[4]+source.meta[2]*32);
   const hash=this.#hash(source.rows.length);for(let n=0;n<source.rows.length;n++)this.#feed(hash,source.rows[n]!);
   const fact=this.#fact(hash,source.rows.length,source.meta[3],source.meta[4]);this.#exit('initial');return fact;
  }catch(error){return this.#abort(error);}
 }
 /** One already-validated prepared Task upsert. This copies raw bytes only;
  * it does not validate Task meaning or authorize its effects. Batch upkeep
  * is intentionally unimplemented and must not reset this shared allowance. */
 prospective(id:Uint8Array,expectedRevision:number,payload:Uint8Array):RawTaskCommitment{
  try{
   this.#enter('initial');this.#key(id);this.#cipher(payload);
   this.#need(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0&&expectedRevision<Number.MAX_SAFE_INTEGER,'Raw Task predecessor revision invalid');
   const idBytes=byteLength.call(id),cipherBytes=byteLength.call(payload);
   this.#pay(5,idBytes+cipherBytes+128);
   const key=new Uint8Array(idBytes),cipher=new Uint8Array(cipherBytes);setBytes.call(key,id);setBytes.call(cipher,payload);
   let index=0;while(index<this.#rows.length&&compare(this.#rows[index]![0],key)<0)index++;
   const before=index<this.#rows.length&&compare(this.#rows[index]![0],key)===0?this.#rows[index]:undefined;
   this.#need((before?.[1]??0)===expectedRevision,'Raw Task predecessor changed');
   this.#change=[key,expectedRevision+1,cipher];this.#index=index;this.#insert=!before;
   const count=this.#rows.length+(before?0:1),keys=this.#meta![3]+(before?0:idBytes),bytes=this.#meta![4]-(before?.[2].byteLength??0)+cipherBytes;
   this.#pay(count,keys+bytes+count*32);const hash=this.#hash(count);
   for(let n=0;n<count;n++)this.#feed(hash,this.#expectedRow(n));
   const fact=this.#fact(hash,count,keys,bytes);this.#expected=fact;this.#exit('prospective');return fact;
  }catch(error){return this.#abort(error);}
 }
 #expectedRow(index:number):RawRow{
  if(index===this.#index)return this.#change!;
  return this.#rows[index-(this.#insert&&index>this.#index?1:0)]!;
 }
 final():RawTaskCommitment{
  try{
   this.#enter('prospective');const source=this.#read(),expected=this.#expected!;
   this.#need(source.meta[0]===this.#meta![0]+(this.#insert?1:0)&&source.rows.length===expected.rows&&source.meta[3]===expected.keyBytes&&source.meta[4]===expected.cipherBytes,'Raw Task final inventory differs');
   this.#pay(0,source.meta[3]*3+source.meta[4]*3+source.rows.length*32);
   const hash=this.#hash(source.rows.length);
   for(let n=0;n<source.rows.length;n++){
    const actual=source.rows[n]!,planned=this.#expectedRow(n);
    this.#need(actual[1]===planned[1]&&compare(actual[0],planned[0])===0&&compare(actual[2],planned[2])===0,'Raw Task final exact bytes differ');
    this.#feed(hash,actual);
   }
   const fact=this.#fact(hash,source.rows.length,source.meta[3],source.meta[4]);
   this.#need(fact.sha256===expected.sha256,'Raw Task final commitment differs');this.#exit('final');
   this.#rows.length=0;this.#change=undefined;this.#expected=undefined;return fact;
  }catch(error){return this.#abort(error);}
 }
 close(){this.#rows.length=0;this.#change=undefined;this.#expected=undefined;if(this.#phase!=='failed')this.#phase='closed';}
}

export function prepareRawTaskSource(db:DatabaseSync,budget:MutationPlanBudget,recordBytes:number,epoch:string,current:()=>void){
 return new RawTaskSource(db,budget,recordBytes,epoch,current);
}
