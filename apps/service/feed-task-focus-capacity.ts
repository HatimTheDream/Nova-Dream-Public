import {canonical} from '../../packages/domain/contracts.js';
import {focusElapsed,focusLeaseMs,focusSchema,type Focus,type FocusCommand} from '../../packages/domain/tasks.js';
import {DraftCapacityContext,type DraftStoredRow} from './feed-draft-capacity.js';
import {TaskCapacityPlanner} from './feed-task-capacity.js';
import {consumedTaskFocus} from './feed-task-focus-fields.js';
import type {ProducerCompletionPorts} from './feed-history-completion-reader.js';
import type {HistoryWriteSequence} from './feed-history-write-sequence.js';
import {capacitySum} from './feed-projected-capacity-policy.js';

type FaultFactory=(status:number,code:string,message:string)=>Error;
export type TaskFocusPlan=Readonly<{key:string;previous?:DraftStoredRow;value:Readonly<Focus>}>;

/** Authenticated startup hold check. This result is only data: the writer must
 * reread the actual state in its own original transaction before preparing. */
export function focusStartupHeld(c:DraftCapacityContext):boolean{return c.checked(()=>{
 const row=c.row('service_records','recovery:state');if(!row)return false;
 c.need(row.value!==null&&typeof row.value==='object'&&!Array.isArray(row.value)&&
  (row.value.held===undefined||typeof row.value.held==='boolean'),'Focus startup recovery state malformed');
 return row.value.held===true;
});}

export type FocusStartupFootprint=Readonly<{previousBytes:number;nextBytes:number;records:number}>;
/** Closed receiptless plan. Only scalar footprint data reaches the capacity
 * callback; all authenticated predecessors and ciphertexts stay in this scope. */
export function settleTaskFocusStartup(owner:ProducerCompletionPorts,sequence:HistoryWriteSequence,seal:(aad:string,value:unknown)=>Buffer,
 admit:(footprint:FocusStartupFootprint)=>void):void{
 sequence.withFocusStartup(owner,seal,(budget,guard)=>{
  // Ports, context guard/finalizer, plan vector, footprint and fixed work slots.
  for(let i=0;i<12;i++)budget.entry();budget.reserveBytes(768);
  const c:DraftCapacityContext=new DraftCapacityContext({db:owner.db,budget,limits:owner.sequence,recordBytes:owner.limits.objectBytes,guard,openText:owner.openText,seal});
  try{c.checked(()=>{
   c.need(!focusStartupHeld(c),'Focus startup recovery became held');
   const changes:{key:string;revision:number;before:Uint8Array;after:Buffer}[]=[];let previousBytes=0,nextBytes=0;
   for(const key of c.focusKeys()){
    const row=c.row('service_records',key);c.need(!!row,'Focus startup inventory row disappeared');
    c.slots(1,32+key.length*2);const value=consumedTaskFocus(c,row.value,key.slice(12));
    if(!value.running)continue;
    c.need(value.revision<Number.MAX_SAFE_INTEGER&&row.raw.revision<Number.MAX_SAFE_INTEGER,'Focus startup revision exhausted');
    const next=c.child(value,()=>({...value,running:false,revision:value.revision+1}));
    c.slots(1,32+2*(key.length+8));const aad='service:'+key,payload=c.encrypted(aad,next);
    // Both sum argument vectors, the descriptor and its retained vector slot.
    c.slots(4,256);previousBytes=capacitySum(previousBytes,row.raw.payload.byteLength);nextBytes=capacitySum(nextBytes,payload.byteLength);
    changes.push({key,revision:row.raw.revision,before:row.raw.payload,after:payload});
   }
   const returned:unknown=admit(Object.freeze({previousBytes,nextBytes,records:changes.length}));
   c.guard();c.need(returned===undefined,'Focus startup admission must be synchronous and return no value');
   for(const change of changes){
    // Arguments/result and per-effect metadata, followed by query's own slots.
    c.slots(6,320);
    const saved=c.query('UPDATE service_records SET revision=?,payload=? WHERE id=? AND revision=? AND payload=?')
     .run(change.revision+1,change.after,change.key,change.revision,change.before);
    c.need(saved.changes===1,'Focus startup ciphertext predecessor changed');
   }
  });}finally{c.close();}
 });
}

/** Store-private read/derive program only. Store owns original-receipt replay
 * before plan(), followed by ciphertext preparation, capacity and SQL effects.
 * No generic writer, caller-provided service key or payload scan is exposed. */
export class TaskFocusCapacityPlanner{
 constructor(private c:DraftCapacityContext,private fault:FaultFactory){c.slots(2,128);}
 private error(status:number,code:string,message:string):never{throw this.fault(status,code,message);}
 private finite(value:unknown,min=-Number.MAX_SAFE_INTEGER){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=Number.MAX_SAFE_INTEGER;}
 parse(raw:unknown):FocusCommand{return this.c.checked(()=>{
  const owned=this.c.capture(raw),command=this.c.child(owned,()=>focusSchema.parse(owned));
  this.c.need(Number.isSafeInteger(command.expectedRevision),'Task focus expected revision malformed');return Object.freeze(command);
 });}
 plan(device:string,command:FocusCommand,clock:()=>number):TaskFocusPlan{return this.c.checked(()=>{
  this.c.key(device);this.c.key(command.taskId);
  const task=this.c.row('entities',command.taskId,'task');
  if(!task)this.error(404,'task_missing','This task is unavailable.');
  this.c.need(task.value!==null&&typeof task.value==='object'&&!Array.isArray(task.value),'Task focus Task malformed');
  this.c.need(task.value.trashed===undefined||typeof task.value.trashed==='boolean','Task focus Task Trash malformed');
  if(task.value.trashed)this.error(404,'task_missing','This task is unavailable.');
  this.c.need(typeof task.value.status==='string','Task focus Task status malformed');
  this.c.slots(1,32+command.taskId.length*2);const key='tasks:focus:'+command.taskId,previous=this.c.row('service_records',key);
  const current=previous?consumedTaskFocus(this.c,previous.value,command.taskId):undefined;
  if((current?.revision??0)!==command.expectedRevision)this.error(409,'focus_changed','Focus changed in another window. Review its current state.');
  const now=clock();this.c.guard();this.c.need(this.finite(now,0),'Task focus clock invalid');
  if(command.action==='start'){
   if(task.value.status!=='active')this.error(409,'task_not_active','Start this task before focusing on it.');
   const planner=new TaskCapacityPlanner(this.c,clock,this.fault),parsed=planner.parse(task.value),validated=planner.normalize(command.taskId,parsed,task);
   this.c.slots(3,48);this.c.need(this.c.child([task.value,validated],()=>canonical(task.value)===canonical(validated)),'Retained Task must not be normalized');
   for(const focusKey of this.c.focusKeys()){
    const row=this.c.row('service_records',focusKey);this.c.need(!!row,'Task focus inventory row disappeared');
    this.c.slots(1,32+focusKey.length*2);const other=consumedTaskFocus(this.c,row.value,focusKey.slice(12));
    if(this.live(other,now)&&(other.taskId!==command.taskId||other.clientId!==command.clientId||other.deviceId!==device))this.error(409,'focus_busy','Another focus session is running. Pause it in its window or wait for it to disconnect.');
   }
  }else{
   if(!current||current.deviceId!==device||current.clientId!==command.clientId)this.error(409,'focus_owner','Only the window that started this focus session can update it.');
  }
  if(command.action==='pulse'&&(!current||!this.live(current,now)||task.value.status!=='active'))this.error(409,'focus_expired','Focus paused after an interruption. Resume explicitly when you are ready.');
  this.c.need(!current||current.revision<Number.MAX_SAFE_INTEGER,'Task focus revision exhausted');
  this.c.need(!previous||previous.raw.revision<Number.MAX_SAFE_INTEGER,'Task focus service revision exhausted');
  if(current?.running)this.c.need(this.finite(now-current.lastPulse),'Task focus elapsed arithmetic overflow');
  const elapsedMs=current?focusElapsed(current,now):0;this.c.need(this.finite(elapsedMs,0),'Task focus elapsed overflow');
  this.c.slots(10,512);
  const value:Focus=Object.freeze({taskId:command.taskId,deviceId:device,clientId:command.clientId,revision:(current?.revision??0)+1,running:command.action!=='pause',elapsedMs,lastPulse:now});
  return Object.freeze({key,previous,value});
 });}
 private live(value:Focus,now:number){
  if(!value.running)return false;
  this.c.need(this.finite(value.lastPulse+focusLeaseMs),'Task focus lease arithmetic overflow');return now<value.lastPulse+focusLeaseMs;
 }
}
