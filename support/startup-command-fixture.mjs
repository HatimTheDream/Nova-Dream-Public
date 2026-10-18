/** Synthetic source bindings for pure checks; never actual qualification. */
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {sha256} from '../scripts/release-plan.mjs';
import {verifyCandidate} from '../scripts/candidate.mjs';
import {dependencyFixture} from './dependency-transport-fixture.mjs';
import {STARTUP_SCENARIOS,startupRetainedRequest} from '../scripts/release-delivery-startup-retained.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>sha256(Buffer.from(canonical(v)+'\n'));
export function startupCommandFixture(t,{sources}={}){
  const f=dependencyFixture(t,{format:4,change:'startup',includeHost:true});
  sources??=Object.fromEntries(['qualified-startup.py','qualified-parent.py','produce-startup-inputs.py','contracts.py'].map(n=>[n,sha256(n)]));
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
    helpers:{...helperHashes,'operator_rehearsal.py':sha256('synthetic operator')},runtime:{agentVersion:'2026.9.8',agentNodeSha256:'2'.repeat(64)},workspaceEpoch:f.descriptor.operation.workspaceEpoch};
  const names=['producer','parent',...Object.keys(sources).map(n=>'source/'+n),'review','originalPlan','executionIntent','technicalReview','originalIntention','childResult','outsideClosure','restorationIntent','restorationCompleted','effectiveProfile','negativeVerifierSource','negativeVerifierResult',...STARTUP_SCENARIOS.flatMap(n=>['started','process','ready','closed','preservation','bootstrap','clock-attribution'].map(r=>n+'/'+r))];
  const references=Object.fromEntries(names.map(n=>[n,{path:'/fixture/evidence/'+n+'.json',sha256:sha256(n),bytes:1}]));
  references.parent={...parent,bytes:1};references.producer={...producer,bytes:1};
  for(const [name,sha256]of Object.entries(sources))references['source/'+name]={path:'/fixture/sources/'+name,sha256,bytes:1};
  const op=f.descriptor.operation.id;
  const proof={format:1,kind:'actual-retained-startup-qualification-observation',readOnly:true,hostEffects:false,request,requestSha256:digest(request),
    sourceHashes:sources,scope:'retained-same-runtime-startup-restart-restoration',qualificationOperationId:op,qualificationBinding:binding,
    actualSettledQualification:true,independentOriginalRestored:true,completeMaintainedSavedAndNativeState:true,heldBootstrapVerified:true,
    workerClosed:true,workerIdentity:{pid:123,startTicks:456,controlGroup:'/system.slice/nova-qa-qualified-'+op+'.service'},
    productionAdmission:false,freshFullRehearsalStillRequired:true,liveAcceptanceStillRequired:true,references,
    scenarios:STARTUP_SCENARIOS.map((scenario,i)=>({scenario,candidateId:i===2?prior.id:candidates.private.id,startedAtSeconds:100+i*100,closedAtSeconds:150+i*100}))};
  return{...f,sources,options,proof,candidates,prior,helperHashes,transportOptions:{...f.options,format:5,mode:'retained-startup-qualified-native-successor',startupQualification:options},
    assertion:{operation:f.descriptor.operation,prior,candidates,artifacts:f.artifacts,helpers:helperHashes,dependencyGraphSha256:binding.dependencyGraphSha256}};
}
