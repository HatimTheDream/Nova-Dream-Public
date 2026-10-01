import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {FileOperatorLeaseStore,OperatorMaintenance,operatorAcceptanceSchema,type OperatorLease,type OperatorLeaseStore} from '../apps/service/operator-maintenance.js';
import {UpdateSupervisor,type UpdateJournal} from '../apps/service/update-supervisor.js';
import {SoftwareUpdates,type UpdateWorkspace} from '../apps/service/software-updates.js';
import {NativeUpdateLease} from '../apps/service/update-native-idle.js';
import {Store} from '../apps/service/store.js';
import {operatorNativeInterop} from './fixtures/operator-native-interop.js';

const candidateId='a'.repeat(64),workspaceEpoch='22222222-2222-4222-8222-222222222222',leaseId='11111111-1111-4111-8111-111111111111';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function memory(){let value:unknown,fail:boolean|'after-write'=false,proofValue:unknown;const historical=new Map<string,unknown>();const store:OperatorLeaseStore={read:()=>structuredClone(value),find:id=>historical.get(id),save:lease=>{if(fail===true)throw Error('durability failed');if(value&&(value as OperatorLease).id!==lease.id)historical.set((value as OperatorLease).id,value);value=structuredClone(lease);if(fail==='after-write')throw Error('durability failed after rename');},proof:()=>({value:structuredClone(proofValue),sha256:hash(proofValue)})};return {store,set:(next:unknown)=>value=next,value:()=>structuredClone(value) as OperatorLease,fail:(next:boolean|'after-write')=>fail=next,proof:(next:unknown)=>proofValue=next};}
function proof(outcome:'unchanged'|'rehearsed'='rehearsed'){return {format:1,kind:'operator-maintenance-acceptance',leaseId,candidateId,workspaceEpoch,evidenceSha256:'b'.repeat(64),priorAcceptanceSha256:'c'.repeat(64),returnedAcceptanceSha256:'d'.repeat(64),accountsVerified:true,healthVerified:true,...(outcome==='rehearsed'?{outcome,savedWorkVerified:true,recoveryVerified:true}:{outcome,reason:'insufficient_storage',unchangedVerified:true})};}
function abortProof(){return {format:1,kind:'operator-maintenance-abort-acceptance',outcome:'aborted',reason:'verification_failed_before_swap',leaseId,candidateId,workspaceEpoch,evidenceSha256:'b'.repeat(64),returnedAcceptanceSha256:'c'.repeat(64),snapshotManifestSha256:'d'.repeat(64),snapshotVerifiedSha256:'e'.repeat(64),originalRetained:true,noWorkspaceSwap:true,closedSnapshotVerified:true,accountsVerified:true,healthVerified:true};}
function fixture(saved=memory()){
  let now=1000,current=candidateId,conflict=false;
  const create=()=>new OperatorMaintenance(saved.store,()=>current,()=>{if(conflict)throw Error('installation conflict');},()=>now);
  let operator=create();
  const beat=(heldFor:string|null=null,nativeSuspended=false,extra:Record<string,unknown>={})=>operator.observe({candidateId:current,epoch:workspaceEpoch,heldFor,nativeSuspended,blockers:[],...extra} as any);
  const enter=()=>operator.enter({leaseId,candidateId,workspaceEpoch});
  const held=()=>{beat();enter();beat(leaseId,true);};
  const checking=()=>{held();for(const phase of ['stopping','stopped','snapshot','restore','checking'])operator.mark({leaseId,phase});saved.proof(proof());};
  return {get operator(){return operator;},saved,beat,enter,held,checking,advance:(ms:number)=>now+=ms,current:(id:string)=>current=id,conflict:(value:boolean)=>conflict=value,restart:()=>operator=create()};
}

test('operator entry requires fresh exact idle identity and durable authority before publishing a hold',()=>{
  const f=fixture();assert.throws(f.enter,/fresh idle/);f.beat();f.advance(10000);assert.throws(f.enter,/fresh idle/);f.beat(null,false,{epoch:randomUUID()});assert.throws(f.enter,/fresh idle/);
  f.beat(null,false,{blockers:[{code:'busy',message:'Busy'}]});assert.throws(f.enter,/fresh idle/);f.beat();f.saved.fail(true);assert.throws(f.enter,/durability/);assert.equal(f.operator.holdFor,null);assert.equal(f.operator.active,true);f.saved.fail(false);assert.throws(f.enter,/uncertain/);f.restart();f.beat();f.enter();assert.equal(f.operator.holdFor,leaseId);assert.equal(f.saved.value().phase,'entered');assert.equal(f.operator.status().held,false);
});
test('a persisted entry followed by fsync failure blocks installation until durable authority is reloaded',async()=>{
  const f=fixture();f.beat();f.saved.fail('after-write');assert.throws(f.enter,/after rename/);assert.equal(f.saved.value().phase,'entered');assert.equal(f.operator.active,true);assert.throws(()=>f.operator.status(),/uncertain/);assert.throws(()=>f.operator.cancel({leaseId}),/uncertain/);assert.throws(f.beat,/uncertain/);
  const supervisor=new UpdateSupervisor({status:()=>({availability:'unavailable'})} as any,{current:()=>undefined,find:()=>undefined,save:()=>assert.fail('Uncertain operator authority cannot create an install job')},{} as any,()=>candidateId,Date.now,f.operator);
  assert.equal(supervisor.view().installation.supported,false);await assert.rejects(supervisor.request({}),/operator maintenance/);f.saved.fail(false);f.restart();assert.equal(f.operator.holdFor,leaseId);assert.equal(f.operator.status().freshHeartbeat,false);f.beat(leaseId,true);assert.equal(f.saved.value().phase,'held');
});
test('workload or native acknowledgement mismatch cannot authorize a service stop',()=>{
  const f=fixture();f.beat();f.enter();for(const extra of [{heldFor:null,nativeSuspended:false},{heldFor:leaseId,nativeSuspended:false},{heldFor:leaseId,nativeSuspended:true,blockers:[{code:'busy',message:'Busy'}]}]){f.beat(leaseId,true,extra);assert.throws(()=>f.operator.mark({leaseId,phase:'stopping'}));}
  f.beat(leaseId,true);assert.equal(f.saved.value().phase,'held');f.advance(10000);assert.throws(()=>f.operator.mark({leaseId,phase:'stopping'}));f.beat(leaseId,true);f.operator.mark({leaseId,phase:'stopping'});assert.equal(f.saved.value().stopMarked,true);
});
test('post-stop restart and elapsed time retain the exact lease and prohibit cancellation',()=>{
  const f=fixture();f.held();f.operator.mark({leaseId,phase:'stopping'});f.advance(1e8);f.restart();assert.equal(f.operator.holdFor,leaseId);assert.equal(f.operator.status().freshHeartbeat,false);assert.throws(()=>f.operator.cancel({leaseId}));assert.throws(()=>f.operator.mark({leaseId,phase:'restore'}));assert.throws(()=>f.operator.release({leaseId}));
});
test('cancellation is desired release, not proof that an in-flight native prepare finished',()=>{
  const f=fixture();f.beat();f.enter();f.operator.cancel({leaseId});assert.equal(f.operator.holdFor,null);assert.equal(f.operator.active,true);assert.equal(f.saved.value().phase,'releasing');
  f.beat(leaseId,true);assert.equal(f.operator.active,true,'late suspension acknowledgement cannot finish cancellation');f.beat(null,false,{blockers:[{code:'native_unknown',message:'Unknown'}]});assert.equal(f.operator.active,true);f.beat();assert.equal(f.saved.value().phase,'cancelled');assert.equal(f.operator.active,false);f.enter();assert.equal(f.saved.value().phase,'cancelled','replay does not mint another hold');
});
test('post-stop proof binds exact identity and narrow refusal does not claim full restoration',()=>{
  const f=fixture();f.checking();f.saved.proof({...proof(),workspaceEpoch:randomUUID()});assert.throws(()=>f.operator.release({leaseId}),/does not match/);f.saved.proof(proof('unchanged'));assert(operatorAcceptanceSchema.safeParse(proof('unchanged')).success);assert(!operatorAcceptanceSchema.safeParse({...proof('unchanged'),recoveryVerified:true}).success);
  f.operator.release({leaseId});assert.equal(f.saved.value().releaseKind,'unchanged');assert.equal(f.saved.value().phase,'releasing');assert.equal(f.operator.active,true);f.beat();assert.equal(f.saved.value().phase,'released');
});

test('a verification abort proves retained original and snapshot without inventing a prior acceptance or rehearsal pass',()=>{
  assert(operatorAcceptanceSchema.safeParse(abortProof()).success);
  for(const patch of [{reason:'preflight_failed'},{reason:'insufficient_storage'},{noWorkspaceSwap:false},{originalRetained:false},{closedSnapshotVerified:false},{snapshotManifestSha256:undefined},{snapshotVerifiedSha256:undefined},{priorAcceptanceSha256:'f'.repeat(64)},{savedWorkVerified:true},{recoveryVerified:true},{unchangedVerified:true},{kind:'operator-maintenance-acceptance'}])assert.equal(operatorAcceptanceSchema.safeParse({...abortProof(),...patch}).success,false,JSON.stringify(patch));
});

test('a stopped restore lease can abort only after checked original restart and the normal native release handshake',()=>{
  const f=fixture();f.held();for(const phase of ['stopping','stopped','snapshot','restore'])f.operator.mark({leaseId,phase});f.restart();assert.equal(f.operator.holdFor,leaseId);assert.throws(()=>f.operator.cancel({leaseId}));f.saved.proof(abortProof());assert.throws(()=>f.operator.release({leaseId}));f.operator.mark({leaseId,phase:'checking'});assert.throws(()=>f.operator.release({leaseId}),'restart needs a fresh original heartbeat');f.beat(leaseId,false);assert.throws(()=>f.operator.release({leaseId}));f.beat(leaseId,true,{blockers:[{code:'busy',message:'Busy'}]});assert.throws(()=>f.operator.release({leaseId}));f.beat(leaseId,true);f.saved.proof({...abortProof(),candidateId:'e'.repeat(64)});assert.throws(()=>f.operator.release({leaseId}),/does not match/);f.saved.proof(abortProof());f.operator.release({leaseId});assert.equal(f.saved.value().releaseKind,'aborted');assert.equal(f.saved.value().phase,'releasing');f.restart();assert.equal(f.operator.active,true);f.beat(leaseId,true);assert.equal(f.saved.value().phase,'releasing');f.beat();assert.equal(f.saved.value().phase,'released');assert.equal(f.saved.value().releaseKind,'aborted');assert.equal(f.operator.active,false);
});

test('changing an abort proof during native release fails closed across restart',()=>{
  const f=fixture();f.checking();f.saved.proof(abortProof());f.operator.release({leaseId});f.saved.proof({...abortProof(),snapshotManifestSha256:'f'.repeat(64)});assert.throws(f.restart,/does not match/);assert.throws(f.beat,/does not match/);assert.equal(f.saved.value().phase,'failed');assert.equal(f.operator.holdFor,leaseId);
});
test('proof or durable release-write failure never clears the held authority',()=>{
  const f=fixture();f.checking();f.saved.fail(true);assert.throws(()=>f.operator.release({leaseId}),/durability/);assert.equal(f.operator.holdFor,leaseId);f.saved.fail(false);assert.throws(()=>f.operator.release({leaseId}),/uncertain/);f.restart();f.beat(leaseId,true);f.operator.release({leaseId});f.saved.proof({...proof(),evidenceSha256:'e'.repeat(64)});assert.throws(f.restart,/does not match/);assert.throws(()=>f.beat(),/does not match/);assert.equal(f.saved.value().phase,'failed');assert.equal(f.operator.holdFor,leaseId);
});
test('broken durable authority and impossible phase combinations fail closed',()=>{
  const saved=memory();saved.set({format:1,id:leaseId});assert.throws(()=>fixture(saved));const f=fixture();f.checking();saved.set({...f.saved.value(),phase:'held',stopMarked:true});assert.throws(()=>fixture(saved));
});
test('identity changes cannot advance or release another workspace lease',()=>{
  const f=fixture();f.held();assert.throws(()=>f.operator.cancel({leaseId:randomUUID()}));assert.throws(()=>f.operator.enter({leaseId,candidateId,workspaceEpoch:randomUUID()}));f.beat(leaseId,true,{epoch:randomUUID()});assert.equal(f.saved.value().phase,'failed');assert.equal(f.operator.holdFor,leaseId);assert.throws(()=>f.operator.mark({leaseId,phase:'stopping'}));f.current('b'.repeat(64));assert.throws(()=>f.operator.release({leaseId}));
});
test('an old app heartbeat cannot release maintenance after the selected candidate changes',()=>{
  const f=fixture();f.checking();f.operator.release({leaseId});f.current('e'.repeat(64));f.beat(null,false,{candidateId});assert.equal(f.saved.value().phase,'failed');assert.equal(f.operator.active,true);assert.equal(f.operator.holdFor,leaseId);
});
test('restart refuses simultaneous active installation and operator authorities',()=>{
  const f=fixture();f.held();assert.throws(()=>new UpdateSupervisor({} as any,{current:()=>({id:randomUUID(),state:'failed',hold:true}) as any,find:()=>undefined,save:()=>{}},{} as any,()=>candidateId,Date.now,f.operator),/existing installation/);
});
test('an active installation and an operator lease mutually exclude each other without fake jobs',async()=>{
  const saved=memory();let supervisor:UpdateSupervisor;const operator=new OperatorMaintenance(saved.store,()=>candidateId,()=>supervisor.assertOperatorAdmission());let journalValue:any;
  const journal:UpdateJournal={current:()=>journalValue,find:()=>undefined,save:value=>{journalValue=value;}};
  supervisor=new UpdateSupervisor({status:()=>({availability:'unavailable'}),check:async()=>({availability:'unavailable'}),verifiedRelease:()=>undefined},journal,{} as any,()=>candidateId,Date.now,operator);
  supervisor.beat({candidateId,epoch:workspaceEpoch,heldFor:null,nativeSuspended:false,blockers:[]});operator.enter({leaseId,candidateId,workspaceEpoch});assert.equal(supervisor.view().holdFor,leaseId);assert.equal(supervisor.view().job,undefined);assert.equal(supervisor.view().installation.supported,false);await assert.rejects(supervisor.request({}),/operator maintenance/);assert.equal(journalValue,undefined);
  const conflicted=fixture();conflicted.beat();conflicted.conflict(true);assert.throws(conflicted.enter,/conflict/);assert.equal(conflicted.operator.holdFor,null);
});
test('existing app bridge reconciles a late prepare before acknowledging operator cancellation',async()=>{
  const saved=memory();let supervisor:UpdateSupervisor,heldFor:string|null=null,nativeHeld=false,prepareDone:()=>void=()=>{},resumeCount=0;
  const waiting=new Promise<void>(resolve=>prepareDone=resolve),operator=new OperatorMaintenance(saved.store,()=>candidateId,()=>supervisor.assertOperatorAdmission());
  supervisor=new UpdateSupervisor({status:()=>({availability:'unavailable'}),check:async()=>({availability:'unavailable'}),verifiedRelease:()=>undefined},{current:()=>undefined,find:()=>undefined,save:()=>assert.fail('No installation job allowed')},{} as any,()=>candidateId,Date.now,operator);
  const workspace:UpdateWorkspace={epoch:()=>workspaceEpoch,installed:()=>({novaVersion:'2.0.2',candidateId,agent:{} as any}),hold:id=>{heldFor=id;},heldFor:()=>heldFor,blockers:()=>[],native:{acquire:async()=>{await waiting;nativeHeld=true;return [];},release:async()=>{nativeHeld=false;resumeCount++;return [];},snapshot:()=>({nativeSuspended:nativeHeld}),pendingJobIds:()=>nativeHeld?[leaseId]:[]}};
  const bridge=new SoftwareUpdates(workspace,{call:async(action,value)=>{assert.equal(action,'heartbeat');return supervisor.beat(value as any) as any;}});
  await bridge.refresh();operator.enter({leaseId,candidateId,workspaceEpoch});const preparing=bridge.refresh();await new Promise(resolve=>setImmediate(resolve));operator.cancel({leaseId});prepareDone();await preparing;assert.equal(operator.active,true);assert.equal(nativeHeld,true);await bridge.refresh();assert.equal(resumeCount,1);assert.equal(heldFor,null);assert.equal(operator.active,true);await bridge.refresh();assert.equal(operator.active,false);assert.equal(saved.value().phase,'cancelled');bridge.close();
});
test('real app bridge and durable native lease reconcile lost prepare and resume before operator cancellation',async()=>{
  await operatorNativeInterop({SoftwareUpdates,NativeUpdateLease,Store});
});
test('private store preserves terminal IDs and rejects malformed current state', {skip:process.platform==='linux'&&process.getuid?.()!==0},()=>{
  const root=mkdtempSync(join(process.env.QA_PROTECTED_PARENT??(process.platform==='linux'?'/root':tmpdir()),'nova-operator-'));chmodSync(root,0o700);
  try{const store=new FileOperatorLeaseStore(root),f=fixture({...memory(),store} as any);f.beat();f.enter();f.operator.cancel({leaseId});f.beat();f.operator.enter({leaseId:randomUUID(),candidateId,workspaceEpoch});assert.equal((store.find(leaseId) as OperatorLease).phase,'cancelled');writeFileSync(join(root,'current.json'),'{}');assert.throws(()=>new OperatorMaintenance(store,()=>candidateId,()=>{}));}finally{rmSync(root,{recursive:true,force:true});}
});

test('abort file proof requires every retained-snapshot companion and accepts no substituted bytes', {skip:process.platform==='linux'&&process.getuid?.()!==0},()=>{
  const root=mkdtempSync(join(process.env.QA_PROTECTED_PARENT??(process.platform==='linux'?'/root':tmpdir()),'nova-operator-abort-'));chmodSync(root,0o700);
  try{const store=new FileOperatorLeaseStore(root),folder=join(root,leaseId);mkdirSync(folder,{mode:0o700});const value=abortProof();const companions=[['abort.json','evidenceSha256'],['returned-acceptance.json','returnedAcceptanceSha256'],['snapshot-manifest.json','snapshotManifestSha256'],['snapshot-verified.json','snapshotVerifiedSha256']] as const;
    for(const [name,field] of companions){const bytes=Buffer.from(JSON.stringify({fixture:name}));writeFileSync(join(folder,name),bytes,{mode:0o600});value[field]=createHash('sha256').update(bytes).digest('hex');}writeFileSync(join(folder,'acceptance.json'),JSON.stringify(value),{mode:0o600});assert.deepEqual(store.proof(leaseId).value,value,'no prior-acceptance.json exists or is needed');
    for(const [name] of companions){const path=join(folder,name),bytes=readFileSync(path);unlinkSync(path);assert.throws(()=>store.proof(leaseId));writeFileSync(path,'{}',{mode:0o600});assert.throws(()=>store.proof(leaseId),/evidence changed/);writeFileSync(path,bytes,{mode:0o600});}assert.deepEqual(store.proof(leaseId).value,value);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a dangling authority symlink is corrupt state, not an absent lease', {skip:process.platform==='linux'&&process.getuid?.()!==0},t=>{
  const root=mkdtempSync(join(process.env.QA_PROTECTED_PARENT??(process.platform==='linux'?'/root':tmpdir()),'nova-operator-'));chmodSync(root,0o700);
  try{const store=new FileOperatorLeaseStore(root);try{symlinkSync(join(root,'missing'),join(root,'current.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Creating symlinks requires platform permission.');return;}throw error;}assert.throws(()=>store.read());}finally{rmSync(root,{recursive:true,force:true});}
});
