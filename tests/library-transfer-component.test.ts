import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { HomeLibraryController } from '../apps/client/src/HomeLibrary';
import type { HomeLibraryCommand, HomeLibraryReceipt } from '../packages/domain/home-library';
import { LibraryTransferDraftOwner, type LibraryTransferDraft } from '../apps/client/src/library-transfer-draft';
import { buildLibraryPortable } from '../packages/domain/home-library-portable';

const scope = { deviceId: 'device:transfer', epoch: '11111111-1111-4111-8111-111111111111', windowId: 'window:transfer' };
const at = '2026-10-20T12:00:00.000Z';
const collection = { id: 'collection:one', revision: 1, updatedAt: at, title: 'Original collection', subtitle: '', icon: 'folder' as const, pinned: false, archived: false, references: [] };
const proposal = (): LibraryTransferDraft => ({ file: { name: 'kept.json', sha256: 'a'.repeat(64), format: 'nova-json', entries: 1, unsupported: 0, archived: 0 }, destination: { id: collection.id, expectedRevision: 1 }, rows: [{ position: 0, rowId: 'row:one', id: 'library:one', selected: true, value: { kind: 'note', title: 'Original writing', body: 'Keep all text', archived: false } }] });
const symbol = Symbol.for('nova.test.library-transfer'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (context.parentURL?.includes('/LibraryTransfer.')) {
   if (specifier === 'react') return { url: 'nova-transfer-test:react', shortCircuit: true };
   if (specifier === './home-draft-navigation') return { url: 'nova-transfer-test:guard', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url === 'nova-transfer-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.library-transfer')];export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'nova-transfer-test:guard') return { format: 'module', shortCircuit: true, source: `export const registerHomeDraftNavigation=fn=>{const f=globalThis[Symbol.for('nova.test.library-transfer')];f.guard=fn;return()=>{f.guard=undefined;};};` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { LibraryTransfer } = await import('../apps/client/src/LibraryTransfer');loader.deregister();
class Hooks {
 slots: any[] = []; index = 0; pending: (() => void)[] = []; guard?: () => boolean; values = new Map<string, string>(); failWrite = false; deny = false;
 state(value: any) { const n=this.index++;if (!(n in this.slots)) this.slots[n]=typeof value==='function'?value():value;return [this.slots[n],(v:any)=>{this.slots[n]=typeof v==='function'?v(this.slots[n]):v;}]; }
 ref(value: any) { const n=this.index++;return this.slots[n]??={current:value}; }
 effect(fn: () => (() => void) | void, deps: any[]) { const n=this.index++,old=this.slots[n];if(!old||deps.some((v,i)=>v!==old.deps[i]))this.pending.push(()=>{old?.cleanup?.();this.slots[n]={deps,cleanup:fn()};}); }
 io = { getItem: (key: string) => this.values.get(key)??null, setItem: (key: string,value: string) => {if(this.failWrite)throw Error('Storage refused');this.values.set(key,value);} };
 render<T>(fn: () => T) { (globalThis as any)[symbol]=this;Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{if(this.deny)throw Error('Denied getter');return this.io;}});this.index=0;this.pending=[];const tree=fn();for(const run of this.pending)run();return tree; }
 seed(value=proposal()) { const owner=new LibraryTransferDraftOwner(this.io,scope,()=>true);assert.equal(owner.begin(value),true);return owner.key; }
 close() {for(const slot of this.slots)slot?.cleanup?.();}
}
const nodes = (value:any):any[] => Array.isArray(value)?value.flatMap(nodes):value?.props?[value,...nodes(value.props.children)]:[];
const text = (value:any):string => Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
const button = (tree:any,label:string) => nodes(tree).find(n=>n.type==='button'&&text(n)===label);
const dialog = (tree:any) => nodes(tree).find(n=>n.props.title==='Import Library File'||n.props.title==='Export Library Collection');
function controller(run: HomeLibraryController['run']): HomeLibraryController { return {state:{epoch:scope.epoch,collections:[collection],items:[],resources:[],ideaPreferences:{revision:0,saved:[],hidden:[]},organization:{revision:0,collectionIds:[collection.id]}},busy:false,pending:undefined,error:'',journalError:'',lastSave:undefined,loading:false,load:async()=>{},run}; }
const request = () => ({...scope,nonce:crypto.randomUUID(),kind:'import'as const});
const tick = async () => {for(let n=0;n<4;n++)await new Promise<void>(done=>setImmediate(done));};
function reply(input: Extract<HomeLibraryCommand,{type:'items-capture'}>):HomeLibraryReceipt {
 const ref={kind:'note'as const,id:input.rows[0].id,revision:1};return {format:1,type:'items-capture',epoch:scope.epoch,operationId:input.requestId,appliedAt:at,changed:true,
 outcomes:[{rowId:input.rows[0].rowId,reference:ref,disposition:'created-and-added'}],createdItems:[{...input.rows[0].value,kind:'note',id:ref.id,revision:1,updatedAt:at}],collections:[{...collection,revision:2,references:[ref]}],undo:{operationId:input.requestId,expected:{collections:[{id:collection.id,expectedRevision:2}],organizationRevision:null}}};
}
test('actual import component keeps failed writing on Close and Home departure, then resumes without a command',()=>{
 const f=new Hooks();f.seed();let commands=0;const props={scope,controller:controller(async()=>{commands++;return undefined;}),request:request(),acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
 try {render();let tree=render();f.failWrite=true;nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'Newer unsaved words'}});tree=render();dialog(tree).props.close();assert.ok(dialog(render()));assert.equal(f.guard!(),false);assert.equal(nodes(render()).find(n=>n.type==='textarea').props.value,'Newer unsaved words');f.failWrite=false;assert.equal(f.guard!(),true);dialog(render()).props.close();tree=render();assert.equal(dialog(tree),undefined);button(tree,'Resume Import Review').props.onClick();assert.equal(nodes(render()).find(n=>n.type==='textarea').props.value,'Newer unsaved words');assert.equal(commands,0);}finally{f.close();}
});
test('actual known save with refused local acknowledgement cannot generate a second command; newer writing remains',async()=>{
 const f=new Hooks();f.seed();let commands=0, sent!:Extract<HomeLibraryCommand,{type:'items-capture'}>,resolve!:(v:HomeLibraryReceipt)=>void;
 const props={scope,controller:controller(async input=>{commands++;sent=input as typeof sent;return new Promise(done=>{resolve=done;});}),request:request(),acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
 try {render();let tree=render();button(tree,'Save 1 Selected Sources').props.onClick();f.failWrite=true;nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'Newer proposal after original'}});resolve(reply(sent));await tick();tree=render();assert.equal(commands,1);assert.equal(nodes(tree).find(n=>n.type==='textarea').props.value,'Newer proposal after original');f.failWrite=false;button(tree,'Retry Keeping Review').props.onClick();tree=render();assert.equal(button(tree,'Save 0 Selected Sources').props.disabled,true);assert.equal(commands,1);assert.match(text(tree),/original save|newer review writing/i);}finally{f.close();}
});
test('actual original reconciliation passes the exact pending command and does nothing automatically on mount',async()=>{
 const f=new Hooks();f.seed();const owner=new LibraryTransferDraftOwner(f.io,scope,()=>true),original=owner.command(crypto.randomUUID())!,calls:HomeLibraryCommand[]=[];
 const ctl=controller(async input=>{calls.push(input);return reply(original);});ctl.pending=original;
 const props={scope,controller:ctl,request:request(),acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
 try {render();let tree=render();assert.equal(calls.length,0);assert.equal(button(tree,'Save 1 Selected Sources').props.disabled,true);button(tree,'Check Original Save').props.onClick();await tick();assert.equal(calls.length,1);assert.equal(calls[0],original);ctl.lastSave={command:original,result:reply(original),undo:reply(original).undo};ctl.pending=undefined;render();tree=render();assert.equal(button(tree,'Save 0 Selected Sources').props.disabled,true);}finally{f.close();}
});
test('own import result keeps its destination current while a later external collection change still requires review',async()=>{
 const f=new Hooks();f.seed();let commands=0;
 const ctl=controller(async input=>{commands++;const result=reply(input as Extract<HomeLibraryCommand,{type:'items-capture'}>);ctl.state!.collections=result.collections;return result;});
 const props={scope,controller:ctl,request:request(),acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
 try {
  render();button(render(),'Save 1 Selected Sources').props.onClick();await tick();
  let tree=render();assert.equal(commands,1);assert.doesNotMatch(text(tree),/The destination changed/);
  dialog(tree).props.close();button(render(),'Resume Import Review').props.onClick();
  assert.doesNotMatch(text(render()),/The destination changed/);
  ctl.state!.collections=[{...ctl.state!.collections[0],revision:3}];tree=render();
  assert.match(text(tree),/The destination changed/);assert.equal(commands,1);
  button(tree,'Use Current Collection').props.onClick();assert.doesNotMatch(text(render()),/The destination changed/);
  assert.equal(commands,1);
 }finally{f.close();}
});
test('actual import survives denied storage getter and preserves a malformed kept source',()=>{
 for(const deny of [true,false]){const f=new Hooks();if(deny)f.deny=true;else f.values.set(`e3:library-transfer-draft:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,'{original');let calls=0;
  const props={scope,controller:controller(async()=>{calls++;return undefined;}),request:request(),acceptText:()=>false,showPaste(){}};
  try{assert.doesNotThrow(()=>f.render(()=>LibraryTransfer(props)));const tree=f.render(()=>LibraryTransfer(props));assert.equal(nodes(tree).some(n=>n.type==='input'&&n.props.type==='file'),false);assert.equal(calls,0);if(!deny)assert.equal([...f.values.values()][0],'{original');}finally{f.close();}}
});
test('late exact export response after close or selection change cannot offer a download or mutate Library',async()=>{
 const before=globalThis.fetch;
 for(const mode of ['close','changed']as const){const f=new Hooks();let resolve!:(v:Response)=>void,valid=true;const requests:any[]=[];
  globalThis.fetch=async(path,init)=>{requests.push({path,init});return new Promise(done=>{resolve=done;});};
  const query={epoch:scope.epoch,collection:collection.id,revision:1};const file=buildLibraryPortable(scope.epoch,collection,query,at,()=>undefined);
  const props={scope,controller:controller(async()=>{assert.fail('No POST');}),request:{...scope,kind:'export'as const,nonce:crypto.randomUUID(),query,current:()=>valid},acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
  try{render();button(render(),'Prepare Export').props.onClick();if(mode==='close')dialog(render()).props.close();else valid=false;resolve(new Response(JSON.stringify(file)));await tick();const tree=render();assert.equal(button(tree,'Download Nova JSON'),undefined);assert.equal(requests.length,1);assert.equal(requests[0].init.method,'GET');assert.equal(f.values.size,0);}finally{f.close();}}
 globalThis.fetch=before;
});
test('retired import owner ignores a late confirmed save and cannot clear the original review',async()=>{
 const f=new Hooks();const key=f.seed();let sent!:Extract<HomeLibraryCommand,{type:'items-capture'}>,resolve!:(v:HomeLibraryReceipt)=>void;
 const props={scope,controller:controller(async input=>{sent=input as typeof sent;return new Promise(done=>{resolve=done;});}),request:request(),acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
 try{render();button(render(),'Save 1 Selected Sources').props.onClick();const before=f.values.get(key);f.close();resolve(reply(sent));await tick();assert.equal(f.values.get(key),before);}finally{f.close();}
});
test('actual file review selects only explicit portable rows and keeps full invalid writing without a save',async()=>{
 const f=new Hooks();let commands=0;
 const refs=[{kind:'note'as const,id:'library:from-file',revision:2},{kind:'task'as const,id:'task:original',revision:3}];
 const source={...collection,references:refs}, query={epoch:scope.epoch,collection:collection.id,revision:1};
 const file=buildLibraryPortable(scope.epoch,source,query,at,ref=>ref.kind==='note'?{kind:'note',id:ref.id,revision:2,updatedAt:at,title:'Full source',body:'Every original\nline Ω',archived:false}:undefined);
 const bytes=new TextEncoder().encode(JSON.stringify(file));
 const props={scope,controller:controller(async()=>{commands++;return undefined;}),request:request(),acceptText:()=>false,showPaste(){}};const render=()=>f.render(()=>LibraryTransfer(props));
 try {
  render();const input=nodes(render()).find(n=>n.type==='input'&&n.props.type==='file');
  input.props.onChange({target:{files:[{name:'original.json',size:bytes.length,arrayBuffer:async()=>bytes.buffer}],value:'original.json'}});
  await tick();let tree=render();
  const group=nodes(tree).find(n=>n.props['aria-label']==='File entries'), checks=nodes(group).filter(n=>n.type==='input');
  assert.equal(checks.length,2);assert.equal(checks[0].props.checked,false);assert.equal(checks[1].props.disabled,true);assert.equal(commands,0);
  checks[0].props.onChange({target:{checked:true}});tree=render();
  assert.equal(nodes(tree).find(n=>n.type==='textarea').props.value,'Every original\nline Ω');
  nodes(tree).find(n=>n.type==='input'&&n.props.maxLength===150).props.onChange({target:{value:''}});
  tree=render();assert.equal(nodes(tree).find(n=>n.type==='input'&&n.props.maxLength===150).props.value,'');
  assert.equal(commands,0);assert.equal([...f.values.values()].some(raw=>raw.includes('Every original\\nline Ω')),true);
 } finally {f.close();}
});
test('text handoff opens the original Paste Links only after verified adoption and local review clear',()=>{
 const f=new Hooks();const key=f.seed({...proposal(),file:{...proposal().file,format:'url-text',entries:0},rows:[],text:'https://example.org/keep'});
 let accepts=0,opens=0,allow=false,failClear=false;
 const props={scope,controller:controller(async()=>{assert.fail('No command');}),request:request(),acceptText:(value:string)=>{assert.equal(value,'https://example.org/keep');accepts++;if(failClear)f.failWrite=true;return allow;},showPaste(){opens++;}};const render=()=>f.render(()=>LibraryTransfer(props));
 try {
  render();button(render(),'Review In Paste Links').props.onClick();assert.equal(opens,0);assert.ok(f.values.get(key)?.includes('https://example.org/keep'));
  allow=true;failClear=true;button(render(),'Review In Paste Links').props.onClick();assert.equal(opens,0);assert.ok(dialog(render()));
  f.failWrite=false;failClear=false;button(render(),'Review In Paste Links').props.onClick();assert.equal(opens,1);assert.equal(f.values.get(key),'null');assert.equal(accepts,3);assert.equal(dialog(render()),undefined);
 } finally {f.close();}
});
