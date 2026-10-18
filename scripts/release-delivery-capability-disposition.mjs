/** Close a proven pre-reservation capability gap without inventing a failed
 * producer or replaying the original operation. Historical validators retain
 * their original identity; this module never dispatches those producers. */
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { withVerificationPass } from './release-verification-pass.mjs';
import { PREWRITE_PREREQUISITES } from './release-delivery-disposition.mjs';

const need=(value,reason)=>{if(!value)throw Error(reason);};
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=z.string().regex(/^[a-f0-9]{64}$/), absolute=z.string().min(1).max(4096).refine(isAbsolute);
const ref=z.object({path:absolute,sha256:hash}).strict();
const json=(r,maximum=2*1024**2)=>JSON.parse(readEvidenceFile(r,{maximum}));
export const CAPABILITY_GAP='changed-startup-qualification-producer-required';
export const capabilityRequestSchema=z.object({format:z.literal(1),kind:z.literal('nova-delivery-capability-reconciliation'),operationId:z.uuid(),
  historical:z.object({root:absolute,manifest:ref}).strict(),
  owner:z.object({launched:ref,completed:ref,stdout:ref}).strict()}).strict();
export const capabilityDispositionSchema=z.object({format:z.literal(1),kind:z.literal('nova-delivery-reconciled-capability-gap'),
  policy:z.literal('changed-startup-before-package-v1'),operationId:z.uuid(),targetIdentity:hash,descriptorSha256:hash,adapterIdentity:hash,
  request:ref,snapshotSha256:hash,reviewedAtMs:z.number().int().nonnegative(),originalTimelineSha256:hash,
  prerequisiteProofs:z.array(z.object({phase:z.enum(PREWRITE_PREREQUISITES),key:z.uuid(),inputSha256:hash,observationSha256:hash}).strict()).length(6),
  gap:z.object({phase:z.literal('package'),reason:z.literal(CAPABILITY_GAP),reserved:z.literal(false)}).strict(),
  ownerPids:z.array(z.number().int().positive()).length(2),historicalValidatorIdentity:hash,
  prerequisiteEffectsPreserved:z.literal(true),downstreamDeliveryEffects:z.literal(false),automaticReplayPermitted:z.literal(false)}).strict();
export const predecessorRecoverySchema=z.object({journalDirectory:absolute,operationId:z.uuid(),descriptorSha256:hash,dispositionSha256:hash,originalTimelineSha256:hash}).strict();

function pathIn(root,name){
  need(typeof name==='string'&&name.length<256&&!name.includes('\\')&&!name.includes('\0'),'capability-historical-name-invalid');
  const path=resolve(root,'scripts',name),child=relative(resolve(root),path);
  need(child!==''&&!child.startsWith('..'+sep)&&child!=='..'&&!isAbsolute(child),'capability-historical-path-escape');
  return path;
}
export function verifyHistoricalGraph(request,descriptor){
  const rows=json(request.historical.manifest);
  need(Array.isArray(rows)&&rows.length>0&&rows.length<=512&&new Set(rows.map(x=>x.name)).size===rows.length,'capability-historical-graph-invalid');
  for(const row of rows){need(same(Object.keys(row).sort(),['name','sha256'])&&hash.safeParse(row.sha256).success,'capability-historical-graph-invalid');readEvidenceFile({path:pathIn(request.historical.root,row.name),sha256:row.sha256},{maximum:8*1024**2});}
  need(sha256(canonical(rows))===descriptor.adapterIdentity&&rows.some(x=>x.name==='release-delivery-adapters.mjs'),'capability-historical-identity-changed');
  return rows;
}
function absent(path){try{lstatSync(path);throw Error('capability-downstream-output-present');}catch(error){if(error.code!=='ENOENT')throw error;}}
function absentPid(pid){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw Error('capability-owner-closure-unavailable');}throw Error('capability-original-owner-still-present');}
export function verifyCapabilityOwner(request,journal,id,descriptor,{assertAbsent=absentPid,reviewedAtMs=Date.now()}={}){
  const launched=json(request.owner.launched),completed=json(request.owner.completed),stdout=json(request.owner.stdout);
  const target=json(descriptor.target,256*1024),result=stdout.release;
  need(launched.operationId===id&&Number.isSafeInteger(launched.pid)&&launched.pid>0&&Number.isSafeInteger(launched.launcherPid)&&launched.launcherPid>0
    &&launched.pid!==launched.launcherPid&&same(launched.node,target.artifactTools?.node)
    &&same(launched.argv,[launched.node.path,join(request.historical.root,'scripts','release-deliver.mjs'),'resume',journal.directory,id])
    &&resolve(launched.cwd)===resolve(request.historical.root),'capability-original-launch-changed');
  readEvidenceFile(launched.node,{maximum:128*1024**2});
  need(completed.originalOperationId===id&&completed.pid===launched.pid&&completed.outcome==='transport-returned'&&completed.exitCode===2
    &&completed.deliverySuccessInferred===false&&completed.automaticReplayPermitted===false&&completed.processTerminationPerformed===false
    &&Number.isFinite(Date.parse(launched.startedAt))&&Date.parse(completed.completedAt)>=Date.parse(launched.startedAt),'capability-original-terminal-result-required');
  need(stdout.operationId===id&&stdout.originalOperationPreserved===true&&stdout.state==='release-pending'&&stdout.complete===false&&stdout.storageCloseoutPerformed===false
    &&result?.operationId===id&&result.complete===false&&result.closed===false
    &&result.acceptanceGap===CAPABILITY_GAP&&same(result.integrationGaps,[CAPABILITY_GAP]),'capability-original-gap-result-required');
  const states=values=>values.map(({phase,state,key,externalId,reason})=>({phase,state,key,externalId,reason}));
  need(Array.isArray(result.phases)&&same(states(result.phases),states(journal.deliveryStatus(id,reviewedAtMs).phases)),
    'capability-original-result-journal-changed');
  const pids=[launched.pid,launched.launcherPid];pids.forEach(assertAbsent);return pids;
}
export function deriveCapabilityDisposition(journal,id,requestRef,reviewedAtMs,{assertAbsent}={}){
  const retained=journal.loadDelivery(id),descriptor=retained.descriptor,request=capabilityRequestSchema.parse(json(requestRef));
  need(retained.state==='active'&&request.operationId===id,'capability-original-active-operation-required');
  need(Number.isSafeInteger(reviewedAtMs)&&reviewedAtMs>=retained.created_at,'capability-clock-invalid');
  readEvidenceFile(descriptor.target,{maximum:256*1024});verifyHistoricalGraph(request,descriptor);
  const names=journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(x=>x.phase);
  need(same(names,[...PREWRITE_PREREQUISITES].sort()),'capability-downstream-or-unknown-reservation');
  const phases=PREWRITE_PREREQUISITES.map(name=>journal.deliveryPhase(id,name));
  need(phases.every(p=>p?.state==='completed'&&p.validation?.state!=='failed'&&p.current?.observedAtMs<=reviewedAtMs),'capability-prerequisites-not-complete');
  need(phases.at(-1).current.output?.route==='full','capability-full-route-required');
  need(!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id)&&!journal.intent(id),'capability-coordinator-effect-present');
  need(!journal.db.prepare("SELECT id FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(id),'capability-rejected-effect-history');
  need(!readdirSync(journal.directory).some(name=>/^(delivery-package-|delivery-signature-|delivery-full-|dependency-)/.test(name)),'capability-downstream-output-present');
  for(const name of ['package','sign','capacity','recovery','publication','installation','assistant','browser'])absent(join(journal.directory,'delivery-'+name+'-'+id));
  for(const phase of phases)if(phase.current.receipt)readEvidenceFile(phase.current.receipt);
  const ownerPids=verifyCapabilityOwner(request,journal,id,descriptor,{assertAbsent,reviewedAtMs});
  return capabilityDispositionSchema.parse({format:1,kind:'nova-delivery-reconciled-capability-gap',policy:'changed-startup-before-package-v1',operationId:id,
    targetIdentity:descriptor.targetIdentity,descriptorSha256:retained.descriptor_hash,adapterIdentity:descriptor.adapterIdentity,request:requestRef,
    snapshotSha256:sha256(canonical(phases)),reviewedAtMs,originalTimelineSha256:sha256(canonical(journal.deliveryTimeline(id,reviewedAtMs).timeline)),
    prerequisiteProofs:phases.map(p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sha256(canonical(p.current))})),
    gap:{phase:'package',reason:CAPABILITY_GAP,reserved:false},ownerPids,historicalValidatorIdentity:descriptor.adapterIdentity,
    prerequisiteEffectsPreserved:true,downstreamDeliveryEffects:false,automaticReplayPermitted:false});
}

export async function historicalCapabilityRegistry(request,descriptor){
  const rows=verifyHistoricalGraph(request,descriptor);
  const current=await import('./release-delivery-adapters.mjs');
  const target=json(descriptor.target,256*1024);current.validateSourceTools(target.sourceTools);
  const blob=raw=>createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');
  for(const side of ['private','public']){
    const source=descriptor.sources[side],prefix=side==='private'?'edition3/':'';
    const expected=new Map(rows.map(row=>[prefix+relative(request.historical.root,pathIn(request.historical.root,row.name)).split(sep).join('/'),blob(readEvidenceFile({path:pathIn(request.historical.root,row.name),sha256:row.sha256},{maximum:8*1024**2}))]));
    const found=(await current.fixedCommand(target.sourceTools.git.path,['-C',source.root,'ls-tree','-r','--format=%(objectname)%x09%(path)',source.commit,'--',...expected.keys()],{gitExecPath:target.sourceTools.gitExecPath})).trim().split(/\r?\n/).filter(Boolean).map(x=>x.split('\t'));
    need(found.length===expected.size&&new Set(found.map(x=>x[1])).size===found.length&&found.every(([oid,name])=>expected.get(name)===oid),'capability-historical-committed-graph-changed');
  }
  verifyHistoricalGraph(request,descriptor);
  const old=await import(pathToFileURL(pathIn(request.historical.root,'release-delivery-adapters.mjs')).href);
  need(same(old.deliveryAdapterSourceFiles(),rows.map(x=>x.name))&&old.deliveryAdapterIdentity()===descriptor.adapterIdentity,'capability-historical-module-changed');
  // A vanished/different capability gap must not fall through to host planning.
  const deny=()=>{throw Error('capability-reconciliation-effect-forbidden');};
  return old.createDeliveryRegistry({command:capabilityReadOnlyCommand(target,descriptor,current.fixedCommand),run:deny,receiptStore:deny});
}
export function capabilityReadOnlyCommand(target,descriptor,execute){
  const allowed=Object.values(descriptor.sources).flatMap(source=>[['remote','get-url','--push','origin'],['rev-parse','--verify',source.commit+'^{commit}'],
    ['rev-parse','--verify',source.baseCommit+'^{commit}'],['merge-base','--is-ancestor',source.baseCommit,source.commit]].map(args=>['-C',source.root,...args]));
  return(executable,args,options)=>{
    need(executable===target.sourceTools.git.path&&allowed.some(row=>same(row,args))
      &&same(options,{gitExecPath:target.sourceTools.gitExecPath}),'capability-reconciliation-command-forbidden');
    return execute(executable,args,options);
  };
}
export async function reconcileCapabilityGap(journal,id,requestRef,{clock=Date.now,loadRegistry=historicalCapabilityRegistry,assertAbsent}={}){
  const retained=journal.deliveryDisposition(id);
  if(retained){need(retained.proof.kind==='nova-delivery-reconciled-capability-gap'&&same(retained.proof.request,requestRef),'capability-existing-disposition-changed');return journal.deliveryStatus(id,clock());}
  const before=deriveCapabilityDisposition(journal,id,requestRef,clock(),{assertAbsent}),descriptor=journal.loadDelivery(id).descriptor;
  const request=capabilityRequestSchema.parse(json(requestRef)),registry=await loadRegistry(request,descriptor),prior={};
  need(await registry.identity(descriptor)===descriptor.adapterIdentity&&await registry.targetIdentity(descriptor)===descriptor.targetIdentity,'capability-historical-registry-changed');
  await withVerificationPass({},async scope=>{
    for(const phase of PREWRITE_PREREQUISITES){const intent=journal.deliveryPhase(id,phase),adapter=registry.adapter(phase,descriptor,prior);
      need(adapter&&typeof adapter.validate==='function'&&typeof adapter.verify==='function','capability-prerequisite-verifier-missing');
      const context={...scope,descriptor,prior,input:intent.input,intent,journal};await adapter.validate(context);await adapter.verify(intent.current,context);prior[phase]=intent.current.output;
    }
    need(same(await registry.phasePreflight('package',descriptor,prior),[CAPABILITY_GAP]),'capability-original-gap-not-reproduced');
  },{readOnly:true});
  const after=deriveCapabilityDisposition(journal,id,requestRef,before.reviewedAtMs,{assertAbsent});
  need(same(before,after),'capability-original-operation-changed');
  need(await registry.identity(descriptor)===descriptor.adapterIdentity&&await registry.targetIdentity(descriptor)===descriptor.targetIdentity,'capability-historical-registry-changed');
  return journal.recordCapabilityDisposition(id,after,clock(),{assertAbsent});
}

export async function verifyRecoveryPredecessor(lineage,operation,{openJournal,targetIdentity}={}){
  const link=predecessorRecoverySchema.parse(lineage);need(link.operationId!==operation.id,'capability-successor-operation-reused');
  const Journal=openJournal??((await import('./release-coordinate.mjs')).ReleaseJournal);
  const journal=new Journal(link.journalDirectory,{create:false,readOnly:true});
  try{const original=journal.loadDelivery(link.operationId),disposition=journal.deliveryDisposition(link.operationId);
    need(original.state==='reconciled-gap'&&original.descriptor.targetIdentity===targetIdentity&&disposition?.proof.kind==='nova-delivery-reconciled-capability-gap'&&disposition.sha256===link.dispositionSha256
      &&original.descriptor_hash===link.descriptorSha256&&disposition.proof.originalTimelineSha256===link.originalTimelineSha256,'capability-predecessor-disposition-required');
    const newer=(next,prior)=>{const a=next.split('.').map(Number),b=prior.split('.').map(Number);return a.length===3&&b.length===3&&a.some((n,i)=>n>b[i]&&a.slice(0,i).every((x,j)=>x===b[j]));};
    need(original.descriptor.operation.priorCandidateId===operation.priorCandidateId&&original.descriptor.operation.workspaceEpoch===operation.workspaceEpoch
      &&newer(operation.version,original.descriptor.operation.version)&&newer(operation.buildVersion,original.descriptor.operation.buildVersion)
      &&['private','public'].every(side=>original.descriptor.operation.sourceCommits[side]!==operation.sourceCommits[side]),'capability-successor-lineage-changed');
    return link;
  }finally{journal.close();}
}
