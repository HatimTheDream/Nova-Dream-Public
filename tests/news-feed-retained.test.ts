import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyFeedSettings,emptyFeedLearningControl,type FeedCommand,type FeedState,type FeedStory} from '../packages/domain/news-feed';
import {FeedRequestJournal,FeedSettingsJournal,FeedReadingJournal,feedSettingsWriting,parseFeedSettingsWriting,stableFeedEdition,checkedFeedState} from '../apps/client/src/news-feed-retained';
const scope={deviceId:randomUUID(),epoch:randomUUID(),windowId:'test-window'};
const source={id:'source:one',title:'Publisher',url:'https://publisher.example/feed',enabled:true};
const settings={...emptyFeedSettings(),interests:['Writing'],sources:[source]};
const state=():FeedState=>({epoch:scope.epoch,value:{format:1,revision:1,profile:{format:1,revision:1,updatedAt:'2026-10-20T12:00:00Z',settings},
 control:emptyFeedLearningControl(),interests:[],feedback:[],hidden:[]},interpretation:{status:'ready',profileRevision:1,topics:['Writing'],excluded:[],only:false,unsupported:[]},
 stories:[],eligibleCount:0,sources:[],hiddenStories:[],activity:{status:'not-connected',message:'Not connected'}});
const story=(id:string):FeedStory=>({id:id.repeat(64),revision:1,canonicalUrl:`https://publisher.example/${id}`,sourceId:source.id,publisherId:'publisher.example',publisher:source.title,
 title:`Writing ${id}`,summary:'Writing methods',summaryKind:'publisher-preview',publishedAt:null,updatedAt:null,fetchedAt:'2026-10-20T12:00:00Z',sourceDigest:'f'.repeat(64),topics:['Writing']});
const row=(id:string)=>{const value=story(id);return {story:value,eligibility:{eligible:true as const,profileRevision:1,storyId:value.id,storyRevision:1,reasons:[{kind:'written-topic' as const,topic:'Writing',evidenceIds:[]}]}};};
function storage(){
 const values=new Map<string,string>();let fail=false,readBack=false;
 return {values,fail:(value:boolean)=>{fail=value;},readBack:(value:boolean)=>{readBack=value;},
  getItem(key:string){if(readBack){readBack=false;throw Error('Readback unavailable');}return values.get(key)??null;},
  setItem(key:string,value:string){if(fail)throw Error('Storage full');values.set(key,value);}};
}
const command=():FeedCommand=>({requestId:randomUUID(),epoch:scope.epoch,expectedRevision:1,type:'settings',settings});
test('settings retain exact raw multiline edits and normalize only an explicitly prepared command',()=>{
 const port=storage(),journal=new FeedSettingsJournal(port,scope),writing={...feedSettingsWriting(settings),interestsText:'  Writing  \n\nDesign\n',directions:'Keep this exact unfinished instruction '};
 assert.equal(journal.put({baseRevision:1,base:settings,writing}),true);
 const loaded=new FeedSettingsJournal(port,scope);assert.equal(loaded.value.draft!.writing.interestsText,writing.interestsText);assert.equal(loaded.value.draft!.writing.directions,writing.directions);
 assert.deepEqual(parseFeedSettingsWriting(writing).interests,['Writing','Design']);assert.equal(parseFeedSettingsWriting(writing).directions,writing.directions);
 assert.throws(()=>parseFeedSettingsWriting({...writing,interestsText:'writing\nWriting'}));
});
test('full local and saved settings survive explicit comparison preparation without an automatic save',()=>{
 const port=storage(),journal=new FeedSettingsJournal(port,scope),local={baseRevision:1,base:settings,writing:{...feedSettingsWriting(settings),directions:'My complete local writing'}};
 journal.put(local);const latest=state();latest.value.revision=3;latest.value.profile.settings={...settings,directions:'Saved elsewhere'};
 assert.equal(journal.prepare(local,latest,false),true);assert.equal(journal.value.draft!.baseRevision,3);assert.equal(journal.value.draft!.writing.directions,'My complete local writing');
 assert.deepEqual(journal.value.comparisons[0],{local,saved:latest.value.profile.settings});
 assert.equal(port.values.size,1);
});
test('failed retention and another window never overwrite original request or writing bytes',()=>{
 const port=storage(),journal=new FeedSettingsJournal(port,scope),draft={baseRevision:1,base:settings,writing:feedSettingsWriting(settings)};
 journal.put(draft);const original=port.values.get(journal.key);port.fail(true);
 assert.equal(journal.put({...draft,writing:{...draft.writing,directions:'New writing'}}),false);assert.equal(port.values.get(journal.key),original);
 port.fail(false);port.values.set(journal.key,'{"foreign":true}');assert.equal(journal.put(draft),false);assert.equal(port.values.get(journal.key),'{"foreign":true}');
});
test('unknown readback retains the original; exact saved acknowledgement advances only that request',()=>{
 const port=storage(),journal=new FeedRequestJournal(port,scope),input=command(),pending={kind:'mutation' as const,command:input};
 assert.equal(journal.begin(pending),true);assert.equal(journal.acknowledge(pending,{state:'unknown',command:input}),true);assert.deepEqual(journal.value.pending,pending);
 assert.equal(journal.begin({kind:'mutation',command:command()}),false);
 const saved={format:1,state:'saved',requestId:input.requestId,epoch:scope.epoch,command:input,at:'2026-10-20T12:00:00Z',revision:2,profileRevision:2};
 assert.equal(journal.acknowledge(pending,{...saved,requestId:randomUUID()}),false);assert.deepEqual(journal.value.pending,pending);
 assert.equal(journal.acknowledge(pending,saved),true);assert.equal(journal.value.pending,null);assert.equal(new FeedRequestJournal(port,scope).value.receipt!.value.state,'saved');
});
test('a forged kept receipt or wrong workspace cannot advance draft state after reload',()=>{
 const port=storage(),journal=new FeedRequestJournal(port,scope),input=command();
 port.values.set(journal.key,JSON.stringify({format:1,pending:null,receipt:{kind:'mutation',value:{format:1,state:'saved',requestId:randomUUID(),epoch:scope.epoch,command:input,at:'2026-10-20T12:00:00Z',revision:2,profileRevision:2}}}));
 assert.equal(new FeedRequestJournal(port,scope).invalid,true);
 const wrong={kind:'mutation' as const,command:{...input,epoch:randomUUID()}};assert.equal(journal.begin(wrong),false);
});
test('source checks bind device, source, original deadline and exact intent; expired does not mean saved',()=>{
 const port=storage(),journal=new FeedRequestJournal(port,scope),input={requestId:randomUUID(),epoch:scope.epoch,sourceId:source.id,profileRevision:1},pending={kind:'refresh' as const,command:input};
 journal.begin(pending);
 const receipt={format:1,requestId:input.requestId,epoch:scope.epoch,deviceId:scope.deviceId,command:input,source,startedAt:'2026-10-20T12:00:00Z',deadline:'2026-10-20T12:00:20Z',
  finishedAt:null,state:'unknown',message:'Unconfirmed',acceptedCount:0,rejectedCount:0};
 assert.equal(journal.acknowledge(pending,{...receipt,source:{...source,id:'source:other'}}),false);
 assert.equal(journal.acknowledge(pending,{...receipt,deadline:'2026-10-20T13:00:00Z'}),false);
 assert.equal(journal.acknowledge(pending,receipt),true);assert.ok(journal.value.pending);
 assert.equal(journal.acknowledge(pending,{...receipt,state:'expired'}),true);assert.equal(journal.value.pending,null);assert.equal(journal.value.receipt!.value.state,'expired');
});
test('storage refusal before dispatch keeps a new request unadmitted',()=>{
 const port=storage();port.fail(true);const journal=new FeedRequestJournal(port,scope);
 assert.equal(journal.begin({kind:'mutation',command:command()}),false);assert.equal(journal.value.pending,null);assert.equal(port.values.size,0);
});
test('new eligible stories queue without reordering current reading; hide and Undo retain their slot',()=>{
 const port=storage(),journal=new FeedReadingJournal(port,scope),initial=state();initial.stories=[row('a'),row('b')];
 journal.keep({...journal.value,profileRevision:1,order:initial.stories.map(row=>row.story.id),reader:story('a'),anchor:{id:'a'.repeat(64),offset:36}});
 const next={...initial,stories:[row('c'),row('b'),row('a')]},edition=stableFeedEdition(journal.value,next);
 assert.deepEqual(edition.rows.map(row=>row.story.id),['a'.repeat(64),'b'.repeat(64)]);assert.deepEqual(edition.queued.map(row=>row.story.id),['c'.repeat(64)]);
 const hidden=stableFeedEdition(journal.value,{...initial,stories:[row('b')]});assert.deepEqual(hidden.order,journal.value.order);assert.equal(hidden.rows.length,1);
 assert.equal(stableFeedEdition({...journal.value,order:hidden.order},initial).rows[0].story.id,'a'.repeat(64));
 const reloaded=new FeedReadingJournal(port,scope);assert.deepEqual(reloaded.value.reader,story('a'));assert.deepEqual(reloaded.value.anchor,{id:'a'.repeat(64),offset:36});
});
test('a changed brief immediately refilters the edition while preserving the originally opened preview',()=>{
 const journal=new FeedReadingJournal(storage(),scope),next=state();next.value.profile.revision=2;next.interpretation.profileRevision=2;next.stories=[];
 journal.keep({...journal.value,profileRevision:1,order:['a'.repeat(64)],reader:story('a')});
 assert.deepEqual(stableFeedEdition(journal.value,next).rows,[]);assert.equal(journal.value.reader!.title,'Writing a');
 const invalid=state();invalid.stories=[row('a')];invalid.stories[0].eligibility.profileRevision=2;assert.throws(()=>checkedFeedState(invalid,scope.epoch));
 const duplicate=state();duplicate.stories=[row('a'),row('a')];assert.throws(()=>checkedFeedState(duplicate,scope.epoch));
});
