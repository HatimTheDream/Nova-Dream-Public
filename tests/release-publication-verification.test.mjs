import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {sha256} from '../scripts/release-plan.mjs';
import {validateJournalDirectory} from '../scripts/release-coordinate.mjs';
import {FULL_HELPERS,verifyFullPremaintenance} from '../scripts/release-delivery-full-host.mjs';
import {createFullPublicationAdapter,fullPublicationHelpers,verifyFullPublicationInput} from '../scripts/release-delivery-full-publication.mjs';
import {withVerificationPass,verificationEffect} from '../scripts/release-verification-pass.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';

function fixture(t){
 const root=fs.mkdtempSync(join(tmpdir(),'nova-publication-verification-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=(name,v)=>{const path=join(root,name),b=Buffer.isBuffer(v)?v:Buffer.from(JSON.stringify(v)+'\n');fs.writeFileSync(path,b);return{path,sha256:sha256(b)};};
 const {descriptor:original,completed,values}=fullHostFixture(),descriptor=structuredClone(original);
 const sourceCommits={private:'a'.repeat(40),public:'b'.repeat(40)};
 descriptor.operation={...descriptor.operation,id:randomUUID(),version:'2.5.0',buildVersion:'1.0.294',candidateId:'e'.repeat(64),sourceCommits};
 descriptor.sources=Object.fromEntries(['private','public'].map(side=>[side,{commit:sourceCommits[side],root:join(root,side)}]));
 const files=Object.entries(FULL_HELPERS).filter(([name])=>name!=='operator_rehearsal.py').map(([name,sha256])=>({name,sha256,data:fs.readFileSync(new URL('../deploy/update-runner/'+name,import.meta.url)).toString('base64')}));
 files.push({name:'app.tgz',data:''},{name:'reviewed-pair.json',data:''});
 const bundle=put('bundle.json',{files}),archive=put('dependencies.tgz',Buffer.from('synthetic complete dependency bytes'));
 const description={archiveBytes:fs.statSync(archive.path).size,archiveSha256:archive.sha256},metadata=put('dependencies.metadata.json',description),nativeQualification=put('native.json',{synthetic:true});
 const qualification=put('qualification.json',{passed:true,everyRetainedMemberIdentical:true,newNativeExecutionClaimed:false,newTargetStartupClaimed:false,freshFullRehearsalStillRequired:true,archive,metadata,description,originalNativeQualificationReused:nativeQualification});
 const dependencies={archive,metadata,description,nativeQualification,qualification,unchangedNativeDependencies:true};
 const keys=generateKeyPairSync('ed25519'),publicKey=put('public.pem',Buffer.from(keys.publicKey.export({format:'pem',type:'spki'})));
 descriptor.operation.trustedPublicKeySha256=publicKey.sha256;
 const op=descriptor.operation,release={candidateId:op.candidateId,fromCandidateId:op.priorCandidateId,novaVersion:op.version,agentVersion:op.agentVersion,bundle:{sha256:bundle.sha256,bytes:fs.statSync(bundle.path).size},applicationDependenciesBundle:{sha256:archive.sha256,bytes:description.archiveBytes}};
 const now=Date.now(),manifest={channel:'stable',sequence:4,createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),releases:[release]},payload=Buffer.from(JSON.stringify(manifest));
 const signedFeed=put('signed.json',{payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')});
 const ledgerDirectory=join(root,'ledger');validateJournalDirectory(ledgerDirectory,{create:true});
 const input={operationId:op.id,version:op.version,buildVersion:op.buildVersion,priorCandidateId:op.priorCandidateId,trustedPublicKeySha256:publicKey.sha256,sourceCommits,sources:descriptor.sources,
  signed:{route:'full',candidateId:op.candidateId,priorCandidateId:op.priorCandidateId,sourceCommits,bundle,dependencies,publicKey,signedFeed,channel:'stable',sequence:4,release},
  capacity:{targetCandidateId:op.candidateId},recovery:{completion:completed,values},helperHashes:fullPublicationHelpers(),ledgerDirectory,releaseIds:{private:1,public:2},
  tools:Object.fromEntries(['node','python','git'].map(name=>[name,put(name,Buffer.from('synthetic '+name))])),previousFeed:put('previous.json',{}),applicationArchive:put('app.tgz',Buffer.from('synthetic app'))};
 return{root,input,descriptor,now,put};
}
function countOpens(t,paths){
 const original=fs.openSync,counts=Object.fromEntries(paths.map(p=>[resolve(p),0]));
 fs.openSync=function(path,...args){if(typeof path==='string'&&resolve(path)in counts)counts[resolve(path)]++;return original.call(this,path,...args);};syncBuiltinESMExports();
 t.after(()=>{fs.openSync=original;syncBuiltinESMExports();});return path=>counts[resolve(path)];
}
test('actual publication reads each archive once per pure pass and rechecks each new boundary',async t=>{
 const f=fixture(t),bundle=f.input.signed.bundle.path,archive=f.input.signed.dependencies.archive.path,reads=countOpens(t,[bundle,archive]);
 const check=c=>verifyFullPublicationInput(f.input,f.descriptor,f.now,c);
 await withVerificationPass({journal:{directory:f.root}},async c=>{
  const first=check(c);assert.equal(first.find(x=>x.role==='bundle').bytes,fs.statSync(bundle).size);
  for(let i=0;i<10;i++)assert.deepEqual(check(c),first);
  first[0].bytes=-1;assert.notEqual(check(c)[0].bytes,-1,'caller cannot poison retained facts through a returned spec');
  assert.equal(reads(bundle),1);assert.equal(reads(archive),1);
  await verificationEffect(c,async()=>{});check(c);assert.equal(reads(bundle),2);assert.equal(reads(archive),2);
 });
 await withVerificationPass({journal:{directory:f.root}},async c=>check(c));assert.equal(reads(bundle),3);assert.equal(reads(archive),3);
 t.diagnostic(JSON.stringify({pureValidations:12,bundleReads:1,dependencyReads:1,previousBundleReads:24,previousDependencyReads:24}));
});
test('feed time and ledger authority stay fresh while immutable verification is reused',async t=>{
 const f=fixture(t),c={journal:{directory:f.root}};
 await withVerificationPass(c,async c=>{
  const a=verifyFullPremaintenance(f.input,f.descriptor,f.now,c),b=verifyFullPremaintenance(f.input,f.descriptor,f.now+1,c);
  assert.equal(a.evaluatedAtMilliseconds,f.now);assert.equal(b.evaluatedAtMilliseconds,f.now+1);
  assert.throws(()=>verifyFullPublicationInput(f.input,f.descriptor,f.now+60000,c),/expired/);
  verifyFullPublicationInput(f.input,f.descriptor,f.now,c);fs.renameSync(f.input.ledgerDirectory,f.input.ledgerDirectory+'-moved');
  assert.throws(()=>verifyFullPublicationInput(f.input,f.descriptor,f.now,c),/missing/);
 });
});
test('changed operation, signature, tool, journal and artifact cannot borrow a verified input',async t=>{
 const f=fixture(t),archive=f.input.signed.dependencies.archive.path,reads=countOpens(t,[archive]);
 await withVerificationPass({journal:{directory:f.root}},async c=>{
  verifyFullPublicationInput(f.input,f.descriptor,f.now,c);
  verifyFullPublicationInput(f.input,f.descriptor,f.now,{...c,journal:{directory:f.root+'-other'}});assert.equal(reads(archive),2);
  const wrong=structuredClone(f.descriptor);wrong.operation.id=randomUUID();assert.throws(()=>verifyFullPublicationInput(f.input,wrong,f.now,c),/operation/);
  const toolChanged=structuredClone(f.input);toolChanged.tools.node.sha256='0'.repeat(64);assert.throws(()=>verifyFullPublicationInput(toolChanged,f.descriptor,f.now,c),/hash|changed/i);
  const bad=structuredClone(f.input),envelope=JSON.parse(fs.readFileSync(bad.signed.signedFeed.path));envelope.signature=Buffer.alloc(64).toString('base64');bad.signed.signedFeed=f.put('bad-signature.json',envelope);
  assert.throws(()=>verifyFullPublicationInput(bad,f.descriptor,f.now,c),/signature-invalid/);
  await verificationEffect(c,()=>fs.writeFileSync(archive,'corrupt'));
  assert.throws(()=>verifyFullPublicationInput(f.input,f.descriptor,f.now,c),/hash|changed/i);
 });
 await assert.rejects(withVerificationPass({},async c=>verifyFullPublicationInput(f.input,f.descriptor,f.now,c)),/hash|changed/i);
});


test('pending and failed publication claims skip completed-input reads; completed claims still authenticate',async t=>{
 const f=fixture(t),bundle=f.input.signed.bundle.path,archive=f.input.signed.dependencies.archive.path,reads=countOpens(t,[bundle,archive]);
 const adapter=createFullPublicationAdapter({releaseIds:f.input.releaseIds,clock:()=>f.now});
 const c={descriptor:f.descriptor,intent:{input:f.input,key:randomUUID(),inputSha256:sha256(JSON.stringify(f.input))},journal:{directory:f.root}};
 for(const state of ['uncertain','running','reserved','gap','failed']){
  const value={state,output:null,receipt:null};
  await adapter.verify(value,c);assert.equal(value.state,state);assert.equal(reads(bundle),0);assert.equal(reads(archive),0);
 }
 const completed={state:'completed',externalId:'wrong-original-operation',output:null,receipt:null};
 await assert.rejects(async()=>adapter.verify(completed,c),/full-publication-result-changed/);
 assert.equal(reads(bundle),1);assert.equal(reads(archive),1);
 const bad=structuredClone(f.input),envelope=JSON.parse(fs.readFileSync(bad.signed.signedFeed.path));
 envelope.signature=Buffer.alloc(64).toString('base64');bad.signed.signedFeed=f.put('completed-bad-signature.json',envelope);
 await assert.rejects(async()=>adapter.verify(completed,{...c,intent:{...c.intent,input:bad}}),/signature-invalid/);
 const changed=structuredClone(f.descriptor);changed.operation.id=randomUUID();
 await assert.rejects(async()=>adapter.verify(completed,{...c,descriptor:changed}),/operation/);
});
