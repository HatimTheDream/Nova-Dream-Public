import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ContentCommandJournal,checkedContentReceipt} from '../apps/client/src/content-command-recovery';
import type {ContentWorkspaceCommand} from '../packages/domain/content-workspace';
const scope={deviceId:randomUUID(),epoch:randomUUID(),id:'content:a'};
const command=():ContentWorkspaceCommand=>({type:'review-request',requestId:randomUUID(),epoch:scope.epoch,contentId:scope.id,expectedRevision:4,reviewerId:null});
const result=()=>({id:randomUUID(),revision:1,contentId:scope.id,sourceRevision:4,reviewerId:null,comments:[]});
function storage(){const records=new Map<string,string>();let full=false;return {records,set full(value:boolean){full=value;},getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{if(full)throw Error('Storage full');records.set(key,value);}};}
test('legacy Content requests keep their original bytes and only settle through exact receipts',()=>{
 const s=storage(),c=command(),legacy=`e3:content-command:${scope.deviceId}:${scope.epoch}:${scope.id}`,raw=JSON.stringify(c);s.records.set(legacy,raw);
 const j=new ContentCommandJournal(s,scope);assert.deepEqual(j.pending,c);assert(!j.begin(command()));
 assert(j.acknowledge(c,{command:c,state:'unknown',message:'Unconfirmed'}));assert.deepEqual(j.pending,c);
 assert(j.acknowledge(c,{command:c,state:'recorded',result:result(),message:'Recorded'}));assert.equal(j.pending,undefined);
 assert.equal(s.getItem(legacy),raw);assert.equal(new ContentCommandJournal(s,scope).pending,undefined);
});
test('wrong requests, revisions, Content items and run identities cannot clear recovery',()=>{
 const c=command();
 for(const r of [{...result(),contentId:'content:other'},{...result(),sourceRevision:5},{...result(),revision:2}])
  assert.throws(()=>checkedContentReceipt(c,{command:c,state:'recorded',result:r,message:'Recorded'}));
 assert.throws(()=>checkedContentReceipt(c,{command:{...c,requestId:randomUUID()},state:'rejected',code:'changed',message:'Changed'}));
 const control:ContentWorkspaceCommand={type:'work-control',jobId:randomUUID(),action:'stop',requestId:randomUUID(),epoch:scope.epoch};
 const s=storage(),j=new ContentCommandJournal(s,scope);assert(j.begin(control));
 assert(!j.acknowledge(control,{command:control,state:'recorded',result:{id:control.jobId,planId:'assignment:a',contentId:'content:other'},message:'Requested'}));assert(j.pending);
});
test('storage denial and a competing window preserve the original command and attempted acknowledgement',()=>{
 const s=storage(),a=new ContentCommandJournal(s,scope),b=new ContentCommandJournal(s,scope),c=command();
 assert(a.begin(c));assert(!b.begin(command()));const before=s.getItem(a.key);
 s.full=true;assert(!a.acknowledge(c,{command:c,state:'recorded',result:result(),message:'Recorded'}));assert(a.pending);assert.equal(s.getItem(a.key),before);assert.match(a.copy(),/Recorded/);
 s.full=false;assert(a.acknowledge(c,{command:c,state:'rejected',code:'changed',message:'Review changed version'}));assert(!a.pending);
});
test('malformed original recovery and wrong workspace data remain untouched',()=>{
 const s=storage(),j=new ContentCommandJournal(s,scope);s.records.set(j.key,'{invalid');
 const bad=new ContentCommandJournal(s,scope);assert(bad.invalid);assert(!bad.begin(command()));assert.equal(s.getItem(j.key),'{invalid');
 const other=storage();other.records.set(`e3:content-command:${scope.deviceId}:${scope.epoch}:${scope.id}`,JSON.stringify({...command(),epoch:randomUUID()}));
 assert(new ContentCommandJournal(other,scope).invalid);
});
test('recorded work controls retain uncertainty instead of claiming a completed native reply',()=>{
 const s=storage(),j=new ContentCommandJournal(s,scope),c:ContentWorkspaceCommand={type:'work-control',jobId:randomUUID(),action:'check',requestId:randomUUID(),epoch:scope.epoch};
 assert(j.begin(c));
 const receipt={command:c,state:'recorded',result:{id:c.jobId,planId:'assignment:a',contentId:scope.id},message:'The control request is recorded; the native outcome remains unconfirmed.'};
 assert(j.acknowledge(c,receipt));assert(!j.pending);assert.match(j.value.receipt!.message,/unconfirmed/);
 assert.equal(new ContentCommandJournal(s,scope).value.receipt!.message,receipt.message);
});
test('failed legacy import remains an explicit blocking recovery condition',()=>{
 const s=storage(),c=command(),key=`e3:content-command:${scope.deviceId}:${scope.epoch}:${scope.id}`,raw=JSON.stringify(c);
 s.records.set(key,raw);s.full=true;const j=new ContentCommandJournal(s,scope);
 assert(j.invalid);assert(!j.begin(command()));assert.equal(s.getItem(key),raw);assert.match(j.copy(),/review-request/);
});
