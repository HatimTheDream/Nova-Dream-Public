import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ContentLibraryDrafts,ContentLibraryRequest,checkedLibraryReceipt} from '../apps/client/src/content-library-recovery';
import type {ContentLibraryCommand,ContentLibraryItem} from '../packages/domain/content-workspace';
const item:ContentLibraryItem={id:'library:a',type:'template',revision:3,name:'Original',archived:false,guidance:'',brief:'Full brief',body:'Full body',format:'markdown',platform:'Article',collection:'Launch',tags:['a'],brandId:null};
const scope={deviceId:randomUUID(),epoch:randomUUID(),windowId:randomUUID()};
const command=():ContentLibraryCommand=>({type:'library-save',requestId:randomUUID(),epoch:scope.epoch,expectedRevision:3,item:{...item}});
function storage(){const values=new Map<string,string>();let fail=false;return {values,set fail(v:boolean){fail=v;},getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(fail)throw Error('Storage full');values.set(key,value);}};}
test('separate library edits preserve raw name/tags, all fields and selected editor across reload',()=>{
 const s=storage(),j=new ContentLibraryDrafts(s,scope),a={item:{...item,name:'  Raw name  '},rawTags:'a,  b, '},b={item:{...item,id:'library:b',type:'brand' as const,name:'',revision:0,guidance:'Raw\n voice'},rawTags:''};
 assert(j.put(a));assert(j.put(b));assert(j.select(a.item.id));const reload=new ContentLibraryDrafts(s,scope);
 assert.deepEqual(reload.value.rows,[a,b]);assert.equal(reload.value.selected,a.item.id);
 assert(reload.discard(a.item.id));assert.deepEqual(reload.value.rows,[b]);
});
test('legacy writing imports once without deleting its original or resurrecting a discarded edit',()=>{
 const s=storage(),key=`e3:content-library-draft:${scope.deviceId}:${scope.epoch}:${scope.windowId}`,raw=JSON.stringify(item);s.values.set(key,raw);
 const j=new ContentLibraryDrafts(s,scope);assert.equal(j.value.rows[0].item.body,item.body);assert(j.discard(item.id));
 assert.equal(new ContentLibraryDrafts(s,scope).value.rows.length,0);assert.equal(s.values.get(key),raw);
});
test('storage failure and concurrent writers preserve existing data and refuse admission',()=>{
 const s=storage(),j=new ContentLibraryDrafts(s,scope);assert(j.put({item,rawTags:'a'}));const prior=s.getItem(j.key),other=new ContentLibraryDrafts(s,scope);
 s.fail=true;assert.equal(j.put({item:{...item,body:'Latest full writing'},rawTags:'a, '}),false);assert.equal(s.getItem(j.key),prior);assert.match(j.copy(),/Latest full writing/);
 s.fail=false;assert(other.put({item:{...item,body:'Other writing'},rawTags:'a'}));assert.equal(j.put({item,rawTags:'a'}),false);assert.match(j.error,/Another window/);
});
test('newer-version preparation keeps complete original and saved fields before rebasing',()=>{
 const s=storage(),j=new ContentLibraryDrafts(s,scope),original={item:{...item,body:'Owner edits'},rawTags:'a, '},saved={...item,revision:4,body:'Remote writing',guidance:'Remote guidance'};
 assert(j.put(original));assert(j.prepare(original,saved,false));assert.equal(j.value.rows[0].item.body,'Owner edits');assert.equal(j.value.rows[0].item.revision,4);assert.deepEqual(j.value.comparisons,[{original,saved}]);
 assert(j.prepare(j.value.rows[0],saved,true));assert.deepEqual(j.value.rows[0].item,saved);
});
test('invalid and full recovery stores never overwrite their originals',()=>{
 const s=storage(),j=new ContentLibraryDrafts(s,scope);s.values.set(j.key,'{broken');
 const invalid=new ContentLibraryDrafts(s,scope);assert(invalid.invalid);assert.equal(invalid.put({item,rawTags:''}),false);assert.equal(s.getItem(j.key),'{broken');
 const clean=storage(),book=new ContentLibraryDrafts(clean,scope);for(let n=0;n<32;n++)assert(book.put({item:{...item,id:`library:${n}`},rawTags:''}));
 const before=clean.getItem(book.key);assert.equal(book.put({item:{...item,id:'library:overflow'},rawTags:''}),false);assert.equal(clean.getItem(book.key),before);
});
test('request recovery imports original ID, treats absence as unknown and only accepts exact receipts',()=>{
 const s=storage(),c=command(),legacy=`e3:content-command:${scope.deviceId}:${scope.epoch}:library`,raw=JSON.stringify(c);s.values.set(legacy,raw);
 const j=new ContentLibraryRequest(s,scope);assert.deepEqual(j.pending,c);assert.equal(j.begin(command()),false);
 assert(j.acknowledge(c,{command:c,state:'unknown'}));assert.deepEqual(j.pending,c);
 assert.equal(j.acknowledge(c,{command:{...c,requestId:randomUUID()},state:'saved',item:{...item,revision:4}}),false);
 assert(j.acknowledge(c,{command:c,state:'saved',item:{...item,revision:4}}));assert.equal(j.pending,undefined);
 assert.equal(new ContentLibraryRequest(s,scope).pending,undefined);assert.equal(s.getItem(legacy),raw);
});
test('a saved receipt must match all fields and the exact resulting revision',()=>{
 const c=command();for(const changed of [{...item,revision:3},{...item,revision:4,body:'Wrong body'},{...item,revision:4,assets:[]}])
 assert.throws(()=>checkedLibraryReceipt(c,{command:c,state:'saved',item:changed}),/exact saved/);
 assert.equal(checkedLibraryReceipt(c,{command:c,state:'rejected',code:'content_library_changed',message:'Review the newer version.'}).state,'rejected');
});
test('a different window cannot overwrite the original pending request or acknowledge a replaced intent',()=>{
 const s=storage(),a=new ContentLibraryRequest(s,scope),b=new ContentLibraryRequest(s,scope),c=command();assert(a.begin(c));assert.equal(b.begin(command()),false);
 assert.equal(a.acknowledge(command(),{command:c,state:'saved',item:{...item,revision:4}}),false);assert.deepEqual(new ContentLibraryRequest(s,scope).pending,c);
});
test('a failed receipt write keeps the original request unresolved',()=>{
 const s=storage(),j=new ContentLibraryRequest(s,scope),c=command();assert(j.begin(c));s.fail=true;
 assert.equal(j.acknowledge(c,{command:c,state:'saved',item:{...item,revision:4}}),false);assert.deepEqual(j.pending,c);
 s.fail=false;assert(j.acknowledge(c,{command:c,state:'saved',item:{...item,revision:4}}));assert(j.begin(command()));
});
