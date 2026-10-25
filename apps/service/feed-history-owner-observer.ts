import {FeedHistoryOwnerFence,type FeedHistoryOwnerRole,type FeedHistoryWorkKind} from './feed-history-owner-fence.js';
import {AsyncLocalStorage} from 'node:async_hooks';

export type HistoryOwnerToken=Readonly<{finish():void}>;
export interface HistoryOwnerPort{
 enter(kind:FeedHistoryWorkKind):HistoryOwnerToken;
 run<T>(kind:FeedHistoryWorkKind,produce:()=>Promise<T>,settled?:(original:Promise<T>)=>void):Promise<T>;
 sync<T>(kind:FeedHistoryWorkKind,produce:()=>T):T;
 taint(reason:unknown):void;
}
export interface HistoryTransactionPorts{
 inTransaction():boolean;
 begin():void;initialize():void;verify():void;commit():void;rollback():void;cleanup():void;
}
type AdmissionContext={open:boolean;pending:number;done:boolean;uncertain:boolean;released:boolean;finish():void};
const attached=new WeakMap<object,FeedHistoryOwnerObservation>(),constructed=new WeakSet<object>();
const noopToken=Object.freeze({finish(){}});
const ordinary:HistoryOwnerPort=Object.freeze({enter:()=>noopToken,
 run<T>(_kind:FeedHistoryWorkKind,produce:()=>Promise<T>,settled?:(original:Promise<T>)=>void){
  const original=produce();if(settled)void original.then(()=>settled(original),()=>settled(original));return original;
 },sync<T>(_kind:FeedHistoryWorkKind,produce:()=>T){return produce();},taint(){}});

/** Constructor call sites own their role. No HTTP/native qualification, SQL,
 * reconciliation assertion or maintenance lease is exposed by this observer. */
export function claimFeedHistoryOwner(store:object,role:FeedHistoryOwnerRole):HistoryOwnerPort{
 constructed.add(store);return attached.get(store)?.claim(role)??ordinary;
}
/** Private source-review attachment, called by Store before real constructors.
 * A default Store that already constructed a Feed owner cannot attach later. */
export function attachFeedHistoryOwnerObservation(store:object):FeedHistoryOwnerObservation{
 if(attached.has(store)||constructed.has(store))throw Error('History owner observation must precede composition');
 const value=new FeedHistoryOwnerObservation(store);attached.set(store,value);return value;
}
export function feedHistoryOwnerObservation(store:object){return attached.get(store);}
export function feedHistoryOwnerBlockers(store:object){const state=attached.get(store)?.status();return {
 'feed-history-owned':state?.rawWork??0,
 'feed-history-uncertain':Number(!!state&&(state.transactionTainted||state.localOwnershipUnresolved))
};}

export class FeedHistoryOwnerObservation{
 private readonly fence:FeedHistoryOwnerFence;
 private readonly roles=new Set<FeedHistoryOwnerRole>();
 private readonly work=new Map<object,{role:FeedHistoryOwnerRole;kind:FeedHistoryWorkKind}>();
 private generation=0;
 private maintenanceIneligible=false;
 private transactionTainted=false;
 private localOwnershipUnresolved=false;
 private closing=false;
 private admissionPort?:HistoryOwnerPort;
 private admissionActive=false;
 private readonly admissionContext=new AsyncLocalStorage<AdmissionContext>();
 private readonly failures:unknown[]=[];
 constructor(store:object){this.fence=new FeedHistoryOwnerFence(store);}
 private fail(reason:unknown,transaction=false){
  this.maintenanceIneligible=true;
  if(transaction)this.transactionTainted=true;else this.localOwnershipUnresolved=true;
  // Failure ownership itself is bounded. Preserve the first concrete cause.
  if(!this.failures.length)this.failures.push(reason);
 }
 taintTransaction(reason:unknown){this.fail(reason,true);}
 invalidateMaintenance(){this.maintenanceIneligible=true;}
 assertMutation(){
  const context=this.admissionContext.getStore();
  if(context&&!context.open)throw Error('Escaped history admission continuation cannot mutate this Store');
  if(this.closing||this.transactionTainted||this.localOwnershipUnresolved)throw Error('History owner mutation is held');
 }
 beginClose(){this.closing=true;}
 assertDisposable(){if(this.work.size||this.transactionTainted||this.localOwnershipUnresolved)throw Error('Original history owner work or transaction remains unsettled');}
 /** The Store supplies exact synchronous SQLite operations. The observer never
  * repeats an operation and does not infer native reconciliation from rollback. */
 transaction<T>(ports:HistoryTransactionPorts,body:()=>T):T{
  this.assertMutation();
  if(!this.admissionPort)throw Error('Actual private admission owner is missing');
  if(this.admissionActive||ports.inTransaction())throw Error('Nested history mutation cannot own the outer transaction');
  const token=this.admissionPort.enter('admission');
  const state:AdmissionContext={open:true,pending:0,done:false,uncertain:false,released:false,finish:()=>{
   if(state.done&&!state.pending&&!state.uncertain&&!state.released){token.finish();state.released=true;}
  }};
  this.admissionActive=true;
  return this.admissionContext.run(state,()=>{
   let began=false,commitAttempted=false,committed=false,value!:T;const errors:unknown[]=[];
   const taint=(error:unknown)=>{state.uncertain=true;this.taintTransaction(error);};
   const actual=()=>{try{const result=ports.inTransaction();if(typeof result!=='boolean')throw Error('Actual SQLite transaction state unavailable');return result;}
    catch(error){errors.push(error);taint(error);return undefined;}};
   try{
    ports.begin();began=true;if(actual()!==true)throw Error('Original SQLite transaction did not become active');
    ports.initialize();value=this.synchronous(body);ports.verify();
    commitAttempted=true;ports.commit();committed=true;
    if(actual()!==false){const error=Error('Committed SQLite transaction disposition is unknown');taint(error);throw error;}
   }catch(error){
    errors.push(error);const active=actual();
    if(!began){if(active!==false)taint(error);}
    else if(active===true){
     try{ports.rollback();if(actual()!==false)taint(Error('Original rollback did not settle SQLite'));}
     catch(rollbackError){errors.push(rollbackError);taint(rollbackError);}
    }else if(active!==false||commitAttempted&&!committed)taint(error);
   }finally{
    if(began)try{ports.cleanup();}catch(error){errors.push(error);taint(error);}
    state.open=false;state.done=true;this.admissionActive=false;
    try{state.finish();}catch(error){errors.push(error);taint(error);}
   }
   if(errors.length>1)throw new AggregateError(errors,'Original Store transaction and disposition failed');
   if(errors.length)throw errors[0];return value;
  });
 }
 /** A forbidden Promise from prepare/body remains part of the original
  * transaction owner after synchronous rollback, until its actual settlement. */
 synchronous<T>(produce:()=>T):T{
  this.assertMutation();const state=this.admissionContext.getStore();
  if(!state?.open)throw Error('Exact current history admission callback required');
  const value=produce();let then:unknown;
  try{if(value!==null&&(typeof value==='object'||typeof value==='function'))then=(value as {then?:unknown}).then;}
  catch(error){this.maintenanceIneligible=true;throw error;}
  if(typeof then==='function'){
   this.maintenanceIneligible=true;state.pending++;
   const original=new Promise<unknown>((resolve,reject)=>{try{Reflect.apply(then,value,[resolve,reject]);}catch(error){reject(error);}});
   const settled=()=>{state.pending--;try{state.finish();}catch(error){state.uncertain=true;this.fail(error);}};
   void original.then(settled,settled);throw Error('History admission callback must remain synchronous');
  }
  return value;
 }
 status(){const byKind:Record<string,number>={};for(const {role,kind} of this.work.values()){const key=role+':'+kind;byKind[key]=(byKind[key]??0)+1;}
  return {registered:this.roles.size,roles:[...this.roles],rawWork:this.work.size,generation:this.generation,byKind,
   maintenanceIneligible:this.maintenanceIneligible,transactionTainted:this.transactionTainted,localOwnershipUnresolved:this.localOwnershipUnresolved,
   maintenanceAvailable:false as const,closing:this.closing};}
 claim(role:FeedHistoryOwnerRole):HistoryOwnerPort{
  if(this.closing||this.roles.has(role))throw Error('History owner role is duplicated or closing');
  const registered=this.fence.register(role);this.roles.add(role);
  const enter=(kind:FeedHistoryWorkKind):HistoryOwnerToken=>{
   this.assertMutation();
   if(!Number.isSafeInteger(this.generation+this.work.size+2)||!Number.isSafeInteger(this.work.size+1)){this.fail(Error('History owner count exhausted'));throw Error('History owner count exhausted');}
   const original=registered.enter(kind),key={};this.work.set(key,{role,kind});this.generation++;let done=false;
   return Object.freeze({finish:()=>{if(done){this.fail(Error('History owner token already settled'));throw Error('History owner token already settled');}
    try{original.finish();this.work.delete(key);this.generation++;done=true;}catch(error){this.fail(error);throw error;}}});
  };
  const finish=(token:HistoryOwnerToken,cleanup?:()=>void)=>{try{cleanup?.();token.finish();}catch(error){this.fail(error);}};
  const port:HistoryOwnerPort=Object.freeze({enter,
   run:<T>(kind:FeedHistoryWorkKind,produce:()=>Promise<T>,settled?:(original:Promise<T>)=>void):Promise<T>=>{
    const token=enter(kind);let original:Promise<T>;
    try{original=Promise.resolve(produce());}catch(error){finish(token);throw error;}
    // Return the actual native Promise unchanged. The finite observer and reuse
    // maps keep its identity; cleanup completes before this exact token leaves.
    void original.then(()=>finish(token,()=>settled?.(original)),()=>finish(token,()=>settled?.(original)));
    return original;
   },
   sync:<T>(kind:FeedHistoryWorkKind,produce:()=>T):T=>{
    const token=enter(kind);let value:T;
    try{value=produce();}catch(error){finish(token);throw error;}
    let then:unknown;
    try{if(value!==null&&(typeof value==='object'||typeof value==='function'))then=(value as {then?:unknown}).then;}
    catch(error){this.maintenanceIneligible=true;finish(token);throw error;}
    if(typeof then==='function'){
     this.maintenanceIneligible=true;
     // Assimilation happens while token remains owned. The already-read method
     // is invoked once, avoiding a second getter with different behavior.
     const original=new Promise<unknown>((resolve,reject)=>{try{Reflect.apply(then,value,[resolve,reject]);}catch(error){reject(error);}});
     void original.then(()=>finish(token),()=>finish(token));
     throw Error('History owner synchronous callback returned a thenable');
    }
    finish(token);return value;
   },taint:(reason:unknown)=>this.fail(reason)});
  if(role==='private-admission')this.admissionPort=port;
  return port;
 }
}
