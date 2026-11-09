/** One explicit current-operator grant for an expired, untouched package phase.
 * Candidate identity and original execution history are never rewritten. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { PREWRITE_PREREQUISITES } from './release-delivery-disposition.mjs';
import { withVerificationPass } from './release-verification-pass.mjs';
import { fullFactsSpec, verifyFullFacts } from './release-delivery-full-host.mjs';

const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/),path=z.string().min(1).max(4096).refine(isAbsolute);
const ref=z.object({path,sha256:hash}).strict();
const source=z.object({root:path,repository:z.string(),branch:z.literal('codex/operator-continuation-31'),commit}).strict();
const pair=s=>z.object({private:s,public:s}).strict();
const json=r=>JSON.parse(readEvidenceFile(ref.parse(r),{maximum:2*1024**2}));
const reference=p=>({path:resolve(p),sha256:sha256(readFileSync(p))});
const graphSchema=z.array(z.object({name:z.string(),sha256:hash}).strict()).min(1).max(512);
export const continuationRequestSchema=z.object({format:z.literal(1),kind:z.literal('nova-expired-prepackage-request'),operationId:z.uuid(),
 historical:z.object({root:path,manifest:ref}).strict(),owner:z.object({request:ref,attempts:z.array(z.object({launcher:ref,intent:ref,exit:ref,childResult:ref,stdout:ref}).strict()).min(1).max(8)}).strict(),
 operatorSources:pair(source),ciRuns:pair(z.number().int().positive()),durationMs:z.number().int().min(60000).max(14400000)}).strict();
export const continuationGrantSchema=z.object({format:z.literal(1),kind:z.literal('nova-expired-prepackage-continuation'),operationId:z.uuid(),
 descriptorSha256:hash,targetIdentity:hash,originalAdapterIdentity:hash,originalTimelineSha256:hash,originalBudgetMs:z.number().int().positive(),
 originalCreatedAtMs:z.number().int().nonnegative(),snapshotSha256:hash,eventHighWaterMark:z.number().int().nonnegative(),historySha256:hash,
 prerequisites:z.array(z.object({phase:z.enum(PREWRITE_PREREQUISITES),key:z.uuid(),inputSha256:hash,observationSha256:hash}).strict()).length(6),
 request:ref,ownerPids:z.array(z.number().int().positive()).min(2).max(16),
 operator:z.object({adapterIdentity:hash,sources:pair(source),sourceFiles:graphSchema,ci:pair(ref)}).strict(),
 hostFacts:ref,issuedAtMs:z.number().int().nonnegative(),expiresAtMs:z.number().int().positive(),
 automaticRenewal:z.literal(false),originalHistoryPreserved:z.literal(true)}).strict().refine(v=>v.expiresAtMs>v.issuedAtMs&&v.expiresAtMs-v.issuedAtMs<=14400000,'finite-continuation-window-required');

function absentOwner(owner){
 need(Number.isSafeInteger(owner.pid)&&owner.pid>0&&/^\/Date\([0-9]+\)\/$/.test(owner.created??'')&&typeof owner.executable==='string'&&hash.safeParse(owner.commandLineSha256).success,'continuation-original-process-identity-invalid');
 try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')return;throw Error('continuation-owner-closure-unavailable');}
 need(process.platform==='win32','continuation-original-owner-still-present');
 const script="$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+owner.pid+"';if($null -eq $p){'null'}else{@{pid=[int]$p.ProcessId;created=$p.CreationDate}|ConvertTo-Json -Compress}";
 const raw=execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000,maxBuffer:65536,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const current=JSON.parse(raw);need(current===null||(current.pid===owner.pid&&/^\/Date\([0-9]+\)\/$/.test(current.created)&&current.created!==owner.created),'continuation-original-owner-still-present');
}
export function verifyOriginalContinuationGraph(request,descriptor){
 const graph=json(request.historical.manifest);need(graph.format===1&&graph.adapterIdentity===descriptor.adapterIdentity&&Array.isArray(graph.sourceFiles)&&graph.sourceFiles.length>0&&graph.sourceFiles.length<=512,'continuation-original-graph-invalid');
 const rows=graph.sourceFiles.map(r=>{ref.parse(r);const name=relative(join(request.historical.root,'scripts'),r.path).replaceAll('\\','/');need(!isAbsolute(name)&&!name.startsWith('../../')&&!name.includes('\0'),'continuation-original-graph-path-invalid');readEvidenceFile(r,{maximum:8*1024**2});return{name,sha256:r.sha256};});
 need(new Set(rows.map(r=>r.name)).size===rows.length&&rows.some(r=>r.name==='release-delivery-adapters.mjs')&&sha256(canonical(rows))===descriptor.adapterIdentity,'continuation-original-adapter-changed');return rows;
}
function history(journal,id,through=null){
 const rows=journal.db.prepare('SELECT id,at_ms,kind,payload_hash FROM delivery_events WHERE operation_id=? AND id<=? ORDER BY id').all(id,through??Number.MAX_SAFE_INTEGER);
 return {eventHighWaterMark:rows.at(-1)?.id??0,historySha256:sha256(canonical(rows))};
}
export function continuationSnapshot(journal,id,now,{assertAbsent=absentOwner,request=null}={}){
 const retained=journal.loadDelivery(id),d=retained.descriptor;
 need(retained.state==='active'&&!journal.deliveryDisposition(id),'continuation-original-active-operation-required');
 need(Number.isSafeInteger(now)&&now>retained.created_at+d.observationBudgetMs,'continuation-original-budget-not-expired');
 const names=journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(x=>x.phase);
 need(same(names,[...PREWRITE_PREREQUISITES].sort()),'continuation-downstream-reservation-present');
 const phases=PREWRITE_PREREQUISITES.map(n=>journal.deliveryPhase(id,n));
 need(phases.every(p=>p?.state==='completed'&&p.validation?.state!=='failed'),'continuation-prerequisites-not-complete');
 need(phases.at(-1).current.output?.route==='full','continuation-full-route-required');
 need(!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id)&&!journal.intent(id),'continuation-coordinator-effect-present');
 need(!journal.db.prepare("SELECT id FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(id),'continuation-rejected-effect-history');
 need(!readdirSync(journal.directory).some(n=>/^(delivery-package-|delivery-signature-|delivery-full-|dependency-)/.test(n)),'continuation-downstream-output-present');
 let ownerPids=[];
 if(request){
  need(request.operationId===id,'continuation-request-operation-changed');verifyOriginalContinuationGraph(request,d);
  const original=json(request.owner.request),root=resolve(request.owner.request.path,'..'),target=json(d.target),dirs=[];
  need(original.operationId===id&&same(original.node,target.artifactTools.node),'continuation-original-storage-request-changed');
  for(const a of request.owner.attempts){
   const launcher=json(a.launcher),intent=json(a.intent),closed=json(a.childResult),exit=json(a.exit),status=json(a.stdout),dir=resolve(a.intent.path,'..');dirs.push(dir);
   need(/^observation-[0-9]{4,}$/.test(relative(join(root,'observations'),dir))&&a.intent.path===join(dir,'intent.json')&&a.exit.path===join(dir,'exit.json')&&a.childResult.path===join(dir,'default-child-result.json')&&a.stdout.path===join(dir,'stdout.json'),'continuation-original-observation-path-changed');
   need(launcher.kind==='verified-waiting-release-launcher'&&launcher.dispatchAuthority===false&&launcher.operationId===id&&['start','resume'].includes(launcher.mode)
    &&same(launcher.node,original.node)&&same(launcher.entry,original.deliveryEntry)&&same(launcher.start,original.releaseInput)&&same(launcher.budget,original.storageBudget)
    &&resolve(launcher.cwd)===resolve(request.historical.root)&&launcher.worker.parentPid===launcher.owner.pid,'continuation-original-owner-identity-changed');
   for(const r of [launcher.node,launcher.entry,launcher.runner,launcher.config])readEvidenceFile(r,{maximum:128*1024**2});
   const tail=launcher.mode==='resume'?id:join(resolve(journal.directory,'..'),'request-'+id,'descriptor.json');
   need(same(intent.request,request.owner.request)&&intent.sameReleaseOperation===true&&same(intent.argv,[launcher.node.path,launcher.entry.path,launcher.mode,journal.directory,tail]),'continuation-original-child-argv-changed');
   need(closed.originalChildClosed===true&&closed.returnCode===2&&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false&&exit.returnCode===2
    &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds<=now,'continuation-original-owner-not-closed');
   need(status.operationId===id&&status.complete===false&&status.closed===false,'continuation-original-result-changed');
   for(const p of [launcher.owner,launcher.worker]){need(Number(p.created.match(/^\/Date\(([0-9]+)\)\/$/)?.[1])<=exit.finishedAtMilliseconds,'continuation-original-owner-time-changed');assertAbsent(p);ownerPids.push(p.pid);}
  }
  const actual=readdirSync(join(root,'observations')).filter(n=>/^observation-[0-9]{4,}$/.test(n)).map(n=>join(root,'observations',n));
  need(new Set(dirs).size===dirs.length&&same([...dirs].sort(),actual.sort()),'continuation-unclassified-original-owner');
  const latest=request.owner.attempts.find(a=>resolve(a.intent.path,'..')===[...dirs].sort().at(-1)),status=json(latest.stdout);
  need(status.observationBudgetExpired===true,'continuation-original-expired-result-required');
  const states=rows=>rows.map(({phase,state,key,externalId,reason})=>({phase,state,key,externalId,reason}));
  need(same(states(status.phases),states(journal.deliveryStatus(id,now).phases)),'continuation-original-owner-result-changed');
 }
 return {descriptorSha256:retained.descriptor_hash,targetIdentity:d.targetIdentity,originalAdapterIdentity:d.adapterIdentity,
  originalTimelineSha256:sha256(canonical(d.timeline)),originalBudgetMs:d.observationBudgetMs,originalCreatedAtMs:retained.created_at,...history(journal,id),
  snapshotSha256:sha256(canonical(phases)),prerequisites:phases.map(p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sha256(canonical(p.current))})),ownerPids};
}
function save(journal,name,value){
 const dir=join(journal.directory,'delivery-continuation-evidence');mkdirSync(dir,{recursive:true,mode:0o700});
 const b=Buffer.from(canonical(value)+'\n'),p=join(dir,name+'-'+sha256(b)+'.json');
 if(existsSync(p))need(readFileSync(p).equals(b),'continuation-existing-evidence-changed');else{const fd=openSync(p,'wx',0o600);try{writeFileSync(fd,b);fsyncSync(fd);}finally{closeSync(fd);}}
 return reference(p);
}
const WORKFLOW='.github/workflows/operator-continuation-quality.yml';
export function verifyOperatorCi(value,source){
 const run=value.run,jobs=value.jobs;
 need(run?.head_sha===source.commit&&run.head_branch===source.branch&&run.event==='push'&&run.path===WORKFLOW&&run.name==='Operator continuation quality'
  &&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0&&value.requestedAttempt===run.run_attempt&&run.status==='completed'&&run.conclusion==='success'&&run.repository?.full_name===source.repository,'continuation-operator-ci-run-changed');
 need(jobs?.total_count===1&&jobs.jobs?.length===1,'continuation-operator-ci-jobs-changed');
 const job=jobs.jobs[0];need(Number.isSafeInteger(job.id)&&job.id>0&&job.run_id===run.id&&(job.run_attempt===undefined||job.run_attempt===run.run_attempt)&&job.head_sha===source.commit&&job.name==='quality'&&job.status==='completed'&&job.conclusion==='success','continuation-operator-quality-not-passed');
 for(const name of ['Run npm run quality','Verify Linux update recovery'])need(job.steps.filter(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success').length===1,'continuation-operator-quality-step-missing');
 return value;
}
export async function qualifyOperatorSources(request,descriptor,{command,adapterFiles,adapterIdentity}={}){
 const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;adapterFiles??=A.deliveryAdapterSourceFiles;adapterIdentity??=A.deliveryAdapterIdentity;
 const target=json(descriptor.target);A.validateSourceTools(target.sourceTools);const names=adapterFiles();
 const rows=names.map(name=>({name,sha256:sha256(readFileSync(new URL(name,import.meta.url)))}));
 need(names.length===new Set(names).size&&sha256(canonical(rows))===adapterIdentity(),'continuation-current-graph-invalid');
 for(const side of ['private','public']){
  const s=request.operatorSources[side],repository=side==='private'?'HatimTheDream/Nova-Dream':'HatimTheDream/Nova-Dream-Public',prefix=side==='private'?'edition3/':'';
  need(s.repository===repository&&s.commit!==descriptor.sources[side].commit&&resolve(s.root)!==resolve(descriptor.sources[side].root),'continuation-distinct-current-operator-source-required');
  const git=args=>command(target.sourceTools.git.path,['-C',s.root,...args],{gitExecPath:target.sourceTools.gitExecPath});
  need((await git(['branch','--show-current'])).trim()===s.branch&&(await git(['rev-parse','HEAD'])).trim()===s.commit&&(await git(['status','--porcelain','--untracked-files=no'])).trim()==='','continuation-current-operator-checkout-changed');
  need([`https://github.com/${repository}.git`,`https://github.com/${repository}`,`git@github.com:${repository}.git`].includes((await git(['remote','get-url','--push','origin'])).trim()),'continuation-operator-remote-changed');
  need((await git(['ls-remote','--exit-code','origin','refs/heads/'+s.branch])).trim()===s.commit+'\trefs/heads/'+s.branch,'continuation-operator-publication-required');
  await git(['merge-base','--is-ancestor',descriptor.sources[side].commit,s.commit]);
  const blob=b=>createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
  const expected=new Map(names.map(n=>[(prefix+'scripts/'+n).replace(/scripts\/\.\.\//,'').replaceAll('\\','/'),blob(readFileSync(new URL(n,import.meta.url)))]));
  const workflow=readFileSync(join(s.root,WORKFLOW));expected.set(WORKFLOW,blob(workflow));
  const found=(await git(['ls-tree','-r','--format=%(objectname)%x09%(path)',s.commit,'--',...expected.keys()])).trim().split(/\r?\n/).map(x=>x.split('\t'));
  need(found.length===expected.size&&new Set(found.map(x=>x[1])).size===found.length&&found.every(([oid,p])=>expected.get(p)===oid),'continuation-operator-committed-graph-changed');
  const original=verifyOriginalContinuationGraph(request,descriptor),old=descriptor.sources[side];
  const oldExpected=new Map(original.map(row=>[(prefix+'scripts/'+row.name).replace(/scripts\/\.\.\//,''),blob(readEvidenceFile({path:resolve(request.historical.root,'scripts',row.name),sha256:row.sha256},{maximum:8*1024**2}))]));
  const oldFound=(await command(target.sourceTools.git.path,['-C',old.root,'ls-tree','-r','--format=%(objectname)%x09%(path)',old.commit,'--',...oldExpected.keys()],{gitExecPath:target.sourceTools.gitExecPath})).trim().split(/\r?\n/).map(x=>x.split('\t'));
  need(oldFound.length===oldExpected.size&&new Set(oldFound.map(x=>x[1])).size===oldFound.length&&oldFound.every(([oid,p])=>oldExpected.get(p)===oid),'continuation-original-committed-graph-changed');
 }
 need([resolve(request.operatorSources.private.root,'edition3/scripts/release-delivery-continuation.mjs'),resolve(request.operatorSources.public.root,'scripts/release-delivery-continuation.mjs')].includes(fileURLToPath(import.meta.url)),'continuation-current-entry-source-required');
 return {adapterIdentity:adapterIdentity(),sources:request.operatorSources,sourceFiles:rows};
}
export async function reconcileExpiredPrepackage(journal,id,requestRef,{clock=Date.now,assertAbsent,command,registry}={}){
 const request=continuationRequestSchema.parse(json(requestRef)),old=journal.deliveryOperatorContinuation(id);
 if(old){need(same(old.proof.request,requestRef),'continuation-already-granted');await verifyContinuationStorageAuthority({journal,operationId:id});return old;}
 const before=continuationSnapshot(journal,id,clock(),{request,assertAbsent}),d=journal.loadDelivery(id).descriptor;
 const A=await import('./release-delivery-adapters.mjs');command??=A.fixedCommand;registry??=A.createDeliveryRegistry({command,clock});
 const operator=await qualifyOperatorSources(request,d,{command});operator.ci={};
 const target=json(d.target);
 for(const side of ['private','public']){
  const s=operator.sources[side],runId=request.ciRuns[side];
  const input=save(journal,'operator-ci-request-'+side,{format:1,source:s,runId,tools:target.sourceTools});
  const result=JSON.parse(await command(target.sourceTools.python.path,[fileURLToPath(new URL('release-operator-ci.py',import.meta.url)),'--request',input.path,'--request-sha256',input.sha256],{maximum:8*1024**2,timeoutMs:180000}));
  need(result.run.id===runId,'continuation-operator-ci-id-changed');operator.ci[side]=save(journal,'operator-ci-'+side,verifyOperatorCi(result,s));
 }
 const prior=Object.fromEntries(PREWRITE_PREREQUISITES.map(p=>[p,journal.deliveryPhase(id,p).current.output]));
 await withVerificationPass({},async scope=>{for(const phase of PREWRITE_PREREQUISITES){const intent=journal.deliveryPhase(id,phase),adapter=registry.adapter(phase,d,prior),context={...scope,journal,descriptor:d,prior,intent,input:intent.input};need(adapter,'continuation-current-verifier-missing');await adapter.validate(context);await adapter.verify(intent.current,context);}},{readOnly:true});
 need((await registry.phasePreflight('package',d,prior)).length===0,'continuation-package-prerequisite-unavailable');
 const facts=await registry.continuationFacts(d,{journal});const hostFacts=save(journal,'current-idle-host',facts);
 const at=clock(),after=continuationSnapshot(journal,id,at,{request,assertAbsent});need(same(before,after),'continuation-original-history-changed');
 const proof=continuationGrantSchema.parse({format:1,kind:'nova-expired-prepackage-continuation',operationId:id,...after,request:requestRef,operator,hostFacts,
  issuedAtMs:at,expiresAtMs:at+request.durationMs,automaticRenewal:false,originalHistoryPreserved:true});
 return journal.recordOperatorContinuation(id,proof,at,{assertAbsent});
}
/** The grant admits only the already elapsed baseline; later misses retain the
 * maintained review and changed-approach rules without resetting any history. */
export function verifyContinuationTimeline(journal,id,baseline,now){
 const {timeline,eta}=journal.deliveryTimeline(id,now);
 const later=eta.deadlineAssessments.filter(e=>e.deadlineAtMs>baseline),ids=new Set(later.map(e=>e.deadlineId));
 need(!eta.dueReviews.some(e=>ids.has(e.deadlineId)),'continuation-later-overrun-review-required');
 const groups={'private-ci':['private-ci'],'public-ci':['public-ci'],package:['package','sign'],capacity:['capacity'],recovery:['recovery'],publication:['publication'],installation:['installation'],acceptance:['assistant','browser']};
 const passed=names=>names.every(name=>{const p=journal.deliveryPhase(id,name);return p?.state==='completed'&&p.validation?.state!=='failed';});
 for(const step of new Set(later.map(e=>e.step))){
  const missed=later.filter(e=>e.step===step&&e.state==='missed');if(missed.length<2||passed(step==='total'?Object.values(groups).flat():groups[step]))continue;
  const latest=Math.max(...missed.map(e=>e.deadlineAtMs));
  need(timeline.reviews.some((r,index)=>r.action==='change-approach'&&missed.some(e=>e.deadlineId===r.deadlineId)&&r.reviewedAtMs>=latest
   &&!timeline.reviews.slice(0,index).some(old=>old.action==='change-approach'&&old.evidenceSha256===r.evidenceSha256)),'continuation-later-change-approach-required');
 }
}
export function verifyContinuationGrant(journal,id,{now=Date.now(),effect=false}={}){
 const saved=journal.deliveryOperatorContinuation(id);need(saved,'continuation-grant-required');const p=continuationGrantSchema.parse(saved.proof),d=journal.loadDelivery(id);
 need(p.descriptorSha256===d.descriptor_hash&&p.originalAdapterIdentity===d.descriptor.adapterIdentity&&p.targetIdentity===d.descriptor.targetIdentity
  &&p.originalCreatedAtMs===d.created_at&&p.originalBudgetMs===d.descriptor.observationBudgetMs
  &&p.originalTimelineSha256===sha256(canonical(d.descriptor.timeline))&&same(history(journal,id,p.eventHighWaterMark),{eventHighWaterMark:p.eventHighWaterMark,historySha256:p.historySha256}),'continuation-original-descriptor-changed');
 const request=continuationRequestSchema.parse(json(p.request));verifyOriginalContinuationGraph(request,d.descriptor);
 need(request.operationId===id&&same(p.operator.sources,request.operatorSources)&&p.expiresAtMs-p.issuedAtMs===request.durationMs,'continuation-request-authority-changed');
 for(const row of p.prerequisites){const original=journal.deliveryPhase(id,row.phase);need(original?.state==='completed'&&original.validation?.state!=='failed'&&original.key===row.key&&original.inputSha256===row.inputSha256&&sha256(canonical(original.current))===row.observationSha256,'continuation-original-prerequisite-changed');}
 for(const side of ['private','public']){const ci=verifyOperatorCi(json(p.operator.ci[side]),p.operator.sources[side]);need(ci.run.id===request.ciRuns[side],'continuation-request-ci-changed');}
 const host=json(p.hostFacts),target=json(d.descriptor.target),bytes=Buffer.from(host.stdoutRawBase64??'','base64');
 need(host.hostWrites===false&&bytes.length<=131072&&bytes.toString('base64')===host.stdoutRawBase64&&sha256(bytes)===host.stdoutSha256&&same(JSON.parse(bytes),host.facts),'continuation-original-host-observation-changed');
 const spec=fullFactsSpec(d.descriptor,target.full.host,id,null,host.spec.applicationTransition??null);
 need(same(host.spec,spec),'continuation-original-host-spec-changed');verifyFullFacts(host.facts,spec,p.issuedAtMs,true);
 need(!effect||(now>=p.issuedAtMs&&now<p.expiresAtMs),'continuation-window-expired');
 if(effect)verifyContinuationTimeline(journal,id,saved.recordedAtMs,now);return saved;
}
export async function verifyContinuationStorageAuthority({journal,operationId,entry=null,now=Date.now(),effect=false}){
 const saved=verifyContinuationGrant(journal,operationId,{now,effect}),p=saved.proof,A=await import('./release-delivery-adapters.mjs');
 const current=A.deliveryAdapterSourceFiles().map(name=>({name,sha256:sha256(readFileSync(new URL(name,import.meta.url)))}));
 need(A.deliveryAdapterIdentity()===p.operator.adapterIdentity&&same(current,p.operator.sourceFiles),'continuation-current-operator-graph-changed');
 const roots=[join(p.operator.sources.private.root,'edition3'),p.operator.sources.public.root],actual=join(roots[0],'scripts/release-deliver.mjs');
 need(entry===null||resolve(entry)===resolve(actual),'continuation-current-operator-entry-changed');
 need([join(roots[0],'scripts/release-deliver.mjs'),join(roots[1],'scripts/release-deliver.mjs')].map(p=>resolve(p)).includes(fileURLToPath(new URL('release-deliver.mjs',import.meta.url))),'continuation-current-module-root-changed');
 return {grantSha256:saved.sha256,operatorAdapterIdentity:p.operator.adapterIdentity,operatorEntry:reference(actual),operatorRoots:roots,operatorSources:p.operator.sources,
  expiresAtMs:p.expiresAtMs,originalAdapterIdentity:p.originalAdapterIdentity,descriptorSha256:p.descriptorSha256,
  newEffectsAllowed:now>=p.issuedAtMs&&now<p.expiresAtMs,continuationStarted:Boolean(journal.deliveryPhase(operationId,'package'))};
}
export async function assertDeliveryOperator(journal,id,registry,{clock=Date.now,effect=false}={}){
 const d=journal.loadDelivery(id).descriptor,current=await registry.identity(d);
 if(!journal.deliveryOperatorContinuation(id)){need(current===d.adapterIdentity,'delivery-adapter-changed');return null;}
 const authority=await verifyContinuationStorageAuthority({journal,operationId:id,now:clock(),effect});need(current===authority.operatorAdapterIdentity,'delivery-continuation-adapter-changed');return authority;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,directory,id,entry]=process.argv.slice(2);need(mode==='storage-authority'&&entry,'continuation-exact-readonly-command-required');
 const {ReleaseJournal}=await import('./release-coordinate.mjs');const journal=new ReleaseJournal(directory,{create:false,readOnly:true});
 try{process.stdout.write(JSON.stringify(await verifyContinuationStorageAuthority({journal,operationId:id,entry}))+'\n');}finally{journal.close();}
}
