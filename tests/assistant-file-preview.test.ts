import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readPreviewBytes, previewByteLimit } from '../apps/client/src/assistant-preview-reader';
import type { Attachment } from '../packages/domain/contracts';

const utf8=(s:string)=>new TextEncoder().encode(s),sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function stream(chunks:Uint8Array[],headers:Record<string,string>={},failure?:Error){
  let index=0,cancelled=0,pulls=0;
  const body=new ReadableStream<Uint8Array>({pull(c){pulls++;if(index<chunks.length)c.enqueue(chunks[index++]);else if(failure)c.error(failure);else c.close();},cancel(){cancelled++;}}, {highWaterMark:0});
  const response=new Response(body,{headers});Object.defineProperty(response,'arrayBuffer',{value:()=>{throw Error('Unbounded read is forbidden');}});
  return{response,get pulls(){return pulls;},get cancelled(){return cancelled;}};
}
const signal=()=>new AbortController().signal;
test('bounded reader accepts exact chunked bytes, zero length and the existing8MiB ceiling without arrayBuffer',async()=>{
  const s=stream([utf8('ab'),utf8('cd')],{'content-length':'4'});assert.deepEqual(await readPreviewBytes(s.response,4,signal()),utf8('abcd'));assert.equal(s.response.body!.locked,false);assert.equal(s.cancelled,0);
  assert.equal((await readPreviewBytes(new Response(null, {headers:{'content-length':'0'}}),0,signal())).length,0);
  const data=new Uint8Array(previewByteLimit);data[data.length-1]=17;const max=stream([data],{'content-length':String(data.length)});const read=await readPreviewBytes(max.response,data.length,signal());assert.equal(read.length,previewByteLimit);assert.equal(read.at(-1),17);
});
test('invalid expected size or declared length refuses before reading and cancels the body',async()=>{
  for(const [size,length]of [[-1,'1'],[1.5,'1'],[previewByteLimit+1,'1'],[1,'-1'],[1,'NaN'],[1,'9007199254740993'],[1,String(previewByteLimit+1)],[2,'1'],[1,'2']]as const){const s=stream([utf8('x')],{'content-length':length});await assert.rejects(readPreviewBytes(s.response,size,signal()));assert.equal(s.pulls,0);assert.equal(s.cancelled,1);assert.equal(s.response.body!.locked,false);}
});
test('actual stream overrun and truncation cannot escape exact saved length even without a header',async()=>{
  for(const chunks of [[utf8('abcd')],[utf8('a'),utf8('bcd')]]){const s=stream(chunks);await assert.rejects(readPreviewBytes(s.response,3,signal()),/exceeds/);assert.equal(s.cancelled,1);assert.equal(s.response.body!.locked,false);}
  const short=stream([utf8('ab')]);await assert.rejects(readPreviewBytes(short.response,3,signal()),/incomplete/);assert.equal(short.response.body!.locked,false);
  await assert.rejects(readPreviewBytes(new Response(null),1,signal()),/body is unavailable/);
});
test('compressed transfer length is distinct from exact decoded size but remains bounded',async()=>{
  const s=stream([utf8('abc')],{'content-encoding':'gzip','content-length':'5'});assert.deepEqual(await readPreviewBytes(s.response,3,signal()),utf8('abc'));
  const tooBig=stream([utf8('abc')],{'content-encoding':'br','content-length':String(previewByteLimit+1)});await assert.rejects(readPreviewBytes(tooBig.response,3,signal()));assert.equal(tooBig.pulls,0);assert.equal(tooBig.cancelled,1);
});
test('read refusal releases its lock; abort closes a pending read without awaiting a stuck cancel promise',async()=>{
  const failed=stream([],{},Error('Synthetic stream failure'));await assert.rejects(readPreviewBytes(failed.response,3,signal()),/Synthetic stream/);assert.equal(failed.response.body!.locked,false);
  let cancels=0;const pending=new ReadableStream<Uint8Array>({pull(){},cancel(){cancels++;return new Promise(()=>{});}},{highWaterMark:0}),controller=new AbortController();
  const read=readPreviewBytes(new Response(pending),3,controller.signal);controller.abort();await assert.rejects(read,{name:'AbortError'});assert.equal(cancels,1);assert.equal(pending.locked,false);
});
test('HTTP refusal and already-aborted requests cancel without consuming body data',async()=>{
  let cancelled=0;const body=new ReadableStream<Uint8Array>({cancel(){cancelled++;}},{highWaterMark:0});await assert.rejects(readPreviewBytes(new Response(body,{status:403}),3,signal()),/could not be opened/);assert.equal(cancelled,1);assert.equal(body.locked,false);
  const s=stream([utf8('abc')]),c=new AbortController();c.abort();await assert.rejects(readPreviewBytes(s.response,3,c.signal),{name:'AbortError'});assert.equal(s.pulls,0);assert.equal(s.cancelled,1);
});

const fixtureKey=Symbol.for('nova.test.file-preview'),react=pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader=registerHooks({resolve(s,c,next){if(s==='react'&&c.parentURL?.includes('/apps/client/src/'))return{url:'nova-test:preview-hooks',shortCircuit:true};return next(s,c);},load(u,c,next){if(u==='nova-test:preview-hooks')return{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};const h=()=>globalThis[Symbol.for('nova.test.file-preview')];export const useState=v=>h().state(v),useRef=v=>h().ref(v),useEffect=(f,d)=>h().effect(f,d);`};if(u.endsWith('.css'))return{format:'module',source:'',shortCircuit:true};return next(u,c);}});
const {AssistantFilePreview}=await import('../apps/client/src/AssistantFilePreview');loader.deregister();
const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):n?.props?[n,...nodes(n.props.children)]:[];
const text=(n:any):string=>Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'';
const attachment=(name:string,data:Uint8Array):Attachment=>({id:randomUUID(),name,size:data.length,sha256:sha(data)});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
function host(initial:Attachment,respond:(url:string,init:RequestInit)=>Response|Promise<Response>){
  let file=initial,cursor=0,dirty=true,mounted=true,tree:any;const cells:any[]=[],effects:(()=>void)[]=[],calls:{url:string;init:RequestInit}[]=[],created:{url:string;blob:Blob}[]=[],revoked:string[]=[];
  const values:Record<PropertyKey,unknown>={
    [fixtureKey]:{state(v:any){const i=cursor++;if(!cells[i])cells[i]={value:typeof v==='function'?v():v};return[cells[i].value,(n:any)=>{const next=typeof n==='function'?n(cells[i].value):n;if(!Object.is(next,cells[i].value)){cells[i].value=next;dirty=true;}}];},ref(v:any){return cells[cursor++]??={current:v};},effect(run:()=>void|(()=>void),deps:unknown[]){const i=cursor++,old=cells[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=run();});}}},
    fetch:async(url:string,init:RequestInit)=>{calls.push({url,init});return respond(url,init);},
  };
  const originals=Reflect.ownKeys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]as const),create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  for(const k of Reflect.ownKeys(values))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:values[k]});URL.createObjectURL=(blob:Blob)=>{const url=`blob:controlled-${created.length}`;created.push({url,blob});return url;};URL.revokeObjectURL=url=>{revoked.push(url);};
  const flush=async(until?:()=>boolean)=>{const deadline=performance.now()+5000;for(let i=0;until||i<25;i++){if(dirty&&mounted){dirty=false;cursor=0;tree=AssistantFilePreview({file});while(effects.length)effects.shift()!();}if(until?.())return;if(until)assert.ok(performance.now()<deadline,'Preview did not reach the expected state within5seconds');await new Promise<void>(r=>until?setTimeout(r,1):setImmediate(r));}};
  return{calls,created,revoked,get tree(){return tree;},flush,async ready(){await flush(()=>nodes(tree).some(n=>['pre','img','p'].includes(n.type)));},async update(next:Attachment){file=next;dirty=true;await flush();},unmount(){mounted=false;for(const c of cells)c?.cleanup?.();},close(){this.unmount();URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const[k,d]of originals)if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}};
}
test('actual preview verifies original saved bytes and SHA before showing text; download remains the fallback',async()=>{
  const data=utf8('Original exact text'),file=attachment('original.txt',data),app=host(file,()=>stream([data],{'content-length':String(data.length)}).response);
  try{await app.ready();assert.equal(nodes(app.tree).find(n=>n.type==='pre').props.children,'Original exact text');assert.equal(app.calls[0].url,`/api/attachments/${file.id}?preview=1`);assert.equal(app.calls[0].init.credentials,'same-origin');assert.equal(app.created.length,0);}finally{app.close();}
  for(const mode of ['hash','invalid-text','unsupported']as const){const bytes=mode==='invalid-text'?new Uint8Array([255]):data,f=attachment(mode==='unsupported'?'original.pdf':'original.txt',bytes);if(mode==='hash')f.sha256='0'.repeat(64);const h=host(f,()=>stream([bytes]).response);try{await h.ready();assert.equal(nodes(h.tree).find(n=>n.type==='pre'),undefined);assert.match(text(h.tree),mode==='hash'?/version could not be verified/:/Download/);}finally{h.close();}}
});
test('oversized or invalid saved metadata refuses before any fetch and keeps an original-download explanation',async()=>{
  for(const change of ['large','hash','size']as const){const f=attachment('original.txt',utf8('abc'));if(change==='large')f.size=previewByteLimit+1;if(change==='hash')f.sha256='bad';if(change==='size')f.size=-1;const app=host(f,()=>{throw Error('Must not fetch');});try{await app.flush();assert.equal(app.calls.length,0);assert.match(text(app.tree),/Download the original/);}finally{app.close();}}
});
test('old image errors cannot alter the next file and each original object URL is revoked',async()=>{
  const data=utf8('synthetic image bytes'),first=attachment('one.png',data),second=attachment('two.png',data),app=host(first,()=>stream([data],{'content-type':'image/png'}).response);
  try{await app.ready();const old=nodes(app.tree).find(n=>n.type==='img');assert.equal(old.props.alt,first.name);await app.update(second);await app.ready();const current=nodes(app.tree).find(n=>n.type==='img');assert.equal(current.props.alt,second.name);assert.notEqual(current.props.src,old.props.src);old.props.onError();await app.flush();assert.equal(nodes(app.tree).find(n=>n.type==='img').props.src,current.props.src);assert.deepEqual(app.revoked,[old.props.src]);current.props.onError();await app.flush();assert.match(text(app.tree),/image could not be displayed/);assert.deepEqual(app.revoked,[old.props.src,current.props.src]);app.unmount();assert.equal(app.revoked.length,2);}finally{app.close();}
});
test('late fetch for an old file is cancelled and cannot replace current saved text',async()=>{
  const oldBytes=utf8('old'),newBytes=utf8('current'),old=attachment('old.txt',oldBytes),current=attachment('current.txt',newBytes),wait=deferred<Response>(),app=host(old,url=>url.includes(old.id)?wait.promise:stream([newBytes]).response);
  try{await app.flush();await app.update(current);await app.ready();assert.equal(app.calls[0].init.signal!.aborted,true);const late=stream([oldBytes]);wait.resolve(late.response);await app.flush();assert.equal(nodes(app.tree).find(n=>n.type==='pre').props.children,'current');assert.equal(late.cancelled,1);assert.equal(app.created.length,0);}finally{app.close();}
});
test('same ID with a different saved hash/name fences old digest completion and image callbacks',{timeout:5000},async t=>{
  const firstData=utf8('first'),nextData=utf8('next'),first=attachment('first.png',firstData),next={...attachment('next.txt',nextData),id:first.id};
  const firstStarted=deferred<void>(),nextStarted=deferred<void>(),firstDigest=deferred<ArrayBuffer>(),nextDigest=deferred<ArrayBuffer>();let count=0;
  const digestBytes=(data:Uint8Array)=>Uint8Array.from(createHash('sha256').update(data).digest()).buffer;
  t.mock.method(crypto.subtle,'digest',async(algorithm:AlgorithmIdentifier,data:BufferSource)=>{
    assert.equal(algorithm,'SHA-256');const previous=count++===0;
    assert.deepEqual(data,previous?firstData:nextData);(previous?firstStarted:nextStarted).resolve();
    return(previous?firstDigest:nextDigest).promise;
  });
  const app=host(first,()=>stream([count===0?firstData:nextData],{'content-type':count===0?'image/png':'application/octet-stream'}).response);
  try{
    await app.flush();await firstStarted.promise;await app.update(next);await nextStarted.promise;
    assert.equal(count,2);assert.equal(nodes(app.tree).find(n=>n.type==='pre'),undefined,'current text waits for its own digest');
    let settled=false;const ready=app.ready().then(()=>{settled=true;});await app.flush();assert.equal(settled,false,'readiness must wait for the actual digest');nextDigest.resolve(digestBytes(nextData));await ready;
    assert.equal(nodes(app.tree).find(n=>n.type==='pre').props.children,'next');
    firstDigest.resolve(digestBytes(firstData));await app.flush();
    assert.equal(nodes(app.tree).find(n=>n.type==='pre').props.children,'next');assert.equal(app.created.length,0);
  }finally{app.close();}
});
test('unmount aborts pending body, releases reader, and never publishes a preview afterward',async()=>{
  let cancelled=0;const body=new ReadableStream<Uint8Array>({pull(){},cancel(){cancelled++;}},{highWaterMark:0}),app=host(attachment('pending.txt',utf8('abc')),()=>new Response(body));
  try{await app.flush();assert.equal(body.locked,true);app.unmount();await app.flush();assert.equal(app.calls[0].init.signal!.aborted,true);assert.equal(body.locked,false);assert.equal(cancelled,1);assert.equal(app.created.length,0);}finally{app.close();}
});
test('the finite preview deadline cancels its pending body and exposes the original-download fallback',async t=>{
  const timeout=new AbortController();t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{assert.equal(milliseconds,30000);return timeout.signal;});
  let cancelled=0;const body=new ReadableStream<Uint8Array>({pull(){},cancel(){cancelled++;}},{highWaterMark:0}),app=host(attachment('pending.txt',utf8('abc')),()=>new Response(body));
  try{await app.flush();timeout.abort(new DOMException('Synthetic preview timeout','TimeoutError'));await app.flush();assert.match(text(app.tree),/Preview took too long.*Download/);assert.equal(body.locked,false);assert.equal(cancelled,1);assert.equal(app.created.length,0);}finally{app.close();}
});
test('supported text is bounded visually without changing the verified original download bytes',async()=>{
  const bytes=utf8('a'.repeat(200005)),app=host(attachment('long.txt',bytes),()=>stream([bytes]).response);
  try{await app.ready();assert.equal(nodes(app.tree).find(n=>n.type==='pre').props.children.length,200000);assert.match(text(app.tree),/Download includes the full file/);}finally{app.close();}
});
