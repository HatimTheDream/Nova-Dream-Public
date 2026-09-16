import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createDraftFileReader} from '../apps/client/src/dreamclaw/inbox-draft-files';
import type {MailDeliveryFile} from '../packages/domain/mail-delivery';
const fixture=()=>{
 const bytes=Buffer.from('Retained original bytes');
 const file={name:'original.txt',mimeType:'text/plain',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
 const scope={epoch:randomUUID(),operationId:randomUUID(),digest:'a'.repeat(64)},response:MailDeliveryFile={...scope,index:0,sha256:file.sha256,file};
 const {base64:_,...metadata}=file;return {file,metadata,scope,response};
};
test('draft file reads share one verified request and memory cache, with no browser persistence',async()=>{
 const f=fixture();let calls=0;const before=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('Must not persist mail file bytes');}});
 try {
  const reader=createDraftFileReader(f.scope,[f.metadata],async(input)=>{calls++;assert.deepEqual(input,{...f.scope,index:0,sha256:f.file.sha256});return structuredClone(f.response);});
  const [one,two]=await Promise.all([reader.read(0),reader.read(0)]);assert.deepEqual(one,two);assert.equal(calls,1);
  assert.deepEqual(await reader.read(0),f.response);assert.equal(calls,1);reader.dispose();await assert.rejects(reader.read(0),{name:'AbortError'});
 }finally{if(before)Object.defineProperty(globalThis,'localStorage',before);else Reflect.deleteProperty(globalThis,'localStorage');}
});
test('closing or switching a draft aborts pending file reads and rejects late bytes',async()=>{
 const f=fixture();let finish!:(response:MailDeliveryFile)=>void,signal:AbortSignal|undefined;
 const reader=createDraftFileReader(f.scope,[f.metadata],async(_input,abort)=>{signal=abort;return new Promise(resolve=>finish=resolve);});
 const pending=reader.read(0);reader.dispose();assert.equal(signal?.aborted,true);finish(f.response);await assert.rejects(pending,{name:'AbortError'});
 const next={...f.scope,operationId:randomUUID()},other=createDraftFileReader(next,[f.metadata],async()=>f.response);
 await assert.rejects(other.read(0),/does not match/);other.dispose();
});
test('foreign identities, changed file metadata and altered bytes are never cached; explicit retry can recover',async()=>{
 const f=fixture();
 for(const change of [
  {operationId:randomUUID()},{epoch:randomUUID()},{digest:'b'.repeat(64)},{index:1},
  {file:{...f.file,name:'wrong.txt'}},{file:{...f.file,base64:Buffer.from('Different content bytes').toString('base64')}},
  {file:{...f.file,base64:'!!'}},{previewMimeType:'image/svg+xml'},
 ]){
  let calls=0;const reader=createDraftFileReader(f.scope,[f.metadata],async()=>{calls++;return calls===1?{...f.response,...change} as MailDeliveryFile:f.response;});
  await assert.rejects(reader.read(0));assert.deepEqual(await reader.read(0),f.response);assert.equal(calls,2);reader.dispose();
 }
});
