import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createArtifactAdapter} from '../scripts/release-delivery-artifact-adapter.mjs';
import {sha256} from '../scripts/release-plan.mjs';

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'nova-artifact-transport-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let sequence=0;
  const put=raw=>{const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(JSON.stringify(raw));const path=join(root,String(sequence++)+'.json');writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
  const tool=put(Buffer.from('synthetic tool; never executed'));
  const tools={git:tool,node:tool,python:tool};
  const sources=Object.fromEntries(['private','public'].map((side,index)=>[side,{repository:'HatimTheDream/'+(side==='private'?'Nova-Dream':'Nova-Dream-Public'),commit:String(index+1).repeat(40),root}]));
  const descriptor={operation:{id:'synthetic-operation',version:'2.9.6',buildVersion:'1.0.300'},sources};
  const prior=Object.fromEntries(['private','public'].map((side,index)=>[side+'-ci',{sourceCommit:sources[side].commit,runId:123+index,runAttempt:1,release:{id:80+index}}]));
  const adapter=createArtifactAdapter({tools,command:()=>assert.fail('No command/network effects'),storeReceipt:()=>assert.fail('No writes through producer')});
  const input=await adapter.input({descriptor,prior});
  const context={descriptor,intent:{key:'synthetic-key',inputSha256:'a'.repeat(64),input}};
  const repositories={};
  for(const side of ['private','public']){
    const archive=put(Buffer.from('synthetic archive')),metadata=put({}),ciSourceReceipt=put({sourceCommit:sources[side].commit}),zip=put(Buffer.from('synthetic ZIP'));
    repositories[side]={repository:sources[side].repository,sourceCommit:sources[side].commit,runId:prior[side+'-ci'].runId,runAttempt:1,archive,metadata,ciSourceReceipt,zip};
  }
  const privateRow=repositories.private;
  const manifest={repository:{fullName:privateRow.repository,private:true},sourceCommit:privateRow.sourceCommit,run:{id:123,attempt:1},release:{id:80},
    qualityJob:{id:10},producerJob:{id:11},ciSourceSha256:privateRow.ciSourceReceipt.sha256,archive:{name:'exact.zip',sha256:privateRow.zip.sha256,bytes:13},buildOrigin:'same-run-release-job'};
  privateRow.releaseAssetId=81;
  privateRow.transport={kind:'private-release-asset',releaseId:80,releaseAssetId:81,assetName:'exact.zip',assetApiDigest:'sha256:'+privateRow.zip.sha256,
    zipBytes:13,transportAssetId:82,receipt:put(manifest),qualityJobId:10,producerJobId:11,authenticatedDownloadVerified:true,buildOrigin:'same-run-release-job'};
  repositories.public.artifactId=90;
  const output={kind:'nova-delivery-authenticated-artifacts',key:context.intent.key,operationId:descriptor.operation.id,inputSha256:context.intent.inputSha256,
    authenticatedGithubCollection:true,rebuilt:false,repositories};
  const result=value=>({state:'completed',output:value,receipt:put(value)});
  return{adapter,descriptor,input,context,output,result,manifest,put};
}

test('artifact input selects private release explicitly and refuses route downgrade or public redirection',async t=>{
  const f=await fixture(t);
  assert.equal(f.input.ci.private.transport,'private-release-asset');assert.equal(f.input.ci.private.releaseId,80);
  assert.equal(f.input.ci.public.transport,'actions-artifact');
  f.adapter.validate({descriptor:f.descriptor,input:f.input});
  for(const side of ['private','public']){
    const changed=structuredClone(f.input);changed.ci[side].transport=side==='private'?'actions-artifact':'private-release-asset';
    assert.throws(()=>f.adapter.validate({descriptor:f.descriptor,input:changed}),/artifact-ci-input-changed/);
  }
});

test('artifact result preserves distinct release IDs and verifies private transport proof',async t=>{
  const f=await fixture(t);
  await f.adapter.verify(f.result(f.output),f.context);
  for(const change of [p=>{p.artifactId=81;},p=>{p.transport.releaseId=999;},p=>{p.transport.assetApiDigest='sha256:'+'0'.repeat(64);},
    p=>{p.transport.qualityJobId=p.transport.producerJobId;},p=>{p.transport.authenticatedDownloadVerified=false;},p=>{p.transport.zipBytes=14;}]){
    const changed=structuredClone(f.output);change(changed.repositories.private);
    await assert.rejects(f.adapter.verify(f.result(changed),f.context),/artifact-release-transport-changed/);
  }
  const changed=structuredClone(f.output);changed.repositories.public.releaseAssetId=90;
  await assert.rejects(f.adapter.verify(f.result(changed),f.context),/artifact-public-transport-changed/);
  const otherAttempt=structuredClone(f.output);otherAttempt.repositories.private.runAttempt=2;
  const otherManifest=structuredClone(f.manifest);otherManifest.run.attempt=2;
  otherAttempt.repositories.private.transport.receipt=f.put(otherManifest);
  await assert.rejects(f.adapter.verify(f.result(otherAttempt),f.context),/artifact-source-changed/);
});

test('a replaced transport receipt cannot recertify another source or CI producer',async t=>{
  const f=await fixture(t);
  for(const change of [m=>{m.sourceCommit='f'.repeat(40);},m=>{m.run.attempt=2;},m=>{m.producerJob.id=999;},m=>{m.repository.private=false;},
    m=>{m.ciSourceSha256='0'.repeat(64);},m=>{m.archive.sha256='0'.repeat(64);},m=>{m.buildOrigin='quality-job';}]){
    const manifest=structuredClone(f.manifest);change(manifest);
    const changed=structuredClone(f.output);changed.repositories.private.transport.receipt=f.put(manifest);
    await assert.rejects(f.adapter.verify(f.result(changed),f.context),/artifact-release-transport-changed/);
  }
});
