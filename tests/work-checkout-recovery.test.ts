import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CheckoutRequestOwner, sameCheckout, type CheckoutRequest } from '../apps/client/src/work-checkout-client';
import type { WorkCheckout } from '../packages/domain/work-repositories';

const fixtureKey=Symbol.for('nova.test.checkout-recovery'),react=pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader=registerHooks({
  resolve(specifier,context,next){if(specifier==='react'&&context.parentURL?.includes('/apps/client/src/'))return{url:'nova-test:checkout-hooks',shortCircuit:true};return next(specifier,context);},
  load(url,context,next){if(url==='nova-test:checkout-hooks')return{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)}; const h=()=>globalThis[Symbol.for('nova.test.checkout-recovery')];export const useState=v=>h().state(v),useRef=v=>h().ref(v),useEffect=(f,d)=>h().effect(f,d),useCallback=(f,d)=>h().memo(()=>f,d);`};if(url.endsWith('.css'))return{format:'module',source:'',shortCircuit:true};return next(url,context);},
});
const { GitHubRepositoryPicker, RepositoryResults }=await import('../apps/client/src/GitHubRepositoryPicker');
const { GitHubConnection }=await import('../apps/client/src/GitHubConnection');
loader.deregister();
const nodes=(n:any):any[]=>Array.isArray(n)?n.flatMap(nodes):n?.props?[n,...nodes(n.props.children)]:[];
const text=(n:any):string=>Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'';
const button=(tree:any,label:string)=>nodes(tree).find(n=>n.type==='button'&&text(n)===label);
const repo={id:71,fullName:'fixture/original',description:'',private:true,archived:false,canPush:true,defaultBranch:'main'};
const command=(epoch:string=randomUUID()):CheckoutRequest=>({requestId:randomUUID(),epoch,repository:repo.fullName,baseBranch:'main'});
function checkout(cmd:CheckoutRequest,state:WorkCheckout['state']='ready'):WorkCheckout{const id=randomUUID();return{id,repository:repo,branch:`nova/${id.slice(0,12)}`,folder:`C:/synthetic/${id}`,state,message:`Original ${state}`,createdAt:1,accountId:42,operationId:cmd.requestId};}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
function host(initial?:CheckoutRequest,reply?:(body:CheckoutRequest)=>unknown|Promise<unknown>){
  const epoch=initial?.epoch??randomUUID();let props={epoch,deviceId:'device',projectId:'project',onSelect:(c:WorkCheckout)=>{selected.push(c);return selectedAllowed;}},cursor=0,dirty=true,tree:any,selectedAllowed=true,mounted=true;
  const cells:any[]=[],effects:(()=>void)[]=[],storage=new Map<string,string>(),calls:{path:string;body?:CheckoutRequest}[]=[],selected:WorkCheckout[]=[],timers=new Map<number,()=>void>();let timer=0;
  const faults={read:false,write:false,readback:false,onceReadback:false,drop:false,getter:false};
  const key=`e3:work-checkout:${epoch}:device:project`;if(initial)storage.set(key,JSON.stringify(initial));
  let rows:WorkCheckout[]=[],posts=reply??((body:CheckoutRequest)=>checkout(body)),getState:undefined|(()=>Promise<unknown>);
  const io={getItem:(k:string)=>{if(faults.onceReadback){faults.onceReadback=false;throw Error('Synthetic readback failure');}if(faults.read)throw Error('Synthetic read refusal');return storage.get(k)??null;},setItem:(k:string,v:string)=>{if(faults.write)throw Error('Synthetic write refusal');if(!faults.drop)storage.set(k,v);if(faults.readback)faults.onceReadback=true;}};
  const values:Record<PropertyKey,unknown>={
    [fixtureKey]:{
      state(v:any){const i=cursor++;if(!cells[i])cells[i]={value:typeof v==='function'?v():v};return[cells[i].value,(n:any)=>{const next=typeof n==='function'?n(cells[i].value):n;if(!Object.is(next,cells[i].value)){cells[i].value=next;dirty=true;}}];},
      ref(v:any){return cells[cursor++]??={current:v};},
      effect(run:()=>void|(()=>void),deps:unknown[]){const i=cursor++,old=cells[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=run();});}},
      memo(f:()=>unknown,deps:unknown[]){const i=cursor++,old=cells[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n])))cells[i]={deps,value:f()};return cells[i].value;},
    },
    setInterval:(fn:()=>void)=>{const id=++timer;timers.set(id,fn);return id;},clearInterval:(id:number)=>timers.delete(id),
    fetch:async(path:string,init:RequestInit)=>{const body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});let result:unknown;
      if(path==='/api/work/state')result=getState?await getState():{checkouts:rows};else if(path.startsWith('/api/work/repositories?'))result={items:[repo],nextPage:null};else if(path.startsWith('/api/work/branches?'))result={items:[{name:'main'}],nextPage:null};else if(path==='/api/work/checkout'){result=await posts(body);if(result instanceof Response)return result;}else throw Error(`Unexpected ${path}`);
      return new Response(JSON.stringify(result));},
  };
  const originals=Reflect.ownKeys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]as const),originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  for(const k of Reflect.ownKeys(values))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:values[k]});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){if(faults.getter)throw Error('Synthetic denied getter');return io;}});
  const flush=async()=>{for(let pass=0;pass<30;pass++){if(dirty&&mounted){dirty=false;cursor=0;tree=GitHubRepositoryPicker(props);while(effects.length)effects.shift()!();}for(let n=0;n<10;n++)await Promise.resolve();}};
  return{key,epoch,storage,calls,selected,faults,io,get tree(){return tree;},set rows(v:WorkCheckout[]){rows=v;},get rows(){return rows;},set reply(v:typeof posts){posts=v;},set getState(v:typeof getState){getState=v;},set selectedAllowed(v:boolean){selectedAllowed=v;},flush,
    async load(){nodes(tree).find(n=>n.type===GitHubConnection).props.onConnected();await flush();},async chooseRepo(){nodes(tree).find(n=>n.type===RepositoryResults).props.onChoose(repo);await flush();},async click(label:string){const b=button(tree,label);assert.ok(b,`Missing ${label}: ${text(tree)}`);assert.notEqual(b.props.disabled,true);b.props.onClick();await flush();},async poll(){for(const f of timers.values())f();await flush();},async update(next:Partial<typeof props>){props={...props,...next};dirty=true;await flush();},unmount(){mounted=false;for(const c of cells)c?.cleanup?.();},close(){this.unmount();for(const[k,d]of originals)if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);if(originalStorage)Object.defineProperty(globalThis,'localStorage',originalStorage);else Reflect.deleteProperty(globalThis,'localStorage');}};
}

test('mount only observes; unknown original cannot be abandoned or replaced by a prepared result',async()=>{
  const c=command(),app=host(c,()=>checkout(c,'unknown'));app.rows=[checkout(c,'unknown'),checkout(command(c.epoch))];
  try{await app.flush();assert.equal(app.calls.filter(c=>c.body).length,0);assert.equal(button(app.tree,'Choose another checkout'),undefined);assert.equal(button(app.tree,'Use').props.disabled,true);button(app.tree,'Use').props.onClick();await app.flush();assert.equal(app.selected.length,0);assert.equal(app.calls.filter(c=>c.body).length,0);assert.equal(app.storage.get(app.key),JSON.stringify(c));await app.click('Reconcile preparation');assert.deepEqual(app.calls.filter(c=>c.body).map(c=>c.body),[c]);assert.equal(button(app.tree,'Choose another checkout'),undefined);await app.click('Refresh original status');assert.equal(app.calls.filter(c=>c.body).length,1);}finally{app.close();}
});
test('a reopened failed row requires the exact original receipt before explicit retirement',async()=>{
  const c=command(),failed=checkout(c,'failed'),app=host(c,()=>failed);app.rows=[failed];
  try{await app.flush();assert.equal(button(app.tree,'Choose another checkout'),undefined);await app.click('Reconcile preparation');app.faults.write=true;await app.click('Choose another checkout');assert.equal(app.storage.get(app.key),JSON.stringify(c));app.faults.write=false;await app.click('Choose another checkout');assert.equal(app.storage.get(app.key),'null');assert.equal(app.calls.filter(c=>c.body).length,1);}finally{app.close();}
});
test('failed clear readback retries its own exact bytes without another POST or callback',async()=>{
  const c=command(),ready=checkout(c),app=host(c,()=>ready);app.rows=[ready];
  try{await app.flush();await app.click('Reconcile preparation');app.faults.readback=true;await app.click('Use this repository');assert.equal(app.storage.get(app.key),'null');assert.equal(app.selected.length,0);app.faults.readback=false;await app.click('Use this repository');assert.deepEqual(app.selected,[ready]);assert.equal(app.calls.filter(c=>c.body).length,1);}finally{app.close();}
});
test('ready selection clears only a verified original, and parent refusal leaves the prepared checkout reusable',async()=>{
  const c=command(),ready=checkout(c),app=host(c,()=>ready);app.rows=[ready];app.selectedAllowed=false;
  try{await app.flush();assert.equal(button(app.tree,'Use this repository'),undefined);await app.click('Reconcile preparation');await app.click('Use this repository');assert.equal(app.storage.get(app.key),'null');assert.match(text(app.tree),/prepared checkout remains available/);app.selectedAllowed=true;await app.click('Use');assert.deepEqual(app.selected,[ready,ready]);assert.equal(app.calls.filter(c=>c.body).length,1);}finally{app.close();}
});
test('malformed, wrong-epoch and denied storage retain original bytes and refuse prepared admission',async()=>{
  for(const mode of ['syntax','shape','epoch','read','getter']as const){const app=host();const raw=mode==='syntax'?'original {':mode==='shape'?JSON.stringify({...command(app.epoch),unexpected:true}):JSON.stringify(command(randomUUID()));app.storage.set(app.key,raw);app.rows=[checkout(command(app.epoch))];app.faults.read=mode==='read';app.faults.getter=mode==='getter';try{await app.flush();assert.ok(button(app.tree,'Read kept request again'));button(app.tree,'Use').props.onClick();await app.flush();assert.equal(app.storage.get(app.key),raw);assert.equal(app.selected.length,0);assert.equal(app.calls.filter(c=>c.body).length,0);}finally{app.close();}}
});
test('new request readback failure keeps the same UUID and dispatches only after a successful local retry',async()=>{
  const app=host();try{await app.flush();await app.load();await app.chooseRepo();app.faults.readback=true;await app.click('Prepare on host');const kept=JSON.parse(app.storage.get(app.key)!);assert.equal(app.calls.filter(c=>c.body).length,0);app.faults.readback=false;await app.click('Reconcile preparation');assert.deepEqual(app.calls.filter(c=>c.body).map(c=>c.body),[kept]);}finally{app.close();}
});
test('network uncertainty and terminal admission errors retain the original exact request',async()=>{
  for(const code of ['host_unavailable','work_preparing','github_disconnected']){const c=command(),app=host(c,()=>new Response(JSON.stringify({code,message:'Synthetic refusal'}),{status:409}));try{await app.flush();await app.click('Reconcile preparation');assert.equal(app.storage.get(app.key),JSON.stringify(c));assert.equal(button(app.tree,'Choose another checkout'),undefined);await app.click('Reconcile preparation');assert.deepEqual(app.calls.filter(c=>c.body).map(c=>c.body),[c,c]);}finally{app.close();}}
});
test('wrong operation, repository and malformed ready replies cannot authorize selection or clearing',async()=>{
  for(const change of ['operation','repository','branch','shape']as const){const c=command(),ready=checkout(c),bad:any=structuredClone(ready);if(change==='operation')bad.operationId=randomUUID();if(change==='repository')bad.repository.fullName='fixture/other';if(change==='branch')bad.branch='main';if(change==='shape')delete bad.folder;const app=host(c,()=>bad);app.rows=[ready];try{await app.flush();await app.click('Reconcile preparation');assert.equal(button(app.tree,'Use this repository'),undefined);assert.equal(app.storage.get(app.key),JSON.stringify(c));assert.equal(app.selected.length,0);}finally{app.close();}}
});
test('a late original response cannot replace a newer raw request or select its checkout',async()=>{
  const c=command(),wait=deferred<WorkCheckout>(),app=host(c,()=>wait.promise);try{await app.flush();await app.click('Reconcile preparation');const newer=JSON.stringify(command(c.epoch));app.storage.set(app.key,newer);wait.resolve(checkout(c));await app.flush();assert.equal(app.storage.get(app.key),newer);button(app.tree,'Use this repository')?.props.onClick();await app.flush();assert.equal(app.selected.length,0);assert.equal(app.storage.get(app.key),newer);}finally{app.close();}
});
test('late response and saved callbacks are fenced after device, project, epoch changes and unmount',async()=>{
  for(const change of ['device','project','epoch','unmount']as const){const c=command(),wait=deferred<WorkCheckout>(),app=host(c,()=>wait.promise);try{await app.flush();const old=button(app.tree,'Reconcile preparation');await app.click('Reconcile preparation');if(change==='unmount')app.unmount();else await app.update(change==='device'?{deviceId:'other'}:change==='project'?{projectId:'other'}:{epoch:randomUUID()});wait.resolve(checkout(c));await app.flush();old.props.onClick();await app.flush();assert.equal(app.calls.filter(c=>c.body).length,1);assert.equal(app.selected.length,0);assert.equal(app.storage.get(app.key),JSON.stringify(c));}finally{app.close();}}
});
test('a departed owner cannot finish an in-flight ready selection',async()=>{
  const c=command(),ready=checkout(c),wait=deferred<unknown>(),app=host(c,()=>ready);app.rows=[ready];try{await app.flush();await app.click('Reconcile preparation');app.getState=()=>wait.promise;await app.click('Use this repository');app.unmount();wait.resolve({checkouts:[ready]});await app.flush();assert.equal(app.selected.length,0);assert.equal(app.storage.get(app.key),JSON.stringify(c));}finally{app.close();}
});
test('known reply survives a read failure; matching status refresh uses no second checkout POST',async()=>{
  const c=command(),preparing=checkout(c,'preparing'),app=host(c,()=>{app.faults.read=true;return preparing;});app.rows=[preparing];try{await app.flush();await app.click('Reconcile preparation');app.faults.read=false;await app.click('Refresh original status');assert.equal(app.calls.filter(c=>c.body).length,1);const ready={...preparing,state:'ready' as const,folder:'C:/realpath/original'};app.rows=[ready];await app.poll();assert.ok(button(app.tree,'Use this repository'));await app.click('Use this repository');assert.deepEqual(app.selected,[ready]);}finally{app.close();}
});
test('explicit original refresh accepts preparing to canonical ready without a background poll',async()=>{
  const c=command(),preparing=checkout(c,'preparing'),app=host(c,()=>preparing);app.rows=[preparing];
  try{await app.flush();await app.click('Reconcile preparation');const ready={...preparing,state:'ready'as const,folder:'C:/canonical/original'};app.rows=[ready];await app.click('Refresh original status');assert.ok(button(app.tree,'Use this repository'));assert.equal(app.calls.filter(c=>c.body).length,1);await app.click('Use this repository');assert.deepEqual(app.selected,[ready]);assert.equal(app.storage.get(app.key),'null');}finally{app.close();}
});
test('original status refuses a reversed canonical ready to old preparing folder transition',()=>{
  const c=command(),preparing=checkout(c,'preparing'),ready={...preparing,state:'ready'as const,folder:'C:/canonical/original'},raw=JSON.stringify(c),map=new Map([['key',raw]]);
  const owner=new CheckoutRequestOwner('key',c.epoch,()=>true,{getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v);}});
  owner.accept(c,ready);assert.throws(()=>owner.originalStatus([preparing]),/Reconcile/);assert.deepEqual(owner.known,ready);assert.equal(map.get('key'),raw);
});
test('final original identity refuses changed account, branch, checkout, folder or status before Use',async()=>{
  for(const change of ['account','branch','checkout','folder','state']as const){const c=command(),ready=checkout(c),app=host(c,()=>ready);app.rows=[ready];try{await app.flush();await app.click('Reconcile preparation');const other={...ready};if(change==='account')other.accountId++;if(change==='branch')other.branch='nova/other';if(change==='checkout'){other.id=randomUUID();other.branch=`nova/${other.id.slice(0,12)}`;}if(change==='folder')other.folder='C:/other';if(change==='state')other.state='unknown';app.rows=[other];await app.click('Use this repository');assert.equal(app.selected.length,0);assert.equal(app.storage.get(app.key),JSON.stringify(c));}finally{app.close();}}
});
test('local owner never clears preparing/unknown work and can recover denied initial reads without writing',()=>{
  const c=command(),raw=JSON.stringify(c),map=new Map([['key',raw]]);let denied=true;const io={getItem:(k:string)=>{if(denied)throw Error();return map.get(k)??null;},setItem:(k:string,v:string)=>map.set(k,v)};
  const owner=new CheckoutRequestOwner('key',c.epoch,()=>true,io);assert.ok(owner.error);assert.throws(()=>owner.retain(c));assert.equal(owner.pending,undefined);denied=false;owner.read();assert.deepEqual(owner.pending,c);for(const state of ['preparing','unknown']as const){const result=checkout(c,state);const fresh=new CheckoutRequestOwner('key',c.epoch,()=>true,io);fresh.accept(c,result);assert.throws(()=>fresh.clearCompleted(result,'failed'));assert.equal(map.get('key'),raw);}assert.equal(sameCheckout(checkout(c),checkout(c)),false);
});
