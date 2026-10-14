/** Synthetic portable proof/host facts for validator tests only.
 * No private host evidence, credentials or real completed operation is copied. */
import { randomUUID } from 'node:crypto';
import { sha256 } from '../scripts/release-plan.mjs';
import { FULL_HELPERS, fullFactsSpec } from '../scripts/release-delivery-full-host.mjs';
const encoded=value=>Buffer.from(JSON.stringify(value)+'\n');
export function fullHostFixture() {
  const key=randomUUID(),epoch=randomUUID(),candidate=sha256('synthetic accepted base'),source='a'.repeat(40);
  const options={format:1,hostConfiguration:{path:'/etc/nova-update/config.json',sha256:sha256('synthetic configuration')},
    helperDirectory:'/opt/nova-release-tools/fixture-helpers',
    acceptedInstallation:{path:'/var/lib/nova-update/fixture-accepted.json',sha256:sha256('synthetic accepted installation')},
    priorVersion:'8.0.0',priorBuildVersion:'1.0.800',priorJobId:randomUUID(),stageParent:'/opt/nova-release-tools/fixture-stages',
    startupGuardFile:null,excludedIdentities:{candidateIds:[sha256('synthetic excluded candidate')],bundleSha256s:[sha256('synthetic excluded bundle')],rehearsalLeaseIds:[randomUUID()]}};
  const descriptor={operation:{id:key,priorCandidateId:candidate,workspaceEpoch:epoch,priorAgentVersion:'2026.9.8',agentVersion:'2026.9.8',changeClass:'application'},
    sources:{private:{commit:source}}};
  const spec=fullFactsSpec(descriptor,options,key),review={leaseId:spec.leaseId,candidateId:candidate,novaVersion:options.priorVersion,
    agentVersion:spec.base.agentVersion,workspaceEpoch:epoch,helperHashes:{...FULL_HELPERS},hostConfiguration:options.hostConfiguration.path};
  const facts={format:2,kind:'current-rehearsal-facts',readOnly:true,noHostWrites:true,sourceCommit:source,base:spec.base,
    acceptedInstallation:options.acceptedInstallation,observedAtMilliseconds:1700000000000,review,
    protectedHashes:{[options.hostConfiguration.path]:options.hostConfiguration.sha256,[options.acceptedInstallation.path]:options.acceptedInstallation.sha256},
    historicalClosedLeaseRetained:true,operatorStatus:{held:false,lease:{phase:'released',workspaceEpoch:epoch,id:randomUUID(),candidateId:sha256('synthetic historical base')}},
    health:{status:'ready',candidateId:candidate,version:options.priorVersion},accessContext:{workspaceEpoch:epoch}};
  const leaseId=randomUUID(),reviewSha256=sha256('synthetic reviewed rehearsal'),snapshot=sha256('synthetic snapshot manifest');
  const rootIdentity={device:1,inode:500,mode:448,uid:0};
  const values={executionUnit:'nova-test-'+randomUUID()+'.service',leaseId,candidateId:candidate,workspaceEpoch:epoch,
    files:{'operator-review.json':reviewSha256}};
  const detail={manualResumption:false,automaticRehearsalPassed:true,deliveryQualification:true,reviewSha256,leaseId,
    outcome:'rehearsed',snapshotManifestSha256:snapshot,sourceRootIdentity:rootIdentity,returnedRootIdentity:rootIdentity};
  const detailRaw=encoded(detail),proof={format:1,kind:'operator-maintenance-acceptance',outcome:'rehearsed',leaseId,
    candidateId:candidate,workspaceEpoch:epoch,evidenceSha256:sha256(detailRaw),savedWorkVerified:true,accountsVerified:true,healthVerified:true,recoveryVerified:true};
  const proofRaw=encoded(proof),operator={id:leaseId,phase:'released',releaseKind:'rehearsed',proofSha256:sha256(proofRaw)};
  const completed={format:1,readOnlyObservation:true,hostDataWritten:false,sourceSqliteOpened:false,unitName:values.executionUnit,
    unit:{LoadState:'loaded',Type:'oneshot',Restart:'no',UMask:'0077',RemainAfterExit:'yes',TimeoutStartUSec:'1h',
      ActiveState:'active',SubState:'exited',Result:'success',ExecMainStatus:'0',MainPID:'0',ControlPID:'0'},
    proofRawBase64:proofRaw.toString('base64'),evidenceRawBase64:detailRaw.toString('base64'),rehearsalEvidenceSha256:sha256(detailRaw),
    completedProof:{proof,proofSha256:sha256(proofRaw),reviewSha256,originalReturned:true,nativeLeaseReleaseSettled:true,
      automaticRehearsalPassed:true,snapshotManifestSha256:snapshot},
    status:{lastPhase:'complete',originalRootIdentity:rootIdentity,roles:{live:rootIdentity,original:null,trial:null,restore:null}},
    operator,socketStatus:{held:false,lease:structuredClone(operator)},requestFailure:null,helperHashes:{...FULL_HELPERS}};
  return {key,options,descriptor,facts,values,completed};
}
