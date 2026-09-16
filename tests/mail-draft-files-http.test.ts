import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {startServer} from '../apps/service/http';
import {Providers,accountCapabilities} from '../apps/service/providers';

test('private draft file HTTP reads enforce session, origin, exact operation and bounded selector without provider traffic',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'e3-draft-file-http-'));let providerCalls=0;
 const server=await startServer({directory,port:0,providers:new Providers((async()=>{providerCalls++;throw Error('No provider request is needed for retained bytes');}) as typeof fetch)});
 try {
  const session=async()=>{const response=await fetch(server.origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1'},body:'{}'});return {cookie:response.headers.get('set-cookie')!.split(';')[0],device:(await response.json()).deviceId};};
  const owner=await session(),other=await session(),epoch=server.store.epoch,id=randomUUID(),accountId=randomUUID(),generation=randomUUID(),digest='a'.repeat(64);
  const bytes=Buffer.from('Private original draft file'),file={name:'private.txt',mimeType:'text/plain',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
  const scopes=['https://www.googleapis.com/auth/gmail.readonly'];
  server.store.internalWrite('accounts:item:'+accountId,{id:accountId,generation,provider:'google',email:'fixture@example.test',state:'connected',scopes,capabilities:accountCapabilities('google',scopes)});
  server.store.internalWrite('mail:delivery:head:'+id,{device:owner.device,review:{id,epoch,accountId,generation,digest}});
  server.store.internalWrite('mail:delivery:content:'+id,{message:{from:'fixture@example.test',to:[],cc:[],bcc:[],subject:'Kept',bodyText:'',attachments:[file]}});
  const input={epoch,operationId:id,digest,index:0,sha256:file.sha256},url=server.origin+'/api/mail/delivery/file';
  const send=(body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1',cookie:owner.cookie,...headers},body:JSON.stringify(body)});
  const good=await send(input);assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store');assert.deepEqual((await good.json()).file,file);
  assert.equal((await send(input,{'X-Edition3-Client':''})).status,403);assert.equal((await send(input,{cookie:''})).status,401);
  assert.equal((await send(input,{origin:'https://foreign.example'})).status,403);assert.equal((await send(input,{cookie:other.cookie})).status,404);
  assert.equal((await send({...input,operationId:randomUUID()})).status,404);assert.equal((await send({...input,index:20})).status,400);
  assert.equal((await send({...input,digest:'b'.repeat(64)})).status,409);assert.equal((await send({...input,url:'https://arbitrary.example/file'})).status,400);
  assert.equal((await fetch(url+'?operationId='+id,{headers:{cookie:owner.cookie}})).status,404);
  assert.equal(providerCalls,0);
 }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});

test('outgoing file HTTP upload and recovery are private, bounded and send no provider requests',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'e3-outgoing-file-http-'));let providerCalls=0;
 const server=await startServer({directory,port:0,providers:new Providers((async()=>{providerCalls++;throw Error('No provider request for selected files');}) as typeof fetch)});
 try{
  const session=await fetch(server.origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1'},body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0];await session.json();
  const bytes=Buffer.from('Private outgoing contents'),file={name:'picked.txt',mimeType:'text/plain',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
  const input={epoch:server.store.epoch,requestId:randomUUID(),file};
  const send=(route:string,body:unknown,headers:Record<string,string>={})=>fetch(server.origin+route,{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Edition3-Client':'1',...headers},body:JSON.stringify(body)});
  assert.equal((await send('/api/mail/files',input,{'X-Edition3-Client':''})).status,403);
  assert.equal((await send('/api/mail/files',input,{cookie:''})).status,401);
  assert.equal((await send('/api/mail/files',input,{origin:'https://foreign.example'})).status,403);
  const result=await send('/api/mail/files',input);assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');const saved=await result.json();assert.equal(saved.id,input.requestId);assert.equal(saved.file.base64,undefined);
  assert.deepEqual(await (await send('/api/mail/files',input)).json(),saved);
  const read={epoch:input.epoch,id:saved.id,sha256:file.sha256,bytes:true};const exact=await send('/api/mail/files/read',read);assert.equal(exact.status,200);assert.deepEqual((await exact.json()).file,file);
  assert.equal((await send('/api/mail/files/read',{...read,sha256:'0'.repeat(64)})).status,409);
  assert.equal((await send('/api/mail/files/read',{...read,url:'https://foreign.example/file'})).status,400);
  assert.equal((await send('/api/mail/files',{...input,requestId:randomUUID(),file:{...file,bytes:10*1024*1024+1}})).status,400);
  assert.equal((await send('/api/mail/files',{...input,requestId:randomUUID(),file:{...file,base64:'Zg='}})).status,400);
  assert.equal(providerCalls,0);
 }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});
