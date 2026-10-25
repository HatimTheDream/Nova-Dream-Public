import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {emptyFeedSettings,emptyFeedLearningControl,type FeedStory} from '../packages/domain/news-feed';
import {checkedFeedView,type FeedViewReady} from '../packages/domain/news-feed-view';

const key=Symbol.for('nova.test.news-reader'),react=import.meta.resolve('react');
const loader=registerHooks({
 resolve(name,context,next){
  if(context.parentURL?.endsWith('/NewsFeed.tsx')){
   if(name==='react')return {url:'news-reader:react',shortCircuit:true};
   if(name==='./useNewsFeed')return {url:'news-reader:controller',shortCircuit:true};
  }
  if(name.endsWith('.css'))return {url:'news-reader:css',shortCircuit:true};return next(name,context);
 },
 load(url,context,next){
  if(url==='news-reader:react')return {format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.news-reader')];export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=(r,d)=>f().effect(r,d),useLayoutEffect=useEffect;`};
  if(url==='news-reader:controller')return {format:'module',shortCircuit:true,source:`export const useNewsFeed=()=>globalThis[Symbol.for('nova.test.news-reader')].controller;`};
  if(url==='news-reader:css')return {format:'module',shortCircuit:true,source:''};return next(url,context);
 }
});
const {default:NewsFeed}=await import('../apps/client/src/NewsFeed');loader.deregister();
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node?.props?[node,...nodes(node.props.children)]:[];
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'?node:'';
function fixture(){
 const snapshot:any={epoch:randomUUID(),deviceId:randomUUID(),layout:{value:{timezone:'UTC'}}};
 const story:FeedStory={id:'a'.repeat(64),revision:1,canonicalUrl:'https://publisher.example/story',sourceId:'source:one',publisherId:'publisher.example',publisher:'Publisher',
  title:'Writing Methods',summary:'The complete original publisher preview.',summaryKind:'publisher-preview',publishedAt:null,updatedAt:null,fetchedAt:'2026-10-20T12:00:00Z',sourceDigest:'b'.repeat(64),topics:['Writing']};
 const state:FeedViewReady={format:1,state:'ready',checkpoint:{epoch:snapshot.epoch,deviceId:snapshot.deviceId,savedRevision:1,profileRevision:1,following:false,at:Date.parse('2026-10-20T12:00:00Z')},value:{format:1,revision:1,profile:{format:1,revision:1,updatedAt:'2026-10-20T12:00:00Z',settings:{...emptyFeedSettings(),interests:['Writing'],sources:[{id:'source:one',title:'Publisher',url:'https://publisher.example/feed',enabled:true}]}},
  control:emptyFeedLearningControl(),interests:[],feedback:[],hidden:[]},interpretation:{status:'ready',profileRevision:1,topics:['Writing'],excluded:[],only:false,unsupported:[]},
  stories:[{story,match:{kind:'literal',literal:{eligible:true,storyId:story.id,storyRevision:1,profileRevision:1,reasons:[{kind:'written-topic',topic:'Writing',evidenceIds:[]}]}}}],
  sources:[{source:{id:'source:one',title:'Publisher',url:'https://publisher.example/feed',enabled:true},fetchedAt:null,acceptedCount:1,rejectedCount:0}],
  hiddenStories:[],eligibleCount:1,activity:{status:'not-connected',message:'Not connected',literalEvidence:[]},semantic:{state:'unavailable',reason:'current-source',interests:[]}};
 const mutations:any[]=[],handoffs:any[]=[],cells:any[]=[],effects:(()=>void)[]=[],frames:(()=>void)[]=[];let cursor=0,width=800,resize=()=>{},tree:any;
 const scroll={scrollTop:120,getBoundingClientRect:()=>({top:10})},button={focus:()=>{},isConnected:true},card={getBoundingClientRect:()=>({top:54}),querySelector:()=>button,isConnected:true,closest:()=>null};
 const root={getBoundingClientRect:()=>({width}),closest:()=>scroll,querySelector:()=>card};
 const controller:any={state,currentView:state,settingsState:{value:state.value,activity:state.activity},authorized:true,loading:false,busy:false,invalid:false,pending:null,error:'',receipt:null,
  reading:{invalid:false,error:'',value:{format:1,following:false,topic:'',profileRevision:0,order:[],anchor:null,reader:null},copy:()=>''},
  requests:{value:{pending:null},copy:()=>''},settings:{copy:()=>''},
  keepReading(value:any){controller.reading.value=structuredClone(value);return true;},
  mutate(value:any){mutations.push(value);return Promise.resolve();},load:async()=>{},refresh:async()=>{},check:async()=>{},retry:async()=>{}};
 const hooks={controller,
  state(value:any){const i=cursor++;cells[i]??={value:typeof value==='function'?value():value};return[cells[i].value,(next:any)=>{cells[i].value=typeof next==='function'?next(cells[i].value):next;}];},
  ref(value:any){return cells[cursor++]??={current:value};},
  effect(run:()=>any,deps:unknown[]){const i=cursor++,old=cells[i];if(!old||deps.some((value,k)=>!Object.is(value,old.deps[k]))){cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=run();});}}
 };
 const globals:Record<PropertyKey,unknown>={[key]:hooks,ResizeObserver:class{constructor(fn:()=>void){resize=fn;}observe(){}disconnect(){}},
  requestAnimationFrame:(fn:()=>void)=>{frames.push(fn);return frames.length;},cancelAnimationFrame:()=>{}};
 const previous=Reflect.ownKeys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 for(const name of Reflect.ownKeys(globals))Object.defineProperty(globalThis,name,{configurable:true,value:globals[name]});
 const render=()=>{checkedFeedView(state);cursor=0;tree=NewsFeed({snapshot,library:{state:undefined,busy:false,loading:false} as any,openLibrary:()=>{},onAssistantHandoff:handoff=>{handoffs.push(handoff);}});tree.props.ref.current=root;
  while(effects.length)effects.shift()!();return tree;};
 return {controller,state,story,mutations,handoffs,render,frames,
  resize(value:number){width=value;resize();},
  close(){for(const cell of cells)cell.cleanup?.();for(const[name,value]of previous)if(value)Object.defineProperty(globalThis,name,value);else Reflect.deleteProperty(globalThis,name);}
 };
}
test('the reader retains the original preview and Back anchor across source refresh; Discuss only prepares the draft',async()=>{
 const f=fixture();
 try{
  f.render();let tree=f.render();assert.equal(tree.props['data-compact'],true);
  nodes(tree).find(node=>node.type==='button'&&node.props.className==='news-story-open').props.onClick();tree=f.render();
  assert.deepEqual(f.controller.reading.value.anchor,{id:f.story.id,offset:44});assert.deepEqual(f.controller.reading.value.reader,f.story);
  const original=f.state.stories[0];assert.equal(original.match.kind,'literal');
  if(original.match.kind!=='literal')throw Error('Expected literal fixture');
  f.state.stories=[{...original,story:{...f.story,revision:2,sourceDigest:'c'.repeat(64),summary:'A newer preview'},match:{kind:'literal',literal:{...original.match.literal,storyRevision:2}}}];tree=f.render();
  assert.ok(nodes(tree).some(node=>node.type==='p'&&node.props.className==='news-full-preview preserve-case'&&text(node)===f.story.summary));
  assert.ok(text(tree).includes('It is no longer part of the current matching edition'));
  await nodes(tree).find(node=>node.type==='button'&&text(node)==='Discuss In Assistant').props.onClick();await Promise.resolve();
  assert.equal(f.handoffs.length,1);assert.ok(f.handoffs[0].text.includes(f.story.summary));assert.equal(f.mutations.length,0);
  const reader=nodes(tree).find(node=>node.props.title==='Reading');reader.props.close();assert.equal(f.controller.reading.value.reader,null);assert.equal(f.controller.reading.value.anchor.offset,44);
  f.resize(801);tree=f.render();assert.equal(tree.props['data-compact'],undefined);
 }finally{f.close();}
});
test('hidden-story Undo is available inside the reader and setup never displays generic cards',()=>{
 const f=fixture();
 try{
  f.render();let tree=f.render();nodes(tree).find(node=>node.type==='button'&&node.props.className==='news-story-open').props.onClick();tree=f.render();
  f.state.value.hidden=[f.story.id];f.state.hiddenStories=[{id:f.story.id,title:f.story.title}];f.state.stories=[];tree=f.render();
  nodes(tree).find(node=>node.type==='button'&&text(node)==='Undo Hide').props.onClick();
  assert.deepEqual(f.mutations[0],{type:'unhide',expectedRevision:1,storyId:f.story.id});
  f.controller.reading.value.reader=null;f.state.interpretation.status='unconfigured';tree=f.render();
  assert.equal(nodes(tree).filter(node=>node.props.className==='news-story-card').length,0);
  assert.ok(nodes(tree).some(node=>node.props.title==='Make This Feed Yours'));
 }finally{f.close();}
});
test('opening reading records an exact event only with current explicit consent and no competing original request',()=>{
 const f=fixture();
 try{
  f.state.value.profile.settings.learning={enabled:true,paused:false,instructionsOnly:false,allowed:['reading'],scope:'within'};
  f.render();let tree=f.render();nodes(tree).find(node=>node.type==='button'&&node.props.className==='news-story-open').props.onClick();
  assert.deepEqual(f.mutations,[{type:'reading',expectedRevision:1,story:{id:f.story.id,revision:f.story.revision,sourceId:f.story.sourceId,sourceDigest:f.story.sourceDigest}}]);
  f.controller.reading.value.reader=null;f.controller.pending={kind:'mutation'};tree=f.render();
  nodes(tree).find(node=>node.type==='button'&&node.props.className==='news-story-open').props.onClick();
  assert.equal(f.mutations.length,1);assert.deepEqual(f.controller.reading.value.reader,f.story);
  f.controller.pending=null;f.controller.reading.value.reader=null;f.state.value.profile.settings.learning.paused=true;tree=f.render();
  nodes(tree).find(node=>node.type==='button'&&node.props.className==='news-story-open').props.onClick();assert.equal(f.mutations.length,1);
 }finally{f.close();}
});
