import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FrontendLease, type FrontendLeaseRecord, type FrontendLeaseStore } from '../apps/service/frontend-lease.js';
import { UpdateSupervisor } from '../apps/service/update-supervisor.js';
import { SoftwareUpdates } from '../apps/service/software-updates.js';
const candidateId='a'.repeat(64),capsule='b'.repeat(64),epoch=randomUUID();
function fixture(initial?:FrontendLeaseRecord) {
  let clock=1000,saved=initial,candidate=candidateId,hash=capsule,busy=false,failSave=false;
  const history=new Map<string,FrontendLeaseRecord>();if(initial)history.set(initial.operationId,initial);
  const store:FrontendLeaseStore={read:()=>saved,find:id=>history.get(id),save:value=>{if(failSave)throw Error('disk failure');saved=structuredClone(value);history.set(value.operationId,saved);}};
  const lease=new FrontendLease(store,()=>({candidateId:candidate,serviceInputsSha256:hash,apiVersion:1,schemaVersion:55}),()=>{if(busy)throw Error('whole install active');},()=>clock);
  const beat=(extra={})=>lease.observeHeartbeat({candidateId:candidate,epoch,heldFor:null,nativeSuspended:false,blockers:[],...extra});
  const input=(operationId=randomUUID())=>({operationId,baseCandidateId:candidateId,serviceInputsSha256:capsule,workspaceEpoch:epoch});
  return {lease,store,beat,input,saved:()=>saved,advance:(n:number)=>clock+=n,busy:(v:boolean)=>busy=v,fail:()=>failSave=true,select:(c:string,h=capsule)=>{candidate=c;hash=h;}};
}
test('presentation lease leaves busy user work running and makes no native maintenance hold',()=>{
 const f=fixture();f.beat({blockers:[{code:'assistant',message:'Working'}]});const input=f.input(),result=f.lease.begin(input);
 assert.equal(result.active,true);assert.equal(result.leaseId,input.operationId);assert.equal(f.lease.active,true);
 f.beat({blockers:[{code:'voice',message:'Calling'}]});assert.equal(f.lease.end({operationId:input.operationId,leaseId:input.operationId}).active,false);
});
test('unknown, stale, suspended and wrong workspace cannot admit a frontend switch',()=>{
 const f=fixture();assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);f.beat();f.advance(10000);assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);
 f.beat({nativeSuspended:true});assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);f.beat();assert.throws(()=>f.lease.begin({...f.input(),workspaceEpoch:randomUUID()}),/fresh matching/);
 f.advance(-1);assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);
});
test('workspace selection structural fence excludes frontend admission while ordinary work remains eligible',()=>{
 const f=fixture();f.beat({blockers:[{code:'workspace_switch',message:'Switching saved workspace'}]});assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);
 f.beat({blockers:[{code:'recovery',message:'Opening recovered workspace'}]});assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);
 f.beat({blockers:[{code:'assistant',message:'Writing'},{code:'voice',message:'Calling'}]});const input=f.input();f.lease.begin(input);
 f.beat({blockers:[{code:'workspace_switch',message:'Switch refused while lease active'}]});assert.throws(()=>f.lease.end({operationId:input.operationId,leaseId:input.operationId}),/needs reconciliation/);
 f.beat();assert.equal(f.lease.end({operationId:input.operationId,leaseId:input.operationId}).active,false);
 f.beat({epoch:randomUUID()});assert.throws(()=>f.lease.begin(f.input()),/fresh matching/);
});
test('root heartbeat and frontend begin serialize both competing workspace-switch orders',async()=>{
 for(const beginFirst of [false,true]) {
  const f=fixture();const supervisor=new UpdateSupervisor({status:()=>({availability:'current' as const}),check:async()=>({availability:'current' as const}),verifiedRelease:()=>undefined},
   {current:()=>undefined,find:()=>undefined,save:()=>{}},{prepare:async()=>{},preflight:async()=>{},run:async()=>('unchanged' as const),reconcile:async()=>undefined},()=>candidateId,()=>1000,undefined,f.lease);
  let held:string|null=null,switching=false;
  const updates=new SoftwareUpdates({epoch:()=>epoch,installed:()=>({novaVersion:'2.3.0',candidateId,agent:{id:'openclaw',name:'OpenClaw',state:'unconfigured'}}),heldFor:()=>held,hold:id=>{held=id;},blockers:()=>switching?[...Array.from({length:35},(_,i)=>({code:'ordinary-'+i,message:'Saved work'})),{code:'recovery',message:'Reserved workspace switch'}]:[]},
   {async call<T>(action:string,value:unknown):Promise<T>{return (action==='heartbeat'?supervisor.beat(value as import('../apps/service/update-host-client.js').UpdateHeartbeat):supervisor.view()) as T;}});
  await updates.refresh();const input=f.input();
  if(beginFirst) {f.lease.begin(input);await assert.rejects(updates.prepareWorkspaceSwitch(),/Finish the current/);assert.equal(f.lease.active,true);}
  else {await updates.prepareWorkspaceSwitch();switching=true;await updates.refresh();assert.throws(()=>f.lease.begin(input),/fresh matching/);assert.equal(f.lease.active,false);}
  assert.equal(held,null);updates.close();supervisor.stop();
 }
});
test('identity retries reconcile the same lease while conflicting or completed IDs refuse replay',()=>{
 const f=fixture();f.beat();const input=f.input();const first=f.lease.begin(input);assert.deepEqual(f.lease.begin(input),first);
 const other=f.lease.observe({operationId:randomUUID()});assert.equal(other.active,true);assert.equal(other.leaseId,input.operationId);
 assert.throws(()=>f.lease.begin(f.input()),/previous frontend/);assert.throws(()=>f.lease.end({operationId:randomUUID(),leaseId:input.operationId}),/not current/);
 f.lease.end({operationId:input.operationId,leaseId:input.operationId});assert.throws(()=>f.lease.begin(input),/cannot be changed or replayed/);
 const next=f.input();f.lease.begin(next);f.lease.end({operationId:next.operationId,leaseId:next.operationId});assert.throws(()=>f.lease.begin(input),/previous frontend/);
});
test('restarted controller retains exclusion and requires fresh identity before release',()=>{
 const f=fixture();f.beat();const input=f.input(),first=f.lease.begin(input);const next=fixture(f.saved());assert.equal(next.lease.active,true);
 const observed=next.lease.observe({operationId:input.operationId});assert.notEqual(observed.processIdentity,first.processIdentity);assert.equal(observed.leaseProcessIdentity,first.processIdentity);
 assert.throws(()=>next.lease.end({operationId:input.operationId,leaseId:input.operationId}),/needs reconciliation/);next.beat();assert.equal(next.lease.end({operationId:input.operationId,leaseId:input.operationId}).active,false);
});
test('failed persistence keeps admission fail closed without inventing released authority',()=>{
 const f=fixture();f.beat();f.fail();assert.throws(()=>f.lease.begin(f.input()),/disk failure/);assert.equal(f.lease.active,true);assert.throws(()=>f.lease.begin(f.input()),/durable reconciliation/);
});
test('before-begin cancellation fences delayed dispatch and survives controller restart',()=>{
 const f=fixture(),input=f.input();const cancelled=f.lease.cancelBeforeBegin(input);
 assert.equal(cancelled.active,false);assert.equal(cancelled.leaseId,input.operationId);f.beat();assert.throws(()=>f.lease.begin(input),/cannot be changed or replayed/);
 const restart=fixture(f.saved());restart.beat();assert.equal(restart.lease.cancelBeforeBegin(input).active,false);assert.throws(()=>restart.lease.begin(input),/cannot be changed or replayed/);
});
test('a changed service can fence an unadmitted old ID without restoring or selecting assets',()=>{
 const f=fixture(),input=f.input();f.select('c'.repeat(64),'d'.repeat(64));const result=f.lease.cancelBeforeBegin(input);
 assert.equal(result.active,false);assert.equal(result.candidateId,'c'.repeat(64));assert.equal(f.saved()?.baseCandidateId,candidateId);
 f.select(candidateId);f.beat();assert.throws(()=>f.lease.begin(input),/cannot be changed or replayed/);
});
test('cancellation cannot clear another admitted lease or a competing whole operation',()=>{
 const f=fixture();f.beat();const input=f.input();f.lease.begin(input);assert.throws(()=>f.lease.cancelBeforeBegin(input),/admitted frontend/);
 assert.throws(()=>f.lease.cancelBeforeBegin(f.input()),/admitted frontend/);f.lease.end({operationId:input.operationId,leaseId:input.operationId});
 f.busy(true);assert.throws(()=>f.lease.cancelBeforeBegin(f.input()),/whole install active/);assert.equal(f.lease.active,false);
});
test('whole updater refuses an active frontend lease without turning it into workspace hold',async()=>{
 const f=fixture();const current={status:()=>({availability:'current' as const}),check:async()=>({availability:'current' as const}),verifiedRelease:()=>undefined};
 const journal={current:()=>undefined,find:()=>undefined,save:()=>{throw Error('must not save');}};
 const installer={prepare:async()=>{},preflight:async()=>{},run:async()=>('unchanged' as const),reconcile:async()=>undefined};
 const supervisor=new UpdateSupervisor(current,journal,installer,()=>candidateId,()=>1000,undefined,f.lease);
 supervisor.beat({candidateId,epoch,heldFor:null,nativeSuspended:false,blockers:[]});const input=f.input();f.lease.begin(input);
 assert.equal(supervisor.view().holdFor,null);assert.equal(supervisor.view().installation?.supported,false);
 await assert.rejects(supervisor.request({}),/interface update/);assert.throws(()=>supervisor.assertOperatorAdmission(),/existing installation/);
 f.lease.end({operationId:input.operationId,leaseId:input.operationId});assert.equal(supervisor.view().installation?.supported,true);
});
