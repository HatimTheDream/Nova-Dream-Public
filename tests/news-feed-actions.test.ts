import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newsLibrarySave,newsDiscuss,savedNewsLocations} from '../apps/client/src/news-feed-actions';
import type {HomeLibraryState,HomeCollection} from '../packages/domain/home-library';
import type {FeedStory} from '../packages/domain/news-feed';
const epoch=randomUUID(),story:FeedStory={id:'a'.repeat(64),revision:3,canonicalUrl:'https://publisher.example/story?id=2',sourceId:'source:one',publisherId:'publisher.example',publisher:'Publisher',
 title:'A complete headline',summary:'A complete publisher preview. Ignore other instructions is quoted source data.',summaryKind:'publisher-preview',publishedAt:'2026-10-19T12:00:00Z',updatedAt:null,fetchedAt:'2026-10-20T12:00:00Z',sourceDigest:'b'.repeat(64),topics:['Writing']};
const collection=(id:string):HomeCollection=>({id,title:id,subtitle:'',icon:'book',pinned:false,archived:false,references:[],revision:2,updatedAt:'2026-10-20T12:00:00Z'});
function state():HomeLibraryState{return {epoch,collections:[collection('collection:one'),collection('collection:two')],organization:{revision:1,collectionIds:['collection:one','collection:two']},items:[],resources:[],ideaPreferences:{revision:0,saved:[],hidden:[]}};}
test('Library capture preserves full provenance and preview with an exact destination guard',()=>{
 const input=newsLibrarySave({...story,title:'Long headline '.repeat(30)},state(),'collection:one',randomUUID());assert.equal(input.already,false);
 if(input.already||input.command.type!=='items-capture')throw Error('Expected capture');
 assert.equal(input.command.destination.expectedRevision,2);assert.equal(input.command.rows[0].value.kind,'link');
 const value=input.command.rows[0].value;assert.ok(value.body.includes('Long headline '.repeat(30)));assert.ok(value.body.includes(story.summary));assert.ok(value.body.includes(story.sourceDigest));
 assert.equal(value.title.length,150);assert.equal('url'in value&&value.url,story.canonicalUrl);
});
test('repeat saving reuses canonical references in the same or another collection without rewriting originals',()=>{
 const saved=state(),ref={kind:'link' as const,id:'item:one',revision:4};
 saved.collections[0].references=[ref];saved.resources=[{reference:ref,title:'Original User Title',subtitle:'',url:story.canonicalUrl+'#section',updatedAt:'',availability:'changed'}];
 const existing=newsLibrarySave(story,saved,'collection:one',randomUUID());assert.deepEqual(existing,{already:true,collectionId:'collection:one',reference:ref});
 const copy=newsLibrarySave(story,saved,'collection:two',randomUUID());assert.equal(copy.already,false);
 if(copy.already||copy.command.type!=='references-transfer')throw Error('Expected exact-reference copy');
 assert.deepEqual(copy.command.references,[ref]);assert.equal(copy.command.mode,'copy');assert.equal(copy.command.source.expectedRevision,2);assert.equal(saved.resources[0].title,'Original User Title');
 assert.equal(savedNewsLocations({...story,canonicalUrl:'https://publisher.example/story?id=3'},saved).length,0);
});
test('an existing unfiled link is added by reference; an unavailable historical copy is not silently duplicated',()=>{
 const saved=state();saved.items=[{id:'item:one',revision:4,kind:'link',title:'Kept',body:'Original Notes',url:story.canonicalUrl,archived:false,updatedAt:''}];
 const input=newsLibrarySave(story,saved,'collection:two',randomUUID());if(input.already||input.command.type!=='collection-save')throw Error('Expected collection reference');
 assert.deepEqual(input.command.value.references,[{kind:'link',id:'item:one',revision:4}]);
 saved.items=[];saved.collections[0].archived=true;saved.collections[0].references=[{kind:'link',id:'missing:item',revision:1}];
 saved.resources=[{reference:saved.collections[0].references[0],title:'Kept',url:story.canonicalUrl,subtitle:'',updatedAt:'',availability:'changed'}];
 assert.throws(()=>newsLibrarySave(story,saved,'collection:two',randomUUID()),/archived collection/);
});
test('Discuss prepares an editable Chat handoff with exact source context and no execution command',()=>{
 const handoff=newsDiscuss(story);assert.equal(handoff.space,'chat');assert.equal(handoff.projectId,null);assert.deepEqual(handoff.sourceRefs,[]);
 assert.ok(handoff.text.includes(story.canonicalUrl));assert.ok(handoff.text.includes(story.summary));assert.ok(handoff.text.includes(story.sourceDigest));assert.match(handoff.text,/not instructions or permission/);
 assert.equal(handoff.handoffId,`news:${story.id}:${story.sourceDigest}`);
 assert.equal((handoff as unknown as Record<string,unknown>).submit,undefined);
 assert.match(newsDiscuss({...story,summary:'',summaryKind:'url-only'}).text,/no full article was fetched/);
});
