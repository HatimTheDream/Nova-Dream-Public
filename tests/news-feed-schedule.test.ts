import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/service/store';
import {NewsFeed} from '../apps/service/news-feed';
import {feedScheduleKey} from '../apps/service/news-feed-schedule';
import {parseNewsFeed,type ParsedNewsFeed} from '../apps/service/news-feed-parser';
import {emptyFeedSettings,type FeedRefreshReceipt,type FeedSettings,type FeedSource} from '../packages/domain/news-feed';

const source:FeedSource={id:'publisher:one',title:'Publisher',url:'https://publisher.example/feed',enabled:true};
const body=Buffer.from('<rss><channel><item><title>Writing</title><link>https://publisher.example/story</link><description>Writing methods.</description></item></channel></rss>');
type Fetcher=NonNullable<ConstructorParameters<typeof NewsFeed>[2]>;
async function fixture(run:(f:ReturnType<typeof setup>)=>Promise<void>|void){
 const f=setup();try{await run(f);}finally{f.news.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'nova-feed-schedule-')),store=new Store(dir),device=store.session().deviceId;
 let at=Date.parse('2026-10-20T12:00:00Z'),calls=0;
 const parsed=()=>parseNewsFeed(source,body,new Date(at).toISOString());
 let fetcher:Fetcher=async()=>parsed();
 const now=()=>at,news=new NewsFeed(store,now,(...args)=>{calls++;return fetcher(...args);});
 const settings=(hours?:6|12|24|null):FeedSettings=>({...emptyFeedSettings(),interests:['Writing'],sources:[source],...(hours!==undefined?{autoRefreshHours:hours}:{})});
 const input=(value:FeedSettings)=>({requestId:randomUUID(),epoch:store.epoch,expectedRevision:news.state().value.revision,type:'settings' as const,settings:value});
 const save=(value:FeedSettings=settings(6))=>news.command(device,input(value));
 return {dir,store,device,news,now,parsed,input,settings,save,calls:()=>calls,advance:(hours=6)=>{at+=hours*3600000;},fetcher:(next:Fetcher)=>{fetcher=next;}};
}
test('legacy settings stay manual and saved reads/ticks do not create intents',()=>fixture(async f=>{
 f.save(f.settings());const before=f.store.internalList('home:news:');f.advance(72);
 await f.news.tick();assert.equal(f.news.state().schedule?.status,'off');assert.equal(f.calls(),0);
 assert.deepEqual(f.store.internalList('home:news:'),before);
}));
test('saving an opt-in waits a full interval; duplicate ticks and missed intervals do not refetch',()=>fixture(async f=>{
 const command=f.input(f.settings(6));f.news.command(f.device,command);
 await f.news.tick();assert.equal(f.calls(),0);f.advance(72);
 await Promise.all([f.news.tick(),f.news.tick()]);assert.equal(f.calls(),1);
 assert.equal(f.news.state().stories.length,1);const next=f.news.state().schedule?.nextAt;
 f.news.command(f.device,command);assert.equal(f.news.state().schedule?.nextAt,next);
 await f.news.tick();assert.equal(f.calls(),1);f.advance();await f.news.tick();assert.equal(f.calls(),2);
 assert.equal(f.store.internalList('home:news:schedule-intent:').length,2);
}));
test('restart observes a completed original without dispatching it again',()=>fixture(async f=>{
 f.save();f.advance();await f.news.tick();const row=f.store.internalList<FeedRefreshReceipt>('home:news:refresh:')[0];
 const cursor=f.store.internalRead<Record<string,unknown>>(feedScheduleKey)!;
 f.store.internalWrite(feedScheduleKey,{...cursor,pending:row.command});
 const reopened=new NewsFeed(f.store,f.now,async()=>{throw Error('No redispatch');});
 try{await reopened.tick();assert.equal(reopened.state().schedule?.status,'scheduled');assert.equal(f.calls(),1);}
 finally{reopened.close();}
}));
test('an interrupted admitted original pauses automatic checks and retains its exact identity',()=>fixture(async f=>{
 f.save();let finish!:(value:ParsedNewsFeed)=>void;f.fetcher(async()=>new Promise(resolve=>{finish=resolve;}));
 f.advance();const pending=f.news.tick();const original=f.store.internalList<FeedRefreshReceipt>('home:news:refresh:')[0];
 const reopened=new NewsFeed(f.store,f.now,async()=>{throw Error('No redispatch');});
 try{
  await reopened.tick();assert.equal(reopened.state().schedule?.status,'attention');f.advance(24);await reopened.tick();assert.equal(f.calls(),1);
  assert.equal(f.store.internalList<{command:{requestId:string}}>('home:news:schedule-intent:')[0].command.requestId,original.requestId);
 }finally{reopened.close();finish(f.parsed());await pending;}
}));
test('a saved cursor with no admission is never dispatched after restart',()=>fixture(async f=>{
 f.save();const cursor=f.store.internalRead<Record<string,unknown>>(feedScheduleKey)!;
 const command={requestId:randomUUID(),epoch:f.store.epoch,sourceId:source.id,profileRevision:f.news.state().value.profile.revision};
 f.store.internalWrite(feedScheduleKey,{...cursor,pending:command});f.advance();
 await f.news.tick();assert.equal(f.calls(),0);assert.equal(f.news.state().schedule?.status,'attention');
}));
test('changing the saved source settings withdraws in-flight data and preserves the new schedule',()=>fixture(async f=>{
 f.save();let finish!:(value:ParsedNewsFeed)=>void;f.fetcher(async()=>new Promise(resolve=>{finish=resolve;}));
 f.advance();const pending=f.news.tick();f.save({...f.settings(12),sources:[{...source,enabled:false}]});
 const changed=f.store.internalRead(feedScheduleKey);finish(f.parsed());await pending;
 assert.deepEqual(f.store.internalRead(feedScheduleKey),changed);assert.equal(f.news.state().stories.length,0);
 assert.equal(f.store.internalList<FeedRefreshReceipt>('home:news:refresh:')[0].state,'withdrawn');
 f.advance(24);await f.news.tick();assert.equal(f.calls(),1);
}));
test('failed source checks keep their outcome and wait for a new scheduled interval',()=>fixture(async f=>{
 f.save();f.fetcher(async()=>{throw Error('Publisher unavailable');});f.advance();await f.news.tick();
 const original=f.store.internalList<FeedRefreshReceipt>('home:news:refresh:')[0];assert.equal(original.state,'failed');
 await f.news.tick();assert.equal(f.calls(),1);assert.deepEqual(f.news.refreshReceipt(f.device,original.command),original);
 f.advance();await f.news.tick();assert.equal(f.calls(),2);
}));
test('maintenance and recovery prevent both scheduling writes and manual fetches',()=>fixture(async f=>{
 f.save();f.advance();const before=f.store.internalList('home:news:');f.store.setUpdateMaintenanceHeld(true);
 await f.news.tick();assert.deepEqual(f.store.internalList('home:news:'),before);assert.equal(f.news.state().schedule?.status,'paused');
 await assert.rejects(f.news.refresh(f.device,{requestId:randomUUID(),epoch:f.store.epoch,sourceId:source.id,profileRevision:f.news.state().value.profile.revision}),/update/i);
 f.store.setUpdateMaintenanceHeld(false);f.store.internalWrite('recovery:state',{held:true});await f.news.tick();
 assert.equal(f.calls(),0);assert.deepEqual(f.store.internalList('home:news:'),before);
}));
test('in-flight fetch is tracked and cannot write during maintenance',()=>fixture(async f=>{
 f.save();let finish!:(value:ParsedNewsFeed)=>void;f.fetcher(async()=>new Promise(resolve=>{finish=resolve;}));
 f.advance();const pending=f.news.tick();assert.equal(f.store.updateEffectsInFlight()['news-feed'],1);
 f.store.setUpdateMaintenanceHeld(true);const before=f.store.internalList('home:news:');finish(f.parsed());await pending;
 assert.deepEqual(f.store.internalList('home:news:'),before);assert.deepEqual(f.store.updateEffectsInFlight(),{});
 f.store.setUpdateMaintenanceHeld(false);await f.news.tick();assert.equal(f.news.state().schedule?.status,'attention');
}));
test('recovered epoch never adopts an earlier schedule',()=>fixture(async f=>{
 f.save();const cursor=f.store.internalRead<Record<string,unknown>>(feedScheduleKey)!;f.store.internalWrite(feedScheduleKey,{...cursor,epoch:randomUUID()});
 f.advance();const before=f.store.internalList('home:news:');await f.news.tick();assert.equal(f.calls(),0);
 assert.equal(f.news.state().schedule?.status,'attention');assert.deepEqual(f.store.internalList('home:news:'),before);
}));
test('full retained history pauses without deleting or replacing any original',()=>fixture(async f=>{
 f.save();for(let i=0;i<512;i++)f.store.internalWrite('home:news:schedule-intent:'+i,{id:i});
 f.advance();const before=f.store.internalList('home:news:');await f.news.tick();assert.equal(f.calls(),0);
 assert.equal(f.news.state().schedule?.status,'full');assert.deepEqual(f.store.internalList('home:news:'),before);
}));
test('turning checks off keeps the earlier intents and never affects saved story data',()=>fixture(async f=>{
 f.save();f.advance();await f.news.tick();const intents=f.store.internalList('home:news:schedule-intent:'),stories=f.news.state().stories;
 f.save(f.settings(null));f.advance(72);await f.news.tick();assert.equal(f.calls(),1);
 assert.deepEqual(f.store.internalList('home:news:schedule-intent:'),intents);assert.deepEqual(f.news.state().stories.map(row=>row.story),stories.map(row=>row.story));
 assert.equal(f.news.state().stories[0].eligibility.profileRevision,f.news.state().value.profile.revision);
}));
