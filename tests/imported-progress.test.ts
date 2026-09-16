import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planWorkspaceImport } from '../apps/service/workspace-import';
import { verifiedImportedProgress } from '../apps/service/workspace-import-progress';
import { Store } from '../apps/service/store';
import type { ImportSource } from '../packages/domain/workspace-import';

const at='2026-09-14T20:00:00.000Z';
function source(): Extract<ImportSource,{format:'nova-dream-backup-15'}> {
 const task={id:'old-task',title:'Completed before import',notes:'Keep this history',status:'completed',priority:'normal',createdAt:at,updatedAt:at,revision:1,dueAt:null,projectId:null,parentTaskId:null,recurrence:{cadence:'none',rule:null,everyday:false}};
 const profiles=[{id:'owner',kind:'human',displayName:'Earlier owner',xp:120},{id:'agent',kind:'agent',displayName:'Earlier agent',xp:40}];
 const events=[{id:'first',profileId:'owner',sourceType:'task',sourceId:task.id,amount:100,reason:'Earlier task',createdAt:at},{id:'second',profileId:'owner',sourceType:'achievement',sourceId:'milestone',amount:20,reason:'Earlier milestone',createdAt:at},{id:'agent-event',profileId:'agent',sourceType:'task',sourceId:'agent-work',amount:40,reason:'Earlier agent work',createdAt:at}];
 return {format:'nova-dream-backup-15',storeId:'a605a2a2-7739-49b9-bdb4-eef8f4a8a095',timezone:'America/Los_Angeles',snapshot:{format:1,id:'backup:'+randomUUID(),schemaVersion:15,appVersion:'1.1.3',createdAt:at,kind:'manual',tables:{tasks:{columns:['id','encrypted_payload'],rows:[[task.id,task]]},profiles:{columns:['id','encrypted_payload'],rows:profiles.map(p=>[p.id,p])},xp_events:{columns:['id','encrypted_payload'],rows:events.map(e=>[e.id,e])}}}};
}

test('only the reconciled human ledger carries forward; agent credit remains separate and source is exact',()=>{
 const s=source(),balance=verifiedImportedProgress(s)!;assert(balance);assert.equal(balance.xp,120);assert.equal(balance.events.length,2);assert.equal(balance.profileId,'owner');
 const plan=planWorkspaceImport(s,'0.68.0');assert.equal(plan.review.priorProgress!.carried,true);assert.equal(plan.review.priorProgress!.ledgerTotal,120);assert.equal((plan.snapshot.entities.find(e=>e.id==='profile:owner')!.value as any).name,'Earlier owner');
 assert.deepEqual(plan.snapshot.services.find(r=>r.id==='profile:imported-progress')!.value,balance);assert.deepEqual(plan.snapshot.services.find(r=>r.id.startsWith('migration:source:'))!.value,s);
 assert.equal(plan.snapshot.services.filter(r=>r.id.startsWith('tasks:event:')).length,0);
});

test('ambiguous profiles, mismatched totals and malformed or duplicate ledger identities stay archived',()=>{
 const corruptions=[
  (s:any)=>s.snapshot.tables.profiles.rows[0][1].xp=121,
  (s:any)=>s.snapshot.tables.profiles.rows.push(['other',{...s.snapshot.tables.profiles.rows[0][1],id:'other'}]),
  (s:any)=>s.snapshot.tables.profiles.rows[0][0]='wrong',
  (s:any)=>delete s.snapshot.tables.xp_events,
  (s:any)=>s.snapshot.tables.xp_events.rows.push([...s.snapshot.tables.xp_events.rows[0]]),
  (s:any)=>s.snapshot.tables.xp_events.rows[0][1].amount=1.5,
  (s:any)=>s.snapshot.tables.xp_events.rows[0][1].profileId='missing',
  (s:any)=>s.snapshot.tables.xp_events.rows[0][0]='wrong',
  (s:any)=>s.snapshot.tables.xp_events.rows[0][1].createdAt='2026-09-15T20:00:00.000Z',
  (s:any)=>delete s.snapshot.tables.xp_events.rows[0][1].reason,
 ];
 for(const corrupt of corruptions){const s=source();corrupt(s);assert.equal(verifiedImportedProgress(s),undefined);const plan=planWorkspaceImport(s,'0.68.0');assert(!plan.snapshot.services.some(r=>r.id==='profile:imported-progress'));assert.deepEqual(plan.snapshot.services.find(r=>r.id.startsWith('migration:source:'))!.value,s);}
});

test('restore rejects a carried balance whose exact preserved source or ledger changed',()=>{
 const original=planWorkspaceImport(source(),'0.68.0').snapshot;
 for(const change of [
  (s:any)=>s.services.find((r:any)=>r.id==='profile:imported-progress').value.xp=121,
  (s:any)=>s.services=s.services.filter((r:any)=>!r.id.startsWith('migration:source:')),
  (s:any)=>s.services.find((r:any)=>r.id==='profile:imported-progress').value.events[0].reason='invented',
  (s:any)=>s.services.find((r:any)=>r.id.startsWith('migration:source:')).value.snapshot.tables.profiles.rows[0][1].displayName='Different owner',
  (s:any)=>s.services.push({...s.services.find((r:any)=>r.id.startsWith('migration:source:')),id:'migration:source:duplicate'}),
  (s:any)=>s.services.push({...s.services.find((r:any)=>r.id==='profile:imported-progress'),id:'profile:imported-progress:second'}),
 ]){const copy=structuredClone(original);change(copy);assert.throws(()=>Store.verifyBackup(copy),/earlier XP balance/);}
});

test('prior XP survives restored edits, new awards, correction, restart and another backup without double credit or daily quests',t=>{
 const root=mkdtempSync(join(tmpdir(),'e3-carried-progress-')),directory=join(root,'first'),plan=planWorkspaceImport(source(),'0.68.0');let store=Store.restoreBackup(directory,plan.snapshot);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});store.activateRecoveredLocal();
 const command=(kind:'task',id:string,payload:unknown,revision:number)=>({kind,entityId:id,payload,expectedRevision:revision,epoch:store.epoch,requestId:randomUUID()});
 let progress=store.profileProgress();assert.equal(progress.earnedXp,120);assert.equal(progress.completedTasks,0);assert(progress.quests.every(q=>q.progress===0));assert.equal(progress.imported!.eventCount,2);assert(!('events' in progress.imported!));
 let old=store.snapshot('owner').tasks[0];for(const status of ['open','done','open','done'] as const)old=store.mutate('owner',command('task',old.id,{...old.value,status},old.revision)) as typeof old;
 assert.equal(store.profileProgress().earnedXp,120);assert.equal(store.profileProgress().history.total,0);
 const id='task:'+randomUUID();let fresh=store.mutate('owner',command('task',id,{title:'New task',notes:'',status:'open',planned:'',due:''},0)) as typeof old;
 const done=command('task',id,{...fresh.value,status:'done'},fresh.revision);fresh=store.mutate('owner',done) as typeof old;assert.deepEqual(store.mutate('owner',done),fresh);assert.equal(store.profileProgress().earnedXp,130);
 store.mutate('owner',command('task',id,{...fresh.value,status:'open'},fresh.revision));assert.equal(store.profileProgress().earnedXp,120);
 store.close();store=new Store(directory);assert.equal(store.profileProgress().earnedXp,120);assert.equal(store.profileProgress().imported!.eventCount,2);
 const backup=store.captureBackup('0.68.0',{status:'not-configured',notes:[]});const restored=Store.restoreBackup(join(root,'second'),backup);try{assert.equal(restored.profileProgress().earnedXp,120);assert.equal(restored.profileProgress().completedTasks,0);assert(restored.profileProgress().quests.every(q=>q.progress===0));}finally{restored.close();}
});


test('a reopened source task with carried credit cannot earn the same work again',t=>{
 const s=source();(s.snapshot.tables.tasks.rows[0][1] as any).status='todo';
 const plan=planWorkspaceImport(s,'0.68.0'),root=mkdtempSync(join(tmpdir(),'e3-prior-open-'));let store=Store.restoreBackup(join(root,'copy'),plan.snapshot);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});store.activateRecoveredLocal();
 const task=store.snapshot('owner').tasks[0];assert.equal(task.value.status,'open');store.mutate('owner',{requestId:randomUUID(),epoch:store.epoch,kind:'task',entityId:task.id,expectedRevision:task.revision,payload:{...task.value,status:'done'}});
 assert.equal(store.profileProgress().earnedXp,120);assert.equal(store.profileProgress().completedTasks,0);assert.equal(store.profileProgress().history.total,0);
});
