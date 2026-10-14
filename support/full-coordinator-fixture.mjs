
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture as fullFixture } from './full-fixture.mjs';
import { createFullBundleAdapter } from '../scripts/release-delivery-full.mjs';
import { buildFullCoordinatorDescriptor } from '../scripts/release-delivery-full-coordinator.mjs';
import { planRelease, sha256 } from '../scripts/release-plan.mjs';

export const now = 1791990000000; const canonical = value => JSON.stringify(value,(_k,v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
export async function coordinatorFixture(t) {
  const f = fullFixture(), parent = resolve(tmpdir());
  t.after(() => { assert.equal(dirname(f.root),parent); rmSync(f.root,{recursive:true,force:true}); });
  let count=0; const put = value => f.put(join(f.root,`coordinator-${++count}.json`),value);
  const keys = generateKeyPairSync('ed25519'), publicKey = put(Buffer.from(keys.publicKey.export({type:'spki',format:'pem'})));
  const timeline = {startedAtMs:now,original:{id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[1000,2000],confidence:'low',
    basis:'Synthetic coordinator fixture.',reason:'Original fixture deadline.',nextCheckpointAtMs:now+300000},revisions:[],reviews:[],lastCheckpointAtMs:now};
  Object.assign(f.descriptor.operation,{stage:'draft',candidateId:null,publicCandidateId:null,bundleSha256:null,workspaceEpoch:randomUUID(),trustedPublicKeySha256:publicKey.sha256,changeClass:'application',helperHashes:null});
  const op = f.descriptor.operation, pack = createFullBundleAdapter({options:f.options,pairProducer:f.pairProducer});
  const input = await pack.input({prior:f.prior}), packContext = {descriptor:f.descriptor,intent:{input,key:randomUUID()},journal:{directory:f.root}};
  await pack.validate({descriptor:f.descriptor,input}); const packaged = await pack.execute(packContext); await pack.verify(packaged,packContext);
  const prior = {...f.prior,package:packaged.output};
  const bundle = JSON.parse(readFileSync(prior.package.bundle.path));
  const helperHashes = Object.fromEntries(bundle.files.filter(x => !['app.tgz','reviewed-pair.json'].includes(x.name)).map(x => [x.name,x.sha256]));
  helperHashes['operator_rehearsal.py']=sha256('synthetic operator rehearsal');
  for(const side of ['private','public']) f.artifacts[side].sourceHashes['deploy/update-runner/operator_rehearsal.py']={sha256:helperHashes['operator_rehearsal.py']};
  for(const side of ['private','public']){
    const log=put(Buffer.from('Run npm run quality\n# fail 0\npython tests/update-runner.test.py\n'));
    const receipt=put({format:1,readOnly:true,sourceVersion:op.version,repositories:[{repository:side==='private'?'Nova-Dream':'Nova-Dream-Public',sha:op.sourceCommits[side],runs:[{id:123,
      name:side==='private'?'Nova Dream quality and release history':'Application quality',status:'completed',conclusion:'success',jobs:[{id:456,name:'quality',status:'completed',conclusion:'success',
      logSha256:log.sha256,steps:['Run npm run quality','Verify Linux update recovery'].map(name=>({name,status:'completed',conclusion:'success'}))}]}]}]});
    prior[side+'-ci']={receipt,log};
  }
  const leaseId=randomUUID(), review=put({candidateId:op.priorCandidateId,workspaceEpoch:op.workspaceEpoch,helperHashes,leaseId});
  const proofValue={kind:'operator-maintenance-acceptance',outcome:'rehearsed',candidateId:op.priorCandidateId,workspaceEpoch:op.workspaceEpoch,leaseId,
    savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true},proof=put(proofValue);
  const observation=put({observedAtMilliseconds:now,readOnlyObservation:true,completedProof:{proof:proofValue,proofSha256:proof.sha256,reviewSha256:review.sha256,originalReturned:true,nativeLeaseReleaseSettled:true},
    status:{lastPhase:'complete'},operator:{id:leaseId,phase:'released',releaseKind:'rehearsed',proofSha256:proof.sha256}});
  prior.recovery={evidence:{observation,review,proof},helperHashes};
  const manifest={sequence:2,createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),releases:[{candidateId:prior.package.candidateId,fromCandidateId:op.priorCandidateId,
    novaVersion:op.version,agentVersion:op.agentVersion,bundle:{sha256:prior.package.bundle.sha256},compatibility:{reviewed:true,fromAgentVersion:op.priorAgentVersion}}]};
  const payload=Buffer.from(JSON.stringify(manifest)),feed=put({payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')});
  prior.sign={...prior.package,signedFeed:feed,publicKey};
  const receipt=put({sequence:2,publicFeedReadVerified:true,publicFeedSha256:feed.sha256,repositories:['Nova-Dream','Nova-Dream-Public'].map((repository,i)=>({repository,pushed:true,feedSha256:feed.sha256,sequence:2,sourceCommit:op.sourceCommits[i?'public':'private']}))});
  const capacityEvidence={observation:put({observedAtMilliseconds:now,readOnly:true,workspaceEpoch:op.workspaceEpoch,health:{status:'ready',candidateId:op.priorCandidateId,agentVersion:op.priorAgentVersion},
    capacity:{lifecycle:'online',freeBytes:12*1024**3,candidateBytes:1000,snapshotCopyBytes:2000,independentRestoreBytes:4*1024**3,startupGrowthAllowanceBytes:2*1024**3,nativeMigrationBytes:0,managedCompanionBytes:0,
      metadataOverheadBytes:90*1024**2,reserveBytes:1536*1024**2,allowanceBytes:256*1024**2,metadataOverheadMeasured:true,snapshotDeltaMeasured:true}})};
  const verified={capacityEvidence,evidence:{receipt,feed,publicKey}},ssh=put(Buffer.from('Host fixture\n HostName example.invalid\n'));
  const transport=put({format:1,hostAlias:'fixture',sshConfig:ssh});f.descriptor.targetIdentity=sha256(canonical({hostAlias:'fixture',sshConfig:ssh.sha256}));
  const context={descriptor:f.descriptor,prior,intent:{key:randomUUID()},journal:{directory:f.root,deliveryTimeline:()=>({timeline})}};
  mkdirSync(join(f.root,'delivery-evidence'));
  const storeReceipt=(_j,key,name,bytes)=>{const path=join(f.root,'delivery-evidence',`${key}-${name}`);if(existsSync(path))assert.deepEqual(readFileSync(path),bytes);else writeFileSync(path,bytes,{flag:'wx'});return {path,sha256:sha256(bytes)};};
  const options={transport,base:f.base,storeReceipt,clock:()=>now};
  return {...f,prior,context,verified,options,put,timeline};
}

