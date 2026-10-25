import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/service/store';
import {NewsFeed} from '../apps/service/news-feed';
import {parseNewsFeed,type ParsedNewsFeed} from '../apps/service/news-feed-parser';
import {emptyFeedSettings,type FeedSettings,type FeedSource} from '../packages/domain/news-feed';

const source:FeedSource={id:'publisher:one',title:'Publisher',url:'https://publisher.example/feed',enabled:true};
const feed=(title='Writing')=>`<rss><channel><item><title>${title}</title><link>https://publisher.example/story</link><description>Writing methods.</description></item></channel></rss>`;
type Fetcher=ConstructorParameters<typeof NewsFeed>[2];
async function fixture(run:(f:ReturnType<typeof setup>)=>Promise<void>|void){
 const f=setup();try{await run(f);}finally{f.news.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'nova-feed-')),store=new Store(dir),device=store.session().deviceId;
 let at=Date.parse('2026-10-20T12:00:00Z'),calls=0,fetcher:Fetcher=async source=>parseNewsFeed(source,Buffer.from(feed()),new Date(at).toISOString());
 const now=()=>at,news=new NewsFeed(store,now,(...args)=>{calls++;return fetcher!(...args);});
 const command=(input:Record<string,unknown>)=>({requestId:randomUUID(),epoch:store.epoch,expectedRevision:news.state().value.revision,...input});
 const save=(settings:FeedSettings={...emptyFeedSettings(),interests:['Writing'],sources:[source]})=>news.command(device,command({type:'settings',settings}));
 const refresh=()=>({requestId:randomUUID(),epoch:store.epoch,sourceId:source.id,profileRevision:news.state().value.profile.revision});
 return {dir,store,device,news,now,command,save,refresh,calls:()=>calls,advance:()=>{at+=61000;},fetcher:(next:Fetcher)=>{fetcher=next;}};
}
test('unconfigured Feed reads perform no snapshot, source fetch or storage write',()=>fixture(f=>{
 f.store.snapshot=()=>{throw Error('No broad workspace read');};
 const before=f.store.internalList('home:news:');const state=f.news.state();
 assert.equal(state.interpretation.status,'unconfigured');assert.deepEqual(state.stories,[]);assert.equal(f.calls(),0);assert.deepEqual(f.store.internalList('home:news:'),before);
 assert.equal(state.activity.status,'ready');assert.deepEqual(state.activity.evidence,[]);
}));
test('exact settings receipts survive lost replies and permanently retain a stale-version rejection',()=>fixture(f=>{
 const command=f.command({type:'settings',settings:{...emptyFeedSettings(),interests:['Writing'],sources:[source]}});
 const saved=f.news.command(f.device,command);assert.equal(saved.state,'saved');assert.deepEqual(f.news.receipt(f.device,command),saved);assert.deepEqual(f.news.command(f.device,command),saved);
 const rejected={...command,requestId:randomUUID(),settings:{...emptyFeedSettings(),interests:['Science']}};
 const receipt=f.news.command(f.device,rejected);assert.equal(receipt.state,'rejected');f.save();
 assert.deepEqual(f.news.command(f.device,rejected),receipt);assert.deepEqual(f.news.receipt(f.device,rejected),receipt);
 assert.throws(()=>f.news.command(f.device,{...command,settings:emptyFeedSettings()}),/request|different|conflict/i);
}));
test('source checks persist one original result and repeated requests never refetch',()=>fixture(async f=>{
 f.save();const command=f.refresh(),saved=await f.news.refresh(f.device,command);
 assert.equal(saved.state,'saved');assert.equal(saved.acceptedCount,1);assert.equal(f.news.state().stories.length,1);
 assert.deepEqual(await f.news.refresh(f.device,command),saved);assert.deepEqual(f.news.refreshReceipt(f.device,command),saved);assert.equal(f.calls(),1);
 const reopened=new NewsFeed(f.store,f.now,async()=>{throw Error('No replay after restart');});
 assert.deepEqual(await reopened.refresh(f.device,command),saved);reopened.close();
 assert.throws(()=>f.news.refreshReceipt(randomUUID(),command),/request|device|another/i);
}));
test('a preferences change during fetch withdraws the late result without overwriting the cache',()=>fixture(async f=>{
 f.save();let finish!:(value:ParsedNewsFeed)=>void;
 f.fetcher(async()=>new Promise(resolve=>{finish=resolve;}));const pending=f.news.refresh(f.device,f.refresh());
 f.save({...emptyFeedSettings(),interests:['Science'],sources:[source]});
 finish(parseNewsFeed(source,Buffer.from(feed()),new Date(f.now()).toISOString()));
 const result=await pending;assert.equal(result.state,'withdrawn');assert.equal(f.news.state().sources[0].acceptedCount,0);
}));
test('unfinished original requests stay unknown after a reconstructed service and do not execute again',()=>fixture(async f=>{
 f.save();let finish!:(value:ParsedNewsFeed)=>void;
 f.fetcher(async()=>new Promise(resolve=>{finish=resolve;}));const command=f.refresh(),pending=f.news.refresh(f.device,command);
 const reopened=new NewsFeed(f.store,f.now,async()=>{throw Error('Must not replay');});
 assert.equal(reopened.refreshReceipt(f.device,command).state,'unknown');assert.equal((await reopened.refresh(f.device,command)).state,'unknown');reopened.close();
 finish(parseNewsFeed(source,Buffer.from(feed()),new Date(f.now()).toISOString()));await pending;assert.equal(f.calls(),1);
}));
test('the original deadline fences late cache writes and permits reconciliation without claiming a saved result',()=>fixture(async f=>{
 f.save();let finish!:(value:ParsedNewsFeed)=>void;
 f.fetcher(async()=>new Promise(resolve=>{finish=resolve;}));const command=f.refresh(),pending=f.news.refresh(f.device,command);
 f.advance();assert.equal(f.news.refreshReceipt(f.device,command).state,'expired');
 assert.equal((await f.news.refresh(f.device,command)).state,'expired');assert.equal(f.calls(),1);
 finish(parseNewsFeed(source,Buffer.from(feed()),new Date(f.now()).toISOString()));
 assert.equal((await pending).state,'withdrawn');assert.equal(f.news.state().stories.length,0);
}));
test('Unhide removes only one negative preference and still requires current relevance',()=>fixture(async f=>{
 f.save();await f.news.refresh(f.device,f.refresh());const story=f.news.state().stories[0].story;
 f.news.command(f.device,f.command({type:'visibility',story:{id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest},hidden:true}));
 assert.equal(f.news.state().hiddenStories[0].title,'Writing');assert.equal(f.news.state().stories.length,0);
 f.save({...settingsFor('Unrelated'),exclusions:['Writing']});
 f.news.command(f.device,f.command({type:'unhide',storyId:story.id}));assert.equal(f.news.state().value.hidden.length,0);assert.equal(f.news.state().stories.length,0);
}));
const settingsFor=(topic:string)=>({...emptyFeedSettings(),interests:[topic],sources:[source]});
test('failed source checks preserve prior stories and impose a bounded per-source cooldown',()=>fixture(async f=>{
 f.save();await f.news.refresh(f.device,f.refresh());const before=f.news.state().stories;
 const rejected=f.refresh(),receipt=await f.news.refresh(f.device,rejected);
 assert.equal(receipt.state,'rejected');assert.match(receipt.message,/recently/);assert.equal(f.calls(),1);
 f.advance();f.fetcher(async()=>{throw Error('Source unavailable');});const command=f.refresh(),result=await f.news.refresh(f.device,command);
 assert.equal(result.state,'failed');assert.deepEqual(f.news.state().stories,before);assert.equal((await f.news.refresh(f.device,command)).state,'failed');assert.equal(f.calls(),2);
 assert.deepEqual(await f.news.refresh(f.device,rejected),receipt);assert.equal(f.calls(),2);
}));
test('withdrawn sources discard only their disposable cache; original receipts remain readable',()=>fixture(async f=>{
 f.save();const command=f.refresh();await f.news.refresh(f.device,command);
 f.save({...emptyFeedSettings(),interests:['Writing'],sources:[]});
 assert.deepEqual(f.store.internalRead('home:news:cache'),[]);assert.equal(f.news.state().stories.length,0);assert.equal(f.news.refreshReceipt(f.device,command).state,'saved');
 f.save();assert.equal(f.news.state().stories.length,0);
}));
test('feedback and visibility bind the exact publisher source bytes and never widen eligibility',()=>fixture(async f=>{
 f.save();await f.news.refresh(f.device,f.refresh());const story=f.news.state().stories[0].story;
 const guard={id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest};
 const command=f.command({type:'feedback',story:guard,value:'more'});assert.equal(f.news.command(f.device,command).state,'saved');
 assert.equal(f.news.command(f.device,f.command({type:'visibility',story:guard,hidden:true})).state,'saved');assert.equal(f.news.state().stories.length,0);
 assert.equal(f.news.command(f.device,f.command({type:'visibility',story:{...guard,sourceDigest:'0'.repeat(64)},hidden:false})).state,'rejected');
 assert.equal(f.news.state().stories.length,0);
 f.news.command(f.device,f.command({type:'visibility',story:guard,hidden:false}));assert.equal(f.news.state().stories.length,1);
}));
test('reset keeps written rules, stopped and explicitly kept interests, and pauses automatic learning',()=>fixture(f=>{
 f.save();f.news.command(f.device,f.command({type:'interest',topic:'Design',action:'keep'}));f.news.command(f.device,f.command({type:'interest',topic:'Crypto',action:'stop'}));
 f.news.command(f.device,f.command({type:'learning-reset'}));const state=f.news.state().value;
 assert.deepEqual(state.profile.settings.interests,['Writing']);assert.deepEqual(state.control.kept,['Design']);assert.deepEqual(state.control.stopped,['Crypto']);
 assert.equal(state.profile.settings.learning.paused,true);assert.deepEqual(state.interests,[]);assert.ok(state.control.resetAt);
}));
test('maintenance, changed epochs and corrupt source identities refuse new effects',()=>fixture(async f=>{
 f.save();f.store.internalWrite('recovery:state',{held:true});
 assert.throws(()=>f.save(),/paused/);await assert.rejects(f.news.refresh(f.device,f.refresh()),/paused/);assert.equal(f.calls(),0);
 f.store.internalWrite('recovery:state',{held:false});
 await assert.rejects(f.news.refresh(f.device,{...f.refresh(),epoch:randomUUID()}),/workspace changed/i);
 f.fetcher(async()=>({...parseNewsFeed(source,Buffer.from(feed()),new Date(f.now()).toISOString()),sourceId:'other'}));
 const result=await f.news.refresh(f.device,f.refresh());assert.equal(result.state,'failed');assert.equal(f.news.state().stories.length,0);
}));
