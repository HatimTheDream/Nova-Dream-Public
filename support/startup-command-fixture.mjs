/** Synthetic source bindings for pure checks; never actual qualification. */
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {sha256} from '../scripts/release-plan.mjs';
import {verifyCandidate} from '../scripts/candidate.mjs';
import {dependencyFixture} from './dependency-transport-fixture.mjs';
import {STARTUP_SCENARIOS,startupRetainedRequest,APPLICATION_TRANSITION_HELPERS,QUALIFIED_STARTUP_SOURCES} from '../scripts/release-delivery-startup-retained.mjs';
export const HOME_CAPTURE_ROLES=Object.freeze(['result', 'closure', 'input', 'plan', 'intent', 'sourceCapture', 'sourceBefore', 'sourceAfter', 'sourcePhysical', 'sourceMetadata', 'seedInventory', 'seedPhysical', 'seedMetadata', 'liveContext', 'effectiveUnit']);
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>sha256(Buffer.from(canonical(v)+'\n'));
export function startupCommandFixture(t,{sources,schemaMigration=false,sameSchema60=false,newDependencyGraph=false}={}){
  sources??=Object.fromEntries(['qualified-startup.py','qualified-parent.py','produce-startup-inputs.py','contracts.py'].map(n=>[n,sha256(n)]));
  const targetHelpers=sources['qualified-startup.py']===QUALIFIED_STARTUP_SOURCES['qualified-startup.py']
    ?Object.fromEntries(['recovery.py','install.py'].map(name=>[name,readFileSync(new URL('../deploy/update-runner/'+name,import.meta.url))])):{};
  const f=dependencyFixture(t,{format:4,change:'startup',includeHost:true,targetHelpers,...(newDependencyGraph?{targetDependencyVersion:'2.0.0'}:{}),...(schemaMigration?{targetSchema:60,migrationHelpers:[...APPLICATION_TRANSITION_HELPERS,'operator_rehearsal.py']}:sameSchema60?{targetSchema:60,priorSchema:60}:{})});
  const producer={path:'/fixture/sources/qualified-startup.py',sha256:sources['qualified-startup.py']};
  const parent={path:'/fixture/evidence/parent-verified.json',sha256:'1'.repeat(64)};
  const options={format:1,parent,producer},request=startupRetainedRequest(options,sources);
  const candidates=Object.fromEntries(Object.entries(f.artifacts).map(([s,a])=>[s,verifyCandidate(a.applicationDirectory)]));
  const prior=verifyCandidate(f.base.directory),host=Buffer.from('// synthetic host.mjs');
  const helperHashes=Object.fromEntries(Object.entries(f.artifacts.private.sourceHashes).filter(([k])=>k.startsWith('deploy/update-runner/')).map(([k,v])=>[k.split('/').at(-1),v.sha256]));
  const targets=Object.fromEntries(Object.entries(f.artifacts).map(([side,a])=>[side,{
    candidateId:candidates[side].id,version:candidates[side].manifest.version,buildVersion:candidates[side].manifest.buildVersion,
    archiveSha256:a.archive.sha256,archiveBytes:readFileSync(a.archive.path).length,ciSourceSha256:a.ciSourceReceipt.sha256,
    packageSha256:sha256(candidates[side].bytes.get('package.json')),packageLockSha256:sha256(readFileSync(join(a.applicationDirectory,'package-lock.json'))),
    candidateManifestSha256:sha256(readFileSync(join(a.applicationDirectory,'dist/candidate.json'))),
  }]));
  const binding={format:1,kind:'same-runtime-startup-candidate-binding',sourceCommits:f.descriptor.operation.sourceCommits,
    prior:{candidateId:prior.id,version:prior.manifest.version},targets,
    serviceArtifacts:Object.fromEntries([...candidates.private.bytes].filter(([p])=>p.startsWith('dist/service/')).map(([p,b])=>[p,sha256(b)])),
    hostEntrypointSha256:sha256(host),dependencyGraphSha256:JSON.parse(readFileSync(f.options.selectedPair.path)).applicationDependencies.dependencyGraphSha256,
    helpers:{...helperHashes,...(schemaMigration?{}:{'operator_rehearsal.py':sha256('synthetic operator')})},runtime:{agentVersion:'2026.9.8',agentNodeSha256:'2'.repeat(64)},workspaceEpoch:f.descriptor.operation.workspaceEpoch};
  if(schemaMigration)binding.applicationTransition={format:1,kind:'schema-55-to-60-same-runtime',fromSchemaVersion:55,toSchemaVersion:60,apiVersion:1,fromAgentVersion:'2026.9.8',toAgentVersion:'2026.9.8'};
  const names=['producer','parent',...Object.keys(sources).map(n=>'source/'+n),'review','originalPlan','executionIntent','technicalReview','originalIntention','childResult','outsideClosure','restorationIntent','restorationCompleted','effectiveProfile','negativeVerifierSource','negativeVerifierResult',...HOME_CAPTURE_ROLES.map(n=>'homeCapture/'+n),...STARTUP_SCENARIOS.flatMap(n=>['started','process','ready','closed','preservation','bootstrap','clock-attribution'].map(r=>n+'/'+r))];
  const references=Object.fromEntries(names.map(n=>[n,{path:'/fixture/evidence/'+n+'.json',sha256:sha256(n),bytes:1}]));
  references.parent={...parent,bytes:1};references.producer={...producer,bytes:1};
  for(const [name,sha256]of Object.entries(sources))references['source/'+name]={path:'/fixture/sources/'+name,sha256,bytes:1};
  const op=f.descriptor.operation.id;
  const proof={format:1,kind:'actual-retained-startup-qualification-observation',readOnly:true,hostEffects:false,request,requestSha256:digest(request),
    sourceHashes:sources,scope:'retained-same-runtime-startup-restart-restoration',qualificationOperationId:op,qualificationBinding:binding,
    ...([QUALIFIED_STARTUP_SOURCES['qualified-startup.py'],'bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58'].includes(sources['qualified-startup.py'])?
      {baselineLineage:'verified-pre-swap-aborted-operator-snapshot'}:{}),
    actualSettledQualification:true,independentOriginalRestored:true,completeMaintainedSavedAndNativeState:true,heldBootstrapVerified:true,
    workerClosed:true,workerIdentity:{pid:123,startTicks:456,controlGroup:'/system.slice/nova-qa-qualified-'+op+'.service'},
    productionAdmission:false,freshFullRehearsalStillRequired:true,liveAcceptanceStillRequired:true,references,
    scenarios:STARTUP_SCENARIOS.map((scenario,i)=>({scenario,candidateId:i===2?prior.id:candidates.private.id,startedAtSeconds:100+i*100,closedAtSeconds:150+i*100,
      ...([QUALIFIED_STARTUP_SOURCES['qualified-startup.py'],'bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58'].includes(sources['qualified-startup.py'])?{
        captureRetirement:{kind:'closed-9.8-capture-retirement',beforeSha256:sha256('before'+i),closedSha256:sha256('closed'+i),
          roles:[{roleSha256:sha256('sample capture path'),headerSha256:sha256('synthetic header'),contextSha256:sha256('synthetic neighbors'),
            physicalOwner:['2',i===2?'20':'10'],proofSha256:sha256(i===2?'new prior proof':'original target proof'),
            firstWindow:i===2?[300,350]:[100,150]}]}}:{}),
      ...([QUALIFIED_STARTUP_SOURCES['qualified-startup.py'],'bf65b3f46cdabb5272c7bc2a6824fd242b46d761255f2633887a6f9b61b3fd58','9a30fd20d3a8321d763abba55dfc9ba55818d27984b1aa0337f3a17c0607554b','0a45ca346ec848ec8b17a0f1dcab43314ae344b12b5f8a0144f518d05144f3f5','3c433ce80cf48a2988f2fac3818429174b1bcedbdc78bbcc01bee75e3a9479af'].includes(sources['qualified-startup.py'])?{replicaConfigObservation:{kind:'closed-selected-replica-config-observation',
        sourceDevice:1,replicaDevice:2,observations:[{mode:'unchanged-original-record',changedFields:[]}],
        queueExpiry:{ordinaryAcknowledgements:0,authenticatedStartSeconds:i===1?100:100+i*100,retentionDays:30}}}:{})}))};
  if(sources['qualified-startup.py']===QUALIFIED_STARTUP_SOURCES['qualified-startup.py']){
    proof.references.baselineManifest={path:'/fixture/evidence/snapshot-manifest.json',sha256:sha256('original complete manifest'),bytes:1};
    for(const [i,scenario] of proof.scenarios.entries()){
      scenario.captureRetirement.kind='closed-9.8-capture-lifecycle';
      for(const role of scenario.captureRetirement.roles)Object.assign(role,{state:'retired',reaped:false,
        remainingNamespaces:null,remainingCount:null,remainingSha256:null,sourceAdmissionsSha256:null,
        predecessorProofSha256:i===1?proof.scenarios[0].captureRetirement.roles[0].proofSha256:null,
        lastWindow:[scenario.startedAtSeconds,scenario.closedAtSeconds]});
    }
  }
  return{...f,sources,options,proof,candidates,prior,helperHashes,transportOptions:{...f.options,format:5,mode:'retained-startup-qualified-native-successor',startupQualification:options},
    assertion:{operation:f.descriptor.operation,prior,candidates,artifacts:f.artifacts,helpers:helperHashes,dependencyGraphSha256:binding.dependencyGraphSha256}};
}
