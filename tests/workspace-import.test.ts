import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planWorkspaceImport } from '../apps/service/workspace-import';
import { Store } from '../apps/service/store';
import { WorkspaceBackups } from '../apps/service/workspace-backups';
import type { ImportSource } from '../packages/domain/workspace-import';
const at='2026-09-14T20:00:00.000Z', storeId='1b189952-aa40-4901-814a-575495505e6b';
const task=(id:string,extra:Record<string,unknown>={})=>({id,title:'Keep this task',description:'Exact original notes',priority:'medium',status:'queue',createdAt:at,...extra});
function dc(tasks:unknown[]=[task('a')]):Extract<ImportSource,{format:'dream-claw-storage-1'}>{return {format:'dream-claw-storage-1',appVersion:'0.57.2',storeId,createdAt:at,timezone:'America/Los_Angeles',storage:{'dream-claw-workshop-tasks':JSON.stringify({version:3,state:{tasks,activity:[]}}),'dream-claw-mission-control-v1':JSON.stringify({version:0,state:{projects:[{id:'p',name:'Original Project',description:'Keep purpose',status:'active'}],people:[{id:'c',name:'QA Contact',role:'Writer',handle:'',timezone:'UTC',category:'external',notes:'Contact notes',tags:[]}],contentItems:[{id:'article',title:'Original article',platform:'Newsletter',stage:'scripting',script:'Exact article body',projectId:'p'}],documents:[]}}),'unrecognized-future-store':JSON.stringify({privateFuture:'Preserve this exact value'})}};}
function nova():ImportSource{return {format:'nova-dream-backup-15',storeId,timezone:'America/Los_Angeles',snapshot:{format:1,id:'backup:'+randomUUID(),schemaVersion:15,appVersion:'1.1.3',createdAt:at,kind:'manual',tables:{chat_projects:{columns:['id','encrypted_payload'],rows:[['p',{id:'p',name:'Legacy Project',description:'Project purpose',instructions:'Kept instructions',archived:false}]]},tasks:{columns:['id','encrypted_payload'],rows:[['t',{id:'t',title:'Legacy task',notes:'Earlier notes',status:'completed',priority:'urgent',createdAt:at,updatedAt:at,revision:4,dueAt:null,projectId:'p',recurrence:{cadence:'none',rule:null,everyday:false},waiting:null,unsupportedField:{must:'stay'}}]]},xp_events:{columns:['id','encrypted_payload'],rows:[['earned',{id:'earned',amount:75,sourceId:'t'}]]}}}};}

test('stable source-qualified mapping preserves linked work, all originals, and separates matching titles',()=>{
 const source=dc([task('a'),task('b',{blockedByIds:['a'],checklist:[{id:'old-check',text:'Keep subtask',done:true}]})]);
 const a=planWorkspaceImport(source,'0.64.0'),b=planWorkspaceImport(structuredClone(source),'0.64.0');
 assert.deepEqual(a,b);assert.equal(a.review.duplicates.length,1);assert.equal(a.review.counts.editable,5);
 const one=a.review.items.find(i=>i.source==='tasks'&&i.sourceId==='a')!,two=a.review.items.find(i=>i.source==='tasks'&&i.sourceId==='b')!;
 assert.notEqual(one.targetId,two.targetId);assert(one.targetId!.includes(storeId));
 assert.deepEqual((a.snapshot.entities.find(e=>e.id===two.targetId)!.value as any).dependencies,[one.targetId]);
 const article=a.snapshot.entities.find(e=>e.kind==='content')!.value as any;assert.equal(article.body,'Exact article body');assert.equal(article.projectId,a.review.items.find(i=>i.source==='projects')!.targetId);
 assert.deepEqual(a.snapshot.services.find(s=>s.id.startsWith('migration:source:'))!.value,source);
 const newer=structuredClone(source);newer.createdAt='2026-09-15T20:00:00.000Z';assert.equal(planWorkspaceImport(newer,'0.64.0').review.items[0].targetId,one.targetId);
});
test('missing or invalid linked records preserve the dependency chain instead of severing it',()=>{
 const result=planWorkspaceImport(dc([task('a',{blockedByIds:['absent']}),task('b',{blockedByIds:['a']}),task('good')]),'0.64.0');
 assert.equal(result.review.items.find(i=>i.sourceId==='a')?.outcome,'preserved');assert.equal(result.review.items.find(i=>i.sourceId==='b')?.outcome,'preserved');assert.equal(result.review.items.find(i=>i.sourceId==='good')?.outcome,'editable');
 assert(result.review.items.find(i=>i.sourceId==='b')?.notes.some(n=>n.includes('dependency')));
});
test('future source versions, duplicate identities and inconsistent table structures are rejected',()=>{
 assert.throws(()=>planWorkspaceImport({...dc(),appVersion:'2.0.0'},'0.64.0'));
 assert.throws(()=>planWorkspaceImport(dc([task('same'),task('same')]),'0.64.0'),/duplicate/);
 const bad=nova();if(bad.format==='nova-dream-backup-15')bad.snapshot.tables.tasks.columns.push('extra');assert.throws(()=>planWorkspaceImport(bad,'0.64.0'),/inconsistent/);
});
test('Nova schema 15 maps local task/Project fields without fabricating XP or adopting execution',()=>{
 const source=nova(), result=planWorkspaceImport(source,'0.64.0');
 const t=result.snapshot.entities.find(e=>e.kind==='task')!.value as any;assert.equal(t.status,'done');assert.equal(t.priority,'high');assert(t.projectId);
 assert.equal(result.review.items.find(i=>i.source==='xp_events')?.outcome,'preserved');
 assert.deepEqual(result.snapshot.services.filter(s=>!s.id.startsWith('migration:')&&!s.id.startsWith('tasks:legacy-completion:')),[]);assert.deepEqual(result.snapshot.receipts,[]);
 assert.deepEqual(result.snapshot.services.find(s=>s.id.startsWith('migration:source:'))?.value,source);
});
test('reviewed import reopens with a new epoch, survives restart, reconciles retries and retains the encrypted source',async t=>{
 const root=mkdtempSync(join(tmpdir(),'e3-import-')),store=new Store(join(root,'original'));let backups=new WorkspaceBackups(store,'0.64.0');
 t.after(async()=>{await backups.close();store.close();rmSync(root,{recursive:true,force:true});});
 const source=dc(),command={requestId:randomUUID(),epoch:store.epoch,source};
 const before=store.snapshot('owner');const review=backups.reviewImport('owner',command);
 assert.deepEqual(backups.reviewImport('owner',command),review);assert.deepEqual(backups.imports('other'),[]);assert.throws(()=>backups.importSource('other',review.id));
 assert.deepEqual(store.snapshot('owner'),before);
 const restore={requestId:randomUUID(),epoch:store.epoch,reviewId:review.id,sourceHash:review.sourceHash,targetHash:review.targetHash};
 assert.throws(()=>backups.restoreImport('owner',{...restore,targetHash:'0'.repeat(64)}),/changed/);
 backups.restoreImport('owner',restore);await backups.close();backups=new WorkspaceBackups(store,'0.64.0');
 const job=backups.restoreImport('owner',restore);assert.equal(job.state,'ready',job.message);
 assert.throws(()=>backups.restoreImport('owner',{...restore,requestId:randomUUID()}),/already/);
 assert.deepEqual(store.snapshot('owner'),before);
 const directory=backups.recoveredDirectory('owner',job.id);let recovered=new Store(directory);
 try {
  assert.notEqual(recovered.epoch,store.epoch);assert(recovered.recoveryHeld);assert.equal(recovered.profileProgress().earnedXp,0);
  const imported=planWorkspaceImport(source,'0.64.0');assert.deepEqual(recovered.internalRead('migration:source:'+imported.review.id),source);
  assert(!readFileSync(join(directory,'workspace.sqlite')).includes(Buffer.from('Exact original notes')));
  recovered.activateRecoveredLocal();assert(recovered.recoveryEffectsPaused);assert.equal(recovered.snapshot('reviewer').tasks.length,1);
  const task=recovered.snapshot('reviewer').tasks[0];const edited=recovered.mutate('reviewer',{requestId:randomUUID(),epoch:recovered.epoch,kind:'task',entityId:task.id,expectedRevision:task.revision,payload:{...task.value,notes:'Edited after import'}});assert.equal((edited.value as any).notes,'Edited after import');
  recovered.close();recovered=new Store(directory);assert.equal(recovered.snapshot('reviewer').records!.contact.length,1);
  const manager=new WorkspaceBackups(recovered,'0.64.0');assert.equal(manager.imports('reviewer')[0].savedInWorkspace,true);assert.deepEqual(manager.importSource('reviewer',imported.review.id),source);await manager.close();
 }finally{recovered.close();}
});

test('cycles are preserved, while a deadline retains its date and clock in the selected timezone',()=>{
 const result=planWorkspaceImport(dc([task('cycle-a',{blockedByIds:['cycle-b']}),task('cycle-b',{blockedByIds:['cycle-a']}),task('dependent',{blockedByIds:['cycle-a']}),task('deadline',{dueAt:'2026-09-15T01:30:00.000Z'})]),'0.64.0');
 for(const id of ['cycle-a','cycle-b','dependent'])assert.equal(result.review.items.find(i=>i.sourceId===id)?.outcome,'preserved');
 const value=result.snapshot.entities.find(e=>e.id===result.review.items.find(i=>i.sourceId==='deadline')?.targetId)!.value as any;
 assert.equal(value.due,'2026-09-14');assert.equal(value.dueTime,'18:30');
});
test('repeated historical task identities stay as distinct preserved revisions and mismatched live identities fail',()=>{
 const source=nova();if(source.format!=='nova-dream-backup-15')throw new Error('fixture');
 source.snapshot.tables.task_revisions={columns:['task_id','revision','encrypted_payload'],rows:[['t',1,{id:'t',revision:1,title:'Earlier title'}],['t',2,{id:'t',revision:2,title:'Later title'}]]};
 const result=planWorkspaceImport(source,'0.64.0');assert.equal(result.review.items.filter(i=>i.source==='task_revisions').length,2);
 (source.snapshot.tables.tasks.rows[0][1] as any).id='wrong';assert.throws(()=>planWorkspaceImport(source,'0.64.0'),/identities disagree/);
});

test('HTTP import review and preserved-source download stay authenticated and bound to the reviewing browser',async t=>{
 const {startServer}=await import('../apps/service/http');const root=mkdtempSync(join(tmpdir(),'e3-import-http-')),server=await startServer({directory:root,port:0});
 t.after(async()=>{await server.close();rmSync(root,{recursive:true,force:true});});
 const open=async()=>{const r=await fetch(server.origin+'/api/session',{method:'POST',headers:{'X-Edition3-Client':'1'}});return r.headers.get('set-cookie')!.split(';')[0];};
 const cookie=await open(),other=await open();const command={requestId:randomUUID(),epoch:server.store.epoch,source:dc()};
 const post=(cookie:string,value:unknown)=>fetch(server.origin+'/api/storage/imports/review',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Edition3-Client':'1'},body:JSON.stringify(value)});
 assert.equal((await post('',command)).status,401);
 const response=await post(cookie,command);assert.equal(response.status,200);const review=await response.json();
 assert.equal((await fetch(server.origin+`/api/storage/imports/${review.id}/source`,{headers:{Cookie:other}})).status,404);
 const download=await fetch(server.origin+`/api/storage/imports/${review.id}/source`,{headers:{Cookie:cookie}});assert.equal(download.headers.get('cache-control'),'no-store');assert.deepEqual(await download.json(),command.source);
 assert.equal((await post(cookie,{...command,epoch:randomUUID()})).status,409);
 assert.equal((await fetch(server.origin+'/api/storage/imports/review',{method:'POST',headers:{Cookie:cookie,Origin:'https://unrelated.invalid','Content-Type':'application/json','X-Edition3-Client':'1'},body:JSON.stringify(command)})).status,403);
});


test('child tasks keep their original parent link and earlier progress is reported separately',()=>{
 const source=nova();if(source.format!=='nova-dream-backup-15')throw Error('fixture');
 const original=source.snapshot.tables.tasks.rows[0][1] as any;original.parentTaskId='earlier-parent';
 source.snapshot.tables.profiles={columns:['encrypted_payload'],rows:[[{id:'owner',kind:'human',displayName:'Earlier owner',xp:120}]]};
 source.snapshot.tables.xp_events={columns:['encrypted_payload'],rows:[[{id:'earned',profileId:'owner',amount:100}]]};
 const plan=planWorkspaceImport(source,'0.64.0');
 assert.equal(plan.review.items.find(i=>i.source==='tasks')?.outcome,'preserved');
 assert(plan.review.items.find(i=>i.source==='tasks')?.notes.some(n=>n.includes('parent relationship')));
 assert.deepEqual(plan.review.priorProgress,{name:'Earlier owner',xp:120,ledgerEvents:1,ledgerTotal:100});
 assert(!plan.snapshot.services.some(s=>s.id.startsWith('profile:')));
 assert.equal(plan.review.items.find(i=>i.source==='profiles')?.title,'Earlier owner');
});


test('separate child-task imports retain stable parent identities, fields and editable descendants',()=>{
 const source=dc([task('parent',{status:'done'}),task('child',{parentTaskId:'parent',description:'Child details',plannedDate:'2026-10-04'}),task('leaf',{parentTaskId:'child',blockedByIds:['parent']})]);
 const result=planWorkspaceImport(source,'0.70.0');
 const mapped=(id:string)=>result.snapshot.entities.find(e=>e.id===result.review.items.find(i=>i.source==='tasks'&&i.sourceId===id)!.targetId)!;
 const parent=mapped('parent'),child=mapped('child'),leaf=mapped('leaf');
 assert.equal((child.value as any).parentTaskId,parent.id);assert.equal((child.value as any).planned,'2026-10-04');assert.equal((child.value as any).notes,'Child details');assert.equal((child.value as any).status,'open');
 assert.equal((leaf.value as any).parentTaskId,child.id);assert.deepEqual((leaf.value as any).dependencies,[parent.id]);
 assert.deepEqual(planWorkspaceImport(structuredClone(source),'0.70.0').snapshot.entities,result.snapshot.entities);
 const root=mkdtempSync(join(tmpdir(),'e3-import-family-'));let store=Store.restoreBackup(join(root,'recovered'),result.snapshot);
 try{store.activateRecoveredLocal();assert.equal(store.readEntity('task',leaf.id)!.value.parentTaskId,child.id);let p=store.readEntity('task',parent.id)!;for(const status of ['open','done'] as const)p=store.mutate('owner',{requestId:randomUUID(),epoch:store.epoch,kind:'task',entityId:p.id,expectedRevision:p.revision,payload:{...p.value,status}}) as typeof p;assert.equal(store.profileProgress().earnedXp,0);store.close();store=new Store(join(root,'recovered'));assert.equal(store.readEntity('task',child.id)!.value.parentTaskId,parent.id);assert.deepEqual(store.internalRead('migration:source:'+result.review.id),source);}finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('missing and cyclic task parents preserve descendants and their dependents without severing links',()=>{
 const result=planWorkspaceImport(dc([task('a',{parentTaskId:'b'}),task('b',{parentTaskId:'a'}),task('child',{parentTaskId:'a'}),task('orphan',{parentTaskId:'missing'}),task('dependent',{blockedByIds:['orphan']}),task('good')]),'0.70.0');
 for(const id of ['a','b','child','orphan','dependent'])assert.equal(result.review.items.find(i=>i.sourceId===id)?.outcome,'preserved');
 assert.equal(result.review.items.find(i=>i.sourceId==='good')?.outcome,'editable');
});
test('Nova one-off children remain separate tasks, while children of recurring templates stay preserved',()=>{
 const source=nova();if(source.format!=='nova-dream-backup-15')throw Error('fixture');
 const parent=source.snapshot.tables.tasks.rows[0][1] as any;
 source.snapshot.tables.tasks.rows.push(['child',{...parent,id:'child',title:'Child work',parentTaskId:parent.id,status:'todo',notes:'Keep child notes'}]);
 const first=planWorkspaceImport(source,'0.70.0');const child=first.snapshot.entities.find(e=>(e.value as any).title==='Child work')!;
 assert.equal((child.value as any).parentTaskId,first.review.items.find(i=>i.source==='tasks'&&i.sourceId===parent.id)!.targetId);
 parent.recurrence={cadence:'daily',rule:null,everyday:true};
 const repeated=planWorkspaceImport(source,'0.70.0');assert(repeated.snapshot.entities.some(e=>e.kind==='routine'));assert.equal(repeated.review.items.find(i=>i.sourceId==='child')?.outcome,'preserved');
});
