/** Default private storage route. This guards CLI dispatch, not library imports.
 * The reviewed private runner owns storage work and the original release request;
 * this module only verifies its exact local session before opening a journal. */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { readEvidenceFile, readReleaseInputFile, sha256 } from './release-plan.mjs';

const need = (value, code) => { if (!value) throw Error(code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const MAX_JSON = 2 * 1024 ** 2;
const encoded = value => Buffer.from(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) + '\n');
function absolute(path) {
  need(typeof path === 'string' && path.length <= 4096 && isAbsolute(path) && !path.includes('\0'), 'storage-absolute-path-required');
  return resolve(path);
}
function canonical(path) {
  const resolved = absolute(path);
  need(resolve(realpathSync(resolved)) === resolved, 'storage-canonical-path-required');
  return resolved;
}
function reference(value) {
  need(value && typeof value === 'object' && Object.keys(value).length === 2 && hash(value.sha256), 'storage-reference-required');
  absolute(value.path); return value;
}
function document(ref, maximum = MAX_JSON) {
  reference(ref); return JSON.parse(readEvidenceFile(ref, { maximum }));
}
function inputReference(path) {
  const resolved = canonical(path), bytes = readReleaseInputFile(resolved);
  return { path: resolved, sha256: sha256(bytes) };
}
function contained(root, path) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith('..\\') && !child.startsWith('../') && !isAbsolute(child);
}
function reviewed(ref, kind) {
  const review = document(ref);
  need(review.format === 1 && review.kind === kind && review.status === 'passed' && review.independentReview === true,
    'storage-independent-source-review-required');
  need(review.files && !Array.isArray(review.files) && typeof review.files === 'object' && Object.keys(review.files).length >= 1
    && Object.keys(review.files).length <= 512, 'storage-reviewed-files-required');
  for (const [path, digest] of Object.entries(review.files)) {
    reference({ path, sha256: digest }); readEvidenceFile({ path, sha256: digest }, { maximum: 128 * 1024 ** 2 });
  }
  return review;
}
function reviewedFile(review, ref) {
  reference(ref);
  need(Object.entries(review.files).some(([path, digest]) => absolute(path) === absolute(ref.path) && digest === ref.sha256),
    'storage-runner-source-not-reviewed');
}
export function storageDefaultConfiguration({ env = process.env } = {}) {
  const path = env.NOVA_RELEASE_STORAGE_CONFIG ?? join(homedir(), '.codex', 'nova-release', 'storage-default.json');
  absolute(path); need(existsSync(path), 'storage-default-configuration-required');
  const ref = inputReference(path), config = document(ref);
  need(config.format === 1 && config.kind === 'nova-storage-default', 'storage-default-configuration-required');
  for (const role of ['python', 'runner', 'sourceReview', 'storageReview']) reference(config[role]);
  readEvidenceFile(config.python, { maximum: 128 * 1024 ** 2 });
  const sourceReview = reviewed(config.sourceReview, 'nova-storage-default-source-review');
  reviewedFile(sourceReview, config.runner);
  reviewedFile(sourceReview, inputReference(join(dirname(config.runner.path), 'default_identity.mjs')));
  reviewed(config.storageReview, 'independent-storage-source-review');
  canonical(config.operationsRoot);
  need(Array.isArray(config.applicationRoots) && config.applicationRoots.length === 2
    && new Set(config.applicationRoots.map(canonical)).size === 2, 'storage-application-roots-required');
  for (const root of config.applicationRoots) {
    need(!contained(canonical(root), canonical(config.operationsRoot)) && canonical(root) !== canonical(config.operationsRoot)
      && !contained(canonical(config.operationsRoot), canonical(root)), 'storage-operations-overlap-source');
    for (const name of ['release-deliver.mjs', 'release-coordinate.mjs', 'release-storage-default.mjs', 'release-delivery-adapters.mjs'])
      reviewedFile(sourceReview, inputReference(join(root, 'scripts', name)));
  }
  return { ref, config, sourceReview };
}

function verifyCapacityProof(checked, storageInput, budget) {
  let proof = document(checked.result);
  if (checked.cleanupPerformed === true) {
    const { result: _reference, ...retained } = checked;
    need(same(proof, retained) && proof.kind === 'private-storage-maintenance-result'
      && proof.protectedRolesVerified === true && proof.cleanupPerformed === true, 'storage-cleanup-result-changed');
    const cleanup = document(proof.cleanup);
    need(cleanup.cleanupComplete === true && cleanup.protectedRolesVerified === true && cleanup.originalWorkerClosed === true,
      'storage-cleanup-worker-not-closed');
    proof = document(proof.finalPreflight);
  } else need(checked.cleanupPerformed === false, 'storage-cleanup-disposition-required');
  const assessment = proof.assessment;
  need(proof.format === 1 && proof.kind === 'private-storage-preflight' && proof.state === 'ready'
    && proof.phase === storageInput.phase && storageInput.phase === 'before-allocation'
    && proof.originalDeadline === storageInput.originalDeadline && assessment?.format === 1
    && assessment.kind === 'storage-lifecycle-budget-result' && assessment.phase === storageInput.phase
    && assessment.fits === true && assessment.allocationBudgetAdmissionOnly === true
    && assessment.releaseAdmission === false && assessment.stoppedAndPostStartChecksStillRequired === true
    && assessment.observationExpiresAtMilliseconds === checked.observationExpiresAtMilliseconds,
  'storage-capacity-proof-changed');
  const inventory = document(proof.inventory), rows = assessment.filesystems;
  need(same(inventory.sourceEvidence?.profile, storageInput.profile) && same(inventory.sourceEvidence?.configuration, storageInput.configuration)
    && inventory.readOnly === true && inventory.observedAtMilliseconds + 120000 === assessment.observationExpiresAtMilliseconds,
  'storage-capacity-inventory-context-changed');
  need(Array.isArray(rows) && rows.length > 0 && rows.length <= 64 && rows.every(row => Number.isSafeInteger(row.availableBytes)
    && Number.isSafeInteger(row.requiredFreeBytes) && row.requiredFreeBytes >= 0 && row.availableBytes >= row.requiredFreeBytes
    && row.deficitBytes === 0 && Array.isArray(row.allocations)), 'storage-capacity-shortfall');
  const order = values => [...values].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  need(Array.isArray(budget.allocations) && same(order(rows.flatMap(row => row.allocations)), order(budget.allocations)),
    'storage-capacity-allocation-budget-changed');
}

/** Stable evidence is required even on resume; only the old capacity admission's
 * age may be retained. The maintained producers refresh their effect-time checks. */
export function continuationSessionAuthorityMatches(saved,current,admission,sessionRef,dispatchRef){
  if(!saved||!current)return false;
  if(same(saved,current))return true;
  return Boolean(admission&&saved?.continuationStarted===false&&current?.continuationStarted===true
    &&admission.grantSha256===current.grantSha256&&same(admission.session,sessionRef)&&same(admission.dispatch,dispatchRef)
    &&same(saved,{...current,continuationStarted:false}));
}

export async function verifyStorageSession(args, entry, { env = process.env, clock = Date.now, now = clock(), executable = process.execPath } = {}) {
  need(typeof env.NOVA_RELEASE_STORAGE_SESSION === 'string' && env.NOVA_RELEASE_STORAGE_SESSION.length > 0,
    'storage-session-required-use-release-deliver');
  const loaded = storageDefaultConfiguration({ env }), { config } = loaded;
  need(config.postinstallBrowserRecovery!==true,'storage-postinstall-ordinary-dispatch-forbidden');
  const sessionRef = inputReference(env.NOVA_RELEASE_STORAGE_SESSION), session = document(sessionRef);
  need(session.format === 1 && session.kind === 'nova-storage-default-session' && uuid(session.operationId)
    && ['start', 'resume'].includes(session.mode) && session.mode === args[0], 'storage-session-shape-invalid');
  need(same(session.config, loaded.ref) && same(session.sourceReview, config.sourceReview) && same(session.storageReview, config.storageReview),
    'storage-session-configuration-changed');
  need(Number.isSafeInteger(session.issuedAtMilliseconds) && session.issuedAtMilliseconds <= now + 5000
    && now - session.issuedAtMilliseconds <= 300000, 'storage-session-expired');
  const root = join(canonical(config.operationsRoot), 'release-' + session.operationId);
  const match = /^session-(observation-\d{4,})\.json$/.exec(relative(root, sessionRef.path));
  need(match, 'storage-session-location-invalid');
  for (const [role, path] of Object.entries({ request: join(root, 'request.json'), dispatch: join(root, 'release-dispatch.json'),
    observationIntent: join(root, 'observations', match[1], 'intent.json'), sourceGraph: join(root, 'source-graph-' + match[1] + '.json') })) {
    reference(session[role]); need(absolute(session[role].path) === path, 'storage-session-reference-location-changed');
  }
  const request = document(session.request), dispatch = document(session.dispatch), intent = document(session.observationIntent);
  const initialization = document(session.initialization), descriptor = document(session.descriptor), graph = document(session.sourceGraph);
  const start = document(request.releaseInput), profile = document(start.profile), target = document(profile.target);
  let continuation=null,originalConfig=config,preJournalProof=null,publicationContinuation=false,publicationAdmission=null;
  if(config.operatorContinuation){
    const c=config.operatorContinuation;
    need((session.mode==='resume'||session.mode==='start'&&c.preJournalProof)&&c.operationId===session.operationId&&same(c.originalRequest,session.request)
      &&absolute(c.journalDirectory)===absolute(initialization.journalDirectory),'storage-continuation-original-context-changed');
    originalConfig=document(c.originalConfig);
    const {ReleaseJournal}=await import('./release-coordinate.mjs');
    const {verifyContinuationStorageAuthority,verifyPreJournalStorageAuthority}=await import('./release-delivery-continuation.mjs');
    if(session.mode==='start'&&c.preJournalProof){
      preJournalProof=reference(c.preJournalProof);
      continuation=await verifyPreJournalStorageAuthority({proofReference:preJournalProof,entry,operationId:session.operationId,journalDirectory:initialization.journalDirectory,now});
    }else{
      const journal=new ReleaseJournal(c.journalDirectory,{create:false,readOnly:true});
      try{
        continuation=await verifyContinuationStorageAuthority({journal,operationId:session.operationId,entry,now});
        publicationContinuation=journal.deliveryOperatorContinuation(session.operationId)?.proof.kind==='nova-expired-publication-continuation';
        if(publicationContinuation)publicationAdmission=journal.deliveryPublicationContinuationAdmission(session.operationId)?.admission??null;
      }finally{journal.close();}
    }
    const {normalizedDeliveryDescriptor}=await import('./release-delivery-journal.mjs');
    const original=preJournalProof?descriptor:normalizedDeliveryDescriptor(descriptor,session.descriptor.path);
    need(continuationSessionAuthorityMatches(session.operatorContinuation,continuation,publicationAdmission,sessionRef,session.continuationDispatch)&&continuation.descriptorSha256===sha256(encoded(original).subarray(0,-1)),'storage-continuation-authority-changed');
  }else need(session.operatorContinuation===undefined&&session.continuationDispatch===undefined,'storage-unconfigured-continuation');
  need(request.format === 1 && request.operationId === session.operationId && start.operationId === session.operationId
    && same(request.independentSourceReview, originalConfig.storageReview), 'storage-original-request-changed');
  need(dispatch.format === 1 && same(dispatch.request, session.request) && dispatch.automaticNewOperationPermitted === false
    && same(intent.request, session.request) && intent.sameReleaseOperation === true, 'storage-original-dispatch-changed');
  const storageInput = document(dispatch.storageInput), budget = document(request.storageBudget);
  need(same(storageInput.profile, start.profile) && same(storageInput.budget, request.storageBudget), 'storage-budget-context-changed');
  need(dispatch.storageResult?.state === 'ready' && dispatch.storageResult.historical !== true
    && Number.isSafeInteger(dispatch.startedAtMilliseconds) && Number.isSafeInteger(dispatch.storageResult.observationExpiresAtMilliseconds)
    && dispatch.startedAtMilliseconds <= dispatch.storageResult.observationExpiresAtMilliseconds,
  'storage-original-admission-required');
  verifyCapacityProof(dispatch.storageResult, storageInput, budget);
  let continuedDispatch=null;
  if(continuation){
    const historicalGrant=continuation.browserWindowRecovery?.predecessorGrantSha256??continuation.grantSha256;
    if(continuation.browserWindowRecovery)need(same(session.continuationDispatch,continuation.browserWindowRecovery.storageAdmission.dispatch)&&same(publicationAdmission?.dispatch,session.continuationDispatch)&&publicationAdmission?.grantSha256===historicalGrant,'browser-window-storage-historical-dispatch-required');
    const r=reference(session.continuationDispatch),c=document(r),base=join(root,'continuations',historicalGrant);
    need(/^admission-[0-9]{4,}[\\/]release-dispatch\.json$/.test(relative(base,r.path))&&same(c.originalDispatch,session.dispatch)
      &&c.grantSha256===historicalGrant&&same(c.request,session.request)&&c.format===1&&c.automaticNewOperationPermitted===false,'storage-continuation-dispatch-changed');
    const currentInput=document(c.storageInput);
    need(same(currentInput.profile,start.profile)&&same(currentInput.budget,request.storageBudget),'storage-continuation-budget-context-changed');
    need(c.storageResult?.state==='ready'&&c.storageResult.historical!==true&&Number.isSafeInteger(c.startedAtMilliseconds)
      &&c.startedAtMilliseconds<=c.storageResult.observationExpiresAtMilliseconds,'storage-continuation-original-admission-required');
    verifyCapacityProof(c.storageResult,currentInput,budget);continuedDispatch=c;
    if(!continuation.continuationStarted)need(continuation.newEffectsAllowed&&now<=c.storageResult.observationExpiresAtMilliseconds,'storage-continuation-first-admission-expired');
  }
  if (session.mode === 'start'&&!preJournalProof) need(now <= dispatch.storageResult.observationExpiresAtMilliseconds
    && dispatch.startedAtMilliseconds <= now + 5000, 'fresh-storage-required-before-start');
  const initDirectory = join(absolute(start.outputRoot), 'request-' + session.operationId);
  need(absolute(session.initialization.path) === join(initDirectory, 'initialization.json')
    && initialization.format === 1 && initialization.kind === 'nova-delivery-initialization'
    && same(initialization.input, start) && same(initialization.profile, start.profile)
    && initialization.inputSha256 === sha256(encoded(start)) && absolute(initialization.directory) === initDirectory
    && absolute(initialization.journalDirectory) === join(absolute(start.outputRoot), 'journal-' + session.operationId)
    && same(initialization.descriptor.reference, session.descriptor) && same(initialization.descriptor.value, descriptor)
    && absolute(session.descriptor.path) === join(initDirectory, 'descriptor.json'), 'storage-original-initialization-changed');
  need(descriptor.operation?.id === session.operationId && same(descriptor.operation.sourceCommits, start.sourceCommits)
    && same(descriptor.timeline, start.timeline) && descriptor.observationBudgetMs === start.observationBudgetMs
    && same(descriptor.target, initialization.target.reference) && same(document(descriptor.target), initialization.target.value),
  'storage-original-descriptor-changed');
  const privateRoot = canonical(join(profile.sources.private.root, 'edition3'));
  const publicRoot = canonical(profile.sources.public.root), actualEntry = canonical(entry);
  const operatorRoots=continuation?continuation.operatorRoots.map(canonical):[privateRoot,publicRoot];
  need(same(config.applicationRoots.map(canonical),operatorRoots)&&actualEntry===join(operatorRoots[0],'scripts/release-deliver.mjs')
    &&absolute(request.deliveryEntry.path)===join(privateRoot,'scripts/release-deliver.mjs'),'storage-current-delivery-entry-changed');
  if(continuation)need(same(originalConfig.applicationRoots.map(canonical),[privateRoot,publicRoot]),'storage-original-candidate-roots-changed');
  readEvidenceFile(request.deliveryEntry); readEvidenceFile(request.node, { maximum: 128 * 1024 ** 2 });
  need(same(request.node, target.artifactTools.node) && canonical(request.node.path) === canonical(executable), 'storage-node-identity-changed');
  const expectedArgs = session.mode === 'start'
    ? ['start', initialization.journalDirectory, session.descriptor.path]
    : ['resume', initialization.journalDirectory, session.operationId];
  need(same(args, expectedArgs) && same(session.argv, intent.argv) && same(session.argv, [request.node.path, actualEntry, ...args]),
    'storage-session-argv-changed');
  const { deliveryAdapterIdentity, deliveryAdapterSourceFiles } = await import('./release-delivery-adapters.mjs');
  const adapterIdentity = deliveryAdapterIdentity();
  const originalAdapter=continuation?continuation.originalAdapterIdentity:adapterIdentity;
  need(hash(session.adapterIdentity) && session.adapterIdentity === adapterIdentity && descriptor.adapterIdentity === originalAdapter
    && initialization.adapterIdentity === originalAdapter && graph.format === 1 && graph.adapterIdentity === adapterIdentity,
  'storage-adapter-identity-changed');
  const expectedGraph = deliveryAdapterSourceFiles().map(name => inputReference(fileURLToPath(new URL(name, import.meta.url))));
  need(Array.isArray(graph.sourceFiles) && graph.sourceFiles.length === expectedGraph.length
    && graph.sourceFiles.every((ref, index) => absolute(reference(ref).path) === expectedGraph[index].path && ref.sha256 === expectedGraph[index].sha256),
  'storage-source-graph-changed');
  // A retained first-start capability cannot open a new journal or replay effects.
  if (session.mode === 'start'&&!preJournalProof) need(!existsSync(initialization.journalDirectory), 'storage-start-already-dispatched-use-resume');
  else need(existsSync(initialization.journalDirectory), 'storage-original-journal-unavailable');
  // Source verification takes real time. Recheck immediately before returning
  // the permit to the CLI's journal-open boundary, never using its entry clock.
  const finishedAt = clock();
  need(Number.isSafeInteger(finishedAt) && session.issuedAtMilliseconds <= finishedAt + 5000
    && finishedAt - session.issuedAtMilliseconds <= 300000, 'storage-session-expired');
  if (session.mode === 'start'&&!preJournalProof) need(finishedAt <= dispatch.storageResult.observationExpiresAtMilliseconds
    && dispatch.startedAtMilliseconds <= finishedAt + 5000, 'fresh-storage-required-before-start');
  if(continuation&&!continuation.continuationStarted)need(finishedAt<continuation.expiresAtMs&&finishedAt<=continuedDispatch.storageResult.observationExpiresAtMilliseconds,'storage-continuation-first-admission-expired');
  if(continuation?.browserWindowRecovery)need(continuation.newEffectsAllowed&&finishedAt<continuation.expiresAtMs,'continuation-window-expired');
  if(publicationContinuation&&!publicationAdmission){
    const {ReleaseJournal}=await import('./release-coordinate.mjs'),journal=new ReleaseJournal(initialization.journalDirectory,{create:false});
    try{const at=clock();journal.recordPublicationContinuationAdmission(session.operationId,{format:1,kind:'nova-publication-continuation-storage-admission',
      operationId:session.operationId,grantSha256:continuation.grantSha256,dispatch:reference(session.continuationDispatch),session:sessionRef,verifiedAtMs:at},at);}
    finally{journal.close();}
  }
  return { operationId: session.operationId, journalDirectory: initialization.journalDirectory, descriptor: session.descriptor,
    ...(preJournalProof?{preJournalProof}:{} ) };
}


/** Fresh capacity is a separate read-only observation; it never replaces admission. */
export function verifyBrowserWindowRecoveryStorageReadiness(raw,{journal,operationId,requestRef,request,operator,now=Date.now()}={}){
 const r=reference(raw),v=document(r),config=document(v.config),original=document(request.owner.request),input=document(v.capacity?.input),result=document(v.capacity?.result),graph=document(v.sourceGraph);
 need(v.format===1&&v.kind==='nova-browser-window-recovery-storage-readiness'&&v.operationId===operationId&&request.operationId===operationId
  &&same(v.reconciliationRequest,requestRef)&&same(v.predecessor,request.browserWindowRecovery)&&v.readOnly===true&&v.storageAdmissionCreated===false,'browser-window-storage-readiness-context-changed');
 need(config.kind==='nova-storage-default'&&same(v.sourceReview,config.sourceReview)&&same(v.storageReview,config.storageReview)&&same(v.runner,config.runner)
  &&same(config.applicationRoots.map(x=>resolve(x)),[resolve(request.operatorSources.private.root,'edition3'),resolve(request.operatorSources.public.root)])
  &&same(config.operatorContinuation?.originalRequest,request.owner.request)&&config.operatorContinuation.operationId===operationId
  &&resolve(config.operatorContinuation.journalDirectory)===resolve(journal.directory),'browser-window-storage-configuration-changed');
 const review=reviewed(v.sourceReview,'nova-storage-default-source-review');reviewed(v.storageReview,'independent-storage-source-review');
 reviewedFile(review,v.entry);reviewedFile(review,v.runner);
 need(resolve(v.entry.path)===resolve(request.operatorSources.private.root,'edition3/scripts/release-deliver.mjs'),'browser-window-storage-entry-changed');
 need(graph.format===1&&hash(graph.adapterIdentity)&&Array.isArray(graph.sourceFiles)&&graph.sourceFiles.length>0&&graph.sourceFiles.length<=512,'browser-window-storage-source-graph-invalid');
 for(const item of graph.sourceFiles){reference(item);reviewedFile(review,item);readEvidenceFile(item,{maximum:128*1024**2});}
 need(operator&&graph.adapterIdentity===operator.adapterIdentity&&config.applicationRoots.some(root=>same(graph.sourceFiles.map(item=>({name:relative(join(root,'scripts'),item.path).replaceAll('\\','/'),sha256:item.sha256})),operator.sourceFiles)),'browser-window-storage-current-graph-changed');
 need(same(input.profile,document(original.releaseInput).profile)&&same(input.budget,original.storageBudget)&&input.phase==='before-allocation','browser-window-storage-budget-changed');
 need(result.cleanupPerformed!==true&&result.kind==='private-storage-preflight'&&result.state==='ready','browser-window-storage-readonly-capacity-required');
 verifyCapacityProof({result:v.capacity.result,cleanupPerformed:false,observationExpiresAtMilliseconds:result.assessment?.observationExpiresAtMilliseconds},input,document(original.storageBudget));
 const inventory=document(result.inventory),admission=journal.deliveryPublicationContinuationAdmission(operationId);
 need(admission&&same({eventId:admission.eventId,sha256:admission.sha256,session:admission.admission.session,dispatch:admission.admission.dispatch},request.browserWindowRecovery.storageAdmission)
  &&admission.admission.grantSha256===request.browserWindowRecovery.predecessorGrantSha256,'browser-window-storage-historical-admission-changed');
 need(Number.isSafeInteger(v.observedAtMs)&&Number.isSafeInteger(v.expiresAtMs)&&v.observedAtMs<=now&&now<v.expiresAtMs
  &&inventory.observedAtMilliseconds<=v.observedAtMs&&v.expiresAtMs<=Math.min(result.assessment.observationExpiresAtMilliseconds,v.observedAtMs+300000),'browser-window-storage-readiness-expired');
 return r;
}
export function configuredBrowserWindowRecoveryStorageReadiness({journal,operationId,requestRef,request,operator,now=Date.now(),env=process.env}){
 const {ref:configRef,config}=storageDefaultConfiguration({env}),sessionRef=inputReference(env.NOVA_RELEASE_STORAGE_SESSION),session=document(sessionRef);
 const root=join(canonical(config.operationsRoot),'release-'+operationId);
 need(/^reconciliations[\\/]reconciliation-[0-9]{4,}[\\/]session\.json$/.test(relative(root,sessionRef.path))
  &&session.kind==='nova-storage-publication-reconciliation-session'&&session.operationId===operationId&&same(session.config,configRef)
  &&same(session.reconciliationRequest,requestRef)&&same(session.request,request.owner.request),'browser-window-storage-configured-session-required');
 const r=verifyBrowserWindowRecoveryStorageReadiness(session.browserWindowRecoveryReadiness,{journal,operationId,requestRef,request,operator,now}),v=document(r);
 need(same(v.config,configRef)&&same(v.sourceReview,session.sourceReview)&&same(v.storageReview,session.storageReview)&&same(v.sourceGraph,session.sourceGraph),'browser-window-storage-session-readiness-changed');
 return r;
}

/** The existing private runner owns the same deployment byte lock throughout
 * this child. This permit cannot launch a delivery or bypass storage admission. */
export async function verifyReconciliationSession(args,entry,{env=process.env,clock=Date.now}={}){
  const loaded=storageDefaultConfiguration({env}),{config}=loaded,c=config.operatorContinuation;
  const mode=args[0],sessionKind={ 'reconcile-prepackage':'nova-storage-prepackage-reconciliation-session', 'reconcile-publication':'nova-storage-publication-reconciliation-session', 'plan-publication-continuation':'nova-storage-publication-reconciliation-session', 'plan-browser-recovery':'nova-storage-postinstall-browser-reconciliation-session', 'reconcile-browser-recovery':'nova-storage-postinstall-browser-reconciliation-session' }[mode];
  need(!['plan-browser-recovery','reconcile-browser-recovery'].includes(mode)||config.postinstallBrowserRecovery===true,'storage-postinstall-configuration-required');
  need(c&&sessionKind&&args.length===4&&args[2]===c.operationId&&absolute(args[1])===absolute(c.journalDirectory),'storage-reconciliation-scope-changed');
  const sr=inputReference(env.NOVA_RELEASE_STORAGE_SESSION),s=document(sr),root=join(canonical(config.operationsRoot),'release-'+c.operationId);
  need(/^reconciliations[\\/]reconciliation-[0-9]{4,}[\\/]session\.json$/.test(relative(root,sr.path)),'storage-reconciliation-session-location-changed');
  need(s.format===1&&s.kind===sessionKind&&s.mode===mode&&s.operationId===c.operationId
    &&same(s.config,loaded.ref)&&same(s.sourceReview,config.sourceReview)&&same(s.storageReview,config.storageReview)
    &&same(s.request,c.originalRequest)&&same(s.reconciliationRequest,inputReference(resolve(args[3]))),'storage-reconciliation-session-changed');
  const request=document(s.request),start=document(request.releaseInput),init=document(s.initialization),d=document(s.descriptor),graph=document(s.sourceGraph),waiting=document(s.waitingLauncher);
  need(same(init.input,start)&&same(init.descriptor.reference,s.descriptor)&&same(init.descriptor.value,d)&&init.journalDirectory===c.journalDirectory
    &&d.operation.id===c.operationId&&same(d.operation.sourceCommits,start.sourceCommits),'storage-reconciliation-original-initialization-changed');
  const actual=canonical(entry),expected=join(canonical(config.applicationRoots[0]),'scripts/release-deliver.mjs');
  need(actual===expected&&same(s.argv,[request.node.path,actual,...args])&&Number.isSafeInteger(s.runnerPid)&&s.runnerPid===process.ppid
    &&waiting.kind==='verified-waiting-release-launcher'&&waiting.mode===mode&&waiting.operationId===c.operationId
    &&waiting.worker.pid===s.runnerPid&&same(waiting.entry,inputReference(actual))&&same(waiting.config,loaded.ref),'storage-reconciliation-lock-owner-changed');
  const A=await import('./release-delivery-adapters.mjs'),expectedGraph=A.deliveryAdapterSourceFiles().map(n=>inputReference(fileURLToPath(new URL(n,import.meta.url))));
  need(s.adapterIdentity===A.deliveryAdapterIdentity()&&graph.adapterIdentity===s.adapterIdentity&&same(graph.sourceFiles,expectedGraph),'storage-reconciliation-current-graph-changed');
  const now=clock();need(Number.isSafeInteger(s.issuedAtMilliseconds)&&s.issuedAtMilliseconds<=now&&now-s.issuedAtMilliseconds<=300000,'storage-reconciliation-session-expired');
  return {operationId:c.operationId,journalDirectory:c.journalDirectory};
}

function runRunner(executable, args) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let length = 0, oversized = false;
    child.stdout.on('data', bytes => { length += bytes.length; if (length <= MAX_JSON) chunks.push(bytes); else oversized = true; });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (oversized) return reject(Error('storage-runner-response-too-large-observe-original-operation'));
      if (signal || ![0, 2].includes(code)) return reject(Error('storage-runner-stopped-observe-original-operation'));
      try { accept({ code, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(Error('storage-runner-response-unavailable-observe-original-operation')); }
    });
  });
}

export async function routeStorageDelivery(args, entry, { env = process.env, launch = runRunner } = {}) {
  if(args[0]==='plan-publication-continuation'&&args.length===4&&!document(inputReference(resolve(args[3]))).browserWindowRecovery)return {handled:false};
  const reconcile=['reconcile-prepackage','reconcile-publication','plan-publication-continuation','plan-browser-recovery','reconcile-browser-recovery'].includes(args[0]);
  if (!['start', 'resume','reconcile-prepackage','reconcile-publication','plan-publication-continuation','plan-browser-recovery','reconcile-browser-recovery'].includes(args[0])) return { handled: false };
  if (env.NOVA_RELEASE_STORAGE_SESSION !== undefined) {
    if(reconcile)await verifyReconciliationSession(args,entry,{env});
    else {const permit=await verifyStorageSession(args, entry, { env });return {handled:false,...(permit.preJournalProof?{preJournalProof:permit.preJournalProof}:{})};}
    return { handled: false };
  }
  const mode = args[0];
  need(mode === 'start' ? (args.length === 2 || (args.length === 4 && args[2] === '--storage-budget')) : reconcile?args.length===4:args.length === 3,
    'storage-required-use-release-deliver-start-input');
  const { ref, config } = storageDefaultConfiguration({ env }), actualEntry = canonical(entry);
  need(config.postinstallBrowserRecovery!==true||['plan-browser-recovery','reconcile-browser-recovery'].includes(mode),'storage-postinstall-ordinary-dispatch-forbidden');
  need(!['plan-browser-recovery','reconcile-browser-recovery'].includes(mode)||config.postinstallBrowserRecovery===true,'storage-postinstall-configuration-required');
  need(config.applicationRoots.some(root => join(canonical(root), 'scripts', 'release-deliver.mjs') === actualEntry), 'storage-entry-not-configured');
  const argv = ['-I', '-B', config.runner.path, '--config', ref.path, '--entry', actualEntry, '--mode', mode,
    '--launcher-pid', String(process.pid), '--launcher-cwd', canonical(process.cwd())];
  if (mode === 'start') {
    argv.push('--input', absolute(resolve(args[1])));
    if (args.length === 4) argv.push('--budget', absolute(resolve(args[3])));
  } else {
    need(uuid(args[2]), 'storage-original-operation-required'); argv.push('--journal', absolute(resolve(args[1])), '--operation', args[2]);
    if(reconcile)argv.push('--reconciliation-request',absolute(resolve(args[3])));
  }
  const { code, value } = await launch(config.python.path, argv);
  if (['plan-browser-recovery', 'plan-publication-continuation'].includes(mode) && code !== 0)
    throw Error(typeof value?.reason === 'string' && /^[a-z][a-z0-9-]{0,159}$/.test(value.reason) ? value.reason
      : mode === 'plan-browser-recovery' ? 'storage-postinstall-plan-result-invalid' : 'storage-browser-window-plan-result-invalid');
  if(mode==='plan-browser-recovery'){const p=document(reference(value?.plan));need(code===0&&same(p,value.value)&&p.kind==='nova-postinstall-browser-recovery-plan'&&p.operationId===args[2]&&p.readOnly===true&&p.hostEffects===false&&p.journalWrites===false,'storage-postinstall-plan-result-invalid');return {handled:true,result:value};}
  if(mode==='reconcile-browser-recovery'){
    const {postinstallCoverage}=await import('./release-delivery-postinstall-recovery.mjs');
    const coverage=postinstallCoverage(value?.release);need(same(coverage,postinstallCoverage(value))&&coverage.acceptanceScope,'storage-postinstall-result-scope-required');
    if(value.release?.successor?.profile){const p=document(value.release.successor.profile);need(same(postinstallCoverage(p.previousDelivery),coverage)&&same(postinstallCoverage(value.release.successor),coverage),'storage-postinstall-successor-scope-changed');}
  }
  if(mode==='plan-publication-continuation'){const p=document(reference(value?.plan));need(code===0&&same(p,value.value)&&p.kind==='nova-publication-continuation-plan'&&p.operationId===args[2]&&p.readOnly===true&&p.hostEffects===false&&p.journalWrites===false,'storage-browser-window-plan-result-invalid');return {handled:true,result:value};}
  need(value && typeof value === 'object' && ['complete', 'release-pending', 'acceptance-or-storage-gap', 'original-start-not-observed', 'stopped', 'continuation-granted'].includes(value.state),
    'storage-runner-result-invalid');
  const complete = value.state === 'complete' && value.release?.complete === true && value.storageCloseoutPerformed === true;
  need(code !== 0 || complete || reconcile&&value.state==='continuation-granted', 'storage-runner-incomplete-success-rejected');
  return { handled: true, result: { ...value, complete } };
}
