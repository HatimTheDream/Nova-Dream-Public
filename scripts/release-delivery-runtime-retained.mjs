/** Actual settled runtime evidence, collected through the existing read-only
 * SSH transport. A configured JSON receipt can never stand in for collection. */
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {releaseTransportSchema,runInstallTransport} from './release-adapters.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),hostPath=z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).refine(p=>!p.split('/').some(x=>x==='.'||x==='..'));
const hostRef=z.object({path:hostPath,sha256:hash}).strict();
export const retainedRuntimeOptionsSchema=z.object({format:z.literal(1),parent:hostRef,producer:hostRef}).strict();
export const QUALIFIED_RUNTIME_RUNNER='27e4da22d0dce7af436db73c05ac6e2f45117c4f31a2ebe3b49cd76e627d8660';
export const QUALIFIED_RUNTIME_MATERIALIZER='b2b702f08ee15b74c29e7924b41cb828a9530379fb031b76f4377e284bc6b17c';
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const encoded=v=>Buffer.from(canonical(v)+'\n');
const scenarios=['target-first-start','target-restart','prior-rollback'];
export function runtimeRetainedRequest(options){
 const v=retainedRuntimeOptionsSchema.parse(options);
 need(v.producer.sha256===QUALIFIED_RUNTIME_RUNNER&&v.producer.path.endsWith('/fresh-runtime-held.py')&&v.parent.path.endsWith('/evidence/parent-verified.json'),'reviewed-runtime-producer-required');
 return{format:1,kind:'collect-actual-retained-runtime-proof',parent:v.parent,producer:v.producer};
}
export function buildRuntimeRetainedProgram(request){
 runtimeRetainedRequest({format:1,parent:request.parent,producer:request.producer});
 const source=readFileSync(new URL('./release-runtime-retained-proof.py',import.meta.url));
 const payload=encoded({source:source.toString('base64'),sha256:sha256(source),request}).toString('base64');
 return `import base64,hashlib,json,signal,resource\nv=json.loads(base64.b64decode('${payload}',validate=True));s=base64.b64decode(v['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\nresource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));signal.alarm(110)\nn={'__name__':'fixed_runtime_retained_consumer'};exec(compile(s,'fixed-runtime-retained-consumer','exec'),n)\nprint(json.dumps({'ok':True,'value':n['invoke'](v['request'])},separators=(',',':')))\n`;
}
/** The projection's authority is the fixed collector, not a caller assertion.
 * This verifier also runs on every immutable persisted copy downstream. */
export function verifyRuntimeRetainedProjection(v,request){
 need(v?.format===1&&v.kind==='actual-retained-runtime-qualification-observation'&&v.readOnly===true&&v.hostEffects===false
  &&same(v.request,request)&&v.requestSha256===sha256(encoded(request))&&v.runnerSha256===QUALIFIED_RUNTIME_RUNNER
  &&v.materializerSha256===QUALIFIED_RUNTIME_MATERIALIZER&&v.fromVersion==='2026.9.6'&&v.toVersion==='2026.9.8'
  &&v.scope==='retained-96-to-98-startup-restart-restoration'&&v.actualSettledQualification===true
  &&v.independentOriginalRestored===true&&v.productionAdmission===false&&v.freshFullRehearsalStillRequired===true
  &&v.liveAcceptanceStillRequired===true,'actual-runtime-retained-projection-required');
 z.uuid().parse(v.qualificationOperationId);z.uuid().parse(v.workspaceEpoch);
 need(v.prior?.candidateId!==v.qualifiedTarget?.candidateId&&hash.safeParse(v.prior?.candidateId).success
  &&hash.safeParse(v.qualifiedTarget?.candidateId).success&&v.acceptedSource?.target?.candidateId===v.qualifiedTarget.candidateId
  &&v.qualifiedPair?.candidateId===v.qualifiedTarget.candidateId&&v.qualifiedPackage?.version===v.qualifiedTarget.version
  &&v.runtime?.fromVersion===v.fromVersion&&v.runtime.toVersion===v.toVersion,'runtime-retained-target-roles-changed');
 need(Array.isArray(v.scenarios)&&same(v.scenarios.map(x=>x.scenario),scenarios)
  &&v.scenarios.every(x=>x.candidateId===(x.scenario==='prior-rollback'?v.prior.candidateId:v.qualifiedTarget.candidateId)),
 'runtime-retained-scenarios-incomplete');
 const required=['producer','parent','review','originalPlan','executionIntent','technicalReview','originalIntention','acceptedSourceProof',
  'childResult','outsideClosure','migrationIntent','migrationCompleted','nativeMigrationVerified','nativeMigrationLog','companionInstallLog',
  'restorationIntent','restorationCompleted','acceptedRequest','acceptedResult','acceptedBundle','acceptedHostConfiguration','runtimeDescription','cacheReceipt','cacheManifest',
  ...scenarios.flatMap(x=>['started','process','ready','closed','preservation'].map(y=>x+'/'+y))];
 need(v.references&&required.every(k=>v.references[k]&&hostRef.safeParse({path:v.references[k].path,sha256:v.references[k].sha256}).success
  &&Number.isSafeInteger(v.references[k].bytes)&&v.references[k].bytes>=0),'runtime-retained-original-references-incomplete');
 need(v.references.parent.path===request.parent.path&&v.references.parent.sha256===request.parent.sha256
  &&v.references.producer.path===request.producer.path&&v.references.producer.sha256===request.producer.sha256,
  'runtime-retained-original-request-changed');
 return v;
}

export function assertRuntimeQualifiedCandidate(proof,{operation,prior,nativeAnchor,candidates,runtime,helpers}){
 verifyRuntimeRetainedProjection(proof,proof.request);
 need(operation.priorAgentVersion===proof.fromVersion&&operation.agentVersion===proof.toVersion
  &&operation.priorCandidateId===prior.id&&prior.id===proof.prior.candidateId
  &&operation.workspaceEpoch===proof.workspaceEpoch&&nativeAnchor.id===proof.qualifiedTarget.candidateId,
 'actual-runtime-prior-and-native-anchor-required');
 need(same(helpers,proof.helpers)&&same(runtime,proof.runtime),'actual-runtime-artifact-or-helper-changed');
 need(sha256(nativeAnchor.bytes.get('package.json'))===proof.qualifiedPackageSha256
  &&nativeAnchor.manifest.version===proof.qualifiedTarget.version,'runtime-qualified-native-anchor-changed');
 const compiled=c=>Object.fromEntries([...c.bytes].filter(([p])=>p.startsWith('dist/service/')).map(([p,b])=>[p,sha256(b)]));
 need(same(compiled(nativeAnchor),proof.qualifiedServiceArtifacts),'runtime-qualified-original-service-changed');
 for(const candidate of Object.values(candidates)){
  need(candidate.manifest.schemaVersion===55&&candidate.manifest.apiVersion===1,'changed-schema-qualification-producer-required');
  need(same(compiled(candidate),proof.qualifiedServiceArtifacts),'changed-startup-qualification-producer-required');
 }
 return proof;
}

export function verifyRuntimeQualificationReference(runtime,operation,helpers){
 need(runtime?.qualification&&runtime.qualificationBinding,'actual-settled-runtime-qualification-producer-required');
 const proof=JSON.parse(readEvidenceFile(runtime.qualification,{maximum:120*1024}));
 verifyRuntimeRetainedProjection(proof,proof.request);
 const binding=runtime.qualificationBinding;
 need(operation.priorAgentVersion===proof.fromVersion&&operation.agentVersion===proof.toVersion
  &&operation.priorCandidateId===proof.prior.candidateId&&operation.workspaceEpoch===proof.workspaceEpoch
  &&binding.priorCandidateId===operation.priorCandidateId&&(operation.candidateId===null||binding.candidateId===operation.candidateId)
  &&same(binding.sourceCommits,operation.sourceCommits)&&binding.nativeAnchorCandidateId===proof.qualifiedTarget.candidateId
  &&same(runtime.description,proof.runtime)&&runtime.archive.sha256===proof.runtime.archiveSha256&&same(helpers,proof.helpers),
 'actual-runtime-qualified-package-binding-changed');
 need(same(JSON.parse(readEvidenceFile(runtime.metadata)),runtime.description),'actual-runtime-qualified-description-changed');
 return proof;
}

export function createRuntimeRetainedCollector({transport,options,run=runInstallTransport,clock=Date.now}){
 const request=runtimeRetainedRequest(options);
 return async()=>{
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));
  readEvidenceFile(target.sshConfig,{maximum:65536});
  const before=clock();const raw=await run(target,buildRuntimeRetainedProgram(request),{captureDiagnostics:true});
  need(raw?.uncertain!==true&&raw?.exitCode===0&&typeof raw.stdout==='string'&&Buffer.byteLength(raw.stdout)<=120*1024,'actual-runtime-proof-observation-unavailable');
  const parsed=JSON.parse(raw.stdout);need(parsed.ok===true,'actual-runtime-proof-observation-failed');
  const proof=verifyRuntimeRetainedProjection(parsed.value,request),after=clock();
  need(Number.isSafeInteger(proof.observedAtMilliseconds)&&proof.observedAtMilliseconds>=before-30000
   &&proof.observedAtMilliseconds<=after+30000,'actual-runtime-proof-observation-time-changed');
  // Collection time is an observation, not a new identity or a renewed deadline.
  const{observedAtMilliseconds,...stable}=proof;return stable;
 };
}
