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
import {applicationDependencyDescriptionSchema,applicationTransitionSchema,sameSchemaQualificationSchema,startupQualificationMarker,qualificationMarkerFields} from './release-delivery-qualified-dependencies.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/);
const hostPath=z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).refine(p=>!p.split('/').some(x=>x==='.'||x==='..'));
const hostRef=z.object({path:hostPath,sha256:hash}).strict();
export const startupQualificationOptionsSchema=z.object({format:z.literal(1),parent:hostRef,producer:hostRef}).strict();
// Reviewed producer bytes identify the only accepted evidence implementation.
// Source review alone never replaces its actual settled qualification result.
export const QUALIFIED_STARTUP_SOURCES=Object.freeze({
  'qualified-startup.py':'82794c1b913e241bd881d8c89dac4871c2c4b5ae70c12f362754f9fcc60cc9fb',
  'qualified-parent.py':'11bd0945c69845cd66a5f3dd6024328b4630011bbd5a0640690a18584686d722',
  'produce-startup-inputs.py':'caedf6794abfeb20f55b48d983bec238c73d57b501c9b212d800fda7a5d803b5',
  'contracts.py':'99b4ec258324ce3d87e52a01ddd17dcddd76324c204fc6ce6ad991ee3fdbb32d',
});
// Separate exact producer family for a closed schema-60 source and target.
export const SAME_SCHEMA60_STARTUP_SOURCES=Object.freeze({"qualified-startup.py":"2b86508e231a282ceab5b36796090b5759d66ff9dc43c47a93dd766e3d926dff","qualified-parent.py":"81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036","produce-startup-inputs.py":"d4b8dbb9cf866fa12726cf1360b6704f1d7fdf3697a85b805274844eb050ea61","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
// Additional exact source family; every actual candidate proof remains mandatory.
export const RETIRED_RECAPTURE_STARTUP_SOURCES=Object.freeze({"qualified-startup.py":"f9307cd30f7c9b4b50034e81942604772f93027f5ba915ebd9e9176e67b00092","qualified-parent.py":"81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036","produce-startup-inputs.py":"12d59c2b45e9a6791cba66cec1d9cf0c077ebce3e6cc12392b6090a3e6a0c580","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
export const REHEARSAL_SCHEMA60_STARTUP_SOURCES=Object.freeze({"qualified-startup.py":"0c86d97f56addc71e0d8c57665265da1f40009f14caf19bcf75c1899f4d430c6","qualified-parent.py":"81410714bcb95d168fd8c3e90837813a8ce11847bf9b111cc5ecb5c874aa3036","produce-startup-inputs.py":"12d59c2b45e9a6791cba66cec1d9cf0c077ebce3e6cc12392b6090a3e6a0c580","contracts.py":"ec2d4f7942d291c617cc69d57b8492fe9484db9b9495ca1b8c29510f8f608145"});
const sameSchemaSources=sources=>[SAME_SCHEMA60_STARTUP_SOURCES,RETIRED_RECAPTURE_STARTUP_SOURCES,REHEARSAL_SCHEMA60_STARTUP_SOURCES].some(v=>v!==null&&same(sources,v));
export const SAME_SCHEMA60_STARTUP_HELPERS=Object.freeze({"install.py":"b4cf0ee98ebb80723dba69425f55409adecf7f3d7427d42b53c037251f4b6200","recovery.py":"b4c59da8ee92a1ddf2bbaef4139635494123eab2b299e7e6ea5e627629652ee4","operator_rehearsal.py":"081d4f928b6800ff05dd5a0dbfc3416031425a0c892c5186d994533ca42b1b21","app_dependencies.py":"e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290","codex_log_retention.py":"bc6b09a2b99a9667c9c8fac63f2665362aa3e14b8db10d6be12652250ae2a1f4","workspace_key.py":"e97ae151ff8208c6831e93ef3281e1b1dbff99f4eea4679aa7f6a8ed06c412d2","verify-session-bindings.mjs":"1d51c2af378f27f21c9580a367779ab9192c159c600f02938d780a5de467c5c0","hosted_retained_configuration.py":"a65dff849aa242a0c8eeb51f86ad2cd1cf36a62229169e0197947492d372f55e","local-retained-configuration.mjs":"ec8c0caefbd7bd14cd032755c1351d332dcc00fdd4c1454264678945e1353b56","hosted_retained_catalog.py":"59b33ec350f640d2b8fe2d493e22756f557910ebf2a8cccd107998c9314b9328","hosted-retained-catalog.mjs":"431d5f2741e46a8b2258b6eab22786d369d570c6ec5824434ef0dd2dd4b5f1db"});
export const HISTORICAL_SCHEMA60_HELPERS=Object.freeze({...SAME_SCHEMA60_STARTUP_HELPERS,
  'install.py':'54d8495b616ae94dfce928470ffc46860331f71fc93c70af081f7061943e36ef',
  'recovery.py':'113f2c937e40eac597ec056fcc8042e69392505fa5f5f96dd44a1ea9441e3b11',
  'operator_rehearsal.py':'8fe10fd13b924b78e8eccbe01334ce627e09c46961e5750062c57dcfe957a8d2',
});
function helpersForStartupSources(sources){
  return same(sources,REHEARSAL_SCHEMA60_STARTUP_SOURCES) ? SAME_SCHEMA60_STARTUP_HELPERS : HISTORICAL_SCHEMA60_HELPERS;
}
export function reviewedStartupSources(producer){
 const sources=[QUALIFIED_STARTUP_SOURCES,SAME_SCHEMA60_STARTUP_SOURCES,RETIRED_RECAPTURE_STARTUP_SOURCES,REHEARSAL_SCHEMA60_STARTUP_SOURCES].find(v=>v!==null&&producer?.sha256===v['qualified-startup.py']);
 need(sources,'reviewed-startup-producer-required');return sources;
}
// Exact source capability only; it grants no candidate or runtime acceptance.
const retiredRecaptureProducers=new Set([RETIRED_RECAPTURE_STARTUP_SOURCES,REHEARSAL_SCHEMA60_STARTUP_SOURCES].map(family=>family['qualified-startup.py']));
const CAPTURE_RETIREMENT_PRODUCER='bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58';
const CAPTURE_REAPING_PRODUCER='7ca0aa07ead0d6d6672352a59a520cd93e42295993cd36064994bfb701cfe6eb';
const CAPTURE_REAPING_PRODUCERS=new Set([CAPTURE_REAPING_PRODUCER,'352ce2f79419c0722e902a15df639a04b7854d87d3bab6ed7d79484148da6db9','4e1f6d0aaa729b5df938bb0566e7442be6abf9bfc832c0b5ab1cfcd1746b7dd3',
  '479a10e7303411aaf5e76a08d857747798cf6a65362fdd75a2808d7f2a585294',
  '4404a1c0a7658c206b49d6daa64e4f7c1c0bf8ffa905ce19a4015312c823d599',
  'f1004fc0fafec1669c5bd4822cf27925d64e861b0bb74301a033a431becccc10',
  'f8de414f4822707675dbe0fca150ad0dd917202579bacd8432a6115c4a218a28',QUALIFIED_STARTUP_SOURCES['qualified-startup.py']]);
export const STARTUP_SCENARIOS=Object.freeze(['target-first-start','target-restart','pristine-prior-restoration']);
export const STARTUP_BARRIER_FILES=Object.freeze(['gateway.js','http.js','runtime.js','software-updates.js','store.js','update-maintenance.js','update-native-idle.js','update-native-startup.js'].map(n=>'dist/service/apps/service/'+n));
const HELPERS=['install.py','recovery.py','operator_rehearsal.py','app_dependencies.py','codex_log_retention.py','workspace_key.py','verify-session-bindings.mjs'];
export const APPLICATION_TRANSITION_HELPERS=Object.freeze(['hosted_retained_configuration.py','local-retained-configuration.mjs','hosted_retained_catalog.py','hosted-retained-catalog.mjs']);
export function startupHelperNames(marker=null){qualificationMarkerFields(marker);return [...HELPERS,...(marker?APPLICATION_TRANSITION_HELPERS:[])];}
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const encoded=v=>Buffer.from(canonical(v)+'\n');
const digestMap=z.record(z.string().min(1).max(512),hash);
export {applicationTransitionSchema,sameSchemaQualificationSchema,startupQualificationMarker,qualificationMarkerFields};
/** This describes the only supported schema change; it grants no qualification.
 * The caller must still authenticate the complete original startup projection. */
export function assertStartupApplicationTransition(binding,prior,target){
  const marker=startupQualificationMarker(binding);
  need(prior.apiVersion===1&&target.apiVersion===1,'actual-startup-schema-or-api-unsupported');
  if(prior.schemaVersion===target.schemaVersion&&[55,60].includes(prior.schemaVersion)){
    need(!Object.hasOwn(binding,'applicationTransition'),'unexpected-startup-application-transition');
    need(prior.schemaVersion===60?marker?.kind==='schema-60-same-runtime':marker===null,'actual-startup-same-schema-qualification-required');return null;
  }
  need(prior.schemaVersion===55&&target.schemaVersion===60,'actual-startup-schema-transition-unsupported');
  need(!Object.hasOwn(binding,'sameSchemaQualification'),'unexpected-startup-same-schema-qualification');
  return applicationTransitionSchema.parse(binding.applicationTransition);
}
const targetSchema=z.object({candidateId:hash,version:z.string(),buildVersion:z.string(),archiveSha256:hash,
  archiveBytes:z.number().int().positive(),ciSourceSha256:hash,packageSha256:hash,packageLockSha256:hash,candidateManifestSha256:hash}).strict();
export const startupQualificationBindingSchema=z.object({format:z.literal(1),kind:z.literal('same-runtime-startup-candidate-binding'),
  sourceCommits:z.object({private:commit,public:commit}).strict(),prior:z.object({candidateId:hash,version:z.string()}).strict(),
  targets:z.object({private:targetSchema,public:targetSchema}).strict(),serviceArtifacts:digestMap,
  hostEntrypointSha256:hash,dependencyGraphSha256:hash,helpers:digestMap,runtime:z.record(z.string(),z.unknown()),workspaceEpoch:z.uuid(),
  applicationTransition:applicationTransitionSchema.optional(),sameSchemaQualification:sameSchemaQualificationSchema.optional(),applicationDependencies:applicationDependencyDescriptionSchema.optional(),
}).strict().refine(v=>!(Object.hasOwn(v,'applicationTransition')&&Object.hasOwn(v,'sameSchemaQualification')),'startup-qualification-marker-conflict');
function sourcesReviewed(sources){
  need(same(Object.keys(sources).sort(),Object.keys(QUALIFIED_STARTUP_SOURCES).sort())
    &&Object.values(sources).every(v=>hash.safeParse(v).success&&v!=='0'.repeat(64)),'reviewed-startup-producer-required');
}
export function startupRetainedRequest(options,sources=undefined){
  const v=startupQualificationOptionsSchema.parse(options);sources??=reviewedStartupSources(v.producer);sourcesReviewed(sources);
  need(v.producer.sha256===sources['qualified-startup.py']&&v.producer.path.endsWith('/qualified-startup.py')
    &&v.parent.path.endsWith('/evidence/parent-verified.json'),'reviewed-startup-producer-required');
  return{format:1,kind:'collect-actual-retained-startup-proof',parent:v.parent,producer:v.producer};
}
export function buildStartupRetainedProgram(request){
  startupRetainedRequest({format:1,parent:request.parent,producer:request.producer});
  const sources=reviewedStartupSources(request.producer);
  const source=readFileSync(new URL('./release-startup-retained-proof.py',import.meta.url));
  const payload=encoded({source:source.toString('base64'),sha256:sha256(source),request,sources,...(sameSchemaSources(sources)?{sameSchemaHelpers:helpersForStartupSources(sources)}:{})}).toString('base64');
  return `import base64,hashlib,json,signal,resource\nv=json.loads(base64.b64decode('${payload}',validate=True));s=base64.b64decode(v['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\nresource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));signal.alarm(110)\nn={'__name__':'fixed_startup_retained_consumer'};exec(compile(s,'fixed-startup-retained-consumer','exec'),n)\nprint(json.dumps({'ok':True,'value':n['invoke'](v['request'],v['sources'],v.get('sameSchemaHelpers'))},separators=(',',':')))\n`;
}

function verifyCaptureTransition(proof,binding){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const root=z.tuple([integer.positive(),integer.positive(),integer.max(0o177777).refine(v=>(v&0o170000)===0o040000),integer,integer]);
  const window=z.tuple([integer,integer]).refine(v=>v[1]>=v[0]&&v[1]-v[0]<=3600);
  const hashes=['packetSha256','proofSha256','beforeSha256','closedSha256','writerSourcesSha256','baselineManifestSha256',
    'originsSha256','observationRefsSha256','authorityContextSha256','baselineInventorySha256','beforeLiveInventorySha256',
    'closedLiveInventorySha256','baselineClassificationSha256','beforeLiveClassificationSha256','closedLiveClassificationSha256',
    'baselinePartitionSha256','beforePartitionSha256','closedPartitionSha256','canonicalReportsSha256'];
  const shape=z.object({kind:z.literal('closed-9.8-retired-capture-transition'),candidateId:hash,workspaceEpoch:z.uuid(),
    selectedRelative:z.string().regex(/^recovered-workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    attempt:integer.min(1).max(3),physicalRoots:z.tuple([root,root]),ordinaryWindow:window,
    predicateSha256:z.literal('df724c3ab3fcbfa53da4ec611603ababe0839c5a41900b606583ffe8a54b27a0'),
    ...Object.fromEntries(hashes.map(k=>[k,hash])),predecessorProofSha256:hash.nullable(),
    unchangedCatalogEarlyReturn:z.boolean(),canonicalFunctionObserved:z.boolean(),canonicalReportCount:integer.max(1)}).strict();
  const rows=proof.scenarios.map(s=>shape.parse(s.captureTransition)),first=rows[0];
  for(const [i,row]of rows.entries()){
    const scenario=proof.scenarios[i],prior=rows[i-1];
    need(row.attempt===i+1&&row.candidateId===scenario.candidateId&&row.workspaceEpoch===binding.workspaceEpoch
      &&row.selectedRelative===first.selectedRelative&&same(row.ordinaryWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds])
      &&same(row.physicalRoots[0],first.physicalRoots[0])&&same(row.physicalRoots[0].slice(3),row.physicalRoots[1].slice(3))
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice&&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2))
      &&['predicateSha256','writerSourcesSha256','baselineManifestSha256','originsSha256','authorityContextSha256','baselineInventorySha256','baselineClassificationSha256','baselinePartitionSha256'].every(k=>row[k]===first[k]),
      'same-schema-capture-transition-binding-changed');
    need(row.unchangedCatalogEarlyReturn===(row.canonicalReportCount===0)&&row.canonicalFunctionObserved===(row.canonicalReportCount===1),
      'same-schema-capture-transition-callback-claim-changed');
    if(i===1){
      need(row.predecessorProofSha256===prior.proofSha256&&same(row.physicalRoots,prior.physicalRoots)
        &&row.beforeLiveInventorySha256===prior.closedLiveInventorySha256&&row.beforeLiveClassificationSha256===prior.closedLiveClassificationSha256
        &&row.beforePartitionSha256===prior.closedPartitionSha256,'same-schema-capture-transition-predecessor-changed');
    }else{
      need(row.predecessorProofSha256===null&&row.beforeLiveInventorySha256===row.baselineInventorySha256
        &&row.beforeLiveClassificationSha256===row.baselineClassificationSha256
        &&(i!==2||!same(row.physicalRoots[1].slice(0,2),first.physicalRoots[1].slice(0,2))),
        'same-schema-capture-transition-pristine-required');
    }
    if(row.unchangedCatalogEarlyReturn)need(row.beforeLiveInventorySha256===row.closedLiveInventorySha256
      &&row.beforeLiveClassificationSha256===row.closedLiveClassificationSha256&&row.beforePartitionSha256===row.closedPartitionSha256,
      'same-schema-capture-transition-unchanged-state-required');
    for(const [role,file,key]of [['packet','capture-transition-packet.json','packetSha256'],['proof','capture-continuity.json','proofSha256'],
      ['before','capture-before.json','beforeSha256'],['closed','capture-closed.json','closedSha256']]){
      const ref=proof.references?.[scenario.scenario+'/transition/'+role];
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=16*1024**2
        &&ref.sha256===row[key]&&ref.path.endsWith('/attempt-'+(i+1)+'/'+file),'same-schema-capture-transition-raw-references-required');
    }
  }
}

function verifyCaptureContinuity(proof,binding){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const directoryMode=integer.max(0o177777).refine(v=>(v&0o170000)===0o040000);
  const root=z.tuple([integer.positive(),integer.positive(),directoryMode,z.literal(999),z.literal(986)]);
  const window=z.tuple([integer,integer]).refine(v=>v[1]>=v[0]&&v[1]-v[0]<=3600);
  const report=z.object({sha256:hash,packageRootSha256:hash,originalSourceAdmissionsSha256:hash,
    currentSourceAdmissionsSha256:hash,namespaceMappingSha256:hash,
    windowSource:z.enum(['current-startup','exact-preceding-closed-state']),evaluatedWindow:window,
    predecessorClosedSha256:hash.nullable()}).strict();
  const shape=z.object({kind:z.literal('closed-9.8-retired-capture-continuity'),beforeSha256:hash,closedSha256:hash,proofSha256:hash,
    selectedRelative:z.string().regex(/^recovered-workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    workspaceEpoch:z.uuid(),candidateId:hash,attempt:integer.min(1).max(3),physicalRoots:z.tuple([root,root]),ordinaryWindow:window,stagingCount:z.literal(0),
    baselineInventorySha256:hash,beforeLiveInventorySha256:hash,closedLiveInventorySha256:hash,
    baselineClassificationSha256:hash,beforeLiveClassificationSha256:hash,closedLiveClassificationSha256:hash,
    pathMappingSha256:hash,hardlinkClassesSha256:hash,predecessorClosedSha256:hash.nullable(),writerSourcesSha256:hash,
    canonicalReportsSha256:hash,namespaceMappingSha256:hash,timestampChangesSha256:hash,canonicalReports:z.array(report).min(1).max(8)}).strict();
  const rows=proof.scenarios.map(s=>shape.parse(s.captureContinuity)),first=rows[0];
  for(const [i,row]of rows.entries()){
    const scenario=proof.scenarios[i],prior=rows[i-1];
    need(row.attempt===i+1&&row.workspaceEpoch===binding.workspaceEpoch&&row.candidateId===scenario.candidateId
      &&row.selectedRelative===first.selectedRelative&&same(row.ordinaryWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds])
      &&row.baselineInventorySha256===first.baselineInventorySha256&&row.baselineClassificationSha256===first.baselineClassificationSha256
      &&row.writerSourcesSha256===first.writerSourcesSha256&&same(row.physicalRoots[0],first.physicalRoots[0])
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice
      &&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2)), 'same-schema-retired-capture-binding-changed');
    if(i===1){
      need(row.predecessorClosedSha256===prior.closedSha256&&same(row.physicalRoots,prior.physicalRoots)
        &&row.beforeLiveInventorySha256===prior.closedLiveInventorySha256
        &&row.beforeLiveClassificationSha256===prior.closedLiveClassificationSha256,
        'same-schema-retired-capture-predecessor-changed');
    }else{
      need(row.predecessorClosedSha256===null&&row.beforeLiveInventorySha256===row.baselineInventorySha256
        &&row.beforeLiveClassificationSha256===row.baselineClassificationSha256
        &&(i!==2||!same(row.physicalRoots[1].slice(0,2),first.physicalRoots[1].slice(0,2))),
        'same-schema-retired-capture-pristine-required');
    }
    for(const [suffix,key]of [['before','beforeSha256'],['closed','closedSha256'],['continuity','proofSha256']]){
      const ref=proof.references?.[scenario.scenario+'/capture-'+suffix];
      need(hostRef.safeParse({path:ref?.path,sha256:ref?.sha256}).success&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0
        &&ref.bytes<=(suffix==='continuity'?4:16)*1024**2&&ref.sha256===row[key]
        &&ref.path.endsWith('/attempt-'+(i+1)+'/capture-'+suffix+'.json'), 'same-schema-retired-capture-references-required');
    }
    for(const r of row.canonicalReports){
      if(r.windowSource==='current-startup'){
        need(same(r.evaluatedWindow,row.ordinaryWindow)&&r.predecessorClosedSha256===null,'same-schema-retired-capture-window-changed');
      }else{
        need(i===1&&r.predecessorClosedSha256===prior.closedSha256
          &&row.closedLiveInventorySha256===prior.closedLiveInventorySha256
          &&row.closedLiveClassificationSha256===prior.closedLiveClassificationSha256
          &&r.evaluatedWindow[1]<=row.ordinaryWindow[0], 'same-schema-retired-capture-inherited-state-changed');
        const matches=prior.canonicalReports.filter(p=>['packageRootSha256','originalSourceAdmissionsSha256','currentSourceAdmissionsSha256','namespaceMappingSha256'].every(k=>p[k]===r[k]));
        need(matches.length===1&&same(matches[0].evaluatedWindow,r.evaluatedWindow),'same-schema-retired-capture-inherited-receipt-changed');
      }
    }
  }
}
function verifyNoStagingCaptures(proof,binding){
  const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const directoryMode=integer.max(0o177777).refine(v=>(v&0o170000)===0o040000);
  const root=z.tuple([integer.positive(),integer.positive(),directoryMode,z.literal(999),z.literal(986)]);
  const shape=z.object({kind:z.literal('closed-9.8-no-staging-captures'),beforeSha256:hash,closedSha256:hash,
    classificationSha256:hash,inventorySha256:hash,selectedRelative:z.string().regex(/^recovered-workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    workspaceEpoch:z.uuid(),candidateId:hash,attempt:z.number().int().min(1).max(3),physicalRoots:z.tuple([root,root]),
    stagingCount:z.literal(0),unchanged:z.literal(true)}).strict();
  const rows=proof.scenarios.map(s=>shape.parse(s.captureObservation)),first=rows[0];
  for(const [i,row]of rows.entries()){
    const scenario=proof.scenarios[i],before=proof.references?.[scenario.scenario+'/capture-before'],closed=proof.references?.[scenario.scenario+'/capture-closed'];
    need(row.attempt===i+1&&row.workspaceEpoch===binding.workspaceEpoch&&row.candidateId===scenario.candidateId
      &&row.selectedRelative===first.selectedRelative&&row.classificationSha256===first.classificationSha256&&row.inventorySha256===first.inventorySha256
      &&row.physicalRoots[0][0]===scenario.replicaConfigObservation?.sourceDevice
      &&row.physicalRoots[1][0]===scenario.replicaConfigObservation?.replicaDevice
      &&same(row.physicalRoots[0],first.physicalRoots[0])&&!same(row.physicalRoots[0].slice(0,2),row.physicalRoots[1].slice(0,2))
      &&(i!==1||same(row.physicalRoots[1],first.physicalRoots[1]))
      &&(i!==2||!same(row.physicalRoots[1].slice(0,2),first.physicalRoots[1].slice(0,2))),
      'same-schema-no-staging-capture-binding-changed');
    need(hostRef.safeParse({path:before?.path,sha256:before?.sha256}).success&&hostRef.safeParse({path:closed?.path,sha256:closed?.sha256}).success
      &&Number.isSafeInteger(before.bytes)&&before.bytes>0&&Number.isSafeInteger(closed.bytes)&&closed.bytes>0
      &&before.sha256===row.beforeSha256&&closed.sha256===row.closedSha256,'same-schema-no-staging-capture-references-required');
  }
}
/** Validate every persisted projection again; never trust its passed flags alone. */
export function verifyStartupRetainedProjection(v,request,sources=undefined){
  sources??=reviewedStartupSources(request?.producer);sourcesReviewed(sources);
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
  if(binding.sameSchemaQualification)need(sameSchemaSources(sources),'same-schema-startup-producer-required');
  else need(!sameSchemaSources(sources),'same-schema-startup-marker-required');
  need(binding.prior.candidateId!==binding.targets.private.candidateId&&binding.runtime.agentVersion==='2026.9.8'
    &&same(Object.keys(binding.helpers).sort(),startupHelperNames(startupQualificationMarker(binding)).sort())
    &&Object.keys(binding.serviceArtifacts).length<=1000
    &&Object.keys(binding.serviceArtifacts).every(p=>/^dist\/service\/[a-zA-Z0-9_./-]+$/.test(p)&&!p.split('/').some(v=>['','.','..'].includes(v)))
    &&binding.serviceArtifacts['dist/service/apps/service/main.js']
    &&STARTUP_BARRIER_FILES.every(p=>binding.serviceArtifacts[p]),'startup-qualified-artifact-closure-required');
  if(binding.applicationDependencies)need(startupQualificationMarker(binding)&&binding.applicationDependencies.dependencyGraphSha256===binding.dependencyGraphSha256
    &&Object.values(binding.targets).every(t=>t.packageLockSha256===binding.applicationDependencies.packageLockSha256),'startup-qualified-dependencies-changed');
  need(Array.isArray(v.scenarios)&&same(v.scenarios.map(x=>x.scenario),STARTUP_SCENARIOS)
    &&v.scenarios.every(x=>x.candidateId===(x.scenario==='pristine-prior-restoration'?binding.prior.candidateId:binding.targets.private.candidateId)
      &&Number.isSafeInteger(x.startedAtSeconds)&&Number.isSafeInteger(x.closedAtSeconds)&&x.closedAtSeconds>=x.startedAtSeconds
      &&x.closedAtSeconds-x.startedAtSeconds<=3600),'startup-retained-scenarios-incomplete');
  if([CAPTURE_RETIREMENT_PRODUCER,...CAPTURE_REAPING_PRODUCERS,QUALIFIED_STARTUP_SOURCES['qualified-startup.py'],'9a30fd20d3a8321d763abba55dfc9ba55818d27984b1aa0337f3a17c0607554b','0a45ca346ec848ec8b17a0f1dcab43314ae344b12b5f8a0144f518d05144f3f5','3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af'].includes(sources['qualified-startup.py'])||binding.sameSchemaQualification){
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
  if(sources['qualified-startup.py']===CAPTURE_RETIREMENT_PRODUCER){
    need(v.baselineLineage==='verified-pre-swap-aborted-operator-snapshot','incident-capture-baseline-required');
    const id=z.string().regex(/^(0|[1-9][0-9]*)$/);
    const role=z.object({roleSha256:hash,headerSha256:hash,contextSha256:hash,physicalOwner:z.tuple([id,id]),
      proofSha256:hash,firstWindow:z.tuple([z.number().int().positive(),z.number().int().positive()])}).strict();
    const receipt=z.object({kind:z.literal('closed-9.8-capture-retirement'),
      beforeSha256:hash,closedSha256:hash,roles:z.array(role).min(1).max(1000)}).strict();
    const sets=v.scenarios.map(s=>receipt.parse(s.captureRetirement).roles);
    const first=new Map(sets[0].map(r=>[r.roleSha256,r]));
    need(first.size===sets[0].length,'capture-proof-role-duplicated');
    for(const [i,rows] of sets.entries()){
      const window=v.scenarios[i===1?0:i];
      need(rows.length===first.size&&new Set(rows.map(r=>r.roleSha256)).size===first.size,'capture-proof-role-coverage-changed');
      for(const r of rows){
        const original=first.get(r.roleSha256);
        need(original&&r.headerSha256===original.headerSha256&&r.contextSha256===original.contextSha256
          &&same(r.firstWindow,[window.startedAtSeconds,window.closedAtSeconds])
          &&(i!==1||same(r,original))&&(i!==2||!same(r.physicalOwner,original.physicalOwner)),
          'capture-proof-retirement-or-restart-provenance-changed');
      }
    }
  }

  const captureOnly=key=>v.scenarios.every(s=>['captureObservation','captureRetirement','captureContinuity','captureTransition'].filter(k=>Object.hasOwn(s,k)).join(',')===key);
  const noStaging=binding.sameSchemaQualification&&captureOnly('captureObservation');
  const continuity=binding.sameSchemaQualification&&captureOnly('captureContinuity');
  const transition=binding.sameSchemaQualification&&captureOnly('captureTransition');
  if(binding.sameSchemaQualification){
    need(v.baselineLineage==='verified-closed-schema60-target-retained'&&same(binding.helpers,helpersForStartupSources(sources)),'same-schema-capture-source-required');
    need(noStaging||continuity||transition||captureOnly('captureRetirement'),'same-schema-capture-branch-changed');
    if(noStaging)verifyNoStagingCaptures(v,binding);
    if(transition){
      need(retiredRecaptureProducers.has(sources['qualified-startup.py']),'startup-retired-recapture-source-not-qualified');
      verifyCaptureTransition(v,binding);
    }
    if(continuity){
      need(retiredRecaptureProducers.has(sources['qualified-startup.py']),'startup-retired-recapture-source-not-qualified');
      verifyCaptureContinuity(v,binding);
    }
  }
  if(CAPTURE_REAPING_PRODUCERS.has(sources['qualified-startup.py'])||(binding.sameSchemaQualification&&!noStaging&&!continuity&&!transition)){
    need(v.baselineLineage===(binding.sameSchemaQualification?'verified-closed-schema60-target-retained':'verified-pre-swap-aborted-operator-snapshot'),'incident-capture-baseline-required');
    need(binding.sameSchemaQualification||binding.helpers['recovery.py']==='23b7d18d415393a315a8140b674edee4a12cbc1b8f996b439843472208dcbd15'
      &&['941e295816bbb4c5da054928018ee59ae3164d032dffcab63d79f36b79050a59','f85ef9249d9722558ad6ab6dccee60b8d4412ca793afeeb1a53d316a85a2e62a','522b78eeb6a6d986dde2ac353516c47a987d8283bb030d273b0b4122d08cbe24'].includes(binding.helpers['install.py']),
      'capture-lifecycle-helper-source-required');
    const id=z.string().regex(/^(0|[1-9][0-9]*)$/);
    const names=z.array(z.string().regex(/^admission-[A-Za-z0-9]{6}$/)).max(16);
    const role=z.object({roleSha256:hash,headerSha256:hash,contextSha256:hash,
      physicalOwner:z.tuple([id,id]).nullable(),proofSha256:hash,
      firstWindow:z.tuple([z.number().int().positive(),z.number().int().positive()]),
      state:z.enum(['retired','partially-reaped','reaped']),reaped:z.boolean(),
      remainingNamespaces:names.nullable(),remainingCount:z.number().int().min(0).max(16).nullable(),
      remainingSha256:hash.nullable(),sourceAdmissionsSha256:hash.nullable(),predecessorProofSha256:hash.nullable(),
      lastWindow:z.tuple([z.number().int().positive(),z.number().int().positive()])}).strict();
    const receipt=z.object({kind:z.literal('closed-9.8-capture-lifecycle'),
      beforeSha256:hash,closedSha256:hash,roles:z.array(role).min(1).max(1000)}).strict();
    const sets=v.scenarios.map(s=>receipt.parse(s.captureRetirement).roles);
    const first=new Map(sets[0].map(r=>[r.roleSha256,r]));
    need(first.size===sets[0].length,'capture-proof-role-duplicated');
    for(const [i,rows] of sets.entries()){
      const scenario=v.scenarios[i],firstScenario=v.scenarios[i===1?0:i];
      need(rows.length===first.size&&new Set(rows.map(r=>r.roleSha256)).size===first.size,'capture-proof-role-coverage-changed');
      for(const r of rows){
        const original=first.get(r.roleSha256);
        need(original&&r.headerSha256===original.headerSha256&&r.contextSha256===original.contextSha256
          &&same(r.firstWindow,[firstScenario.startedAtSeconds,firstScenario.closedAtSeconds])
          &&same(r.lastWindow,[scenario.startedAtSeconds,scenario.closedAtSeconds]),'capture-lifecycle-clock-or-source-changed');
        if(i!==1){
          need(r.state==='retired'&&!r.reaped&&r.physicalOwner!==null&&r.remainingNamespaces===null
            &&r.remainingCount===null&&r.remainingSha256===null&&r.sourceAdmissionsSha256===null
            &&r.predecessorProofSha256===null&&(i!==2||!same(r.physicalOwner,original.physicalOwner)),
            'capture-lifecycle-independent-retirement-required');
        }else{
          need(r.predecessorProofSha256===original.proofSha256,'capture-lifecycle-predecessor-changed');
          if(r.state==='retired'){
            need(!r.reaped&&same(r.physicalOwner,original.physicalOwner)&&r.proofSha256===original.proofSha256
              &&r.remainingNamespaces===null&&r.remainingCount===null&&r.remainingSha256===null
              &&r.sourceAdmissionsSha256===null,'capture-lifecycle-unchanged-carry-required');
          }else{
            need(r.proofSha256!==original.proofSha256&&Array.isArray(r.remainingNamespaces)
              &&same(r.remainingNamespaces,[...new Set(r.remainingNamespaces)].sort())
              &&r.remainingCount===r.remainingNamespaces.length
              &&r.remainingSha256===sha256(Buffer.from(canonical(r.remainingNamespaces)))
              &&r.sourceAdmissionsSha256!==null
              &&r.reaped===(r.state==='reaped')
              &&(r.reaped?r.physicalOwner===null&&r.remainingCount===0
                :same(r.physicalOwner,original.physicalOwner)&&r.remainingCount>0),
              'capture-lifecycle-monotonic-generated-reaping-required');
          }
        }
      }
    }
  }


  const required=['producer','parent',...Object.keys(sources).map(k=>'source/'+k),'review','originalPlan','executionIntent',
    'technicalReview','originalIntention','childResult','outsideClosure','restorationIntent','restorationCompleted','effectiveProfile','negativeVerifierSource','negativeVerifierResult',
    ...['result','closure','input','plan','intent','sourceCapture','sourceBefore','sourceAfter','sourcePhysical','sourceMetadata','seedInventory','seedPhysical','seedMetadata','liveContext','effectiveUnit'].map(role=>'homeCapture/'+role),
    ...STARTUP_SCENARIOS.flatMap(x=>['started','process','ready','closed','preservation','bootstrap','clock-attribution'].map(y=>x+'/'+y))];
  if(CAPTURE_REAPING_PRODUCERS.has(sources['qualified-startup.py']))required.push('baselineManifest');
  if(binding.sameSchemaQualification)required.push('baselineManifest','baselineVerified','retainedParent','retainedRoles','retainedClosure','retainedSecondPreservation');
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
export function assertStartupQualifiedCandidate(proof,{operation,prior,candidates,artifacts,helpers,dependencyGraphSha256,applicationDependencies=null},sources=undefined){
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
    need(startupQualificationMarker(b)||candidate.manifest.schemaVersion===55,'actual-startup-same-schema60-producer-unavailable');
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
