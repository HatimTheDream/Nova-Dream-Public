/** Read-only collection of exact-candidate, settled same-runtime qualification.
 * Configured receipts select original evidence; only the fixed collector derives
 * a proof. Collection is neither a new qualification nor production admission. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {frontendRegular} from './frontend-contract.mjs';
import {releaseTransportSchema,runInstallTransport} from './release-adapters.mjs';
import {applicationDependencyDescriptionSchema,applicationTransitionSchema} from './release-delivery-qualified-dependencies.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/);
const hostPath=z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).refine(p=>!p.split('/').some(x=>x==='.'||x==='..'));
const hostRef=z.object({path:hostPath,sha256:hash}).strict();
export const startupQualificationOptionsSchema=z.object({format:z.literal(1),parent:hostRef,producer:hostRef}).strict();
// Reviewed producer bytes identify the only accepted evidence implementation.
// Source review alone never replaces its actual settled qualification result.
export const QUALIFIED_STARTUP_SOURCES=Object.freeze({
  'qualified-startup.py':'3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af',
  'qualified-parent.py':'9ed15c8a2f6899376a2dbe577a4b559fc03c62e0e780332d01ba68c3d7d731b2',
  'produce-startup-inputs.py':'8538ccf1be387997037dde375a06d564871ef5200884449ebcbd2edad33a72ec',
  'contracts.py':'68b6f47f8a5a321f3415a043b152bc99114c56dcea515eae0c54e58be1d35642',
});
export const STARTUP_SCENARIOS=Object.freeze(['target-first-start','target-restart','pristine-prior-restoration']);
export const STARTUP_BARRIER_FILES=Object.freeze(['gateway.js','http.js','runtime.js','software-updates.js','store.js','update-maintenance.js','update-native-idle.js','update-native-startup.js'].map(n=>'dist/service/apps/service/'+n));
const HELPERS=['install.py','recovery.py','operator_rehearsal.py','app_dependencies.py','codex_log_retention.py','workspace_key.py','verify-session-bindings.mjs'];
export const APPLICATION_TRANSITION_HELPERS=Object.freeze(['hosted_retained_configuration.py','local-retained-configuration.mjs','hosted_retained_catalog.py','hosted-retained-catalog.mjs']);
export function startupHelperNames(transition=null){if(transition!==null)applicationTransitionSchema.parse(transition);return [...HELPERS,...(transition?APPLICATION_TRANSITION_HELPERS:[])];}
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const encoded=v=>Buffer.from(canonical(v)+'\n');
const digestMap=z.record(z.string().min(1).max(512),hash);
export {applicationTransitionSchema};
/** This describes the only supported schema change; it grants no qualification.
 * The caller must still authenticate the complete original startup projection. */
export function assertStartupApplicationTransition(binding,prior,target){
  need(prior.apiVersion===1&&target.apiVersion===1,'actual-startup-schema-or-api-unsupported');
  if(prior.schemaVersion===target.schemaVersion&&[55,60].includes(prior.schemaVersion)){
    need(!Object.hasOwn(binding,'applicationTransition'),'unexpected-startup-application-transition');return null;
  }
  need(prior.schemaVersion===55&&target.schemaVersion===60,'actual-startup-schema-transition-unsupported');
  return applicationTransitionSchema.parse(binding.applicationTransition);
}
const targetSchema=z.object({candidateId:hash,version:z.string(),buildVersion:z.string(),archiveSha256:hash,
  archiveBytes:z.number().int().positive(),ciSourceSha256:hash,packageSha256:hash,packageLockSha256:hash,candidateManifestSha256:hash}).strict();
export const startupQualificationBindingSchema=z.object({format:z.literal(1),kind:z.literal('same-runtime-startup-candidate-binding'),
  sourceCommits:z.object({private:commit,public:commit}).strict(),prior:z.object({candidateId:hash,version:z.string()}).strict(),
  targets:z.object({private:targetSchema,public:targetSchema}).strict(),serviceArtifacts:digestMap,
  hostEntrypointSha256:hash,dependencyGraphSha256:hash,helpers:digestMap,runtime:z.record(z.string(),z.unknown()),workspaceEpoch:z.uuid(),
  applicationTransition:applicationTransitionSchema.optional(),applicationDependencies:applicationDependencyDescriptionSchema.optional(),
}).strict();
function sourcesReviewed(sources){
  need(same(Object.keys(sources).sort(),Object.keys(QUALIFIED_STARTUP_SOURCES).sort())
    &&Object.values(sources).every(v=>hash.safeParse(v).success&&v!=='0'.repeat(64)),'reviewed-startup-producer-required');
}
export function startupRetainedRequest(options,sources=QUALIFIED_STARTUP_SOURCES){
  const v=startupQualificationOptionsSchema.parse(options);sourcesReviewed(sources);
  need(v.producer.sha256===sources['qualified-startup.py']&&v.producer.path.endsWith('/qualified-startup.py')
    &&v.parent.path.endsWith('/evidence/parent-verified.json'),'reviewed-startup-producer-required');
  return{format:1,kind:'collect-actual-retained-startup-proof',parent:v.parent,producer:v.producer};
}
export function buildStartupRetainedProgram(request){
  startupRetainedRequest({format:1,parent:request.parent,producer:request.producer});
  const source=readFileSync(new URL('./release-startup-retained-proof.py',import.meta.url));
  const payload=encoded({source:source.toString('base64'),sha256:sha256(source),request,sources:QUALIFIED_STARTUP_SOURCES}).toString('base64');
  return `import base64,hashlib,json,signal,resource\nv=json.loads(base64.b64decode('${payload}',validate=True));s=base64.b64decode(v['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\nresource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));signal.alarm(110)\nn={'__name__':'fixed_startup_retained_consumer'};exec(compile(s,'fixed-startup-retained-consumer','exec'),n)\nprint(json.dumps({'ok':True,'value':n['invoke'](v['request'],v['sources'])},separators=(',',':')))\n`;
}
/** Validate every persisted projection again; never trust its passed flags alone. */
export function verifyStartupRetainedProjection(v,request,sources=QUALIFIED_STARTUP_SOURCES){
  sourcesReviewed(sources);
  need(v?.format===1&&v.kind==='actual-retained-startup-qualification-observation'&&v.readOnly===true&&v.hostEffects===false
    &&same(v.request,request)&&v.requestSha256===sha256(encoded(request))&&same(v.sourceHashes,sources)
    &&v.scope==='retained-same-runtime-startup-restart-restoration'&&v.actualSettledQualification===true
    &&v.independentOriginalRestored===true&&v.completeMaintainedSavedAndNativeState===true&&v.heldBootstrapVerified===true
    &&v.workerClosed===true
    &&v.productionAdmission===false&&v.freshFullRehearsalStillRequired===true&&v.liveAcceptanceStillRequired===true,
    'actual-startup-retained-projection-required');
  z.uuid().parse(v.qualificationOperationId);
  need(Number.isSafeInteger(v.workerIdentity?.pid)&&v.workerIdentity.pid>1&&Number.isSafeInteger(v.workerIdentity.startTicks)&&v.workerIdentity.startTicks>0
    &&v.workerIdentity.controlGroup==='/system.slice/nova-qa-qualified-'+v.qualificationOperationId+'.service','startup-proof-original-worker-identity-required');
  const binding=startupQualificationBindingSchema.parse(v.qualificationBinding);
  need(binding.prior.candidateId!==binding.targets.private.candidateId&&binding.runtime.agentVersion==='2026.9.8'
    &&same(Object.keys(binding.helpers).sort(),startupHelperNames(binding.applicationTransition??null).sort())
    &&Object.keys(binding.serviceArtifacts).length<=1000
    &&Object.keys(binding.serviceArtifacts).every(p=>/^dist\/service\/[a-zA-Z0-9_./-]+$/.test(p)&&!p.split('/').some(v=>['','.','..'].includes(v)))
    &&binding.serviceArtifacts['dist/service/apps/service/main.js']
    &&STARTUP_BARRIER_FILES.every(p=>binding.serviceArtifacts[p]),'startup-qualified-artifact-closure-required');
  if(binding.applicationDependencies)need(binding.applicationTransition&&binding.applicationDependencies.dependencyGraphSha256===binding.dependencyGraphSha256
    &&Object.values(binding.targets).every(t=>t.packageLockSha256===binding.applicationDependencies.packageLockSha256),'startup-qualified-dependencies-changed');
  need(Array.isArray(v.scenarios)&&same(v.scenarios.map(x=>x.scenario),STARTUP_SCENARIOS)
    &&v.scenarios.every(x=>x.candidateId===(x.scenario==='pristine-prior-restoration'?binding.prior.candidateId:binding.targets.private.candidateId)
      &&Number.isSafeInteger(x.startedAtSeconds)&&Number.isSafeInteger(x.closedAtSeconds)&&x.closedAtSeconds>=x.startedAtSeconds
      &&x.closedAtSeconds-x.startedAtSeconds<=3600),'startup-retained-scenarios-incomplete');
  if(sources['qualified-startup.py']==='3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af'){
    const ack=z.object({ordinaryAcknowledgements:z.number().int().min(0).max(1_000_000),
      authenticatedStartSeconds:z.number().int().positive(),retentionDays:z.literal(30)}).strict();
    const original=z.object({mode:z.enum(['unchanged-original-record','same-filesystem-original-equality']),changedFields:z.tuple([])}).strict();
    const relocated=z.object({mode:z.literal('proved-independent-filesystems'),changedFields:z.tuple([z.literal('dev')]),
      configurationHashes:z.tuple([hash,hash]),configurationBytes:z.tuple([z.number().int().positive().max(4*1024*1024),z.number().int().positive().max(4*1024*1024)]),
      observationWriterHashes:z.object({'io.factory-DBfPTl1R.mjs':z.literal('c0cb4b39847898580ac68ca0154498838bf32f028cd4ccfbfbd894e373e50056'),
        'io.warnings-AdNkx0te.mjs':z.literal('836fb6dcdfb3057f581d91e74d791e1c310188dca20815814c12e89d5ec20ab0')}).strict()}).strict();
    const receipt=z.object({kind:z.literal('closed-selected-replica-config-observation'),sourceDevice:z.number().int().nonnegative(),
      replicaDevice:z.number().int().nonnegative(),queueExpiry:ack,observations:z.tuple([z.union([original,relocated])])}).strict();
    for(const [i,scenario] of v.scenarios.entries()){
      const proof=receipt.parse(scenario.replicaConfigObservation),mode=proof.observations[0].mode;
      need(proof.queueExpiry.authenticatedStartSeconds===v.scenarios[i===1?0:i].startedAtSeconds
        &&(mode!=='proved-independent-filesystems'||proof.sourceDevice!==proof.replicaDevice)
        &&(mode!=='same-filesystem-original-equality'||proof.sourceDevice===proof.replicaDevice),'original-replica-evidence-required');
    }
  }
  const required=['producer','parent',...Object.keys(sources).map(k=>'source/'+k),'review','originalPlan','executionIntent',
    'technicalReview','originalIntention','childResult','outsideClosure','restorationIntent','restorationCompleted','effectiveProfile','negativeVerifierSource','negativeVerifierResult',
    ...['result','closure','input','plan','intent','sourceCapture','sourceBefore','sourceAfter','sourcePhysical','sourceMetadata','seedInventory','seedPhysical','seedMetadata','liveContext','effectiveUnit'].map(role=>'homeCapture/'+role),
    ...STARTUP_SCENARIOS.flatMap(x=>['started','process','ready','closed','preservation','bootstrap','clock-attribution'].map(y=>x+'/'+y))];
  need(v.references&&required.every(k=>hostRef.safeParse({path:v.references[k]?.path,sha256:v.references[k]?.sha256}).success
    &&Number.isSafeInteger(v.references[k]?.bytes)&&v.references[k].bytes>=0),'startup-retained-original-references-incomplete');
  need(v.references.parent.path===request.parent.path&&v.references.parent.sha256===request.parent.sha256
    &&v.references.producer.path===request.producer.path&&v.references.producer.sha256===request.producer.sha256
    &&Object.entries(sources).every(([name,digest])=>v.references['source/'+name].sha256===digest),
    'startup-retained-original-request-changed');
  return v;
}
/** This is the sole new exception to byte-identical prior startup files. It
 * requires the actual candidate, including files outside the eight-file barrier. */
export function assertStartupQualifiedCandidate(proof,{operation,prior,candidates,artifacts,helpers,dependencyGraphSha256,applicationDependencies=null},sources=QUALIFIED_STARTUP_SOURCES){
  verifyStartupRetainedProjection(proof,proof.request,sources);
  const b=proof.qualificationBinding;
  need(operation.agentVersion==='2026.9.8'&&operation.priorAgentVersion==='2026.9.8'
    &&operation.priorCandidateId===prior.id&&b.prior.candidateId===prior.id&&b.prior.version===prior.manifest.version
    &&operation.workspaceEpoch===b.workspaceEpoch&&same(operation.sourceCommits,b.sourceCommits)
    &&b.dependencyGraphSha256===dependencyGraphSha256,'actual-startup-prior-runtime-or-source-changed');
  if(b.applicationDependencies)need(same(b.applicationDependencies,applicationDependencies),'actual-startup-dependency-archive-changed');
  need(Object.entries(helpers).every(([name,digest])=>b.helpers[name]===digest),'actual-startup-helper-changed');
  for(const side of ['private','public']){
    const candidate=candidates[side],artifact=artifacts[side],qualified=b.targets[side];
    assertStartupApplicationTransition(b,prior.manifest,candidate.manifest);
    need(b.applicationTransition||candidate.manifest.schemaVersion===55,'actual-startup-same-schema60-producer-unavailable');
    need(candidate.id===qualified.candidateId&&candidate.manifest.version===operation.version
      &&candidate.manifest.version===qualified.version&&candidate.manifest.buildVersion===operation.buildVersion
      &&candidate.manifest.buildVersion===qualified.buildVersion,
      'actual-startup-target-candidate-changed');
    const compiled=Object.fromEntries([...candidate.bytes].filter(([p])=>p.startsWith('dist/service/')).map(([p,bytes])=>[p,sha256(bytes)]));
    need(same(compiled,b.serviceArtifacts)&&sha256(candidate.bytes.get('package.json'))===qualified.packageSha256
      &&sha256(frontendRegular(join(artifact.applicationDirectory,'dist/candidate.json'),2*1024**2))===qualified.candidateManifestSha256,'actual-startup-target-service-changed');
    const archive=readEvidenceFile(artifact.archive,{maximum:128*1024**2});
    need(artifact.archive.sha256===qualified.archiveSha256&&archive.length===qualified.archiveBytes
      &&artifact.ciSourceReceipt.sha256===qualified.ciSourceSha256
      &&sha256(frontendRegular(join(artifact.applicationDirectory,'package-lock.json'),8*1024**2))===qualified.packageLockSha256,
      'actual-startup-target-artifact-changed');
    const host=artifact.sourceHashes?.['scripts/host.mjs'];
    need(host?.sha256===b.hostEntrypointSha256
      &&sha256(frontendRegular(join(artifact.frozenSourceDirectory,'scripts/host.mjs'),2*1024**2))===host.sha256,
      'actual-startup-host-entrypoint-changed');
  }
  return proof;
}
export function createStartupRetainedCollector({transport,options,run=runInstallTransport,clock=Date.now}){
  const request=startupRetainedRequest(options);
  return async()=>{
    const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));
    readEvidenceFile(target.sshConfig,{maximum:65536});
    const before=clock(),raw=await run(target,buildStartupRetainedProgram(request),{captureDiagnostics:true});
    need(raw?.uncertain!==true&&raw?.exitCode===0&&typeof raw.stdout==='string'&&Buffer.byteLength(raw.stdout)<=512*1024,
      'actual-startup-proof-observation-unavailable');
    const parsed=JSON.parse(raw.stdout);need(parsed.ok===true,'actual-startup-proof-observation-failed');
    const proof=verifyStartupRetainedProjection(parsed.value,request),after=clock();
    need(Number.isSafeInteger(proof.observedAtMilliseconds)&&proof.observedAtMilliseconds>=before-30000
      &&proof.observedAtMilliseconds<=after+30000,'actual-startup-proof-observation-time-changed');
    const{observedAtMilliseconds,...stable}=proof;return stable;
  };
}
