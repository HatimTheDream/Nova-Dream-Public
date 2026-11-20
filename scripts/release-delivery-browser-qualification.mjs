/** Candidate-bound, isolated qualification for the ordinary retained-window route. */
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile} from './release-plan.mjs';
import {qualifiedBrowserBuild, retainedWindowPolicy, verifyRemoteBrowserMemory} from './release-delivery-browser-primitives.mjs';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const reference=z.object({path:z.string().min(1),sha256:digest}).strict();
const reviewSchema=z.object({
  format:z.literal(1),kind:z.literal('retained-browser-window-qualification-review'),
  status:z.literal('passed'),independentReview:z.literal(true),policy:z.literal(retainedWindowPolicy),
  priorCandidateId:digest,targetCandidateId:digest,plan:reference,terminal:reference
}).strict();
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
const read=(ref,maximum)=>JSON.parse(readEvidenceFile(ref,{maximum}));
const document=({candidateId,version,buildVersion})=>({candidateId,frontendId:candidateId,assets:`/__bundled/${candidateId}/`,version,buildVersion});

/** The release's frozen target pins the independent review. The private fixture
 * demonstrates the transition geometry; a real saved Assistant reply is still
 * required by the separate live browser acceptance. */
export function ordinaryWindowQualification(descriptor,target,route) {
  const op=descriptor.operation,ref=target.browserWindowQualification;
  const expectedBuild = qualifiedBrowserBuild(op.version);
  if(!ref&&(expectedBuild===undefined||route?.route!=='full'))return null;
  need(ref&&expectedBuild!==undefined&&op.buildVersion===expectedBuild&&route?.route==='full'
    &&target.browserCapability==='available'&&target.browserTools?.mode==='remote'&&target.browserTools.suite==='tasks-search-focus',
    'browser-ordinary-window-qualification-required');
  const review=reviewSchema.parse(read(reference.parse(ref),65536)),base=target.bases?.private;
  need(base?.candidateId===op.priorCandidateId&&review.priorCandidateId===op.priorCandidateId
    &&review.targetCandidateId===route.targetCandidateId&&review.targetCandidateId!==review.priorCandidateId
    &&(op.candidateId==null||op.candidateId===review.targetCandidateId),'browser-qualification-candidate-changed');
  const manifest=read(base.manifest,2*1024**2);
  need(manifest.version==='2.28.39'&&manifest.buildVersion==='1.0.412','browser-qualification-prior-changed');
  const old=document({candidateId:review.priorCandidateId,version:manifest.version,buildVersion:manifest.buildVersion});
  const next=document({candidateId:review.targetCandidateId,version:op.version,buildVersion:op.buildVersion});
  const plan=read(review.plan,256*1024),terminal=read(review.terminal,2*1024**2),id=z.uuid().parse(terminal.fixtureId),files=terminal.files;
  need(plan.format===1&&plan.kind==='isolated-two-page-browser-memory-plan'&&plan.fixtureId===id
    &&digest.safeParse(plan.inputSha256).success&&plan.inputSha256===terminal.runHash
    &&plan.productionEffect===false&&plan.modelRequestsAllowed===false&&plan.source?.classificationComplete===true
    &&plan.source.unclassifiedRootCount===0&&Number.isSafeInteger(plan.source.entryCount)&&plan.source.entryCount>0
    &&['inventorySha256','metadataSha256','projectionSha256'].every(key=>digest.safeParse(plan.source[key]).success)
    &&same(plan.source,terminal.sourceAfterClosure)
    &&same(document(plan.apps.prior),old)&&same(document(plan.apps.target),next),'browser-qualification-plan-changed');
  const item=name=>{
    const value=files?.[name];need(value?.fixtureId===id,'browser-qualification-fixture-changed');return value;
  };
  const done=item('browser-done'),server=item('server-done');
  need(terminal.originalOwnerPidsClosed===true&&server.closed===true&&done.memoryQualificationPassed===true
    &&done.sentModelRequests===0&&done.accepted===false,'browser-qualification-incomplete');
  for(const role of ['browser','server']){
    const unit=terminal.units?.[role],receipt=role==='browser'?done:server;
    need(unit?.ActiveState==='inactive'&&unit.SubState==='dead'&&unit.MainPID==='0'&&unit.Result==='success'
      &&unit.ExecMainStatus==='0'&&receipt.cgroup==='/system.slice/'+plan.units[role]+'.service','browser-qualification-worker-open');
  }
  const prior=item('prior-ready'),targetReady=item('target-ready'),switched=item('switch');
  need(prior.candidateId===old.candidateId&&targetReady.candidateId===next.candidateId
    &&switched.priorCandidateId===old.candidateId&&switched.targetCandidateId===next.candidateId
    &&z.uuid().safeParse(prior.epoch).success&&prior.epoch===targetReady.epoch,'browser-qualification-switch-changed');
  const first=item('documents-prior-draft'),mixed=item('documents-new-page-ready'),reloaded=item('documents-old-page-reloaded');
  need(first.draftRetained===true&&same(first.documents,[old])&&item('motion-prior-first').reduced===true
    &&mixed.distinctPages===true&&mixed.draftRetained===true&&same(mixed.documents,[old,next])&&same(mixed.reducedMotion,[false,false])
    &&reloaded.distinctPages===true&&reloaded.draftRetained===true&&same(reloaded.documents,[next,next])&&same(reloaded.reducedMotion,[false,false])
    &&first.atMs<=switched.atMs&&switched.atMs<=targetReady.atMs&&targetReady.atMs<=mixed.atMs&&mixed.atMs<=reloaded.atMs,
    'browser-qualification-document-transition-changed');
  for(const name of ['one-prior-document-and-unsent-draft','old-document-retained','old-client-fence','new-document-identity',
    'retained-draft-after-refresh','ui-behavior','owned-draft-cleaned'])
    need(done.checks.includes(name)&&item('check-'+name).name===name,'browser-qualification-check-missing');
  for(const milestone of ['prior-draft-ready','new-page-ready','old-page-reloaded','browser-closed'])
    verifyRemoteBrowserMemory(item('memory-'+milestone),id,milestone);
  return {kind:retainedWindowPolicy,priorCandidateId:old.candidateId,targetCandidateId:next.candidateId,
    qualification:{reviewSha256:ref.sha256,planSha256:review.plan.sha256,terminalSha256:review.terminal.sha256}};
}
