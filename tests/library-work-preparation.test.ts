import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AssignmentAttempt, AssignmentStart, AssignmentState } from '../packages/domain/assignments.js';
import type { Command } from '../packages/domain/contracts.js';
import type { Assignment } from '../packages/domain/workspace-records.js';
import { assignmentSchema } from '../packages/domain/workspace-records.js';
import { defaultLibraryView } from '../apps/client/src/home-library-navigation.js';
import { copyLibraryWorkDraft, existingLibraryWorkDraft, keepLibraryWorkStart, listLibraryWorkDrafts, readLibraryWorkDraft,
  updateLibraryWorkDraft, type LibraryWorkDraft, type LibraryWorkStart } from '../apps/client/src/library-work-draft.js';
import { resumeLibraryWork } from '../apps/client/src/library-work-launch.js';
import { MAX_WORK_SOURCES } from '../packages/domain/work-source-limits.js';

function fixture(count = 2) {
  const values = new Map<string,string>();
  const storage = {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,val:string)=>values.set(key,val),
    key:(i:number)=>[...values.keys()][i]??null, get length(){return values.size;}};
  const scope = {deviceId:'device:one',epoch:randomUUID()}, id='library-work:'+randomUUID();
  const references = Array.from({length:count}, (_,i)=>({kind:'note' as const,id:'note:'+i, revision:1}));
  const initial:LibraryWorkStart = {references, origin:{view:{...defaultLibraryView(),query:'hold',mode:'compact',filter:'pinned',
    collectionId:'collection:a',route:{kind:'space',id:'space:a'},selection:{collectionId:'collection:a',references}},scrollTop:135}};
  assert.ok(keepLibraryWorkStart(scope,id,initial,storage));
  const read = () => readLibraryWorkDraft(scope,id,storage)!;
  const edit = (prior:LibraryWorkDraft,next:LibraryWorkDraft) => updateLibraryWorkDraft(scope,prior,next,storage);
  return {id,scope,initial,storage,read,edit};
}
test('Library keeps the full selection and exact origin, including a selection larger than the execution limit',()=>{
  const f=fixture(MAX_WORK_SOURCES+1), old=f.read();
  assert.equal(old.sources.length,MAX_WORK_SOURCES+1);
  assert.deepEqual(old.origin,f.initial.origin);
  assert.equal(keepLibraryWorkStart(f.scope,f.id,f.initial,f.storage),false);
  const kept=f.edit(old,{...old,title:'my Case',brief:'A kept brief.',sources:old.sources.slice(1)});
  assert.deepEqual(f.read(),kept);
  assert.equal(existingLibraryWorkDraft(f.scope,f.initial,f.storage),f.id);
  assert.equal(existingLibraryWorkDraft(f.scope,{...f.initial,references:[{...f.initial.references[0],revision:2}]},f.storage),undefined);
  assert.throws(()=>f.edit(old,{...old,brief:'unseen replacement'}),/another window/);
  assert.equal(f.read().brief,'A kept brief.');
  assert.equal(listLibraryWorkDrafts({...f.scope,epoch:randomUUID()},f.storage).length,0);
  assert.equal(listLibraryWorkDrafts(f.scope,f.storage)[0].id,f.id);
});
test('A damaged saved draft cannot be overwritten by entering from Library again',()=>{
  const f=fixture(); const key=f.storage.key(0)!;
  f.storage.setItem(key,'recovered raw bytes');
  assert.throws(f.read);
  assert.equal(keepLibraryWorkStart(f.scope,f.id,f.initial,f.storage),false);
  assert.equal(f.storage.getItem(key),'recovered raw bytes');
});
test('Copying a conflicted preparation retains unsaved text under a fresh assignment and never clones its request',()=>{
  const f=fixture(), initial=f.read();
  const edited={...initial,title:'My proposed title',brief:'Open changes',planRevision:4,planConflict:true as const};
  const id='library-work:'+randomUUID(), copy=copyLibraryWorkDraft(f.scope,edited,id,f.storage);
  assert.equal(copy.brief,'Open changes'); assert.equal(copy.planRevision,0); assert.equal(copy.planConflict,undefined);
  assert.equal(f.read().brief,'');
  assert.throws(()=>copyLibraryWorkDraft(f.scope,{...edited,attemptId:randomUUID()},'library-work:'+randomUUID(),f.storage));
  assert.throws(()=>copyLibraryWorkDraft(f.scope,edited,id,f.storage));
});
function launcher() {
  const f=fixture(), original=f.read();
  const draft=f.edit(original,{...original,title:'A prepared plan',brief:'Use my kept sources.',agentId:'agent:a',projectId:'project:a',
    pending:{stage:'save-plan',planRequestId:randomUUID(),startRequestId:randomUUID(),agentRevision:3,projectRevision:2}});
  let kept=draft, attempt:AssignmentAttempt|undefined, losePlan=false, loseStart=false;
  const starts:AssignmentStart[]=[], commits:Command[]=[];
  const io = {
    keep:(next:LibraryWorkDraft)=>kept=f.edit(kept,next),
    async commit(c:Command) {
      commits.push(structuredClone(c));
      if(losePlan){losePlan=false;throw Error('Plan response lost');}
      return {id:c.entityId,revision:c.expectedRevision+1,value:assignmentSchema.parse(c.payload),updatedAt:'',deviceId:f.scope.deviceId};
    },
    async start(input:AssignmentStart) {
      assert.equal(f.read().pending?.stage,'check-start'); starts.push(input);
      const id=randomUUID();
      attempt={id,epoch:input.epoch,deviceId:f.scope.deviceId, assignmentId:input.assignmentId,assignmentRevision:input.revision,
        title:draft.title,agentId:'agent:a',agentRevision:3,agentName:'Writer',projectId:draft.projectId,state:'running',createdAt:1,updatedAt:1,deadlineAt:100,
        message:'Started',connected:{role:'result',number:1,rootAttemptId:id}};
      if(loseStart){loseStart=false;throw Error('Start response lost');}
      return attempt;
    },
    async read():Promise<AssignmentState>{return {attempts:attempt?[attempt]:[],canStart:true,reason:'',nextCursor:null};},
  };
  return {f,draft,io,starts,commits,run:()=>resumeLibraryWork(f.read(),f.scope.epoch,io),
    losePlan:()=>losePlan=true,loseStart:()=>loseStart=true};
}
test('Plan and start keep their exact request identities across both kinds of lost responses',async()=>{
  const x=launcher(); x.losePlan(); await assert.rejects(x.run,/Plan response lost/);
  assert.equal(x.f.read().pending?.stage,'save-plan');
  x.loseStart(); await assert.rejects(x.run,/Start response lost/);
  assert.deepEqual(x.commits[0],x.commits[1]);
  assert.equal((x.commits[1].payload as Assignment).executionMode,'proposal');
  assert.deepEqual((x.commits[1].payload as Assignment).workOrigin,x.draft.origin);
  const restored=await x.run();
  assert.ok(restored.attemptId); assert.equal(restored.pending,undefined); assert.equal(x.starts.length,1);
  assert.equal(x.starts[0].requestId,x.draft.pending!.startRequestId);
  assert.equal(listLibraryWorkDrafts(x.f.scope,x.f.storage).length,0);
  assert.equal((await x.run()).attemptId,restored.attemptId); assert.equal(x.starts.length,1);
});
test('A different saved plan or failed durable transition cannot send an assignment',async()=>{
  const x=launcher(), commit=x.io.commit;
  await assert.rejects(resumeLibraryWork(x.draft,x.f.scope.epoch,{...x.io,commit:async c=>{
    const entity=await commit(c);return {...entity,value:{...entity.value,brief:'Different captured brief'}};
  }}),/does not match/);
  assert.equal(x.starts.length,0);
  await assert.rejects(resumeLibraryWork(x.draft,x.f.scope.epoch,{...x.io,keep:()=>{throw Error('storage full');}}),/storage full/);
  assert.equal(x.starts.length,0);
});
