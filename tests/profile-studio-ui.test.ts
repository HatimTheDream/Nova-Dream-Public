import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultLayout, type Snapshot, type Entity, type Task } from '../packages/domain/contracts';
import { buildProfileProgress, type PersonalQuest } from '../packages/domain/profile-progression';
import type { StudioCommand, StudioState } from '../packages/domain/profile-studio';

const key = Symbol.for('nova.test.profile-studio-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (/\/apps\/client\/src\/(?:ProfileStudio|ProfilePage)\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'nova-profile-test:react', shortCircuit: true };
   if (specifier === './api') return { url: 'nova-profile-test:api', shortCircuit: true };
   if (specifier === './useWorkspace') return { url: 'nova-profile-test:window', shortCircuit: true };
   if (specifier === './prepared-views') return { url: 'nova-profile-test:prepared', shortCircuit: true };
   if (specifier === './RecordEditor' || specifier === './ProfileQuestEditor' || specifier.endsWith('/SquareLynx')) return { url: 'nova-profile-test:child', shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  const f = `const f=()=>globalThis[Symbol.for('nova.test.profile-studio-ui')];`;
  if (url === 'nova-profile-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${f}export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useCallback=(fn,deps)=>f().callback(fn,deps);export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
  if (url === 'nova-profile-test:api') return { format: 'module', shortCircuit: true, source: `${f}export class ApiError extends Error{};export const readLocal=k=>f().read(k);export const saveLocal=(k,v)=>f().save(k,v);export const request=(p,d)=>f().request(p,d);` };
  if (url === 'nova-profile-test:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='studio-test-window';` };
  if (url === 'nova-profile-test:prepared') return { format: 'module', shortCircuit: true, source: `${f}export const readPreparedView=()=>f().progress;` };
  if (url === 'nova-profile-test:child') return { format: 'module', shortCircuit: true, source: `export const RecordEditor=()=>null;export const ProfileQuestEditor=()=>null;export const SquareLynx=()=>null;` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { ProfileStudio, StudioCuration } = await import('../apps/client/src/ProfileStudio');
const { default: ProfilePage } = await import('../apps/client/src/ProfilePage');
const { mayLeaveRecordDrafts, registerRecordDraftNavigation } = await import('../apps/client/src/record-draft-navigation');
const instances = new Set<Hooks>();
class Hooks {
 slots: any[] = []; index = 0; effects: (() => void)[] = []; storage = new Map<string,string>(); failStorage = false;
 progress: ReturnType<typeof buildProfileProgress>; studio: StudioState;
 posts: { path: string; input: StudioCommand; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
 constructor(progress: ReturnType<typeof buildProfileProgress>, studio: StudioState) { this.progress = progress; this.studio = studio; }
 state(initial: any) { const i = this.index++;if (!(i in this.slots)) this.slots[i] = typeof initial === 'function' ? initial() : initial;return [this.slots[i], (value: any) => { this.slots[i] = typeof value === 'function' ? value(this.slots[i]) : value; }]; }
 ref(value: unknown) { return this.slots[this.index++] ??= { current: value }; }
 callback(fn: any, deps: unknown[]) { const i = this.index++, old = this.slots[i];if (!old || deps.some((value,n)=>!Object.is(value,old.deps[n]))) this.slots[i]={fn,deps};return this.slots[i].fn; }
 effect(fn: () => (() => void) | void, deps: unknown[]) { const i = this.index++, old = this.slots[i];if (!old || deps.some((value,n)=>!Object.is(value,old.deps[n]))) this.effects.push(()=>{ old?.cleanup?.();this.slots[i]={deps,cleanup:fn()}; }); }
 read(name: string) { try { return JSON.parse(this.storage.get(name) ?? 'null'); } catch { return undefined; } }
 write(name: string, value: string) { if(this.failStorage) throw Error('Synthetic storage full');this.storage.set(name,value); }
 save(name: string,value: unknown) { try {this.write(name,JSON.stringify(value));return true;}catch{return false;} }
 request(path: string,input?: unknown) { if(input===undefined) { assert(['profile/studio','profile/progress'].includes(path));return Promise.resolve(path==='profile/studio'?this.studio:this.progress); }assert(['profile/studio','profile/quests'].includes(path),'Only Profile metadata can be posted');return new Promise((resolve,reject)=>this.posts.push({path,input:input as StudioCommand,resolve,reject})); }
 render<T>(fn:()=>T) {instances.add(this);(globalThis as any)[key]=this;this.index=0;this.effects=[];const tree=fn();for(const effect of this.effects)effect();return tree;}
 dispose(){for(const slot of this.slots)slot?.cleanup?.();instances.delete(this);}
}
const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(name:string)=>((globalThis as any)[key] as Hooks).storage.get(name)??null,setItem:(name:string,value:string)=>((globalThis as any)[key] as Hooks).write(name,value)}});
Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:true}});
test.afterEach(()=>{for(const f of [...instances])f.dispose();});
test.after(()=>{loader.deregister();delete(globalThis as any)[key];if(oldStorage)Object.defineProperty(globalThis,'localStorage',oldStorage);else delete(globalThis as any).localStorage;if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete(globalThis as any).document;});
const nodes=(node:any):any[]=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text=(node:any):string=>typeof node==='string'||typeof node==='number'?String(node):!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');
function button(tree:any,name:string){const found=nodes(tree).find(n=>n.type==='button'&&(n.props['aria-label']===name||text(n)===name));assert.ok(found,name);return found;}
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(){
 const epoch=randomUUID(),device=randomUUID(),id=randomUUID(),at='2026-10-20T07:00:00Z';
 const task:Entity<Task>={id:'task:'+randomUUID(),revision:2,deviceId:device,updatedAt:at,value:{title:'Original next step',notes:'Original notes',status:'open',planned:'',due:''}};
 const quest:PersonalQuest={id,title:'Original quest',description:'Why it matters',projectId:null,due:'',steps:[{id:randomUUID(),taskId:task.id}],revision:1,archived:false,createdAt:at,updatedAt:at};
 const progress=buildProfileProgress([task],[],[quest],'UTC',Date.parse(at),epoch);
 const state:StudioState={epoch,curation:{format:1,revision:0,questIds:[]},availableQuestIds:[],unavailable:[]};
 const snapshot:Snapshot={epoch,deviceId:device,cursor:0,tasks:[task],projects:[],drafts:[],layout:{id:'layout',revision:1,deviceId:device,updatedAt:at,value:structuredClone(defaultLayout)},capabilities:{assistant:false,voice:false,reason:'Synthetic'}};
 const hooks=new Hooks(progress,state);return{hooks,progress,state,snapshot,quest,task};
}
test('curation actual checkbox, close and navigation retain failed choices before leaving',()=>{
 const f=fixture();let closed=0;const props={snapshot:f.snapshot,progress:f.progress,state:f.state,reload:async()=>{},close:()=>{closed++;},saved:async()=>{}};
 const render=()=>f.hooks.render(()=>StudioCuration(props));let tree=render();f.hooks.failStorage=true;
 nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});tree=render();assert.equal(nodes(tree).find(n=>n.type==='input').props.checked,true);
 tree.props.close();assert.equal(closed,0);assert.equal(mayLeaveRecordDrafts(),false);assert.equal(f.hooks.posts.length,0);
 f.hooks.failStorage=false;tree.props.close();assert.equal(closed,1);assert.equal(mayLeaveRecordDrafts(),true);assert([...f.hooks.storage.values()].some(raw=>JSON.parse(raw).questIds?.includes(f.quest.id)));
});
test('curation actual submit and failed local acknowledgement keep one original save',async()=>{
 const f=fixture();let saved=0;const props={snapshot:f.snapshot,progress:f.progress,state:f.state,reload:async()=>{},close:()=>{},saved:async()=>{saved++;}};
 const render=()=>f.hooks.render(()=>StudioCuration(props));let tree=render();nodes(tree).find(n=>n.type==='input').props.onChange({target:{checked:true}});tree=render();
 nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.equal(f.hooks.posts.length,1);const command=f.hooks.posts[0].input;f.hooks.failStorage=true;
 f.hooks.posts[0].resolve({requestId:command.requestId,epoch:command.epoch,curation:{format:1,revision:1,questIds:command.questIds}});await settle();tree=render();assert.equal(saved,0);assert.equal(button(tree,'Check Original Save').props.disabled,false);
 f.hooks.failStorage=false;nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.equal(f.hooks.posts.length,1);assert.equal(saved,1);
});
test('Studio opens exact original Task only after retention; blocked remainder offers review',async()=>{
 const f=fixture();f.state.curation={format:1,revision:1,questIds:[f.quest.id]};f.state.availableQuestIds=[f.quest.id];let opened:Entity<Task>[]=[];let reviews:string[]=[];
 const props={snapshot:f.snapshot,progress:f.progress,focusedId:f.quest.id,focus:()=>true,openTask:(task:Entity<Task>)=>opened.push(task),reviewQuest:(id:string)=>reviews.push(id),newQuest:()=>{throw Error('unexpected');}};
 const render=()=>f.hooks.render(()=>ProfileStudio(props));render();await settle();let tree=render();const unreg=registerRecordDraftNavigation(()=>false);button(tree,'Open Task').props.onClick();assert.deepEqual(opened,[]);unreg();button(tree,'Open Task').props.onClick();assert.equal(opened[0],f.task);
 props.snapshot={...f.snapshot,tasks:[{...f.task,value:{...f.task.value,status:'blocked'}}]};tree=render();assert(!nodes(tree).some(n=>n.type==='button'&&text(n)==='Open Task'));button(tree,'Review Steps').props.onClick();assert.deepEqual(reviews,[f.quest.id]);assert.equal(f.hooks.posts.length,0);
});
test('Profile keeps selected view through reload and refuses a failed navigation write',async()=>{
 const f=fixture();const props={snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}};const render=()=>f.hooks.render(()=>ProfilePage(props));let tree=render();assert.equal(button(tree,'My Studio').props['aria-pressed'],true);
 f.hooks.failStorage=true;button(tree,'Quests').props.onClick();tree=render();assert.equal(button(tree,'My Studio').props['aria-pressed'],true);
 f.hooks.failStorage=false;button(tree,'Quests').props.onClick();tree=render();assert.equal(button(tree,'Quests').props['aria-pressed'],true);button(tree,'Weekly').props.onClick();tree=render();assert.equal(button(tree,'Weekly').props['aria-pressed'],true);
 const saved=new Map(f.hooks.storage);f.hooks.dispose();const reopened=new Hooks(f.progress,f.state);reopened.storage=saved;tree=reopened.render(()=>ProfilePage(props));assert.equal(button(tree,'Quests').props['aria-pressed'],true);assert.equal(button(tree,'Weekly').props['aria-pressed'],true);assert.equal(reopened.posts.length,0);await settle();
});
test('Profile identity uses the original full editor and Close obeys its retained-writer guard',()=>{
 const f=fixture();const render=()=>f.hooks.render(()=>ProfilePage({snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}}));button(render(),'Edit Profile & Appearance').props.onClick();let tree=render();const dialog=nodes(tree).find(n=>n.props?.title==='Your profile & appearance');assert(dialog);
 assert(nodes(dialog).some(n=>n.props?.kind==='profile'&&n.props.id==='profile:owner'&&n.props.snapshot===f.snapshot));const unreg=registerRecordDraftNavigation(()=>false);dialog.props.close();assert(nodes(render()).some(n=>n.props?.title==='Your profile & appearance'));unreg();dialog.props.close();assert(!nodes(render()).some(n=>n.props?.title==='Your profile & appearance'));assert.equal(f.hooks.posts.length,0);
});

test('original quest archive response with failed acknowledgement cannot start another action',async()=>{
 const f=fixture(),render=()=>f.hooks.render(()=>ProfilePage({snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}}));button(render(),'Quests').props.onClick();let tree=render();
 button(tree,'Archive Quest').props.onClick();assert.equal(f.hooks.posts.length,1);assert.equal(f.hooks.posts[0].path,'profile/quests');const cmd:any=f.hooks.posts[0].input;
 f.hooks.failStorage=true;f.hooks.posts[0].resolve({...f.quest,revision:cmd.expectedRevision+1,archived:true});await settle();tree=render();assert(button(tree,'Check Quest Action'));
 f.hooks.failStorage=false;button(tree,'Check Quest Action').props.onClick();await settle();assert.equal(f.hooks.posts.length,1);tree=render();assert(!nodes(tree).some(n=>n.type==='button'&&text(n)==='Check Quest Action'));
});
test('late original archive response preserves the journal after its Profile owner closes',async()=>{
 const f=fixture(),render=()=>f.hooks.render(()=>ProfilePage({snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}}));button(render(),'Quests').props.onClick();button(render(),'Archive Quest').props.onClick();
 const cmd:any=f.hooks.posts[0].input,actionKey=`e3:profile-action:${f.snapshot.deviceId}:${f.snapshot.epoch}:studio-test-window`,original=f.hooks.storage.get(actionKey);assert(original);f.hooks.dispose();
 f.hooks.posts[0].resolve({...f.quest,revision:cmd.expectedRevision+1,archived:true});await settle();assert.equal(f.hooks.storage.get(actionKey),original);assert.equal(f.hooks.posts.length,1);
});
test('unknown legacy draft or action bytes refuse overwrite while unrelated navigation stays available',()=>{
 const f=fixture(),writerKey=`e3:profile-writer:${f.snapshot.deviceId}`,actionKey=`e3:profile-action:${f.snapshot.deviceId}:${f.snapshot.epoch}:studio-test-window`;
 // The writer index retains its original device/window key.
 const actualWriterKey=writerKey+':studio-test-window';f.hooks.storage.set(actualWriterKey,'{original');f.hooks.storage.set(actionKey,JSON.stringify({format:99,original:'keep'}));
 const render=()=>f.hooks.render(()=>ProfilePage({snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}}));button(render(),'Quests').props.onClick();let tree=render();button(tree,'New Quest').props.onClick();tree=render();assert(!nodes(tree).some(n=>n.props?.title==='Create a personal quest'));assert.equal(button(tree,'Archive Quest').props.disabled,true);
 assert.equal(f.hooks.storage.get(actualWriterKey),'{original');assert.equal(f.hooks.storage.get(actionKey),JSON.stringify({format:99,original:'keep'}));assert.equal(mayLeaveRecordDrafts(),true);assert.equal(f.hooks.posts.length,0);
});
test('malformed Studio journal stays read-only and can close without losing original bytes',()=>{
 const f=fixture(),journalKey=`e3:profile-studio:${f.snapshot.epoch}:${f.snapshot.deviceId}:studio-test-window`;f.hooks.storage.set(journalKey,'{kept');let closed=0;
 const tree=f.hooks.render(()=>StudioCuration({snapshot:f.snapshot,progress:f.progress,state:f.state,reload:async()=>{},close:()=>{closed++;},saved:async()=>{}}));
 assert.equal(nodes(tree).find(n=>n.type==='fieldset').props.disabled,true);assert.equal(button(tree,'Save Selection').props.disabled,true);tree.props.close();assert.equal(closed,1);assert.equal(f.hooks.storage.get(journalKey),'{kept');assert.equal(f.hooks.posts.length,0);
});


test('Back to My Studio retains focused quest and refuses navigation until writing is kept',()=>{
 const f=fixture(),viewKey=`e3:profile-view:${f.snapshot.epoch}:${f.snapshot.deviceId}:studio-test-window`;
 f.hooks.storage.set(viewKey,JSON.stringify({format:1,tab:'quests',focusedId:f.quest.id,cadence:'weekly',questFilter:'active',reviewId:f.quest.id}));
 const props={snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}},render=()=>f.hooks.render(()=>ProfilePage(props));
 let tree=render();f.hooks.failStorage=true;button(tree,'Back to My Studio').props.onClick();tree=render();assert.equal(button(tree,'Quests').props['aria-pressed'],true);
 f.hooks.failStorage=false;button(tree,'Back to My Studio').props.onClick();tree=render();assert.equal(button(tree,'My Studio').props['aria-pressed'],true);
 const kept=JSON.parse(f.hooks.storage.get(viewKey)!);assert.equal(kept.focusedId,f.quest.id);assert.equal(kept.reviewId,null);assert.equal(kept.cadence,'weekly');assert.equal(f.hooks.posts.length,0);
 const saved=new Map(f.hooks.storage);f.hooks.dispose();const reopened=new Hooks(f.progress,f.state);reopened.storage=saved;tree=reopened.render(()=>ProfilePage(props));assert.equal(button(tree,'My Studio').props['aria-pressed'],true);assert.equal(JSON.parse(saved.get(viewKey)!).focusedId,f.quest.id);
});

test('Profile reload keeps the latest week scroll through the original view owner and refuses a failed flush',()=>{
 const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),listeners=new Map<string,Function>();
 Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener:(name:string,fn:Function)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)}});
 const f=fixture(),viewKey=`e3:profile-view:${f.snapshot.epoch}:${f.snapshot.deviceId}:studio-test-window`;
 try {
  const tree=f.hooks.render(()=>ProfilePage({snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}}));
  const week=nodes(tree).find(node=>node.type?.name==='ProfileWeek');assert(week);
  week.props.captureView({historyScroll:654,weekScroll:321});
  let prevented=0;const event={preventDefault(){prevented++;},returnValue:undefined};
  f.hooks.failStorage=true;listeners.get('beforeunload')!(event);assert.equal(prevented,1);assert.equal(f.hooks.storage.get(viewKey),undefined);
  f.hooks.failStorage=false;listeners.get('beforeunload')!(event);
  const saved=JSON.parse(f.hooks.storage.get(viewKey)!);assert.equal(saved.historyScroll,654);assert.equal(saved.weekScroll,321);assert.equal(f.hooks.posts.length,0);
  f.hooks.dispose();assert.equal(listeners.size,0);
 } finally {f.hooks.dispose();if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else delete(globalThis as any).window;}
});


test('top-level Your Week admission persists the exact original Home Timezone before opening',()=>{
 const f=fixture(),viewKey=`e3:profile-view:${f.snapshot.epoch}:${f.snapshot.deviceId}:studio-test-window`;
 const render=()=>f.hooks.render(()=>ProfilePage({snapshot:f.snapshot,refresh:async()=>{},editTask:()=>{}}));
 button(render(),'Your Week').props.onClick();
 const kept=JSON.parse(f.hooks.storage.get(viewKey)!);assert.equal(kept.tab,'week');assert.equal(kept.week.timezone,'UTC');assert.equal(kept.week.start,'2026-10-19');
 assert.equal(f.hooks.posts.length,0);
});
