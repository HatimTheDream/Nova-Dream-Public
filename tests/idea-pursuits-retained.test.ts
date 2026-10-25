import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IdeaRequestJournal,IdeaQuestionJournal} from '../apps/client/src/idea-pursuits-retained';
import {applyHomeHandoff} from '../apps/client/src/home-assistant-handoff';
import {emptyDraft} from '../packages/domain/contracts';
import type {IdeaCommand} from '../packages/domain/idea-pursuits';
const scope=()=>({deviceId:randomUUID(),epoch:randomUUID(),windowId:randomUUID()});
function memory(){const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};}
const command=(epoch:string):IdeaCommand=>({requestId:randomUUID(),epoch,type:'review',id:randomUUID(),expectedRevision:1,reviewed:true});

test('JSON escaping cannot admit an Idea brief that exceeds the HTTP body limit',()=>{
 const storage=memory(),owner=scope(),journal=new IdeaRequestJournal(storage,owner);
 const input:IdeaCommand={requestId:randomUUID(),epoch:owner.epoch,type:'create',id:randomUUID(),entryId:randomUUID(),
  handoff:{title:'Draft',text:'\u0000'.repeat(90000),space:'chat',projectId:null,sourceCaptureId:randomUUID(),sourceRefs:[],ideaId:'draft-notes',outputs:['draft']}};
 assert.equal(journal.begin(input),false);assert.equal(journal.pending,undefined);assert.equal(storage.getItem(journal.key),null);
 assert.equal(input.handoff.text.length,90000);assert.match(journal.error,/too large/);
 input.handoff.text='a'.repeat(100000);assert.equal(journal.begin(input),true);
});
test('unknown requests retain exact identity across reload; mismatched receipts cannot settle them',()=>{
 const storage=memory(),owner=scope(),journal=new IdeaRequestJournal(storage,owner),input=command(owner.epoch);
 assert.ok(journal.begin(input));assert.equal(journal.begin(command(owner.epoch)),false);
 const reload=new IdeaRequestJournal(storage,owner);assert.deepEqual(reload.pending,input);
 assert.equal(reload.acknowledge(input,{command:{...input,requestId:randomUUID()},state:'unknown'}),false);
 assert.ok(reload.acknowledge(input,{command:input,state:'unknown'}));assert.deepEqual(reload.pending,input);
 assert.ok(reload.acknowledge(input,{command:input,state:'rejected',code:'changed',message:'Review current version'}));
 assert.equal(reload.pending,undefined);assert.ok(reload.begin(command(owner.epoch)));
});
test('failed retention and another window block admission while keeping original recovery bytes',()=>{
 const storage=memory(),owner=scope(),a=new IdeaRequestJournal(storage,owner),b=new IdeaRequestJournal(storage,owner);
 const input=command(owner.epoch);assert.ok(a.begin(input));assert.equal(b.begin(command(owner.epoch)),false);
 const original=storage.getItem(a.key);storage.setItem=()=>{throw Error('Full');};
 assert.equal(a.acknowledge(input,{command:input,state:'rejected',code:'x',message:'No'}),false);
 assert.deepEqual(a.pending,input);assert.equal(storage.getItem(a.key),original);assert.match(a.copy(),/Full|rejected/);
});
test('complete question writing stays independent across pursuits and windows; corrupt originals stay untouched',()=>{
 const storage=memory(),owner=scope(),id=randomUUID(),a=new IdeaQuestionJournal(storage,owner,id);
 assert.ok(a.keep({format:1,text:'  Exact question\nSecond line  '}));
 assert.equal(new IdeaQuestionJournal(storage,owner,id).value.text,a.value.text);
 assert.equal(new IdeaQuestionJournal(storage,owner,randomUUID()).value.text,'');
 assert.equal(new IdeaQuestionJournal(storage,{...owner,windowId:randomUUID()},id).value.text,'');
 storage.values.set(a.key,'original unreadable bytes');const bad=new IdeaQuestionJournal(storage,owner,id);
 assert.equal(bad.invalid,true);assert.equal(bad.keep({format:1,text:'replacement'}),false);assert.equal(storage.getItem(a.key),'original unreadable bytes');
});
test('an Idea handoff binds the actual editable draft, is idempotent, and refuses mixing different pursuit briefs',()=>{
 const owner=scope(),idea={pursuitId:randomUUID(),entryId:randomUUID()},handoff={id:idea.entryId,...owner,value:{title:'My Pursuit',text:'Exact brief',space:'chat' as const,projectId:null,sourceRefs:[],idea}};
 const first=applyHomeHandoff({...emptyDraft,text:'Earlier unsent writing'},handoff);
 assert.deepEqual(first.idea,idea);assert.ok(first.text.startsWith('Earlier unsent writing'));assert.deepEqual(applyHomeHandoff(first,handoff),first);
 assert.throws(()=>applyHomeHandoff(first,{...handoff,id:randomUUID(),value:{...handoff.value,idea:{...idea,entryId:randomUUID()}}}),/another Idea brief/);
});
