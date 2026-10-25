import {randomUUID} from 'node:crypto';
import {canonical,commandSchema,taskSchema,type Entity,type Task} from '../../packages/domain/contracts.js';
import {syncTaskSubtasks} from '../../packages/domain/task-subtasks.js';
import {focusElapsed,localDate,timezone,type Occurrence,type TaskEvent} from '../../packages/domain/tasks.js';
import {reminderInstant,reminderSchema,type Reminder,type NotificationAttempt,type ReminderSpec} from '../../packages/domain/reminders.js';
import {DraftCapacityContext,type DraftStoredRow} from './feed-draft-capacity.js';
import {consumedTaskFocus} from './feed-task-focus-fields.js';

type Role='credit'|'event'|'focus'|'notification'|'old-reminder'|'new-reminder'|'mapping';
export type TaskServiceChange=Readonly<{role:Role;key:string;previous?:DraftStoredRow;value:unknown;payload:Buffer}>;
type FaultFactory=(status:number,code:string,message:string)=>Error;
const states=['scheduled','ready','missed','unavailable','dismissed','cancelled'] as const;
const notificationStates=['claimed','shown','unavailable','unknown'] as const;

/** Store-private, synchronous, fixed Task program. No caller-provided service
 * keys, writes, inventory or callback can enter the seven-role plan. */
export class TaskCapacityPlanner{
 readonly #c:DraftCapacityContext;
 #phase:'fresh'|'normalizing'|'ready'|'services'|'spent'='fresh';
 #reminder?:Readonly<{id:string;revision:number;current:DraftStoredRow|undefined;previousRevision:number;previousSpec:Readonly<ReminderSpec>|null;spec:Readonly<ReminderSpec>;instant:number}>;
 constructor(c:DraftCapacityContext,private now:()=>number,private fault:FaultFactory,private catalogue?:{assertTrash:(id:string)=>'required'|'children'|undefined}){this.#c=c;c.slots(8,416);}
 private error(status:number,code:string,message:string):never{throw this.fault(status,code,message);}
 private object(value:any,message:string){this.#c.need(value!==null&&typeof value==='object'&&!Array.isArray(value),message);}
 private safe(value:unknown,min=0){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;}
 private finite(value:unknown,min=-Number.MAX_SAFE_INTEGER){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=Number.MAX_SAFE_INTEGER;}
 private pair<T>(a:unknown,b:unknown,fn:()=>T){this.#c.slots(3,48);return this.#c.child([a??null,b??null],fn);}
 private same(a:unknown,b:unknown){return this.pair(a,b,()=>canonical(a)===canonical(b));}
 private clock(){const at=this.now();this.#c.guard();this.#c.need(this.safe(at)&&at<=8640000000000000,'Task clock invalid');return at;}
 parse(value:unknown):Task{
  // Each Task parse can construct two timezone formatters; URL refinements
  // have at most ten bounded source URLs. Reserve before entering Zod.
  this.#c.slots(256,32768);this.#c.slots(640,81920);
  const parsed=this.#c.child(value,()=>taskSchema.parse(value));
  if(parsed.origin)this.#c.need(this.safe(parsed.origin.revision,1),'Task source revision invalid');
  if(parsed.workLink)this.#c.need(this.safe(parsed.workLink.assignmentRevision,1)&&this.safe(parsed.workLink.taskRevision,1),'Task work link revision invalid');
  return parsed;
 }
 private retained(row:DraftStoredRow):Task{
  const parsed=this.parse(row.value);this.#c.need(this.same(row.value,parsed),'Retained Task must not be normalized');return row.value as Task;
 }
 private task(id:string){const row=this.#c.row('entities',id,'task');if(row)this.retained(row);return row;}
 private source(kind:string,id:string){
  const row=this.#c.row('entities',id,kind);if(!row)return;
  this.object(row.value,'Task source value malformed');
  this.#c.need(row.value.archived===undefined||typeof row.value.archived==='boolean','Task source archive state malformed');
  this.#c.need(row.value.projectId===undefined||row.value.projectId===null||typeof row.value.projectId==='string','Task source Project malformed');
  if(typeof row.value.projectId==='string')this.#c.key(row.value.projectId);return row;
 }
 private occurrence(value:any,id:string){
  this.object(value,'Task occurrence malformed');
  this.#c.need(value.taskId===id&&typeof value.routineId==='string'&&this.safe(value.templateRevision,1)&&['task','habit'].includes(value.kind),'Task occurrence identity malformed');
  this.#c.key(value.routineId);this.#c.slots(128,16384);
  this.#c.child(value,()=>{localDate.parse(value.date);timezone.parse(value.timezone);});
  return value as Occurrence;
 }
 private sameReminder(a:ReminderSpec|null|undefined,b:ReminderSpec|null|undefined){
  if(a==null||b==null)return a==null&&b==null;
  for(const key in b)if(Object.hasOwn(b,key)&&key!=='date'&&key!=='time'&&key!=='timezone'&&key!=='overlap')return false;
  return a.date===b.date&&a.time===b.time&&a.timezone===b.timezone&&a.overlap===b.overlap;
 }
 private resolve(spec:ReminderSpec){this.#c.slots(4096,262144);return this.#c.child(spec,()=>reminderInstant(spec));}
 normalize(id:string,value:Task,current?:DraftStoredRow):Task{
  this.#c.need(this.#phase==='fresh','Task normalization already entered');this.#phase='normalizing';
  let completed=false;
  try{
   const result=this.#c.checked(()=>{
  let reminderInstant:number|undefined,reminderSpec:ReminderSpec|undefined,previousSpec:ReminderSpec|null=null;
  const prior=current?this.retained(current):undefined;
  if((value.trashed||prior?.trashed)&&!this.catalogue)this.error(409,'history_capacity_route_held','Task Trash awaits its complete capacity integration.');
  if(value.workResult&&!this.same(value.workResult,prior?.workResult))this.error(409,'history_capacity_route_held','Saved result file admission awaits its complete capacity integration.');
  value=this.pair(value,prior,()=>syncTaskSubtasks(value,prior));
  if(value.parentTaskId){
   this.#c.slots(3,128);const seen=new Set<string>([id]);let parentId:string|null|undefined=value.parentTaskId;
   while(parentId){const parent=this.task(parentId);
    if(!parent||seen.has(parentId)||(!value.trashed&&parent.value.trashed))this.error(409,'invalid_parent','Choose an available parent task outside this task’s own children.');
    this.#c.slots(1,32);seen.add(parentId);parentId=parent.value.parentTaskId;
   }
  }
  if(prior&&!this.same(value.origin,prior.origin)){
   const plan=!prior.origin&&value.origin?.kind==='assignment'?this.source('assignment',value.origin.id):undefined;
   if(!plan||plan.value.archived||plan.raw.revision!==value.origin?.revision||(prior.workLink&&prior.workLink.assignmentId!==plan.raw.id)||(plan.value.projectId??null)!==(value.projectId??null))this.error(409,'source_changed','Keep this task linked to its original source.');
  }
  if(!prior&&value.origin){const source=this.source(value.origin.kind,value.origin.id);
   if(!source||source.value.archived||source.raw.revision!==value.origin.revision)this.error(409,'source_changed','Review the current source before linking a new task.');
  }
  if(!value.workLink&&prior?.workLink)value.workLink=prior.workLink;
  if(prior?.workLink&&!this.same(value.workLink,prior.workLink))this.error(409,'task_work_changed','Keep the saved work link. Reopen this task to review its plan.');
  if(value.workLink&&!prior?.workLink){const plan=this.source('assignment',value.workLink.assignmentId);
   if(!current||value.workLink.taskRevision!==current.raw.revision||!plan||plan.value.archived||plan.raw.revision!==value.workLink.assignmentRevision||(plan.value.projectId??null)!==(value.projectId??null)||(value.origin?.kind==='assignment'&&value.origin.id!==plan.raw.id))this.error(409,'task_work_changed','Review the current task and saved plan before linking work.');
  }
  if(value.trashed||prior?.trashed){
   if(!prior)this.error(409,'task_trashed','Save a task before moving it to Trash.');
   const same=this.pair(value,prior,()=>{const {trashed:before,...original}=prior!,{trashed:after,...proposal}=value;return before!==after&&canonical(original)===canonical(proposal);});
   if(!same)this.error(409,'task_trashed','Restore this task before editing it.');
   if(value.trashed){const reason=this.catalogue!.assertTrash(id);
    if(reason==='required')this.error(409,'task_required','Another task needs this prerequisite. Remove that dependency before moving it to Trash.');
    if(reason==='children')this.error(409,'task_has_children','Move or trash this task’s children before moving their parent to Trash.');
   }
   return value;
  }
  const occurrence=this.#c.row('service_records','tasks:occurrence:'+id);if(occurrence)this.occurrence(occurrence.value,id);
  if((!current&&id.startsWith('task:occ:'))||(value.status==='skipped'&&!occurrence))this.error(400,'invalid_occurrence','Skip belongs to a recurring occurrence.');
  if((value.plannedTime&&!value.planned)||(value.dueTime&&!value.due))this.error(400,'invalid_time','Choose a date before adding a time.');
  if((value.plannedTime||value.dueTime)&&!value.timezone)this.error(400,'invalid_time','Choose a timezone for this time.');
  if(value.reminder&&!this.same(value.reminder,prior?.reminder)){
   if(['done','skipped'].includes(value.status))this.error(400,'invalid_reminder_time','Reopen this task before adding a new reminder.');
   reminderSpec=this.#c.capture(value.reminder) as ReminderSpec;previousSpec=prior?.reminder?this.#c.capture(prior.reminder) as ReminderSpec:null;
   const resolved=this.resolve(reminderSpec);if(resolved.instant===null)this.error(400,'invalid_reminder_time',resolved.problem==='gap'?'This reminder time does not exist in its timezone. Choose another time.':'This reminder time occurs twice. Choose the earlier or later occurrence.');
   reminderInstant=resolved.instant;
  }
  if(value.projectId&&!this.#c.row('entities',value.projectId,'project'))this.error(409,'missing_project','Choose an available Project.');
  for(const dependency of value.dependencies??[]){
   const other=this.task(dependency);if(!other||other.value.trashed)this.error(409,'invalid_dependency','Dependencies must exist and cannot form a loop.');
   this.#c.slots(4,160);const visited=new Set<string>(),stack=[dependency];
   while(stack.length){const next=stack.pop()!;if(next===id)this.error(409,'invalid_dependency','Dependencies must exist and cannot form a loop.');if(visited.has(next))continue;
    this.#c.slots(1,32);visited.add(next);const node=next===dependency?other:this.task(next);
    for(const child of node?.value.dependencies??[]){this.#c.slots(1,16);stack.push(child);}
   }
   if(['active','done'].includes(value.status)&&other.value.status!=='done')this.error(409,'dependency_open','Complete the prerequisite first, or keep this task blocked.');
  }
  if(value.status==='done'&&value.checklist?.some(item=>!item.done))this.error(409,'checklist_open','Finish the checklist before completing this task.');
  if(reminderInstant!==undefined){
   // This fact is only reminderInstant(spec), never Task validation or write
   // authority. Owned frozen four-field inputs keep its cost independent of
   // notes/checklists; all normalization, Store copying and proofs still run.
   this.#c.need(this.#c.child(value.reminder,()=>this.sameReminder(reminderSpec,value.reminder)),'Task reminder changed during normalization');
   if(current)this.#c.need(this.#c.child(current.value.reminder??null,()=>this.sameReminder(previousSpec,current.value.reminder)),'Task predecessor reminder changed during normalization');
   this.#c.slots(8,256+id.length*2);
   this.#reminder=Object.freeze({id,revision:(current?.raw.revision??0)+1,current,previousRevision:current?.raw.revision??0,previousSpec,spec:reminderSpec!,instant:reminderInstant});
  }
  return value;
   });this.#phase='ready';completed=true;return result;
  }finally{if(!completed){this.#reminder=undefined;this.#phase='spent';}}
 }

 private notification(value:any){
  this.object(value,'Task notification malformed');this.#c.need(typeof value.attemptId==='string'&&typeof value.deviceId==='string'&&typeof value.clientId==='string'&&this.finite(value.at)&&notificationStates.includes(value.state),'Task notification fields malformed');
  // Persisted notification attempts use the maintained UUID domain, unlike
  // general historical keys (which deliberately permit an empty cursor).
  this.#c.child(value.attemptId,()=>commandSchema.shape.requestId.parse(value.attemptId));
  this.#c.key(value.attemptId);this.#c.key(value.deviceId);this.#c.key(value.clientId);
 }
 private reminder(value:any,id:string,taskId:string):Reminder{
  this.object(value,'Task reminder malformed');this.#c.need(value.id===id&&value.taskId===taskId&&this.safe(value.revision,1)&&this.safe(value.taskRevision,1)&&states.includes(value.state)&&(value.dueAt===null||this.finite(value.dueAt))&&this.safe(value.snoozes),'Task reminder fields malformed');
  this.#c.need((value.reason===undefined||typeof value.reason==='string')&&(value.seenAt===undefined||this.finite(value.seenAt)),'Task reminder metadata malformed');
  this.#c.slots(128,16384);const spec=this.#c.child(value.spec,()=>reminderSchema.parse(value.spec));this.#c.need(this.same(spec,value.spec),'Task reminder spec would change');
  if(value.notification!==undefined)this.notification(value.notification);return value;
 }
 private attempt(value:any,attemptId:string,reminderId:string,taskId:string):NotificationAttempt{
  this.notification(value);this.#c.need(value.attemptId===attemptId&&value.reminderId===reminderId&&value.taskId===taskId&&(value.dueAt===null||this.finite(value.dueAt))&&this.safe(value.snoozes),'Task notification predecessor owner malformed');return value;
 }
 services(task:Entity<Task>,current?:DraftStoredRow):readonly TaskServiceChange[]{
  this.#c.need(this.#phase==='ready','Task services require one completed normalization');this.#phase='services';
  const reminder=this.#reminder;this.#reminder=undefined;
  try{
   return this.#c.checked(()=>{
    if(reminder){
     this.#c.need(reminder.id===task.id&&reminder.revision===task.revision&&reminder.current===current&&reminder.previousRevision===(current?.raw.revision??0)&&(!current||current.raw.id===task.id),'Task reminder owner changed');
     this.#c.need(Object.isFrozen(task.value)&&Object.isFrozen(task.value.reminder),'Task reminder requires the immutable normalized copy');
     this.#c.need(this.#c.child(task.value.reminder,()=>this.sameReminder(reminder.spec,task.value.reminder)),'Task reminder normalized spec changed');
     if(current)this.#c.need(this.#c.child(current.value.reminder??null,()=>this.sameReminder(reminder.previousSpec,current.value.reminder)),'Task reminder predecessor spec changed');
    }
  this.#c.slots(4,192);const changes:TaskServiceChange[]=[],keys=new Set<string>(),id=task.id,prior=current?.value as Task|undefined;
  this.#c.slots(1,64);const add=(role:Role,key:string,previous:DraftStoredRow|undefined,value:unknown)=>{
   this.#c.key(key);this.#c.need(changes.length<7&&!keys.has(key),'Task service role collision');
   this.#c.need(!previous||previous.raw.revision<Number.MAX_SAFE_INTEGER,'Task service revision exhausted');
   this.#c.slots(3,160);keys.add(key);const owned=this.#c.capture(value),payload=this.#c.encrypted('service:'+key,owned);
   changes.push(Object.freeze({role,key,previous,value:owned,payload}));
  };
  const trashChanged=!!task.value.trashed!==!!prior?.trashed;
  if(task.value.status!==prior?.status||trashChanged){
   const creditKey='tasks:credit:'+id,credit=this.#c.row('service_records',creditKey);
   if(credit){this.object(credit.value,'Task credit malformed');this.#c.need(typeof credit.value.credited==='boolean','Task credit flag malformed');}
   const legacy=this.#c.row('service_records','tasks:legacy-completion:'+id),done=task.value.status==='done',earned=credit?.value.credited??false;
   this.#c.slots(1,32);add('credit',creditKey,credit,{credited:done});
   this.#c.slots(4,256);const eventId=id+':'+task.revision,eventKey='tasks:event:'+eventId;
   this.#c.need(!this.#c.row('service_records',eventKey),'Task event identity already exists');
   const event:TaskEvent={id:eventId,taskId:id,at:new Date(this.clock()).toISOString(),from:prior?.status??null,to:task.value.status,xpDelta:legacy?0:done&&!earned?10:!done&&earned?-10:0,...(trashChanged?{action:task.value.trashed?'trash' as const:'restore' as const}:{})};
   add('event',eventKey,undefined,event);
   if(task.value.status!=='active'||task.value.trashed){
    const key='tasks:focus:'+id,row=this.#c.row('service_records',key),focus=row?consumedTaskFocus(this.#c,row.value,id):undefined;
    if(focus?.running){this.#c.need(focus.revision<Number.MAX_SAFE_INTEGER,'Task focus revision exhausted');
     const elapsedAt=this.clock();this.#c.need(this.finite(elapsedAt-focus.lastPulse),'Task focus elapsed arithmetic overflow');
     const elapsed=focusElapsed(focus,elapsedAt),lastPulse=this.clock();this.#c.need(this.finite(elapsed,0),'Task focus elapsed overflow');
     const value=this.#c.child(focus,()=>({...focus,running:false,elapsedMs:elapsed,lastPulse,revision:focus.revision+1}));add('focus',key,row,value);
    }
   }
  }
  const mappingKey='reminders:task:'+id,mapping=this.#c.row('service_records',mappingKey);let old:DraftStoredRow|undefined;
  if(mapping){this.#c.need(typeof mapping.value==='string'&&mapping.value.length>0,'Task reminder mapping malformed');this.#c.key(mapping.value);old=this.#c.row('service_records','reminders:item:'+mapping.value);if(old)this.reminder(old.value,mapping.value,id);}
  const changed=!this.same(task.value.reminder,prior?.reminder),finished=!!task.value.trashed||['done','skipped'].includes(task.value.status);
  if(old&&(changed||finished)&&!['dismissed','cancelled'].includes(old.value.state)){
   const item=old.value as Reminder;this.#c.need(item.revision<Number.MAX_SAFE_INTEGER,'Task reminder revision exhausted');
   if(item.notification){const key='reminders:attempt:'+item.notification.attemptId,before=this.#c.row('service_records',key);if(before)this.attempt(before.value,item.notification.attemptId,item.id,id);
    const value=this.#c.child(item,()=>({...item.notification!,reminderId:item.id,taskId:id,dueAt:item.dueAt,snoozes:item.snoozes}));add('notification',key,before,value);
   }
   const value=this.#c.child(item,()=>({...item,state:'cancelled' as const,revision:item.revision+1}));add('old-reminder','reminders:item:'+item.id,old,value);
  }
  if(changed&&task.value.reminder&&!finished){
   this.#c.need(reminder,'Task reminder normalization result missing');
   const instant=reminder.instant;this.#c.slots(5,512);const reminderId=randomUUID(),key='reminders:item:'+reminderId;
   this.#c.need(!this.#c.row('service_records',key),'Task reminder identity already exists');
   const value:Reminder={id:reminderId,taskId:id,taskRevision:task.revision,revision:1,spec:task.value.reminder,dueAt:instant,state:'scheduled',snoozes:0};
   add('new-reminder',key,undefined,value);add('mapping',mappingKey,mapping,reminderId);
  }
  this.#c.guard();return Object.freeze(changes);
   });
  }finally{this.#reminder=undefined;this.#phase='spent';}
 }
 footprint(changes:readonly TaskServiceChange[]){
  this.#c.slots(2+changes.length*2,128+changes.length*192);
  return Object.freeze({services:Object.freeze(changes.map(item=>Object.freeze({role:item.role,key:item.key,previousBytes:item.previous?.raw.payload.byteLength??0,nextBytes:item.payload.byteLength,absent:!item.previous})))});
 }
}
