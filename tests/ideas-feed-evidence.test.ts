import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/service/store';
import {HomeLibrary} from '../apps/service/home-library';
import {IdeaPursuits,ideaOperationIndex} from '../apps/service/idea-pursuits';
import {ideaActivityPrefix} from '../apps/service/idea-activity';
import {NewsFeed} from '../apps/service/news-feed';
import {collectFeedEvidence} from '../apps/service/news-feed-activity';
import {emptyFeedSettings,type FeedSettings} from '../packages/domain/news-feed';
import type {IdeaCommand,IdeaEntry} from '../packages/domain/idea-pursuits';
import type {AssistantOperation} from '../packages/domain/assistant';
async function fixture(run:(f:ReturnType<typeof setup>)=>void|Promise<void>){
 const f=setup();try{await run(f);}finally{f.news.close();f.store.close();rmSync(f.dir,{recursive:true,force:true});}
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'nova-idea-evidence-')),store=new Store(dir),device=store.session().deviceId;
 let at=Date.parse('2026-10-20T12:00:00Z');const now=()=>at,ideas=new IdeaPursuits(store,now),news=new NewsFeed(store,now,async()=>{throw Error('No network');});
 const capture=new HomeLibrary(store).capture(device,{requestId:randomUUID(),epoch:store.epoch,references:[]});
 const settings=():FeedSettings=>({...emptyFeedSettings(),interests:['prototyping'],learning:{enabled:true,paused:false,instructionsOnly:false,allowed:['ideas'],scope:'within'}});
 const save=(value=settings())=>news.command(device,{requestId:randomUUID(),epoch:store.epoch,expectedRevision:news.state().value.revision,type:'settings',settings:value});
 const create=(authoredDirections:string|undefined='My prototyping question')=>{
  const command:Extract<IdeaCommand,{type:'create'}>={requestId:randomUUID(),epoch:store.epoch,type:'create',id:randomUUID(),entryId:randomUUID(),
   handoff:{title:'Draft Notes',text:'Captured source says secret phrase.\nMy directions:\nprototyping\n'+(authoredDirections??''),space:'chat',projectId:null,sourceCaptureId:capture.id,sourceRefs:[],ideaId:'draft-notes',outputs:['draft'],...(authoredDirections===undefined?{}:{authoredDirections})}};
  assert.equal(ideas.command(device,command).state,'saved');return command;
 };
 const submit=(command:{id:string;entryId:string},input?:string)=>{
  const entry=ideas.entry(command.entryId).entry;
  const operation={id:randomUUID(),epoch:store.epoch,conversationId:randomUUID(),createdAt:new Date(at).toISOString(),
   context:{idea:{pursuitId:command.id,entryId:command.entryId}},input:input??entry.handoff.text,text:'Private reply must never become evidence',state:'prepared'} as AssistantOperation;
  store.internalBatchJoined([{id:'assistant:operation:'+operation.id,value:operation},...ideaOperationIndex(store,operation)]);return operation;
 };
 return {dir,store,device,ideas,news,settings,save,create,submit,now,advance:()=>{at+=61000;}};
}
test('starter capture and saved brief alone are not pursuit learning signals',()=>fixture(f=>{
 f.save();f.create();f.create();assert.deepEqual(f.store.internalList(ideaActivityPrefix),[]);
 assert.deepEqual(f.news.state().value.interests,[]);
}));
test('two submitted Ideas supply only exact authored quotes with original entry and attempt identities',()=>fixture(f=>{
 f.save();const a=f.create(),b=f.create();const opA=f.submit(a),opB=f.submit(b);
 const interest=f.news.state().value.interests.find(row=>row.topic==='prototyping');assert(interest);
 assert.equal(interest.evidence.length,2);
 assert.deepEqual(new Set(interest.evidence.map(row=>row.sourceOperationId)),new Set([opA.id,opB.id]));
 assert.deepEqual(new Set(interest.evidence.map(row=>row.sourceEntryId)),new Set([a.entryId,b.entryId]));
 assert(interest.evidence.every(row=>row.quote==='My prototyping question'&&!row.quote.includes('secret')&&!row.quote.includes('Private reply')));
}));
test('repeated attempts and questions within one pursuit cannot manufacture independent evidence',()=>fixture(f=>{
 f.save();const a=f.create();f.submit(a);f.advance();f.submit(a);
 const question={requestId:randomUUID(),epoch:f.store.epoch,type:'question' as const,id:a.id,entryId:randomUUID(),expectedRevision:1,text:'More prototyping questions'};
 f.ideas.command(f.device,question);f.advance();f.submit(question);
 assert.deepEqual(f.news.state().value.interests,[]);assert.equal(f.store.internalList(ideaActivityPrefix).length,3);
}));
test('disabled, paused, unselected and instructions-only settings do not capture new Idea signals',()=>fixture(f=>{
 for(const patch of [{enabled:false},{paused:true},{allowed:[]},{instructionsOnly:true}]){
  f.save({...f.settings(),learning:{...f.settings().learning,...patch}});f.submit(f.create());
 }
 assert.deepEqual(f.store.internalList(ideaActivityPrefix),[]);
 f.save();assert.deepEqual(f.news.state().value.interests,[]);
}));
test('legacy combined text and an edited submission cannot stand in for authored directions',()=>fixture(f=>{
 f.save();const legacy=f.create();const entry=f.ideas.entry(legacy.entryId).entry;
 const {authoredDirections:unused,...handoff}=entry.handoff;void unused;
 f.store.internalWrite('home:ideas:entry:'+entry.id,{...entry,handoff});f.submit(legacy);
 f.submit(f.create(),'Completely different edited message');
 assert.deepEqual(f.store.internalList(ideaActivityPrefix),[]);
}));
test('withdrawal skips all Ideas reads, and selected Ideas never reads private conversations or captured source bodies',()=>fixture(f=>{
 f.save();f.submit(f.create());f.submit(f.create());const saved=f.news.state().value;
 const read=f.store.internalRead.bind(f.store),page=f.store.internalPage.bind(f.store),list=f.store.internalList.bind(f.store);
 f.store.internalRead=<T>(id:string):T|undefined=>{assert(!/^(assistant:|home:library:)/u.test(id),id);return read<T>(id);};
 f.store.internalList=<T>(prefix:string):T[]=>{assert(!/^(assistant:|home:library:)/u.test(prefix),prefix);return list<T>(prefix);};
 assert.equal(collectFeedEvidence(f.store,saved,[],f.now()).length,2);
 f.store.internalPage=<T>(prefix:string,after:string,limit:number)=>{assert(!prefix.startsWith('home:ideas:'),'Unselected Ideas read');return page<T>(prefix,after,limit);};
 assert.deepEqual(collectFeedEvidence(f.store,{...saved,profile:{...saved.profile,settings:{...saved.profile.settings,learning:{...saved.profile.settings.learning,allowed:[]}}}},[],f.now()),[]);
}));
test('changed authored bytes, missing original link and recovered entries immediately invalidate evidence',()=>fixture(f=>{
 f.save();const a=f.create(),b=f.create();f.submit(a);const op=f.submit(b);assert.equal(f.news.state().value.interests.length,1);
 const original=f.ideas.entry(b.entryId).entry;
 f.store.internalWrite('home:ideas:entry:'+b.entryId,{...original,handoff:{...original.handoff,authoredDirections:'Changed prototyping'}});
 assert.deepEqual(f.news.state().value.interests,[]);f.store.internalWrite('home:ideas:entry:'+b.entryId,original);
 const key=`home:ideas:run:${b.id}:${op.createdAt}:${op.id}`,link=f.store.internalRead(key);
 f.store.internalWrite(key,{...link as object,entryId:randomUUID()});assert.deepEqual(f.news.state().value.interests,[]);
 f.store.internalWrite(key,link);f.store.internalWrite('home:ideas:entry:'+b.entryId,{...original,epoch:randomUUID()});
 assert.deepEqual(f.news.state().value.interests,[]);
}));
test('reset excludes earlier submissions without deleting the pursuit or its original text',()=>fixture(f=>{
 f.save();const a=f.create(),b=f.create();f.submit(a);f.submit(b);assert.equal(f.news.state().value.interests.length,1);
 const entries=f.store.internalList<IdeaEntry>('home:ideas:entry:');
 f.news.command(f.device,{requestId:randomUUID(),epoch:f.store.epoch,expectedRevision:f.news.state().value.revision,type:'learning-reset'});
 f.save();assert.deepEqual(f.news.state().value.interests,[]);assert.deepEqual(f.store.internalList('home:ideas:entry:'),entries);
 f.advance();f.submit(a);f.submit(b);assert.equal(f.news.state().value.interests.length,1);
}));
test('later operation updates cannot backfill a submission made before permission',()=>fixture(f=>{
 const original=f.submit(f.create());f.save();const changed={...original,state:'completed' as const};
 assert.deepEqual(ideaOperationIndex(f.store,changed),[]);assert.deepEqual(f.store.internalList(ideaActivityPrefix),[]);
}));

test('an explicit saved follow-up can supply authored evidence without parsing a legacy combined brief',()=>fixture(f=>{
 f.save();for(let i=0;i<2;i++){
  const create=f.create(),entry=f.ideas.entry(create.entryId).entry;
  const {authoredDirections:unused,...handoff}=entry.handoff;void unused;
  f.store.internalWrite('home:ideas:entry:'+entry.id,{...entry,handoff});
  const question={requestId:randomUUID(),epoch:f.store.epoch,type:'question' as const,id:create.id,entryId:randomUUID(),expectedRevision:1,text:'My own prototyping follow-up'};
  f.ideas.command(f.device,question);f.submit(question);
 }
 const interest=f.news.state().value.interests[0];assert(interest);
 assert(interest.evidence.every(row=>row.quote==='My own prototyping follow-up'));
}));
