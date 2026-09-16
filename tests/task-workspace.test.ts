import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import type { Command, Entity, Task } from '../packages/domain/contracts';
import { inTaskView } from '../packages/domain/tasks';
import { taskSearch, orderTaskView, taskBlockers, taskDateLabel } from '../packages/domain/task-presentation';
import { createTaskActions, type TaskJournal } from '../apps/client/src/task-actions';
const value: Task = { title: 'Prepare project brief', notes: 'Include the budget', status: 'open', planned: '2026-09-12', due: '2026-09-15' };
const entity = (title = value.title): Entity<Task> => ({ id: `task:${randomUUID()}`, revision: 1, deviceId: 'fixture', updatedAt: '2026-09-12T10:00:00Z', value: { ...value, title } });
function fixture() {
 const path=mkdtempSync(join(tmpdir(),'nova-task-workspace-'));let store=new Store(path,()=>Date.parse('2026-09-12T17:00:00Z'));
 const command=(task:Entity<Task>,patch:Partial<Task>):Command=>({requestId:randomUUID(),epoch:store.epoch,kind:'task',entityId:task.id,expectedRevision:task.revision,payload:{...task.value,...patch}});
 const create=(patch:Partial<Task>={})=>store.mutate('fixture',command({...entity(),revision:0},patch)) as Entity<Task>;
 return {get store(){return store;},command,create,restart(){store.close();store=new Store(path,()=>Date.parse('2026-09-12T17:00:00Z'));},close(){store.close();rmSync(path,{recursive:true,force:true});}};
}
test('Trash preserves identity/history, stops focus and reminders, and restores without rearming',()=>{
 const f=fixture();try{
  let task=f.create({status:'active',reminder:{date:'2026-09-13',time:'09:00',timezone:'UTC'}});
  f.store.focus('fixture',{requestId:randomUUID(),epoch:f.store.epoch,taskId:task.id,expectedRevision:0,clientId:randomUUID(),action:'start'});
  const trash=f.command(task,{trashed:true});task=f.store.mutate('fixture',trash) as Entity<Task>;
  assert.deepEqual(f.store.mutate('fixture',trash),task);let snap=f.store.snapshot('fixture');assert.equal(snap.tasks.length,0);assert.equal(snap.trashedTasks?.[0].id,task.id);assert.equal(snap.taskState?.focus[0].running,false);assert.equal(snap.taskState?.reminders?.[0].state,'cancelled');assert.equal(snap.taskState?.earnedXp,0);
  assert.throws(()=>f.store.mutate('fixture',f.command(task,{notes:'Not yet'})),/Restore/);
  f.restart();task=f.store.mutate('fixture',f.command(task,{trashed:false})) as Entity<Task>;snap=f.store.snapshot('fixture');assert.equal(snap.tasks[0].id,task.id);assert.equal(snap.tasks[0].value.planned,value.planned);assert.equal(snap.taskState?.focus[0].running,false);assert.equal(snap.taskState?.reminders?.[0].state,'cancelled');assert.deepEqual(snap.taskState?.events.filter(e=>e.action).map(e=>e.action).sort(),['restore','trash']);
 }finally{f.close();}
});
test('Trash cannot remove a required prerequisite or bypass task validation; finished credit is stable',()=>{
 const f=fixture();try{
  const parent=f.create({status:'done'});let child=f.create({dependencies:[parent.id]});assert.throws(()=>f.store.mutate('fixture',f.command(parent,{trashed:true})),/prerequisite/);
  child=f.store.mutate('fixture',f.command(child,{trashed:true})) as Entity<Task>;
  assert.throws(()=>f.store.mutate('fixture',f.command(child,{trashed:false,status:'done'})),/Restore/);
  let trashed=f.store.mutate('fixture',f.command(parent,{trashed:true})) as Entity<Task>;assert.equal(f.store.snapshot('fixture').taskState?.earnedXp,10);
  trashed=f.store.mutate('fixture',f.command(trashed,{trashed:false})) as Entity<Task>;assert.equal(f.store.snapshot('fixture').taskState?.earnedXp,10);
  assert.throws(()=>f.store.mutate('fixture',f.command({...entity(),revision:0},{trashed:true})),/Save a task/);
 }finally{f.close();}
});
test('full task revision history is scoped and paged independently of the summary event limit',()=>{
 const f=fixture();try{
  let task=f.create();for(let i=0;i<30;i++)task=f.store.mutate('fixture',f.command(task,{notes:`Revision ${i}`})) as Entity<Task>;
  const other=f.create({title:'Different task'}),page=f.store.taskHistory({taskId:task.id});assert.equal(page.versions.length,25);assert.equal(page.versions[0].revision,31);assert.equal(page.beforeRevision,7);const older=f.store.taskHistory({taskId:task.id,beforeRevision:page.beforeRevision});assert.equal(older.versions.length,6);assert.equal(older.beforeRevision,null);assert.ok([...page.versions,...older.versions].every(v=>v.id===task.id));assert.equal(f.store.taskHistory({taskId:other.id}).versions.length,1);assert.throws(()=>f.store.taskHistory({taskId:'project:missing'}),/unavailable/);
 }finally{f.close();}
});
function actionsFixture() {
 let journal:TaskJournal|undefined,failStorage=false;const db=new Map<string,Entity<Task>>(),receipts=new Map<string,Entity<Task>>();let drop=false,quota=false,diskAfter=false;
 const commit=async(cmd:Command)=>{if(quota)throw Object.assign(Error('Try later'),{status:429});const prior=receipts.get(cmd.requestId);if(prior)return prior;const current=db.get(cmd.entityId);if(current?.revision!==cmd.expectedRevision)throw Object.assign(Error('Newer version'),{status:409});if((cmd.payload as Task).title==='Reject')throw Object.assign(Error('Prerequisite open'),{status:409});const next={...current,revision:current.revision+1,value:cmd.payload as Task};db.set(next.id,next);receipts.set(cmd.requestId,next);if(diskAfter){diskAfter=false;failStorage=true;}if(drop){drop=false;throw Error('Response lost');}return next;};
 const make=(epoch='epoch')=>createTaskActions({epoch,initial:journal,persist(next){if(failStorage)return false;journal=structuredClone(next);return true;},commit,changed(){},async refresh(){}});
 return{db,receipts,make,get journal(){return journal!;},drop(){drop=true;},quota(value:boolean){quota=value;},disk(value:boolean){failStorage=value;},diskAfterSave(){diskAfter=true;}};
}
test('an interrupted batch resumes the exact saved request after reload and Undo restores original values',async()=>{
 const f=actionsFixture(),a=entity('A'),b=entity('B');f.db.set(a.id,a);f.db.set(b.id,b);let actions=f.make();f.drop();assert.equal(await actions.run([a,b].map(task=>({task,value:{...task.value,planned:'2026-09-13'}})),'Planned tomorrow'),false);const firstId=f.journal.queue[0].command.requestId;assert.equal(f.receipts.size,1);actions=f.make();assert.equal(await actions.retry(),true);assert.equal(f.receipts.size,2);assert.ok(f.receipts.has(firstId));assert.equal(f.journal.queue.length,0);assert.equal(f.journal.undo.length,2);assert.equal(await actions.undo(),true);assert.equal(f.db.get(a.id)?.value.planned,value.planned);assert.equal(f.db.get(b.id)?.value.due,value.due);
});
test('one rejected task leaves successful batch effects undoable; stale Undo cannot overwrite a newer edit',async()=>{
 const f=actionsFixture(),a=entity('A'),b=entity('Reject');f.db.set(a.id,a);f.db.set(b.id,b);const actions=f.make();assert.equal(await actions.run([a,b].map(task=>({task,value:{...task.value,status:'done'}})),'Completed'),false);assert.equal(f.journal.queue.length,0);assert.equal(f.journal.undo.length,1);assert.match(f.journal.error,/Prerequisite/);const newer={...f.db.get(a.id)!,revision:3,value:{...value,title:'Newer writing'}};f.db.set(a.id,newer);assert.equal(await actions.undo(),false);assert.deepEqual(f.db.get(a.id),newer);
});
test('quota failures and unavailable local storage never discard unconfirmed mutations',async()=>{
 const f=actionsFixture(),task=entity();f.db.set(task.id,task);const actions=f.make();f.disk(true);assert.equal(await actions.run([{task,value:{...task.value,status:'done'}}],'Done'),false);assert.equal(f.receipts.size,0);f.disk(false);f.quota(true);await actions.run([{task,value:{...task.value,status:'done'}}],'Done');assert.equal(f.journal.queue.length,1);f.quota(false);assert.equal(await actions.retry(),true);assert.equal(f.journal.queue.length,0);
});
test('Undo from an older workspace epoch is rejected without dispatch',async()=>{
 const f=actionsFixture(),task=entity();f.db.set(task.id,task);await f.make().run([{task,value:{...task.value,status:'done'}}],'Done');const count=f.receipts.size;assert.equal(await f.make('recovered').undo(),false);assert.equal(f.receipts.size,count);assert.match(f.journal.error,/workspace changed/);
});
test('task search, ordering, blockers and Trash views preserve dates and task identity',()=>{
 const a=entity('Write brief'),b=entity('Book venue');a.value.checklist=[{id:randomUUID(),text:'Check finance totals',done:false}];b.value.priority='high';assert.ok(taskSearch(a.value,'finance project','Project launch'));assert.equal(taskSearch(a.value,'missing'),false);assert.equal(orderTaskView([a,b],'priority')[0].id,b.id);assert.equal(orderTaskView([a,b],'planned',[b.id,a.id])[0].id,b.id);assert.equal(inTaskView({...a.value,trashed:true},'Today','2026-09-12'),false);assert.equal(inTaskView({...a.value,trashed:true},'Trash','2026-09-12'),true);assert.deepEqual(taskBlockers({...a.value,dependencies:[b.id]},[b]),['Book venue']);assert.equal(taskDateLabel('2026-09-13','2026-09-12'),'Tomorrow');assert.equal(taskDateLabel('2026-09-11','2026-09-12'),'Yesterday');assert.equal(a.value.due,'2026-09-15');
});

test('a storage failure after the host save retains the original receipt for reload recovery',async()=>{
 const f=actionsFixture(),task=entity();f.db.set(task.id,task);const actions=f.make();f.diskAfterSave();assert.equal(await actions.run([{task,value:{...task.value,status:'done'}}],'Done'),false);assert.equal(f.receipts.size,1);assert.equal(f.journal.queue.length,1);const request=f.journal.queue[0].command.requestId;f.disk(false);const recovered=f.make();assert.equal(await recovered.retry(),true);assert.equal(f.receipts.size,1);assert.ok(f.receipts.has(request));assert.equal(f.journal.undo.length,1);assert.equal(await recovered.undo(),true);assert.equal(f.db.get(task.id)?.value.status,'open');
});
test('a rejected row stays visible after a later response is lost and retried',async()=>{
 const f=actionsFixture(),a=entity('Reject'),b=entity('B');f.db.set(a.id,a);f.db.set(b.id,b);f.drop();await f.make().run([a,b].map(task=>({task,value:{...task.value,status:'done'}})),'2 tasks updated');assert.equal(f.journal.queue.length,1);assert.equal(f.journal.rejected?.length,1);assert.equal(await f.make().retry(),false);assert.equal(f.journal.queue.length,0);assert.match(f.journal.error,/Prerequisite/);assert.equal(f.journal.notice,'1 changes saved. Review the remaining tasks.');assert.equal(f.db.get(a.id)?.value.status,'open');assert.equal(f.db.get(b.id)?.value.status,'done');
});

test('completion keeps its planning-list position and checked state across restart',()=>{
 const f=fixture();try{
  let first=f.create({title:'First task'}),second=f.create({title:'Second task'});const order={requestId:randomUUID(),epoch:f.store.epoch,date:'2026-09-12',timezone:'UTC',expectedRevision:0,taskIds:[first.id,second.id]};f.store.orderTasks('fixture',order);first=f.store.mutate('fixture',f.command(first,{status:'done'})) as Entity<Task>;
  for(const view of ['Today','All','History'] as const)assert.equal(inTaskView(first.value,view,'2026-09-12'),true);
  assert.equal(inTaskView(first.value,'Today','2026-09-13'),false);assert.equal(inTaskView({...first.value,planned:'2026-09-13'},'Upcoming','2026-09-12'),true);assert.equal(inTaskView({...first.value,planned:''},'Capture','2026-09-12'),true);assert.equal(inTaskView({...first.value,planned:'',bucket:'anytime'},'Anytime','2026-09-12'),true);
  f.store.orderTasks('fixture',{...order,requestId:randomUUID(),expectedRevision:1});f.restart();const snapshot=f.store.snapshot('fixture'),shown=snapshot.tasks.filter(t=>inTaskView(t.value,'Today','2026-09-12'));assert.deepEqual(orderTaskView(shown,'planned',order.taskIds).map(t=>t.id),order.taskIds);assert.equal(shown.find(t=>t.id===first.id)?.value.status,'done');assert.equal(first.value.due,value.due);
 }finally{f.close();}
});
