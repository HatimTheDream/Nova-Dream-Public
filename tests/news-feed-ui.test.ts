import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {emptyFeedSettings,emptyFeedLearningControl,type FeedState,type FeedStory} from '../packages/domain/news-feed';
import {checkedFeedView,type FeedViewReady} from '../packages/domain/news-feed-view';
import {FeedSettingsJournal} from '../apps/client/src/news-feed-retained';
import type {Snapshot} from '../packages/domain/contracts';

const symbol=Symbol.for('nova.test.news-ui'),react=import.meta.resolve('react');
const loader=registerHooks({
 resolve(name,context,next){
  if(/\/(?:useNewsFeed|NewsFeedSettings)\.tsx?$/u.test(context.parentURL??'')){
   if(name==='react')return {url:'nova-news:react',shortCircuit:true};
   if(name==='./api')return {url:'nova-news:api',shortCircuit:true};
   if(name==='./useWorkspace')return {url:'nova-news:workspace',shortCircuit:true};
  }return next(name,context);
 },
 load(url,context,next){
  if(url==='nova-news:react')return {format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.news-ui')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useMemo=(f,d)=>h().memo(f,d),useEffect=(f,d)=>h().effect(f,d);`};
  if(url==='nova-news:api')return {format:'module',shortCircuit:true,source:`export const request=(...args)=>globalThis[Symbol.for('nova.test.news-ui')].request(...args);`};
  if(url==='nova-news:workspace')return {format:'module',shortCircuit:true,source:`export const retainedWindowId='news-test-window';`};
  return next(url,context);
 }
});
const {useNewsFeed}=await import('../apps/client/src/useNewsFeed');
const {NewsFeedSettings}=await import('../apps/client/src/NewsFeedSettings');loader.deregister();
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'?node:'';
const settle=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
class Hooks{
 cursor=0;cells:any[]=[];effects:(()=>void)[]=[];reads:any[]=[];writes:any[]=[];advances:any[]=[];
 state(initial:any){const i=this.cursor++;this.cells[i]??={value:typeof initial==='function'?initial():initial};return [this.cells[i].value,(next:any)=>{this.cells[i].value=typeof next==='function'?next(this.cells[i].value):next;}];}
 ref(value:any){return this.cells[this.cursor++]??={current:value};}
 memo(make:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((value,k)=>!Object.is(value,old.deps[k])))this.cells[i]={value:make(),deps};return this.cells[i].value;}
 effect(run:()=>any,deps:unknown[]){const i=this.cursor++,old=this.cells[i];if(!old||deps.some((value,k)=>!Object.is(value,old.deps[k]))){this.cells[i]={deps,cleanup:old?.cleanup};this.effects.push(()=>{this.cells[i].cleanup?.();this.cells[i].cleanup=run();});}}
 request(path:string,data?:unknown){return new Promise((resolve,reject)=>(path==='home/news/semantic/advance'?this.advances:data===undefined?this.reads:this.writes).push({path,data,resolve,reject}));}
 render<T>(run:()=>T){(globalThis as any)[symbol]=this;this.cursor=0;const result=run();while(this.effects.length)this.effects.shift()!();return result;}
 close(){for(const cell of this.cells)cell?.cleanup?.();}
}
function environment(){
 const records=new Map<string,string>();let full=false;const hooks:Hooks[]=[];
 const port={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{if(full)throw Error('Storage full');records.set(key,value);}};
 const globals:Record<PropertyKey,unknown>={localStorage:port,document:{hidden:false},window:new EventTarget(),setInterval:()=>1,clearInterval:()=>{}};
 const previous=Reflect.ownKeys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const key of Reflect.ownKeys(globals))Object.defineProperty(globalThis,key,{configurable:true,value:globals[key]});
 return {records,port,full:(value:boolean)=>{full=value;},hooks:()=>{const h=new Hooks();hooks.push(h);return h;},
  close(){hooks.forEach(h=>h.close());for(const[key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);Reflect.deleteProperty(globalThis,symbol);}};
}
const snapshot=()=>({epoch:randomUUID(),deviceId:randomUUID(),layout:{value:{timezone:'UTC'}}} as unknown as Snapshot);
function saved(snapshot:Snapshot):FeedState{return {epoch:snapshot.epoch,value:{format:1,revision:1,profile:{format:1,revision:1,updatedAt:'2026-10-20T12:00:00Z',settings:emptyFeedSettings()},
 control:emptyFeedLearningControl(),interests:[],feedback:[],hidden:[]},stories:[],eligibleCount:0,sources:[],hiddenStories:[],activity:{status:'not-connected',message:'Not connected'},
 interpretation:{status:'unconfigured',profileRevision:1,topics:[],excluded:[],only:false,unsupported:[]}};}
function current(snapshot:Snapshot,following=false):FeedViewReady{
 const base=saved(snapshot),value:FeedViewReady={format:1,state:'ready',checkpoint:{epoch:snapshot.epoch,deviceId:snapshot.deviceId,
  savedRevision:base.value.revision,profileRevision:base.value.profile.revision,following,at:Date.parse('2026-10-20T12:00:00Z')},
  value:base.value,interpretation:base.interpretation,stories:[],eligibleCount:0,sources:base.sources,hiddenStories:base.hiddenStories,
  activity:{...base.activity,literalEvidence:[]},semantic:{state:'unavailable',reason:'current-source',interests:[]}};
 checkedFeedView(value);return value;
}
async function settleInitial(h:Hooks,s:Snapshot){
 assert.equal(h.reads.length,1);const first=h.reads.shift();assert.equal(first.path,'home/news/semantic/feed?following=0');
 assert.equal(h.advances.length,1);const advance=h.advances.shift();assert.deepEqual(advance.data,{epoch:s.epoch});
 first.resolve(current(s));await settle();advance.resolve({});await settle();
 assert.equal(h.reads.length,1);const refreshed=h.reads.shift();assert.equal(refreshed.path,'home/news/semantic/feed?following=0');
 refreshed.resolve(current(s));await settle();assert.equal(h.advances.length,0);assert.equal(h.writes.length,0);
}
const retainedStory=():FeedStory=>({id:'a'.repeat(64),revision:1,canonicalUrl:'https://publisher.example/story',sourceId:'source:one',publisherId:'publisher.example',publisher:'Publisher',
 title:'Writing Methods',summary:'The complete original publisher preview.',summaryKind:'publisher-preview',publishedAt:null,updatedAt:null,fetchedAt:'2026-10-20T12:00:00Z',sourceDigest:'b'.repeat(64),topics:['Writing']});
test('lost mutation replies reconcile by receipt read; reload never dispatches the retained request automatically',async()=>{
 const env=environment(),h=env.hooks(),s=snapshot();
 try{
  const render=()=>h.render(()=>useNewsFeed(s));render();await settleInitial(h,s);let ui=render();assert.ok(ui.state);
  const work=ui.mutate({type:'settings',expectedRevision:1,settings:{...emptyFeedSettings(),interests:['Writing']}});
  assert.equal(h.writes.length,1);const original=h.writes.shift();assert.equal(original.path,'home/news');original.reject(Error('Lost acknowledgement'));await settle();
  assert.equal(h.writes.length,1);const check=h.writes.shift();assert.equal(check.path,'home/news/receipt');assert.deepEqual(check.data,original.data);
  check.resolve({state:'unknown',command:original.data});await settle();
  assert.equal(h.reads.length,1);const readback=h.reads.shift();assert.equal(readback.path,'home/news/semantic/feed?following=0');readback.resolve(current(s));await work;
  ui=render();assert.deepEqual(ui.pending,{kind:'mutation',command:original.data});assert.equal(h.writes.length,0);
  h.close();const reopened=env.hooks(),next=reopened.render(()=>useNewsFeed(s));assert.deepEqual(next.pending,ui.pending);
  assert.equal(reopened.writes.length,0);await settleInitial(reopened,s);
  assert.deepEqual(reopened.render(()=>useNewsFeed(s)).pending,ui.pending);assert.equal(reopened.writes.length,0);
 }finally{env.close();}
});
test('retention failure prevents dispatch and a retired owner cannot publish an old acknowledgement',async()=>{
 const env=environment(),h=env.hooks();let s=snapshot();
 try{
  const render=()=>h.render(()=>useNewsFeed(s));render();await settleInitial(h,s);let ui=render();assert.ok(ui.state);
  env.full(true);await ui.mutate({type:'learning-reset',expectedRevision:1});assert.equal(h.writes.length,0);
  assert.match(render().error,/Storage full/);
  env.full(false);ui=render();const pending=ui.mutate({type:'learning-reset',expectedRevision:1});assert.equal(h.writes.length,1);
  const original=h.writes.shift(),oldKey=ui.requests.key;s=snapshot();render();original.resolve({});await pending;
  assert.equal(h.writes.length,0);assert.deepEqual(JSON.parse(env.records.get(oldKey)!).pending,{kind:'mutation',command:original.data});
  await settleInitial(h,s);assert.equal(render().pending,null);assert.equal(render().receipt,null);
 }finally{env.close();}
});
test('Following never publishes a stale For You response while its new read is pending',async()=>{
 const env=environment(),h=env.hooks(),s=snapshot();
 try{
  const render=()=>h.render(()=>useNewsFeed(s));render();await settleInitial(h,s);const ui=render();assert.ok(ui.state);
  const previous=ui.load(),old=h.reads.shift();assert.equal(old.path,'home/news/semantic/feed?following=0');
  ui.keepReading({...ui.reading.value,following:true});const loading=ui.load(),next=h.reads.shift();
  assert.equal(next.path,'home/news/semantic/feed?following=1');old.resolve(current(s));await previous;assert.equal(render().state,undefined);
  next.resolve(current(s,true));await loading;assert.equal(render().state?.checkpoint.following,true);
  assert.equal(h.writes.length,0);assert.equal(h.advances.length,0);
 }finally{env.close();}
});
function settingsFixture(env:ReturnType<typeof environment>){
 const h=env.hooks(),s=snapshot(),state=saved(s),scope={epoch:s.epoch,deviceId:s.deviceId,windowId:'news-test-window'},journal=new FeedSettingsJournal(env.port,scope);
 let closed=0;const commands:any[]=[],controller:any={settings:journal,busy:false,pending:null,receipt:null,mutate:(command:any)=>{commands.push(command);}};
 const render=()=>h.render(()=>NewsFeedSettings({controller,state,close:()=>{closed++;},focus:()=>null}));
 return {h,state,scope,journal,controller,commands,render,closed:()=>closed};
}
test('settings sections keep one draft, require review and preserve newer writing after the original acknowledgement',()=>{
 const env=environment(),f=settingsFixture(env);
 try{
  let tree=f.render();
  const edit=(label:string,value:string)=>{const node=nodes(tree).find(node=>node.type==='label'&&text(node).startsWith(label));nodes(node).find(node=>node.type==='textarea').props.onChange({target:{value}});tree=f.render();};
  edit('Interests','  Writing\nDesign  ');edit('Written Directions','Topics: writing; design');
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Learning').props.onClick();tree=f.render();
  assert.equal(f.journal.value.draft!.writing.directions,'Topics: writing; design');assert.equal(f.commands.length,0);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Review Brief').props.onClick();tree=f.render();
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Use This Brief').props.onClick();assert.equal(f.commands.length,1);
  const command=f.commands[0];assert.deepEqual(command.settings.interests,['Writing','Design']);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Back To Editing').props.onClick();tree=f.render();
  f.controller.pending={};edit('Written Directions','Topics: writing; design\nMy newer complete writing');
  f.controller.pending=null;f.controller.receipt={kind:'mutation',value:{state:'saved',command:{...command,requestId:randomUUID(),epoch:f.state.epoch},revision:2,profileRevision:2}};
  f.render();tree=f.render();assert.equal(f.journal.value.draft!.baseRevision,2);assert.equal(f.journal.value.draft!.writing.directions,'Topics: writing; design\nMy newer complete writing');
 }finally{env.close();}
});
test('failed settings retention blocks Back and preserves complete copy-out',()=>{
 const env=environment(),f=settingsFixture(env);
 try{
  let tree=f.render();env.full(true);
  nodes(tree).find(node=>node.type==='textarea'&&node.props.value==='').props.onChange({target:{value:'Keep this complete local writing'}});
  tree=f.render();tree.props.close();assert.equal(f.closed(),0);tree=f.render();
  const copy=nodes(tree).find(node=>node.type==='textarea'&&node.props['aria-label']==='Copy Complete Feed Writing');
  assert.ok(copy.props.value.includes('Keep this complete local writing'));env.full(false);tree.props.close();assert.equal(f.closed(),1);
 }finally{env.close();}
});

test('automatic source checks are off until retained settings are explicitly reviewed and saved',()=>{
 const env=environment(),f=settingsFixture(env);
 try{
  let tree=f.render();const controls=()=>nodes(tree).find(node=>node.type==='label'&&text(node).startsWith('Automatic Source Checks'));
  assert.equal(nodes(controls()).find(node=>node.type==='select').props.value,'');
  nodes(controls()).find(node=>node.type==='select').props.onChange({target:{value:'12'}});tree=f.render();
  assert.equal(f.journal.value.draft!.writing.autoRefreshHours,12);assert.equal(f.commands.length,0);
  const reloaded=new FeedSettingsJournal(env.port,f.scope);assert.equal(reloaded.value.draft!.writing.autoRefreshHours,12);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Review Brief').props.onClick();tree=f.render();
  assert.equal(f.commands.length,0);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Use This Brief').props.onClick();
  assert.equal(f.commands[0].settings.autoRefreshHours,12);
  assert.match(text(tree),/missed|check|brief/i);
 }finally{env.close();}
});
test('activity source choices stay staged; reset is a separate explicit action and never sends the edited brief',()=>{
 const env=environment(),f=settingsFixture(env);
 try{
  f.state.activity={status:'ready',supported:['reading','library'],message:'Selected sources only',evidence:[]};
  let tree=f.render();
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Learning').props.onClick();tree=f.render();
  const label=nodes(tree).find(node=>node.type==='label'&&text(node)==='Saved Library Notes And Links');
  const input=nodes(label).find(node=>node.type==='input');assert.equal(input.props.disabled,false);
  input.props.onChange({target:{checked:true}});tree=f.render();
  assert.deepEqual(f.journal.value.draft!.writing.learning.allowed,['library']);assert.equal(f.commands.length,0);
  const ideas=nodes(tree).find(node=>node.type==='label'&&text(node).startsWith('Ideas I Pursue'));
  assert.equal(nodes(ideas).find(node=>node.type==='input').props.disabled,true);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Reset Learned Interests…').props.onClick();tree=f.render();
  assert.equal(f.commands.length,0);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Reset And Pause Learning').props.onClick();
  assert.deepEqual(f.commands,[{type:'learning-reset',expectedRevision:1}]);
  assert.deepEqual(f.journal.value.draft!.writing.learning.allowed,['library']);
 }finally{env.close();}
});
test('malformed or unavailable current evidence clears eligibility while preserving the retained reader',async()=>{
 const env=environment(),h=env.hooks(),s=snapshot();
 try{
  const render=()=>h.render(()=>useNewsFeed(s));render();await settleInitial(h,s);let ui=render();assert.ok(ui.state);
  const story=retainedStory();assert(ui.keepReading({...ui.reading.value,reader:story,anchor:{id:story.id,offset:44}}));
  const retained=structuredClone(ui.reading.value),originalSettings=ui.settingsState,load=ui.load(),bad=current(s);
  bad.value.interests=[{topic:'Writing',status:'active',score:9,evidence:[{id:'missing',eventId:'reading:one',source:'reading',sourceId:story.id,sourceRevision:1,
   contextSha256:'c'.repeat(64),at:'2026-10-20T12:00:00Z',action:'return',topic:'Writing',quote:'Writing Methods',available:true,anchorTopics:['Writing']}]}];
  h.reads.shift().resolve(bad);await load;ui=render();
  assert.equal(ui.state,undefined);assert.equal(ui.currentView,undefined);assert.equal(ui.authorized,false);assert.match(ui.error,/Literal interest evidence unavailable/);
  assert.deepEqual(ui.reading.value,retained);assert.deepEqual(ui.settingsState,originalSettings);assert.equal(ui.settingsStale,true);
  const recover=ui.load();h.reads.shift().resolve(current(s));await recover;ui=render();assert.ok(ui.state);
  const unavailable=ui.load(),checkpoint=current(s).checkpoint;
  h.reads.shift().resolve({format:1,state:'unavailable',checkpoint,reason:'response-budget'});await settle();ui=render();
  assert.equal(ui.state,undefined);assert.equal(ui.currentView?.state,'unavailable');assert.equal(ui.settingsSeparate,true);assert.deepEqual(ui.reading.value,retained);
  assert.equal(h.reads.length,1);const settings=h.reads.shift();assert.equal(settings.path,'home/news');settings.resolve(saved(s));await unavailable;ui=render();
  assert.equal(ui.state,undefined);assert.equal(ui.currentView?.state,'unavailable');assert.ok(ui.settingsState);assert.equal(ui.settingsStale,false);
  assert.deepEqual(ui.reading.value,retained);assert.equal(h.writes.length,0);assert.equal(h.advances.length,0);
 }finally{env.close();}
});

test('connected Ideas learning remains an explicit staged source choice',()=>{
 const env=environment(),f=settingsFixture(env);
 try{
  f.state.activity={status:'ready',supported:['reading','library','ideas'],message:'Only authored submissions after permission',evidence:[]};
  let tree=f.render();const label=nodes(tree).find(node=>node.type==='label'&&text(node)==='Ideas I Submit To Assistant');
  const input=nodes(label).find(node=>node.type==='input');assert.equal(input.props.disabled,false);assert.equal(input.props.checked,false);
  input.props.onChange({target:{checked:true}});tree=f.render();
  assert.deepEqual(f.journal.value.draft!.writing.learning.allowed,['ideas']);assert.deepEqual(f.commands,[]);
  assert.equal(f.state.value.profile.settings.learning.allowed.includes('ideas'),false);
 }finally{env.close();}
});
