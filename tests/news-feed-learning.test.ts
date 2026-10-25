import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/service/store';
import {NewsFeed} from '../apps/service/news-feed';
import {parseNewsFeed} from '../apps/service/news-feed-parser';
import {collectFeedEvidence,readingKey,type FeedReadingEvent} from '../apps/service/news-feed-activity';
import {emptyFeedSettings,type FeedSettings,type FeedSavedState,type FeedSource} from '../packages/domain/news-feed';

const source:FeedSource={id:'source:one',title:'Publisher',url:'https://publisher.example/feed',enabled:true};
const xml='<rss><channel><item><title>Designing Interfaces</title><link>https://publisher.example/story</link><description>Interface design and prototyping.</description><category>interface design</category></item></channel></rss>';
async function fixture(run:(f:ReturnType<typeof setup>)=>Promise<void>|void){
 const f=setup();try{await run(f);}finally{f.news.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'nova-learning-')),store=new Store(dir),device=store.session().deviceId;
 let time=Date.parse('2026-10-20T12:00:00Z');
 const now=()=>time,news=new NewsFeed(store,now,async s=>parseNewsFeed(s,Buffer.from(xml),new Date(time).toISOString()));
 const settings=():FeedSettings=>({...emptyFeedSettings(),interests:['prototyping'],sources:[source],
  learning:{enabled:true,paused:false,instructionsOnly:false,allowed:['library','reading'],scope:'related'}});
 const command=(input:Record<string,unknown>)=>({requestId:randomUUID(),epoch:store.epoch,expectedRevision:news.state().value.revision,...input});
 const save=(value=settings())=>news.command(device,command({type:'settings',settings:value}));
 const library=(id:string,patch:Record<string,unknown>={})=>store.internalWrite('home:library:item:'+id,{
  id,revision:1,kind:'note',title:'Interface design',body:'Prototyping and interface design methods.',archived:false,updatedAt:new Date(time).toISOString(),...patch});
 const refresh=()=>news.refresh(device,{requestId:randomUUID(),epoch:store.epoch,sourceId:source.id,profileRevision:news.state().value.profile.revision});
 return {dir,store,device,news,now,command,settings,save,library,refresh,advance:(ms=61000)=>{time+=ms;}};
}
test('disabled and unselected activity never reads Library or unrelated workspace data',()=>fixture(f=>{
 const list=f.store.internalList.bind(f.store),seen:string[]=[];
 f.store.internalList=<T>(prefix:string):T[]=>{seen.push(prefix);if(!prefix.startsWith('home:news:'))throw Error('Unexpected private source read');return list<T>(prefix);};
 f.store.snapshot=()=>{throw Error('No broad snapshot');};
 assert.equal(f.news.state().activity.status,'ready');
 f.save({...f.settings(),learning:{...f.settings().learning,allowed:[]}});
 assert.deepEqual(f.news.state().activity.evidence,[]);assert(!seen.some(key=>key.startsWith('home:library')));
}));
test('Library learning uses exact current material, literal quotes and independent sources',()=>fixture(async f=>{
 f.library('a');f.save();await f.refresh();assert.equal(f.news.state().value.interests.length,0);
 f.library('b');const state=f.news.state(),interest=state.value.interests.find(row=>row.topic==='interface design');
 assert(interest);assert.equal(interest.status,'active');assert.equal(interest.evidence.length,2);
 assert(interest.evidence.every(row=>row.quote.includes('interface design')&&row.sourceRevision===1&&row.contextSha256.length===64));
 f.library('b',{archived:true,revision:2});assert.equal(f.news.state().value.interests.some(row=>row.topic==='interface design'),false);
 assert.equal(f.store.internalRead<{archived:boolean}>('home:library:item:b')?.archived,true);
}));
test('withdrawing Library permission removes derived evidence immediately without deleting saved notes',()=>fixture(async f=>{
 f.library('a');f.library('b');f.save();await f.refresh();assert(f.news.state().value.interests.length);
 f.save({...f.settings(),learning:{...f.settings().learning,allowed:['reading']}});
 assert.equal(f.news.state().value.interests.length,0);assert.deepEqual(f.news.state().activity.evidence,[]);
 assert(f.store.internalRead('home:library:item:a'));assert(f.store.internalRead('home:library:item:b'));
}));
test('Pause freezes learned membership but still invalidates changed evidence; Instructions Only does not reset the stored profile',()=>fixture(async f=>{
 f.library('a');f.library('b');f.save();await f.refresh();
 f.save({...f.settings(),learning:{...f.settings().learning,paused:true}});
 const learned=f.news.state().value.interests;assert(learned.length);
 f.save({...f.settings(),learning:{...f.settings().learning,paused:true,instructionsOnly:true}});
 assert.deepEqual(f.news.state().value.interests,[]);
 assert.deepEqual(f.store.internalRead<FeedSavedState>('home:news:state')!.interests,learned);
 f.save({...f.settings(),learning:{...f.settings().learning,paused:true}});
 assert(f.news.state().value.interests.length);
 f.library('b',{revision:2,body:'Different saved writing.'});
 assert.equal(f.news.state().value.interests.length,0);
}));
test('reset pauses and excludes old events while keeping explicit interests, feedback and saved material',()=>fixture(async f=>{
 f.library('a');f.library('b');f.save();await f.refresh();
 f.news.command(f.device,f.command({type:'interest',topic:'interface design',action:'keep'}));
 const story=f.news.state().stories[0].story,guard={id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest};
 f.news.command(f.device,f.command({type:'feedback',story:guard,value:'more'}));
 f.news.command(f.device,f.command({type:'learning-reset'}));
 const state=f.news.state();assert(state.value.profile.settings.learning.paused);assert.deepEqual(state.value.interests,[]);
 assert.deepEqual(state.value.control.kept,['interface design']);assert.equal(state.value.feedback[0].value,'more');assert(f.store.internalRead('home:library:item:a'));
 f.save(f.settings());assert.deepEqual(f.news.state().value.interests,[]);
 f.advance();f.library('a',{revision:2});f.library('b',{revision:2});assert(f.news.state().value.interests.length);
}));
test('reading keeps one exact original event, requires a genuine later return and respects permission',()=>fixture(async f=>{
 f.save({...f.settings(),learning:{...f.settings().learning,allowed:['reading']}});await f.refresh();
 const story=f.news.state().stories[0].story,guard={id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest};
 const first=f.command({type:'reading',story:guard}),receipt=f.news.command(f.device,first);
 assert.equal(receipt.state,'saved');assert.deepEqual(f.news.command(f.device,first),receipt);
 assert.equal(f.store.internalRead<FeedReadingEvent[]>(readingKey)!.length,1);
 assert.equal(f.store.internalRead<FeedReadingEvent[]>(readingKey)![0].returnedAt,null);
 f.news.command(f.device,f.command({type:'reading',story:guard}));
 assert.equal(f.store.internalRead<FeedReadingEvent[]>(readingKey)![0].returnedAt,null);
 f.advance();f.news.command(f.device,f.command({type:'reading',story:guard}));
 assert(f.store.internalRead<FeedReadingEvent[]>(readingKey)![0].returnedAt);
 assert.deepEqual(f.news.state().value.interests,[]); // One source cannot establish an interest.
 f.save({...f.settings(),learning:{...f.settings().learning,allowed:[]}});
 assert.deepEqual(f.store.internalRead(readingKey),[]);
 const refusal=f.news.command(f.device,f.command({type:'reading',story:guard}));assert.equal(refusal.state,'rejected');
}));
test('collector evidence requires current source bytes and never accepts a stale reading assertion',()=>fixture(async f=>{
 f.save();await f.refresh();const state=f.news.state(),story=state.stories[0].story;
 f.store.internalWrite(readingKey,[{storyId:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:'0'.repeat(64),
  firstAt:new Date(f.now()-120000).toISOString(),lastAt:new Date(f.now()).toISOString(),returnedAt:new Date(f.now()).toISOString()}]);
 assert.deepEqual(collectFeedEvidence(f.store,state.value,[story],f.now()),[]);
}));
test('Stop Using keeps old signals from reappearing and never removes the saved source',()=>fixture(async f=>{
 f.library('a');f.library('b');f.save();await f.refresh();
 f.news.command(f.device,f.command({type:'interest',topic:'interface design',action:'stop'}));
 assert(!f.news.state().value.interests.some(row=>row.topic==='interface design'));
 f.advance();assert(!f.news.state().value.interests.some(row=>row.topic==='interface design'));
 assert(f.store.internalRead('home:library:item:a'));
}));
