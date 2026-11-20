import {join} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
import {DEPENDENCY_PACK_PROBE_SHA} from '../scripts/release-delivery-qualified-dependencies.mjs';

export function dependencyCorrectionFixture(save,directory,host,operation){
  const helper=save('native-helper',Buffer.from('fixture')), graph=sha256('graph'),candidate=operation.priorCandidateId;
  const runtime={node:'/bin/node',nodeSha256:sha256('node')};
  const identity={platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127};
  const capture=suffix=>{
    const packageRef=save(suffix+'/package.json',{name:'fixture',version:suffix});
    const lockRef=save(suffix+'/package-lock.json',{lock:suffix});
    const archive=save(suffix+'/archive',Buffer.from(suffix));
    const description={format:1,...identity,archiveBytes:suffix.length,archiveSha256:archive.sha256,expandedBytes:12,fileCount:1,packageLockSha256:lockRef.sha256,dependencyGraphSha256:graph};
    const metadata=save(suffix+'/metadata',description);
    const remote={path:'/fixture/source',sha256:sha256(suffix),bytes:1},inventory=sha256('tree');
    const execution=save(suffix+'/execution',{format:1,kind:'qualified-application-dependency-pack',producerSha256:helper.sha256,
      node:{...identity,path:runtime.node,sha256:runtime.nodeSha256},execution:{probeSha256:DEPENDENCY_PACK_PROBE_SHA,identity,exitCode:0},
      source:{packageSha256:packageRef.sha256,packageLockSha256:lockRef.sha256,dependencyGraphSha256:graph,inventoryBeforeSha256:inventory,inventoryAfterSha256:inventory},
      archive:{bytes:suffix.length,sha256:archive.sha256},metadataSha256:metadata.sha256,description,planRef:remote,intentRef:remote,closureRef:remote});
    return {refs:{archive,metadata,execution},description,packageRef,lockRef};
  };
  const old=capture('old'),current=capture('new');
  const acceptedBinding={runtime,targets:{private:{candidateId:candidate,packageSha256:old.packageRef.sha256,packageLockSha256:old.lockRef.sha256,
    version:host.priorVersion,buildVersion:host.priorBuildVersion}},applicationDependencies:old.description,dependencyGraphSha256:graph,
    sameSchemaQualification:{format:1,kind:'schema-60-same-runtime',schemaVersion:60,apiVersion:1,agentVersion:'2026.9.8'}};
  const pair=save('selected-pair',{candidateId:candidate,applicationDependencies:old.description,startupQualification:{binding:acceptedBinding}});
  const installer=save('selected-installer',{candidate}),bundle=save('selected-bundle',{candidate});
  const original=save('stale-input',{kind:'metadata-only-dependency-successor',oldMetadata:save('stale-metadata',{dependencyGraphSha256:sha256('stale')})});
  const native={format:1,kind:'metadata-only-dependency-successor',helper,acceptedCandidate:candidate,
    oldArchive:old.refs.archive,oldMetadata:old.refs.metadata,nativeReceipt:old.refs.execution,acceptedPair:pair,acceptedInstaller:installer,acceptedBundle:bundle,
    targetPackage:current.packageRef,targetLock:current.lockRef,transition:{fromVersion:host.priorVersion,fromBuild:host.priorBuildVersion,toVersion:operation.version,toBuild:operation.buildVersion}};
  const correction={originalNativeInput:original,correctedNativeInput:save('corrected-input',native)};
  const transport={format:6,helper,nativeInput:original,selectedPair:pair,selectedInstaller:installer,selectedBundle:bundle,qualifiedDependencies:current.refs};
  const prior={route:{route:'full',baseCandidateId:candidate},artifacts:{repositories:{private:{applicationDirectory:join(directory,'new')}}}};
  return {correction,transport,prior,native,old,acceptedBinding};
}
