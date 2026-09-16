import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { calendarRepeatSchema, localEventCommandSchema, type CalendarException, type LocalCalendarEvent, type LocalEventInput } from '../packages/domain/calendar.js';
import { expandLocalCalendar, localOccurrence, repeatProblem } from '../packages/domain/calendar-repeat.js';
import { localEventInterval } from '../packages/domain/calendar-time.js';
import { CalendarService } from '../apps/service/calendar.js';
import { Store } from '../apps/service/store.js';
const timezone = 'America/Los_Angeles';
const value: LocalEventInput = { title: 'Weekly studio', notes: '', location: '', timezone, allDay: false, start: { date: '2026-09-08', time: '09:00' }, end: { date: '2026-09-08', time: '10:00' }, state: 'confirmed', projectId: null, taskId: null, repeat: { cadence: 'weekly', interval: 1, weekdays: [2], count: 4 } };
const master = (v: LocalEventInput = value): LocalCalendarEvent => ({ id: randomUUID(), deviceId: 'fixture', revision: 1, updatedAt: '2026-09-08T12:00:00Z', value: v, isSeries: true, exceptionsRevision: 0 });
const range = { from: '2026-09-01', to: '2026-11-01', timezone };
const dates = (v: LocalEventInput, from: string, to: string) => expandLocalCalendar(master(v), [], { from, to, timezone }).occurrences.map(o => o.originalDate);

test('weekly interval, inclusive end and count retain a matching DTSTART and predictable dates', () => {
  assert.deepEqual(dates(value,range.from,range.to), ['2026-09-08','2026-09-15','2026-09-22','2026-09-29']);
  assert.deepEqual(dates({...value, repeat:{cadence:'weekly',interval:2,weekdays:[2,4],endsOn:'2026-09-24'}},range.from,range.to), ['2026-09-08','2026-09-10','2026-09-22','2026-09-24']);
  assert.ok(repeatProblem({...value,repeat:{...value.repeat!,weekdays:[3]}}));
  assert.equal(calendarRepeatSchema.safeParse({...value.repeat,endsOn:'2026-10-01'}).success,false);
});
test('monthly and yearly rules skip nonexistent dates and support explicit last-day and ordinal weekdays', () => {
  const jan={...value,start:{date:'2026-01-31',time:'09:00'},end:{date:'2026-01-31',time:'10:00'},repeat:{cadence:'monthly' as const,interval:1,weekdays:[],count:3}};
  assert.deepEqual(dates(jan,'2026-01-01','2026-07-01'),['2026-01-31','2026-03-31','2026-05-31']);
  assert.deepEqual(dates({...jan,repeat:{...jan.repeat,missingDay:'last-day'}},'2026-01-01','2026-04-01'),['2026-01-31','2026-02-28','2026-03-31']);
  const ordinal={...jan,start:{date:'2026-01-30',time:'09:00'},end:{date:'2026-01-30',time:'10:00'},repeat:{...jan.repeat,monthPattern:'weekday' as const,ordinal:-1 as const,weekday:5}};
  assert.deepEqual(dates(ordinal,'2026-01-01','2026-04-01'),['2026-01-30','2026-02-27','2026-03-27']);
  const leap={...jan,start:{date:'2024-02-29',time:'09:00'},end:{date:'2024-02-29',time:'10:00'},repeat:{cadence:'yearly' as const,interval:1,weekdays:[],count:3}};
  assert.deepEqual(dates(leap,'2024-01-01','2033-01-01'),['2024-02-29','2028-02-29','2032-02-29']);
});
test('nonexistent starts remain visible for review without consuming COUNT; timed DTEND preserves exact duration', () => {
  const daily={...value,start:{date:'2026-03-07',time:'02:30'},end:{date:'2026-03-07',time:'03:30'},repeat:{cadence:'daily' as const,interval:1,weekdays:[],count:3}};
  const result=expandLocalCalendar(master(daily),[],{from:'2026-03-07',to:'2026-03-12',timezone}).occurrences;
  assert.deepEqual(result.map(o=>o.originalDate),['2026-03-07','2026-03-08','2026-03-09','2026-03-10']);
  assert.equal(result[1].excluded,true);assert.match(result[1].problem!,/does not exist/);assert.equal(result.filter(o=>!o.excluded).length,3);
  const crossing={...daily,start:{date:'2026-03-07',time:'01:30'},end:{date:'2026-03-07',time:'03:30'}};
  const events=expandLocalCalendar(master(crossing),[],{from:'2026-03-07',to:'2026-03-10',timezone}).occurrences;
  assert.equal(events[1].value.end.time,'04:30');
  for(const event of events){const interval=localEventInterval(event.value).interval!;assert.equal(Date.parse(interval.end)-Date.parse(interval.start),2*3600000);}
});
test('repeated-hour review and explicit later policy remain distinct; all-day spans stay civil dates', () => {
  const v={...value,start:{date:'2026-10-31',time:'01:30'},end:{date:'2026-10-31',time:'02:30'},repeat:{cadence:'daily' as const,interval:1,weekdays:[],count:3}};
  const unresolved=expandLocalCalendar(master(v),[],{from:'2026-10-31',to:'2026-11-03',timezone}).occurrences;
  assert.match(unresolved[1].problem!,/occurs twice/);assert.equal(unresolved[1].excluded,undefined);
  const later=expandLocalCalendar(master({...v,start:{...v.start,overlap:'later'}}),[],{from:'2026-10-31',to:'2026-11-03',timezone}).occurrences;
  assert.equal(later[1].problem,undefined);assert.equal(localEventInterval(later[1].value).interval?.start,'2026-11-01T09:30:00.000Z');
  const all=expandLocalCalendar(master({...v,allDay:true,end:{date:'2026-11-02',time:'02:30'}}),[],{from:'2026-10-31',to:'2026-11-05',timezone:'Asia/Tokyo'}).occurrences;
  assert.equal(all[1].value.start.date,'2026-11-01');assert.equal(all[1].value.end.date,'2026-11-03');
});
test('moved exceptions retain original identity, appear outside their old window and survive changed recurrence rules', () => {
  const m=master(), override:CalendarException={id:m.id+':2026-09-15',eventId:m.id,originalDate:'2026-09-15',revision:1,deviceId:'fixture',updatedAt:m.updatedAt,retired:false,value:{...value,repeat:undefined,title:'Moved studio',start:{date:'2026-10-05',time:'14:00'},end:{date:'2026-10-05',time:'15:00'}}};
  const old=expandLocalCalendar(m,[override],{from:'2026-09-15',to:'2026-09-16',timezone});assert.equal(old.occurrences.length,0);
  const moved=expandLocalCalendar(m,[override],{from:'2026-10-05',to:'2026-10-06',timezone}).occurrences[0];assert.equal(moved.id,m.id+'@2026-09-15');assert.equal(moved.value.title,'Moved studio');
  const changed={...m,revision:2,value:{...value,repeat:{...value.repeat!,count:1}}};assert.equal(expandLocalCalendar(changed,[override],range).occurrences.length,2);
  assert.equal(localOccurrence(m,[{...override,retired:true,revision:2}],'2026-09-15')?.overrideRevision,2);
  const exact = expandLocalCalendar(changed, [override], range, 2); assert.equal(exact.occurrences.length, 2); assert.equal(exact.limited, false);
});
test('unending series previews stop at their visible bound and report omitted dates', () => {
  const result = expandLocalCalendar(master({ ...value, repeat: { cadence: 'daily', interval: 1, weekdays: [] } }), [], { from: '2026-09-08', to: '9999-12-28', timezone }, 4);
  assert.equal(result.occurrences.length, 4); assert.equal(result.limited, true); assert.equal(result.occurrences[3].originalDate, '2026-09-11');
});
function fixture(){const path=mkdtempSync(join(tmpdir(),'edition3-calendar-repeat-'));let store=new Store(path);const accounts={state:()=>({clients:[],accounts:[],attempts:[],probes:[]}),calendarSources:async()=>({items:[],limited:false}),calendarEvents:async()=>({events:[],coverage:'complete' as const,pages:1,skipped:0})};let calendar=new CalendarService(store,accounts);return{command:()=>({requestId:randomUUID(),epoch:store.epoch}),get store(){return store;},get calendar(){return calendar;},async restart(){await calendar.close();store.close();store=new Store(path);calendar=new CalendarService(store,accounts);},async close(){await calendar.close();store.close();rmSync(path,{recursive:true,force:true});}};}
test('occurrence edits reconcile once, fence series changes and require explicit exception policy for series saves',async()=>{
 const f=fixture();try{
  const created=f.calendar.saveLocal('a',{...f.command(),eventId:randomUUID(),expectedRevision:0,value,scope:'series'});
  assert.throws(()=>f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:1,value:{...value,repeat:undefined}}),/Choose this occurrence/);
  const occurrence= f.calendar.state('a',range).localEvents.find(e=>e.originalDate==='2026-09-15')!;
  const cmd=localEventCommandSchema.parse({...f.command(),eventId:created.id,expectedRevision:1,scope:'occurrence',originalDate:occurrence.originalDate,expectedOverrideRevision:0,value:{...occurrence.value,title:'Adjusted occurrence'}});
  const saved=f.calendar.saveLocal('a',cmd);assert.equal(saved.value.title,'Adjusted occurrence');assert.equal(f.calendar.readLocal(created.id).event.revision,1);assert.equal(f.calendar.readLocal(created.id).event.exceptionsRevision,1);
  assert.throws(()=>f.calendar.saveLocal('b',{...cmd,...f.command(),value:{...occurrence.value,title:'Racing occurrence'}}),(e:any)=>e.code==='calendar_occurrence_changed'&&e.current.overrideRevision===1);
  assert.throws(()=>f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:1,scope:'series',expectedExceptionsRevision:0,exceptions:'keep',value}),/adjusted occurrence changed/);
  const series=f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:1,scope:'series',expectedExceptionsRevision:1,exceptions:'keep',value:{...value,title:'Updated series'}});assert.equal(series.revision,2);
  assert.equal(f.calendar.state('a',range).localEvents.filter(e=>e.value.title==='Adjusted occurrence').length,1);
  await f.restart();assert.deepEqual(f.calendar.saveLocal('a',cmd),saved);
  assert.throws(()=>f.calendar.saveLocal('a',{...cmd,...f.command(),expectedOverrideRevision:1}),/series/);
  f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:2,scope:'series',expectedExceptionsRevision:1,exceptions:'reset',value:{...value,title:'Reset series'}});
  const reset=f.calendar.state('a',range).localEvents.find(e=>e.originalDate==='2026-09-15')!;assert.equal(reset.overrideRevision,2);assert.equal(reset.value.title,'Reset series');assert.ok(f.store.internalList('calendar:exception-history:').length);
  assert.equal(f.calendar.readLocal(created.id, '2026-09-15').occurrence?.overrideRevision, 2); assert.equal(f.calendar.readLocal(created.id).exceptionCount, 0);
  assert.throws(() => f.calendar.readLocal(created.id, '2026-02-31'));
  f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:3,scope:'occurrence',originalDate:'2026-09-15',expectedOverrideRevision:2,value:{...reset.value,title:'After reset'}});
 }finally{await f.close();}
});
test('cancel and restore the whole series preserve independently cancelled occurrences',async()=>{
 const f=fixture();try{
  const created=f.calendar.saveLocal('a',{...f.command(),eventId:randomUUID(),expectedRevision:0,value,scope:'series'}),occ=f.calendar.state('a',range).localEvents[1];
  f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:1,scope:'occurrence',originalDate:occ.originalDate,expectedOverrideRevision:0,value:{...occ.value,state:'cancelled'}});
  f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:1,scope:'series',expectedExceptionsRevision:1,exceptions:'keep',value:{...value,state:'cancelled'}});assert.equal(f.calendar.state('a',range).events.length,0);
  f.calendar.saveLocal('a',{...f.command(),eventId:created.id,expectedRevision:2,scope:'series',expectedExceptionsRevision:1,exceptions:'keep',value});assert.equal(f.calendar.state('a',range).events.length,3);assert.equal(f.calendar.state('a',range).localEvents.find(e=>e.originalDate===occ.originalDate)?.value.state,'cancelled');
 }finally{await f.close();}
});
