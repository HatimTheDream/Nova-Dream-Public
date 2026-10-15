/** Synthetic admission data only; never an actual runtime qualification. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
import {verifyCandidate} from '../scripts/candidate.mjs';
import {QUALIFIED_RUNTIME_RUNNER,QUALIFIED_RUNTIME_MATERIALIZER} from '../scripts/release-delivery-runtime-retained.mjs';
import {dependencyFixture,raw} from './dependency-transport-fixture.mjs';
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)+'\n';
export function runtimeCommandFixture(t){
 const f=dependencyFixture(t,{format:2});
 const path=join(f.base.directory,'dist/service/apps/service/main.js');
 f.put(path,readFileSync(join(f.artifacts.private.directory,'dist/service/apps/service/main.js')));
 const manifest=JSON.parse(readFileSync(f.base.manifest.path));manifest.artifacts.find(x=>x.path==='dist/service/apps/service/main.js').sha256=sha256(readFileSync(path));
 f.base.manifest=f.put(f.base.manifest.path,manifest);f.base.candidateId=verifyCandidate(f.base.directory).id;
 const pair=JSON.parse(readFileSync(f.options.selectedPair.path));pair.candidateId=f.base.candidateId;
 f.options.selectedPair=f.put(f.options.selectedPair.path,pair);
 const installed=JSON.parse(readFileSync(f.options.selectedInstaller.path));installed.candidateId=f.base.candidateId;
 f.options.selectedInstaller=f.put(f.options.selectedInstaller.path,installed);
 const bundle=JSON.parse(readFileSync(f.options.selectedBundle.path)),member=bundle.files.find(x=>x.name==='reviewed-pair.json');
 member.data=readFileSync(f.options.selectedPair.path).toString('base64');member.sha256=f.options.selectedPair.sha256;
 f.options.selectedBundle=f.put(f.options.selectedBundle.path,bundle);
 const native=JSON.parse(readFileSync(f.options.nativeInput.path));Object.assign(native,{acceptedPair:f.options.selectedPair,acceptedInstaller:f.options.selectedInstaller,acceptedBundle:f.options.selectedBundle,acceptedCandidate:f.base.candidateId});
 f.options.nativeInput=f.put(f.options.nativeInput.path,native);
 const nativeAnchor={directory:f.base.directory,candidateId:f.base.candidateId,manifest:f.base.manifest},selected={directory:f.publicBase.directory,candidateId:f.publicBase.candidateId,manifest:f.publicBase.manifest};
 const descriptor=structuredClone(f.descriptor);descriptor.operation.priorCandidateId=selected.candidateId;descriptor.operation.priorAgentVersion='2026.9.6';descriptor.operation.changeClass='runtime';
 const route={...f.route,baseCandidateId:selected.candidateId};
 const root='/opt/nova-release-tools/synthetic-runtime',parent={path:root+'/evidence/parent-verified.json',sha256:'1'.repeat(64)},producer={path:root+'/fresh-runtime-held.py',sha256:QUALIFIED_RUNTIME_RUNNER};
 const options={format:1,parent,producer},request={format:1,kind:'collect-actual-retained-runtime-proof',parent,producer};
 const archive=f.put(join(f.root,'synthetic-runtime.tgz'),Buffer.from('synthetic-runtime'));
 const runtime={format:1,fromVersion:'2026.9.6',toVersion:'2026.9.8',archiveSha256:archive.sha256,archiveBytes:17,expandedBytes:100,fileCount:1,nodeVersion:'24.21.0',nodeSha256:'2'.repeat(64),companion:{pluginVersion:'2026.9.8',codexVersion:'0.158.0',packageLockSha256:'3'.repeat(64),binarySha256:'4'.repeat(64)}};
 const metadata=f.put(join(f.root,'runtime-description.json'),runtime);
 const helperHashes=Object.fromEntries(bundle.files.filter(x=>x.name.endsWith('.py')||x.name==='verify-session-bindings.mjs').map(x=>[x.name,x.sha256]));helperHashes['operator_rehearsal.py']='5'.repeat(64);
 const names=['producer','parent','review','originalPlan','executionIntent','technicalReview','originalIntention','acceptedSourceProof','childResult','outsideClosure','migrationIntent','migrationCompleted','nativeMigrationVerified','nativeMigrationLog','companionInstallLog','restorationIntent','restorationCompleted','acceptedRequest','acceptedResult','acceptedBundle','acceptedHostConfiguration','runtimeDescription','cacheReceipt','cacheManifest',...['target-first-start','target-restart','prior-rollback'].flatMap(x=>['started','process','ready','closed','preservation'].map(y=>x+'/'+y))];
 const references=Object.fromEntries(names.map(n=>[n,{path:root+'/'+n+'.json',sha256:sha256(n),bytes:1}]));references.parent={...parent,bytes:1};references.producer={...producer,bytes:1};references.acceptedResult.sha256=f.options.selectedInstaller.sha256;
 const nativeCandidate=verifyCandidate(f.base.directory);
 const proof={format:1,kind:'actual-retained-runtime-qualification-observation',readOnly:true,hostEffects:false,request,requestSha256:sha256(canonical(request)),runnerSha256:QUALIFIED_RUNTIME_RUNNER,materializerSha256:QUALIFIED_RUNTIME_MATERIALIZER,
  qualificationOperationId:'6f95cac9-8a3e-4f17-9f85-0a34bd630765',workspaceEpoch:descriptor.operation.workspaceEpoch,fromVersion:'2026.9.6',toVersion:'2026.9.8',scope:'retained-96-to-98-startup-restart-restoration',
  prior:{candidateId:selected.candidateId,path:'/opt/nova/releases/synthetic-prior',version:'2.3.5'},qualifiedTarget:{candidateId:nativeAnchor.candidateId,path:'/opt/nova/releases/synthetic-native-anchor',version:'2.3.5'},
  acceptedSource:{target:{candidateId:nativeAnchor.candidateId},bundle:f.options.selectedBundle},qualifiedPair:pair,qualifiedPackage:f.base.pkg,
  qualifiedPackageSha256:sha256(readFileSync(join(f.base.directory,'package.json'))),qualifiedServiceArtifacts:Object.fromEntries([...nativeCandidate.bytes].filter(([p])=>p.startsWith('dist/service/')).map(([p,b])=>[p,sha256(b)])),
  helpers:helperHashes,runtime,scenarios:['target-first-start','target-restart','prior-rollback'].map(scenario=>({scenario,candidateId:scenario==='prior-rollback'?selected.candidateId:nativeAnchor.candidateId})),references,
  actualSettledQualification:true,independentOriginalRestored:true,productionAdmission:false,freshFullRehearsalStillRequired:true,liveAcceptanceStillRequired:true};
 const transportOptions={...f.options,format:3,mode:'retained-runtime-qualified-native-successor',nativeAnchor,runtimeQualification:options,runtime:{archive,metadata}};
 return{...f,descriptor,route,selected,nativeAnchor,runtime,proof,runtimeOptions:options,transportOptions,input:{route,artifacts:f.artifacts},qualified:verifyCandidate(nativeAnchor.directory),priorCandidate:verifyCandidate(selected.directory)};
}
