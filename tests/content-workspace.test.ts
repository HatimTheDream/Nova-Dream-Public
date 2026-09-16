import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Store} from '../apps/service/store';
import {AssignmentService} from '../apps/service/assignments';
import {ContentWorkspace} from '../apps/service/content-workspace';
import {exportContentPackage,crc32} from '../apps/service/content-package';
import {WorkerTransport} from './fixtures/assignment-worker';
import {blankRecord,type Content} from '../packages/domain/workspace-records';
import type {ContentJob,ContentReview} from '../packages/domain/content-workspace';
import type {Entity} from '../packages/domain/contracts';
import {startServer} from '../apps/service/http';
const pause=()=>new Promise(r=>setTimeout(r,30));
function setup(){const dir=mkdtempSync(join(tmpdir(),'e3-content-complete-')),store=new Store(dir),device=store.session().deviceId,gateway=new WorkerTransport(dir,store.epoch),assignments=new AssignmentService(store,gateway),content=new ContentWorkspace(store,assignments);
 const save=(id:string,value:Content,rev=0)=>store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'content',entityId:id,expectedRevision:rev,payload:value}) as Entity<Content>;
 const item=save('content:'+randomUUID(),{...blankRecord('content','UTC'),title:'Launch note',brief:'Explain the new workspace.',body:'# Original\n\nKeep this draft.',collection:'Launch',tags:['release']} as Content);
 const agent=store.mutate(device,{requestId:randomUUID(),epoch:store.epoch,kind:'agent',entityId:'agent:'+randomUUID(),expectedRevision:0,payload:{...blankRecord('agent','UTC'),name:'Reviewer',position:'Reviewer',access:{content:'edit',tasks:'edit'}}});
 const command=(input:Record<string,unknown>)=>content.command(device,{requestId:randomUUID(),epoch:store.epoch,...input});const source=()=>({contentId:item.id,expectedRevision:store.readEntity('content',item.id)!.revision});
 return {dir,store,device,gateway,assignments,content,save,item,agent,command,source};
}
async function fixture(fn:(f:ReturnType<typeof setup>)=>Promise<void>){const f=setup();try{await fn(f);}finally{await f.assignments.close();f.gateway.stopJournal?.();f.store.close();rmSync(f.dir,{recursive:true,force:true});}}
test('library saves are revisioned, replay safely and retain shared guidance after restart',()=>fixture(async f=>{
 const item={id:'library:'+randomUUID(),name:'Nova voice',type:'brand',revision:1,archived:false,guidance:'Warm, direct and concrete.',brief:'',body:'',platform:'Document',collection:'',tags:[],brandId:null};const input={type:'library-save',item,expectedRevision:0,requestId:randomUUID(),epoch:f.store.epoch};
 const saved=await f.content.command(f.device,input);assert.deepEqual(await f.content.command(f.device,input),saved);assert.equal(f.content.library().length,1);
 await assert.rejects(f.command({...input,requestId:randomUUID()}),/changed/);
 await f.command({type:'library-save',item:{...item,archived:true},expectedRevision:1});assert.equal(f.content.library()[0].revision,2);assert.equal(new ContentWorkspace(f.store,f.assignments).library()[0].archived,true);
}));
test('archiving a brand does not prevent managing templates already linked to it',()=>fixture(async f=>{
 const base={name:'Guidance',revision:1,archived:false,guidance:'Be direct.',brief:'',body:'',platform:'Document',collection:'',tags:[],brandId:null};const brand={...base,id:'library:'+randomUUID(),type:'brand'};await f.command({type:'library-save',expectedRevision:0,item:brand});
 const template={...base,id:'library:'+randomUUID(),type:'template',brandId:brand.id};await f.command({type:'library-save',expectedRevision:0,item:template});await f.command({type:'library-save',expectedRevision:1,item:{...brand,archived:true}});
 await f.command({type:'library-save',expectedRevision:1,item:{...template,archived:true}});assert.equal(f.content.library().find(i=>i.id===template.id)!.archived,true);
 await assert.rejects(f.command({type:'library-save',expectedRevision:0,item:{...template,id:'library:'+randomUUID()}}),/available brand/);
}));
test('templates retain verified original attachments and reject forged file identities',()=>fixture(async f=>{
 const file=f.store.upload(f.device,randomUUID(),f.store.epoch,'template.md',Buffer.from('Reusable source').toString('base64'));
 const item={id:'library:'+randomUUID(),name:'Reusable guide',type:'template',revision:1,archived:false,guidance:'',brief:'Audience:',body:'# Guide',format:'markdown',assets:[file],platform:'Article',collection:'Guides',tags:['guide'],brandId:null};
 await f.command({type:'library-save',expectedRevision:0,item});assert.deepEqual(f.content.library()[0].assets,[file]);
 await assert.rejects(f.command({type:'library-save',expectedRevision:1,item:{...item,assets:[{...file,sha256:'0'.repeat(64)}]}}),/attachment changed/);assert.equal(f.content.library()[0].revision,1);
}));
test('review comments, resolution and approval belong to an exact saved version',()=>fixture(async f=>{
 const r=await f.command({type:'review-request',...f.source(),reviewerId:f.agent.id}) as ContentReview;
 const c=await f.command({type:'review-comment',...f.source(),reviewId:r.id,reviewRevision:r.revision,text:'Clarify the audience.',quote:'Original'}) as ContentReview;
 await assert.rejects(f.command({type:'review-decide',...f.source(),reviewId:c.id,reviewRevision:c.revision,decision:'approved'}),/Resolve/);
 const resolved=await f.command({type:'review-resolve',...f.source(),reviewId:c.id,reviewRevision:c.revision,commentId:c.comments[0].id,resolved:true}) as ContentReview;
 const approved=await f.command({type:'review-decide',...f.source(),reviewId:c.id,reviewRevision:resolved.revision,decision:'approved'}) as ContentReview;assert.equal(approved.decisionBy,'You');
 const reopened=await f.command({type:'review-comment',...f.source(),reviewId:c.id,reviewRevision:approved.revision,text:'One more change.'}) as ContentReview;assert.equal(reopened.state,'requested');
 f.save(f.item.id,{...f.item.value,body:'Revised text'},1);
 await assert.rejects(f.command({type:'review-decide',...f.source(),reviewId:c.id,reviewRevision:reopened.revision,decision:'changes'}),/earlier version/);
 assert.equal(f.content.state(f.item.id).reviews[0].sourceRevision,1);
}));
test('reopening a resolved comment withdraws the current approval',()=>fixture(async f=>{
 const r=await f.command({type:'review-request',...f.source(),reviewerId:null}) as ContentReview;
 const commented=await f.command({type:'review-comment',...f.source(),reviewId:r.id,reviewRevision:r.revision,text:'Check this claim.'}) as ContentReview;
 const resolved=await f.command({type:'review-resolve',...f.source(),reviewId:r.id,reviewRevision:commented.revision,commentId:commented.comments[0].id,resolved:true}) as ContentReview;
 const approved=await f.command({type:'review-decide',...f.source(),reviewId:r.id,reviewRevision:resolved.revision,decision:'approved'}) as ContentReview;
 const reopened=await f.command({type:'review-resolve',...f.source(),reviewId:r.id,reviewRevision:approved.revision,commentId:commented.comments[0].id,resolved:false}) as ContentReview;assert.equal(reopened.state,'requested');assert.equal(reopened.decisionBy,undefined);
}));
test('restoration appends history, preserves original sources and clears publication without losing newer work',()=>fixture(async f=>{
 const newer=f.save(f.item.id,{...f.item.value,body:'Later published writing',stage:'published',publication:{kind:'manual',date:'2026-09-13',note:'Manually posted'}},1);
 const input={type:'restore',...f.source(),revision:1,requestId:randomUUID(),epoch:f.store.epoch};const restored=await f.content.command(f.device,input) as Entity<Content>;
 assert.equal(restored.revision,3);assert.equal(restored.value.body,f.item.value.body);assert.equal(restored.value.stage,'drafting');assert.equal(restored.value.publication,null);assert.equal(f.store.readEntityVersion('content',f.item.id,2)!.value.body,newer.value.body);assert.deepEqual(await f.content.command(f.device,input),restored);
 await assert.rejects(f.command({...input,requestId:randomUUID()}),/current Content/);
}));
test('agent work captures source and brand, denies writes and applies only the exact returned proposal once',()=>fixture(async f=>{
 const brand={id:'library:'+randomUUID(),name:'Voice',type:'brand',revision:1,archived:false,guidance:'Use short sentences.',brief:'',body:'',platform:'Document',collection:'',tags:[],brandId:null};await f.command({type:'library-save',item:brand,expectedRevision:0});f.save(f.item.id,{...f.item.value,brandId:brand.id},1);
 const input={type:'work',...f.source(),agentId:f.agent.id,mode:'draft',instructions:'Return a concise launch note.',requestId:randomUUID(),epoch:f.store.epoch};const job=await f.content.command(f.device,input) as ContentJob;await pause();
 const current=f.content.state(f.item.id).jobs[0];assert(current.attempt);const captured=f.assignments.detail(current.attempt.id).capture;assert.equal(captured.plan.value.executionMode,'proposal');assert.equal(captured.sources[0].record.revision,2);assert.match(captured.plan.value.brief,/Use short sentences/);assert.equal(f.assignments.canReviewModule(current.attempt.id,'records.save',{kind:'content'},true),false);assert.equal(f.assignments.canReviewModule(current.attempt.id,'records.read',{kind:'content'},false),true);
 f.gateway.finish('# Proposed\n\nA better launch note.');await f.assignments.reconcile(current.attempt.id);
 assert.equal(f.store.readEntity('content',f.item.id)!.value.body,f.item.value.body);
 await f.content.command(f.device,input);assert.equal(f.gateway.nativeCalls.length,1);
 const apply={type:'apply-work',...f.source(),jobId:job.id,placement:'replace',requestId:randomUUID(),epoch:f.store.epoch};const revised=await f.content.command(f.device,apply) as Entity<Content>;assert.equal(revised.revision,3);assert.equal(revised.value.body,'# Proposed\n\nA better launch note.');assert.equal(revised.value.assets?.length,1);assert.deepEqual(await f.content.command(f.device,apply),revised);assert.equal(f.content.state(f.item.id).jobs[0].appliedRevision,3);
}));
test('Content agents capture complete text and retain exact image identities for source reading',()=>fixture(async f=>{
 const text=Buffer.from('Verified source facts.\n'),image=Buffer.from([137,80,78,71]);
 const source=f.store.upload(f.device,randomUUID(),f.store.epoch,'facts.md',text.toString('base64')),picture=f.store.upload(f.device,randomUUID(),f.store.epoch,'reference.png',image.toString('base64'));
 f.save(f.item.id,{...f.item.value,assets:[source,picture]},1);
 await f.command({type:'work',...f.source(),agentId:f.agent.id,mode:'research',instructions:''});await pause();
 const job=f.content.state(f.item.id).jobs[0],capture=f.assignments.detail(job.attempt!.id).capture;
 assert.deepEqual(capture.files?.map(f=>f.text),[text.toString()]);assert.deepEqual(capture.binaryFiles?.[0].file,picture);assert.equal(capture.omittedFiles,undefined);assert.equal(f.gateway.nativeCalls.length,1);
}));
test('stale agent results cannot overwrite newer writing and reviews cannot replace the draft',()=>fixture(async f=>{
 const job=await f.command({type:'work',...f.source(),agentId:f.agent.id,mode:'review',instructions:''}) as ContentJob;await pause();const a=f.content.state(f.item.id).jobs[0].attempt!;f.gateway.finish('The audience is unclear.');await f.assignments.reconcile(a.id);
 await assert.rejects(f.command({type:'apply-work',...f.source(),jobId:job.id,placement:'replace'}),/comment/);
 const r=await f.command({type:'review-request',...f.source(),reviewerId:f.agent.id}) as ContentReview;
 const review=await f.command({type:'review-comment',...f.source(),reviewId:r.id,reviewRevision:r.revision,jobId:job.id,text:'not trusted replacement'}) as ContentReview;assert.equal(review.comments[0].text,'The audience is unclear.');assert.match(review.comments[0].author,/AI feedback/);
 f.save(f.item.id,{...f.item.value,body:'New owner writing'},1);await assert.rejects(f.command({type:'apply-work',...f.source(),jobId:job.id,placement:'replace'}),/changed after this run/);assert.equal(f.store.readEntity('content',f.item.id)!.value.body,'New owner writing');
}));
test('Improve pins unresolved current-version feedback and rejects oversized context without dispatch',()=>fixture(async f=>{
 const review=await f.command({type:'review-request',...f.source(),reviewerId:f.agent.id}) as ContentReview;
 const commented=await f.command({type:'review-comment',...f.source(),reviewId:review.id,reviewRevision:review.revision,text:'Tell users to save first.',quote:'Choose an action'}) as ContentReview;
 const job=await f.command({type:'work',...f.source(),agentId:f.agent.id,mode:'improve',instructions:''}) as ContentJob;await pause();
 assert.equal(job.reviewContext?.[0].revision,commented.revision);const a=f.content.state(f.item.id).jobs[0].attempt!;assert.match(f.assignments.detail(a.id).capture.plan.value.brief,/Tell users to save first/);
 f.gateway.finish('Revised guide');await f.assignments.reconcile(a.id);
 const more=await f.command({type:'review-comment',...f.source(),reviewId:review.id,reviewRevision:commented.revision,text:'x'.repeat(10000)}) as ContentReview;
 await f.command({type:'review-comment',...f.source(),reviewId:review.id,reviewRevision:more.revision,text:'y'.repeat(10000)});
 await assert.rejects(f.command({type:'work',...f.source(),agentId:f.agent.id,mode:'improve',instructions:''}),/Nothing was truncated/);assert.equal(f.gateway.nativeCalls.length,1);assert.equal(f.content.state(f.item.id).jobs.length,1);
}));
test('another active assignment is never mistaken for this Content job',()=>fixture(async f=>{
 const first=await f.command({type:'work',...f.source(),agentId:f.agent.id,mode:'research',instructions:''}) as ContentJob;await pause();const a=f.content.state(f.item.id).jobs[0].attempt!;f.gateway.finish('Research result');await f.assignments.reconcile(a.id);
 const second=await f.command({type:'work',...f.source(),agentId:f.agent.id,mode:'draft',instructions:''}) as ContentJob;await pause();const jobs=f.content.state(f.item.id).jobs;assert.equal(jobs.find(j=>j.id===first.id)!.attempt!.state,'returned');assert.notEqual(jobs.find(j=>j.id===first.id)!.attempt!.id,jobs.find(j=>j.id===second.id)!.attempt!.id);
}));
test('ZIP exports contain exact saved bytes, collision-safe assets and verifiable hashes',()=>fixture(async f=>{
 const bytes=Buffer.from([0,255,23,91,3]),asset=f.store.upload(f.device,randomUUID(),f.store.epoch,'../odd name.bin',bytes.toString('base64'));const c=f.save(f.item.id,{...f.item.value,body:f.item.value.body+`\n[Asset](/api/attachments/${asset.id})`,assets:[asset]},1);const zip=exportContentPackage(f.store,c.id,c.revision).bytes,entries=new Map<string,Buffer>();let at=0;
 while(zip.readUInt32LE(at)===0x04034b50){const size=zip.readUInt32LE(at+18),nameLength=zip.readUInt16LE(at+26),extra=zip.readUInt16LE(at+28),name=zip.subarray(at+30,at+30+nameLength).toString(),body=zip.subarray(at+30+nameLength+extra,at+30+nameLength+extra+size);assert(!name.includes('..'));assert.equal(crc32(body),zip.readUInt32LE(at+14));entries.set(name,body);at+=30+nameLength+extra+size;}
 assert.equal(entries.get('draft.md')!.toString(),c.value.body);const manifest=JSON.parse(entries.get('manifest.json')!.toString());assert.deepEqual(entries.get(manifest.assets[0].path),bytes);assert.equal(manifest.portableDraft,'portable.md');assert(entries.get('portable.md')!.toString().includes(`[Asset](${manifest.assets[0].path})`));for(const file of manifest.files)assert.equal(createHash('sha256').update(entries.get(file.path)!).digest('hex'),file.sha256);assert.equal(manifest.revision,2);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);
}));
test('Content endpoints enforce session, origin, strict commands and exact version exports',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'e3-content-http-')),server=await startServer({port:0,directory:dir,version:'test'});try{const base=server.origin;assert.equal((await fetch(base+'/api/content/library')).status,401);const session=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Edition3-Client':'1'},body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0],headers={Origin:base,'Content-Type':'application/json','X-Edition3-Client':'1',Cookie:cookie};
 assert.equal((await fetch(base+'/api/content/workspace',{method:'POST',headers:{...headers,Origin:'https://foreign.test'},body:'{}'})).status,403);assert.equal((await fetch(base+'/api/content/workspace',{method:'POST',headers,body:JSON.stringify({type:'review-request',requestId:randomUUID(),epoch:server.store.epoch,contentId:'content:x',expectedRevision:1,reviewerId:null,author:'forged'})})).status,400);assert.equal((await fetch(base+'/api/content/package?id=content:missing&revision=1',{headers})).status,404);
 }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
});
