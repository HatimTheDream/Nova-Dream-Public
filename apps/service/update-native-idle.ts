import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssistantTransport } from './gateway.js';
import type { ManagedRuntime } from './runtime.js';
import { Store } from './store.js';

type Identity = NonNullable<ReturnType<ManagedRuntime['updateIdentity']>>;
type Transport = Pick<AssistantTransport,'status'|'request'|'serviceInfo'|'subscribe'> & {start():void;stop():Promise<void>};
export type NativeUpdateBlocker = {code:string;message:string};
const id=z.string().min(1).max(128).regex(/^\S+$/);
const identity=z.object({epoch:z.uuid(),pid:z.number().int().positive(),url:z.string(),generation:z.string().min(1),startedAt:z.number().int().positive(),version:z.enum(['2026.9.2','2026.9.6'])}).strict();
const savedSchema=z.object({jobId:z.uuid(),requestId:z.uuid(),identity,processInstanceId:id,state:z.enum(['preparing','held','releasing','released']),suspensionId:id.optional(),expiresAtMs:z.number().int().nonnegative().optional()}).strict();
type Saved=z.infer<typeof savedSchema>;
const key=(jobId:string)=>'update:native-lease:'+jobId;
const methods=['system.info','gateway.suspend.prepare','gateway.suspend.status','gateway.suspend.resume'];
const unknown=():NativeUpdateBlocker[]=>[{code:'native_unknown',message:'Assistant update readiness could not be verified. Its existing work is kept.'}];
const same=(a:Identity,b:Identity|undefined)=>!!b&&Object.keys(a).every(k=>a[k as keyof Identity]===b[k as keyof Identity]);

/** Uses the reviewed OpenClaw versions' cooperative suspension contract.
 * prepare(false, preserve) checks the process-wide inventory atomically with
 * native admission. Busy never drains/interrupts work. Stable request IDs recover
 * lost replies; only our saved suspension ID can be resumed. Source contract:
 * openclaw@2026.9.2 docs/gateway/external-apps.md and suspend coordinator.
 */
export class NativeUpdateLease {
  private transport?:Transport;
  private sequence:Promise<unknown>=Promise.resolve();
  private verified?:Saved;
  private unsubscribe?:()=>void;
  private startupCheck?:{key:string;blockers:NativeUpdateBlocker[]};
  private closed=false;
  constructor(private store:Store,private runtime:Pick<ManagedRuntime,'updateIdentity'|'updateStartupBlockers'>,private factory:()=>Transport,private now=Date.now){}
  private serial<T>(run:()=>Promise<T>):Promise<T>{const result=this.sequence.then(run,run);this.sequence=result.catch(()=>{});return result;}
  private read(jobId:string){const raw=this.store.internalRead(key(jobId));return raw===undefined?undefined:savedSchema.parse(raw);}
  private save(value:Saved){return this.store.internalWrite(key(value.jobId),value);}
  pendingJobIds(){
    const ids=new Set<string>();
    for(const raw of this.store.internalList('update:native-lease:')){const value=savedSchema.parse(raw);ids.add(value.jobId);if(ids.size>1000)throw Error('Update receipt inventory needs review.');}
    // Read the exact current key rather than accidentally treating preserved
    // predecessor receipts as current holds.
    return [...ids].filter(jobId=>{const saved=this.read(jobId);if(!saved)throw Error('Current update receipt is missing.');return saved.state!=='released';});
  }
  private async connection(owned:Identity){
    if(this.closed)return;
    if(this.transport&&(!['unconfigured','connecting','ready'].includes(this.transport.status().state)||this.transport.status().generation&&this.transport.status().generation!==owned.generation)){this.unsubscribe?.();await this.transport.stop();this.transport=undefined;}
    if(!this.transport){this.transport=this.factory();this.unsubscribe=this.transport.subscribe(event=>{if(['e3.connected','e3.disconnected','e3.connection-stopped','e3.history-gap'].includes(event.event)||event.event==='gateway.suspension')this.verified=undefined;});this.transport.start();}
    const state=this.transport.status(),info=this.transport.serviceInfo?.();
    if(state.state!=='ready'||state.url!==owned.url||state.generation!==owned.generation||!state.grantedScopes.includes('operator.admin')||!state.grantedScopes.includes('operator.read')||!methods.every(m=>state.methods.includes(m))||info?.id!=='openclaw'||info.version!==owned.version)return;
    return this.transport;
  }
  snapshot(jobId:string|null){
    const value=this.verified,connection=this.transport?.status();
    const nativeSuspended=!this.closed&&!!value&&value.jobId===jobId&&value.state==='held'&&!!value.suspensionId&&!!value.expiresAtMs&&value.expiresAtMs-this.now()>15000&&this.store.updateMaintenanceHeld&&same(value.identity,this.runtime.updateIdentity())&&connection?.state==='ready'&&connection.url===value.identity.url&&connection.generation===value.identity.generation;
    return {nativeSuspended,...(nativeSuspended?{expiresAtMs:value!.expiresAtMs}:{})};
  }
  acquire(jobId:string):Promise<NativeUpdateBlocker[]>{return this.serial(()=>this.prepare(jobId));}
  private async prepare(jobId:string):Promise<NativeUpdateBlocker[]>{
    this.verified=undefined;
    try{
      z.uuid().parse(jobId);
      if(this.closed||!this.store.updateMaintenanceHeld)return unknown();
      const owned=this.runtime.updateIdentity();if(!owned)return unknown();
      const transport=await this.connection(owned);if(!transport||!same(owned,this.runtime.updateIdentity()))return unknown();
      let saved=this.read(jobId);
      if(saved&&!same(saved.identity,owned)){
        // A new owned child cannot inherit its predecessor's process-local lease.
        // Preserve the old receipt; never send its resume to the successor.
        if(saved.identity.pid===owned.pid&&saved.identity.startedAt===owned.startedAt)return unknown();
        this.store.internalWrite(key(jobId)+':previous:'+saved.requestId,saved);saved=undefined;
      }
      if(!saved||saved.state==='released'){
        const info=z.object({pid:z.number().int().positive(),processInstanceId:id}).passthrough().parse(await transport.request('system.info',{}));
        if(info.pid!==owned.pid||!same(owned,this.runtime.updateIdentity())||!this.store.updateMaintenanceHeld)return unknown();
        saved=this.save({jobId,requestId:randomUUID(),identity:owned,processInstanceId:info.processInstanceId,state:'preparing'});
      }
      const result=await transport.request<Record<string,unknown>>('gateway.suspend.prepare',{requestId:saved.requestId,terminalPolicy:'preserve',drain:false});
      if(!same(owned,this.runtime.updateIdentity()))return unknown();
      if(result.status==='busy'){
        const busy=z.object({status:z.literal('busy'),reason:z.enum(['active-work','gateway-draining']),activeCount:z.number().int().nonnegative(),retryAfterMs:z.number().int().nonnegative(),blockers:z.array(z.object({kind:id,count:z.number().int().nonnegative(),message:z.string()}).passthrough())}).strict().parse(result);
        this.save({...saved,state:'released',suspensionId:undefined,expiresAtMs:undefined});
        return [{code:'native_busy',message:busy.blockers.some(b=>b.kind==='terminal-session')?'Close the Assistant’s open terminals before updating.':'Waiting for the Assistant’s current work and saved results to finish.'}];
      }
      const ready=z.object({status:z.literal('ready'),suspensionId:id,expiresAtMs:z.number().int().nonnegative(),activeCount:z.literal(0),blockers:z.array(z.unknown()).length(0)}).strict().parse(result);
      saved=this.save({...saved,state:'held',suspensionId:ready.suspensionId,expiresAtMs:ready.expiresAtMs});
      if(ready.expiresAtMs-this.now()<=15000||ready.expiresAtMs-this.now()>125000)return unknown();
      const checkKey=JSON.stringify([owned,ready.suspensionId]);
      if(this.startupCheck?.key!==checkKey)this.startupCheck={key:checkKey,blockers:this.runtime.updateStartupBlockers()};
      if(this.startupCheck.blockers.length)return this.startupCheck.blockers;
      this.verified=saved;
      return this.snapshot(jobId).nativeSuspended?[]:unknown();
    }catch{return unknown();}
  }
  release(jobId:string):Promise<NativeUpdateBlocker[]>{return this.serial(async()=>{
    this.verified=undefined;
    try{
      z.uuid().parse(jobId);let saved=this.read(jobId);if(!saved||saved.state==='released')return [];
      const owned=this.runtime.updateIdentity();if(!owned)return unknown();
      if(!same(saved.identity,owned)){if(saved.identity.pid===owned.pid&&saved.identity.startedAt===owned.startedAt)return unknown();this.store.internalWrite(key(jobId)+':previous:'+saved.requestId,saved);this.save({...saved,state:'released'});return [];}
      const transport=await this.connection(owned);if(!transport)return unknown();
      if(!saved.suspensionId){
        // Recover an ambiguous prepare using its original identity; do not guess
        // an ID, release another controller, or silently abandon a held engine.
        const blockers=await this.prepare(jobId);saved=this.read(jobId);
        if(saved?.state==='released')return [];
        if(!saved?.suspensionId)return blockers.length?blockers:unknown();
      }
      saved=this.save({...saved,state:'releasing'});
      const result=await transport.request('gateway.suspend.resume',{suspensionId:saved.suspensionId});
      z.object({ok:z.literal(true),status:z.literal('running'),resumed:z.boolean()}).strict().parse(result);
      if(!same(owned,this.runtime.updateIdentity()))return unknown();
      this.save({...saved,state:'released'});return [];
    }catch{return unknown();}
  });}
  async close(){this.closed=true;this.verified=undefined;await this.sequence;this.unsubscribe?.();await this.transport?.stop();}
}
