import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import { CalendarService } from '../apps/service/calendar';
import type { Entity, Task } from '../packages/domain/contracts';
import type { Routine } from '../packages/domain/tasks';
import type { CalendarState, LocalEventInput } from '../packages/domain/calendar';
import { cadenceGroup, inTaskDestination } from '../packages/domain/task-presentation';
import { calendarTaskRows, calendarSeriesKey } from '../apps/client/src/task-calendar-rows';
import { projectCalendarEvent } from '../apps/client/src/dreamclaw/calendar-projection';
const now = Date.parse('2026-09-12T19:00:00Z'), range = { from: '2026-09-01', to: '2026-11-01', timezone: 'America/Los_Angeles' };
const routine: Routine = { title: 'Monthly planning', notes: '', kind: 'task', state: 'active', startsOn: '2026-09-12', timezone: range.timezone, cadence: 'monthly', interval: 1, weekdays: [], projectId: null, plannedTime: '09:00', priority: 'normal', estimateMinutes: 30 };
function fixture() {
 let clock=now;const path=mkdtempSync(join(tmpdir(),'nova-task-calendar-')),store=new Store(path,()=>clock);
 const accounts={state:()=>({accounts:[],clients:[],attempts:[],probes:[]}),calendarSources:async()=>({items:[],limited:false}),calendarEvents:async()=>({events:[],coverage:'complete' as const,pages:1,skipped:0})};
 const calendar=new CalendarService(store,accounts,()=>clock),command=()=>({requestId:randomUUID(),epoch:store.epoch});
 return {store,calendar,command,set clock(value:number){clock=value;},async close(){await calendar.close();store.close();rmSync(path,{recursive:true,force:true});}};
}
test('three destinations retain today completion, carry unfinished work, and keep tomorrow distinct',()=>{
 const task:Entity<Task>={id:'task:test',revision:1,deviceId:'a',updatedAt:new Date(now).toISOString(),value:{title:'Carry forward',notes:'',status:'open',planned:'2026-09-10',due:''}};
 assert.ok(inTaskDestination(task,'Today','2026-09-12',range.timezone));
 task.value.status='done';assert.ok(inTaskDestination(task,'Today','2026-09-12',range.timezone));assert.ok(inTaskDestination(task,'Completed','2026-09-12',range.timezone));assert.equal(inTaskDestination(task,'Today','2026-09-13',range.timezone),false);
 task.value.planned='2026-09-13';assert.ok(inTaskDestination(task,'Scheduled','2026-09-12',range.timezone));assert.equal(inTaskDestination(task,'Today','2026-09-12',range.timezone),false);
 task.value.trashed=true;assert.equal(inTaskDestination(task,'Completed','2026-09-12',range.timezone),false);
 assert.equal(cadenceGroup({...routine,cadence:'weekly',interval:2}),'Every two weeks');assert.equal(cadenceGroup({...routine,cadence:'daily',interval:2}),'Custom');assert.equal(cadenceGroup(routine),'Monthly');
});
test('future routine dates project into Calendar without materializing duplicate tasks and edits share the original series',async()=>{
 const f=fixture();try{
  const id='routine:'+randomUUID();let saved=f.store.mutate('a',{...f.command(),kind:'routine',entityId:id,expectedRevision:0,payload:routine}) as Entity<Routine>;
  const before=f.store.snapshot('a').tasks.length;let state=f.calendar.state('a',range),future=state.events.find(e=>e.routineId===id)!;
  assert.equal(future.interval.kind,'instant');assert.equal(future.interval.start,'2026-10-12T16:00:00.000Z');assert.equal(f.store.snapshot('a').tasks.length,before);
  assert.equal(projectCalendarEvent(future,state).sourceRoute,`/tasks?routine=${encodeURIComponent(id)}`);
  saved=f.store.mutate('a',{...f.command(),kind:'routine',entityId:id,expectedRevision:saved.revision,payload:{...saved.value,plannedTime:'11:00',title:'Updated planning'}}) as Entity<Routine>;
  state=f.calendar.state('a',range);future=state.events.find(e=>e.routineId===id)!;assert.equal(future.title,'Updated planning');assert.equal(future.interval.start,'2026-10-12T18:00:00.000Z');
  const current=state.events.find(e=>e.taskId)!;assert.equal(current.title,'Monthly planning');
  f.store.mutate('a',{...f.command(),kind:'routine',entityId:id,expectedRevision:saved.revision,payload:{...saved.value,state:'paused'}});
  assert.equal(f.calendar.state('a',range).events.some(e=>e.routineId===id),false);
 }finally{await f.close();}
});
test('existing occurrence edits, completion and Trash override future projections by canonical identity',async()=>{
 const f=fixture();try{
  const id='routine:'+randomUUID();f.store.mutate('a',{...f.command(),kind:'routine',entityId:id,expectedRevision:0,payload:routine});
  const futureId=`task:occ:${id.slice(8)}:2026-10-12`;
  f.clock=Date.parse('2026-10-12T19:00:00Z');const materialized=f.store.snapshot('a').tasks.find(t=>t.id===futureId)!;f.clock=now;
  let task=f.store.mutate('a',{...f.command(),kind:'task',entityId:futureId,expectedRevision:materialized.revision,payload:{...materialized.value,title:'Changed occurrence',status:'done',planned:'2026-10-13',plannedTime:''}}) as Entity<Task>;
  let state=f.calendar.state('a',range),events=state.events.filter(e=>e.id===futureId);assert.equal(events.length,1);assert.equal(events[0].interval.start,'2026-10-13');assert.equal(projectCalendarEvent(events[0],state).status,'completed');
  task=f.store.mutate('a',{...f.command(),kind:'task',entityId:task.id,expectedRevision:task.revision,payload:{...task.value,trashed:true}}) as Entity<Task>;
  assert.equal(f.calendar.state('a',range).events.some(e=>e.id===futureId),false);
 }finally{await f.close();}
});
test('monthly local calendar events appear in Tasks with exact occurrence identity and reflect original edits',async()=>{
 const f=fixture();try{
  const id=randomUUID(),value:LocalEventInput={title:'Monthly team review',notes:'',location:'',timezone:range.timezone,allDay:true,start:{date:'2026-09-12',time:'00:00'},end:{date:'2026-09-13',time:'00:00'},state:'confirmed',projectId:null,taskId:null,repeat:{cadence:'monthly',interval:1,weekdays:[]}};
  let saved=f.calendar.saveLocal('a',{...f.command(),eventId:id,expectedRevision:0,value,scope:'series'});
  const rows=calendarTaskRows(f.calendar.state('a',range),new Map());assert.equal(rows.length,2);assert.ok(rows.every(row=>row.localId===id&&row.group==='Monthly'));assert.equal(rows[1].originalDate,'2026-10-12');assert.equal(f.store.snapshot('a').tasks.length,0);
  f.calendar.saveLocal('a',{...f.command(),eventId:id,expectedRevision:saved.revision,expectedExceptionsRevision:saved.exceptionsRevision??0,value:{...value,title:'Renamed team review'},scope:'series',exceptions:'keep'});
  assert.ok(calendarTaskRows(f.calendar.state('a',range),new Map()).every(row=>row.event.title==='Renamed team review'));
 }finally{await f.close();}
});
test('provider recurrence classification is source-generation scoped and never copies appointments into tasks',()=>{
 const source={id:'source',generation:randomUUID(),provider:'google' as const,accountId:'account',calendarId:'calendar',name:'Work',accountLabel:'Work',primary:true,providerCanWrite:true,selected:true,state:'ready' as const};
 const state:CalendarState={epoch:randomUUID(),deviceId:'a',eventsLimited:false,selection:{revision:1,sourceIds:['source'],showLocal:true,showTasks:true},jobs:[],accountMessages:[],range,sources:[source],localEvents:[],events:[{id:'instance',sourceId:'source',seriesId:'master',title:'Planning',notes:'',location:'',status:'confirmed',interval:{kind:'date',start:'2026-10-12',end:'2026-10-13'}}]};
 const repeats=new Map([[calendarSeriesKey(source.id,source.generation,'master'),{cadence:'monthly' as const,interval:1}]]);
 assert.equal(calendarTaskRows(state,repeats)[0].group,'Monthly');source.generation=randomUUID();assert.equal(calendarTaskRows(state,repeats)[0].group,'Custom');source.selected=false;assert.equal(calendarTaskRows(state,repeats).length,0);
});

test('several monthly dates share Calendar identities with materialized Tasks, including the last day',async()=>{
 const f=fixture();try{
  const id='routine:'+randomUUID();f.store.mutate('a',{...f.command(),kind:'routine',entityId:id,expectedRevision:0,payload:{...routine,monthDays:[1,15,31,-1]}});
  const projected=f.calendar.state('a',range).events.filter(e=>e.routineId===id);
  assert.deepEqual(projected.map(e=>e.id),['2026-09-15','2026-09-30','2026-10-01','2026-10-15','2026-10-31'].map(date=>`task:occ:${id.slice(8)}:${date}`));
  assert.equal(f.store.snapshot('a').tasks.length,0);
  f.clock=Date.parse('2026-10-31T19:00:00Z');const state=f.calendar.state('a',range),tasks=f.store.snapshot('a').tasks;
  assert.deepEqual(tasks.map(t=>t.id).sort(),projected.map(e=>e.id).sort());
  for(const e of projected)assert.equal(state.events.filter(row=>row.id===e.id).length,1);
 }finally{await f.close();}
});
