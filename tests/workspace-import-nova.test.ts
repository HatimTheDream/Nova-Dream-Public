import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planWorkspaceImport } from '../apps/service/workspace-import';
import { Store } from '../apps/service/store';
import { scheduled } from '../packages/domain/tasks';
import type { ImportSource } from '../packages/domain/workspace-import';
const at='2026-09-14T20:00:00.000Z', hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const task=(id='t')=>({id,title:'Recurring work',notes:'Keep the original notes',status:'todo',priority:'normal',createdAt:at,updatedAt:at,revision:2,dueAt:at,projectId:'p',parentTaskId:null,recurrence:{cadence:'weekly',rule:null,everyday:false},waiting:null});
function source(){
 const t=task(), schedule={id:'s',taskId:t.id,revision:2,taskRevision:2,taskSnapshot:t,anchorAt:'2026-09-07T16:00:00.000Z',timezone:'America/Los_Angeles',activeFrom:'2026-09-07',rule:{version:1,unit:'week',interval:2,weekdays:[1,3],monthDays:[]},cursor:'2026-09-22',enabled:true,createdAt:at,updatedAt:at};
 t.recurrence={cadence:'custom',rule:JSON.stringify(schedule.rule) as any,everyday:false};
 const o={id:'o',taskId:t.id,scheduleId:'s',scheduleRevision:1,taskSnapshot:t,timezone:schedule.timezone,localDate:'2026-09-07',originalScheduledAt:schedule.anchorAt,plannedAt:'2026-09-09T17:30:00.000Z',status:'completed',state:'active',completedAt:at,revision:3,updatedAt:at};
 const tables:any={tasks:{columns:['id','encrypted_payload'],rows:[['t',t]]},chat_projects:{columns:['id','encrypted_payload'],rows:[['p',{id:'p',name:'Source Project',description:'Retain files',instructions:'Use saved sources',archived:false}]]},task_schedules:{columns:['id','task_id','revision','encrypted_payload'],rows:[['s','t',2,schedule]]},ordinary_task_occurrences:{columns:['id','task_id','local_date','revision','encrypted_payload'],rows:[['o','t',o.localDate,3,o]]}};
 return {format:'nova-dream-backup-15',storeId:'1b189952-aa40-4901-814a-575495505e6b',timezone:schedule.timezone,snapshot:{format:1,id:'backup:'+randomUUID(),schemaVersion:15,appVersion:'1.1.3',createdAt:at,kind:'manual',tables}} as Extract<ImportSource,{format:'nova-dream-backup-15'}>;
}
function withFile(s=source()){
 const bytes=Buffer.from('Exact saved source.\n'), f={sourceId:'fb09b01b-5f70-4eff-9d84-f0b6e0860599',sourceRevision:1,fileName:'saved-source.txt',mimeType:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}, value={...f,content:bytes.toString('base64'),version:1,ownerId:'profile:user',projectId:'p'}, library={version:1,ownerId:'profile:user',projectId:'p',revision:3};
 const lk=hash([value.ownerId,value.projectId]), owner=hash(value.ownerId), sk=hash(value.sourceId);
 Object.assign(s.snapshot.tables,{project_source_libraries:{columns:['library_key','owner_scope','revision','encrypted_payload'],rows:[[lk,owner,3,library]]},project_source_identities:{columns:['source_key','library_key','owner_scope','content_hash','tombstoned'],rows:[[sk,lk,owner,hash(f),0]]},project_sources:{columns:['source_key','library_key','owner_scope','size_bytes','payload_bytes','encrypted_payload'],rows:[[sk,lk,owner,value.size,Buffer.byteLength(JSON.stringify(value)),value]]}});return s;
}
const plan=(s:ImportSource)=>planWorkspaceImport(s,'0.65.0');

test('Nova saved sources, recurrence and rescheduled occurrence restore with stable joined identities',()=>{
 const s=withFile(), a=plan(s), b=plan(structuredClone(s));assert.deepEqual(a,b);
 assert.equal(a.review.counts.editable,3);assert.equal(a.review.counts.linked,2);assert.equal(a.snapshot.files.length,1);
 const p=a.snapshot.entities.find(e=>e.kind==='project')!, r=a.snapshot.entities.find(e=>e.kind==='routine')!, t=a.snapshot.entities.find(e=>e.kind==='task')!;
 assert.match(r.id,/^routine:[a-f0-9-]{36}$/);assert.equal((r.value as any).state,'paused');assert.equal((r.value as any).projectId,p.id);assert.equal((r.value as any).interval,2);
 assert.equal(scheduled(r.value as any,'2026-09-09'),true);assert.equal(scheduled(r.value as any,'2026-09-14'),false);assert.equal(scheduled(r.value as any,'2026-09-21'),true);
 assert.equal((t.value as any).planned,'2026-09-09');assert.equal((t.value as any).plannedTime,'10:30');assert.equal((t.value as any).status,'done');
 const o=a.snapshot.services.find(e=>e.id==='tasks:occurrence:'+t.id)!.value as any;assert.equal(o.date,'2026-09-07');assert.equal(o.routineId,r.id);assert.equal(t.id,`task:occ:${r.id.slice(8)}:${o.date}`);
 assert.deepEqual(a.snapshot.references,[{entityId:p.id,fileId:a.snapshot.files[0].id}]);assert.equal((p.value as any).attachments[0].sha256,a.snapshot.files[0].sha256);
 assert.deepEqual(a.snapshot.services.find(e=>e.id.startsWith('migration:source:'))!.value,s);assert(!a.snapshot.services.some(e=>e.id.startsWith('reminders:')));
});

test('removed, corrupt, orphaned and ambiguous source memberships never restore file bytes',()=>{
 for(const corrupt of [
  (s:any)=>s.snapshot.tables.project_source_identities.rows[0][4]=1,
  (s:any)=>s.snapshot.tables.project_sources.rows[0][5].content='Zm9v',
  (s:any)=>s.snapshot.tables.project_sources.rows[0][2]='0'.repeat(64),
  (s:any)=>s.snapshot.tables.project_source_identities.rows.push([...s.snapshot.tables.project_source_identities.rows[0]]),
  (s:any)=>s.snapshot.tables.chat_projects.rows[0][1].archived=true,
  (s:any)=>s.snapshot.tables.project_sources.rows[0][5].fileName='../escape.txt',
 ]){const s=withFile();corrupt(s);const a=plan(s);assert.equal(a.snapshot.files.length,0);assert.equal(a.snapshot.references.length,0);assert.equal(a.review.items.find(i=>i.source==='project_sources')!.outcome,'preserved');}
});

test('unsupported or inconsistent series remain archived without unrelated one-off templates',()=>{
 for(const change of [
  (s:any)=>s.snapshot.tables.task_schedules.rows[0][3].rule.interval=101,
  (s:any)=>s.snapshot.tables.task_schedules.rows[0][3].rule={version:1,unit:'month',interval:1,weekdays:[],monthDays:[1,15]},
  (s:any)=>s.snapshot.tables.task_schedules.rows[0][3].taskRevision=99,
  (s:any)=>s.snapshot.tables.ordinary_task_occurrences.rows[0][4].scheduleId='wrong',
  (s:any)=>s.snapshot.tables.ordinary_task_occurrences.rows[0][4].timezone='UTC',
  (s:any)=>s.snapshot.tables.ordinary_task_occurrences.rows.push([...s.snapshot.tables.ordinary_task_occurrences.rows[0]]),
 ]){const s=source();change(s);const a=plan(s);assert.equal(a.snapshot.entities.filter(e=>e.kind==='routine'||e.kind==='task').length,0);assert.equal(a.review.items.find(i=>i.source==='tasks')!.outcome,'preserved');assert.equal(a.snapshot.services.filter(e=>e.id.startsWith('tasks:')).length,0);}
});

test('daily habit outcomes map to one paused series and last-day monthly rules retain calendar meaning',()=>{
 const s=source();const t=s.snapshot.tables.tasks.rows[0][1] as any;t.recurrence={cadence:'daily',rule:null,everyday:true};
 delete s.snapshot.tables.task_schedules;delete s.snapshot.tables.ordinary_task_occurrences;
 s.snapshot.tables.task_occurrences={columns:['id','task_id','local_date','revision','encrypted_payload'],rows:[['h','t','2026-09-14',1,{id:'h',taskId:'t',localDate:'2026-09-14',revision:1,updatedAt:at,status:'completed',completedAt:at,timezone:s.timezone,taskSnapshot:t}]]};
 const a=plan(s), r=a.snapshot.entities.find(e=>e.kind==='routine')!;assert.equal((r.value as any).kind,'habit');assert.equal(a.snapshot.entities.filter(e=>e.kind==='task').length,1);
 const monthly=source(), schedule=monthly.snapshot.tables.task_schedules.rows[0][3] as any;schedule.rule={version:1,unit:'month',interval:1,weekdays:[],monthDays:[-1]};schedule.taskSnapshot.recurrence.rule=JSON.stringify(schedule.rule);const value=plan(monthly).snapshot.entities.find(e=>e.kind==='routine')!.value as any;
 assert(scheduled(value,'2027-02-28'));assert(scheduled(value,'2028-02-29'));assert(!scheduled(value,'2028-02-28'));
});

test('restored source downloads, outcome edits and paused series survive restart without replay or repeated XP',t=>{
 const root=mkdtempSync(join(tmpdir(),'e3-nova-import-')), directory=join(root,'recovered'), a=plan(withFile());let store=Store.restoreBackup(directory,a.snapshot);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 assert(store.recoveryHeld);store.activateRecoveredLocal();assert(store.recoveryEffectsPaused);
 const initial=store.snapshot('owner'), task=initial.tasks[0], routine=initial.routines![0];assert.equal(initial.tasks.length,1);assert.equal(initial.routines!.length,1);assert.equal(store.profileProgress().earnedXp,0);
 assert.equal(store.download(a.snapshot.files[0].id).bytes.toString(),'Exact saved source.\n');assert(!readFileSync(join(directory,'blobs',a.snapshot.files[0].id)).includes(Buffer.from('Exact saved source.')));
 let entity=task;for(const status of ['open','done','open','done'] as const)entity=store.mutate('owner',{requestId:randomUUID(),epoch:store.epoch,kind:'task',entityId:task.id,expectedRevision:entity.revision,payload:{...entity.value,status}}) as typeof task;
 assert.equal(store.profileProgress().earnedXp,0);assert.equal(store.snapshot('owner').taskState!.events.every(e=>e.xpDelta===0),true);
 store.mutate('owner',{requestId:randomUUID(),epoch:store.epoch,kind:'routine',entityId:routine.id,expectedRevision:routine.revision,payload:{...routine.value,notes:'Reviewed series; keep paused'}});
 store.close();store=new Store(directory);const after=store.snapshot('owner');assert.equal(after.tasks.length,1);assert.equal(after.tasks[0].value.status,'done');assert.equal(after.routines![0].value.notes,'Reviewed series; keep paused');assert(store.recoveryEffectsPaused);assert.equal(store.profileProgress().earnedXp,0);
 assert.equal(store.download(a.snapshot.files[0].id).bytes.toString(),'Exact saved source.\n');
});

test('multi-date monthly imports retain one paused series, exact archive, month-end rules and prior XP through restore', t=>{
 const original=withFile(), schedule=original.snapshot.tables.task_schedules.rows[0][3] as any;
 schedule.rule={version:1,unit:'month',interval:2,weekdays:[],monthDays:[1,15,31,-1]};schedule.taskSnapshot.recurrence.rule=JSON.stringify(schedule.rule);
 const a=plan(original),r=a.snapshot.entities.find(e=>e.kind==='routine')!;
 assert(r);assert.deepEqual((r.value as any).monthDays,[-1,1,15,31]);assert.equal((r.value as any).state,'paused');
 assert(scheduled(r.value as any,'2026-09-15'));assert(scheduled(r.value as any,'2026-09-30'));assert(!scheduled(r.value as any,'2026-10-15'));assert(scheduled(r.value as any,'2026-11-30'));
 assert.deepEqual(a.snapshot.services.find(e=>e.id.startsWith('migration:source:'))!.value,original);
 const root=mkdtempSync(join(tmpdir(),'e3-monthly-import-')),directory=join(root,'recovered');let store=Store.restoreBackup(directory,a.snapshot);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 store.activateRecoveredLocal();const before=store.snapshot('owner');assert.equal(before.routines!.length,1);assert.equal(before.tasks.length,1);assert.equal(before.tasks[0].value.status,'done');assert.equal(store.profileProgress().earnedXp,0);
 store.close();store=new Store(directory);const after=store.snapshot('owner');assert.deepEqual(after.routines,before.routines);assert.deepEqual(after.tasks,before.tasks);assert.equal(store.profileProgress().earnedXp,0);assert(store.recoveryEffectsPaused);
});
