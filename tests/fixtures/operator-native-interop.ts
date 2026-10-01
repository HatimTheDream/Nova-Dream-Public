import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AssistantConnection} from '../../packages/domain/assistant.js';
import type {SoftwareUpdates,UpdateWorkspace} from '../../apps/service/software-updates.js';
import type {NativeUpdateLease} from '../../apps/service/update-native-idle.js';
import type {Store} from '../../apps/service/store.js';
import {OperatorMaintenance,type OperatorLease} from '../../apps/service/operator-maintenance.js';
import {UpdateSupervisor} from '../../apps/service/update-supervisor.js';

/** The same scenario accepts source classes in CI and pinned prior compiled
 * classes in an operator compatibility check, exercising their real receipts. */
export async function operatorNativeInterop(classes:{SoftwareUpdates:typeof SoftwareUpdates;NativeUpdateLease:typeof NativeUpdateLease;Store:typeof Store}){
  const root=mkdtempSync(join(tmpdir(),'nova-operator-interop-')),store=new classes.Store(join(root,'workspace'));
  const candidateId='a'.repeat(64),leaseId=randomUUID(),time=Date.now(),owned={epoch:store.epoch,pid:112,url:'ws://127.0.0.1:55321',generation:randomUUID(),startedAt:time-5000,version:'2026.9.6' as const};
  const state:AssistantConnection={state:'ready',url:owned.url,generation:owned.generation,message:'',grantedScopes:['operator.read','operator.admin'],methods:['system.info','gateway.suspend.prepare','gateway.suspend.status','gateway.suspend.resume'],modelAuthReady:false};
  let nativeHold:{requestId:string;suspensionId:string;expiresAtMs:number}|undefined,heldFor:string|null=null,value:OperatorLease|undefined,supervisor:UpdateSupervisor,dropResume=true,modelReads=0;
  const prepares:string[]=[],resumes:string[]=[];
  let startedPrepare:()=>void=()=>{},losePrepareReply:()=>void=()=>{};
  const preparing=new Promise<void>(resolve=>startedPrepare=resolve),deferredPrepare=new Promise<void>(resolve=>losePrepareReply=resolve);
  const factory=()=>({start(){},async stop(){},status:()=>state,serviceInfo:()=>({id:'openclaw',name:'OpenClaw',state:'ready' as const,version:owned.version}),subscribe:()=>()=>{},async request<T>(method:string,raw:unknown):Promise<T>{
    const input=raw as Record<string,unknown>;
    if(method==='system.info'){assert.equal(nativeHold,undefined);return {pid:owned.pid,processInstanceId:'process-'+owned.pid} as T;}
    if(method==='gateway.suspend.prepare'){
      assert.equal(input.terminalPolicy,'preserve');assert.equal(input.drain,false);prepares.push(String(input.requestId));
      if(nativeHold)assert.equal(input.requestId,nativeHold.requestId);
      nativeHold??={requestId:String(input.requestId),suspensionId:randomUUID(),expiresAtMs:time+120000};
      if(prepares.length===1){startedPrepare();await deferredPrepare;throw Error('prepare response lost after native suspension');}
      return {status:'ready',suspensionId:nativeHold.suspensionId,expiresAtMs:nativeHold.expiresAtMs,activeCount:0,blockers:[],writeCustody:[]} as T;
    }
    if(method==='gateway.suspend.resume'){
      resumes.push(String(input.suspensionId));if(nativeHold)assert.equal(input.suspensionId,nativeHold.suspensionId);const resumed=!!nativeHold;nativeHold=undefined;
      if(dropResume){dropResume=false;throw Error('resume response lost after native resumed');}return {ok:true,status:'running',resumed} as T;
    }
    throw Error('Unexpected gateway method: '+method);
  }});
  const assistant={status:()=>({...state,grantedScopes:['operator.read','operator.write'],modelAuthReady:true}),serviceInfo:()=>({id:'openclaw',name:'OpenClaw',state:'ready' as const,version:owned.version}),async models(){modelReads++;assert.equal(nativeHold,undefined);return [];}};
  const native=new classes.NativeUpdateLease(store,{updateIdentity:()=>owned,updateStartupBlockers:()=>[]},factory,()=>time,assistant);
  const operator=new OperatorMaintenance({read:()=>value,find:()=>undefined,save:next=>{value=structuredClone(next);},proof:()=>assert.fail('Pre-stop cancellation must not claim recovery proof')},()=>candidateId,()=>supervisor.assertOperatorAdmission(),()=>time);
  supervisor=new UpdateSupervisor({status:()=>({availability:'unavailable'}),check:async()=>({availability:'unavailable'}),verifiedRelease:()=>undefined},{current:()=>undefined,find:()=>undefined,save:()=>assert.fail('Operator maintenance must not manufacture install jobs')},{} as never,()=>candidateId,()=>time,operator);
  const workspace:UpdateWorkspace={epoch:()=>store.epoch,installed:()=>({novaVersion:'2.0.2',candidateId,agent:{} as never}),hold:id=>{heldFor=id;store.setUpdateMaintenanceHeld(!!id);},heldFor:()=>heldFor,blockers:()=>[],native};
  const bridge=new classes.SoftwareUpdates(workspace,{call:async(action,input)=>{assert.equal(action,'heartbeat');return supervisor.beat(input as never) as never;}});
  try{
    await bridge.refresh();operator.enter({leaseId,candidateId,workspaceEpoch:store.epoch});const pending=bridge.refresh();await preparing;
    assert.equal(store.internalRead<{state:string}>('update:native-lease:'+leaseId)?.state,'preparing');operator.cancel({leaseId});assert.equal(operator.active,true);assert.equal(operator.holdFor,null);
    losePrepareReply();await pending;assert.equal(operator.active,true);assert.equal(heldFor,leaseId);assert.deepEqual(native.pendingJobIds(),[leaseId]);
    await bridge.refresh();assert.equal(operator.active,true);assert.equal(heldFor,leaseId);assert.equal(store.internalRead<{state:string}>('update:native-lease:'+leaseId)?.state,'releasing');assert.equal(modelReads,0);
    await bridge.refresh();assert.equal(heldFor,null);assert.equal(operator.active,true,'Only a subsequent clear heartbeat acknowledges native release');assert.equal(modelReads,1);assert.deepEqual(native.pendingJobIds(),[]);
    await bridge.refresh();assert.equal(operator.active,false);assert.equal(value?.phase,'cancelled');assert.equal(store.internalRead<{state:string}>('update:native-lease:'+leaseId)?.state,'released');
    assert.equal(prepares.length,2);assert.equal(new Set(prepares).size,1,'An ambiguous prepare must preserve its request identity');assert.equal(resumes.length,2);assert.equal(new Set(resumes).size,1,'A lost resume reply must retry the same native suspension');
  }finally{losePrepareReply();bridge.close();await native.close();store.close();rmSync(root,{recursive:true,force:true});}
}
