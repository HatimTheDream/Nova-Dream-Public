import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontendPublicationInput, verifyFrontendPublicationInput, retainedFrontendPublication } from '../scripts/release-delivery-frontend.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

function fixture() {
  const root = fileURLToPath(new URL(`../support/fixtures/frontend-input-${randomUUID()}/`, import.meta.url));mkdirSync(root,{recursive:true});
  const put=(name,bytes)=>{const path=join(root,name);writeFileSync(path,bytes);return {path,sha256:sha256(bytes)};};
  // Retained public key from an earlier disposable fixture; no private key or signing.
  const publicKey=put('public.pem',readFileSync(new URL('../support/frontend-publication-test-public.pem',import.meta.url)));
  const ref=put('tool',Buffer.from('tool identity fixture, never executed'));
  const files=[{path:'.vite/manifest.json',bytes:2,sha256:sha256('{}')},{path:'index.html',bytes:7,sha256:sha256('<html/>')}];
  const archive=put('archive.tgz',Buffer.from('archive fixture')),frontendId=sha256(JSON.stringify(files));
  const manifest=put('manifest.json',Buffer.from(JSON.stringify({format:1,kind:'frontend',channel:'frontend-stable',sequence:1,createdAt:'2026-10-13T00:00:00.000Z',expiresAt:'2026-10-14T00:00:00.000Z',frontendId,frontendVersion:'2.3.1',frontendBuildVersion:'1.0.288',sourceRevision:'a'.repeat(40),base:{candidateId:'b'.repeat(64),serviceInputsSha256:'c'.repeat(64),apiVersion:1,schemaVersion:55},artifact:{url:'https://github.com/HatimTheDream/Nova-Dream-Public/releases/download/v2.3.1/nova-2.3.1-frontend.tgz',sha256:archive.sha256,bytes:15},files})+'\n'));
  const signed={route:'frontend',manifest,archive,signature:put('signature.sig',Buffer.alloc(64)),publicKey,sequence:1,frontendId};
  const descriptor={operation:{id:randomUUID(),version:'2.3.1',buildVersion:'1.0.288',priorCandidateId:'b'.repeat(64),trustedPublicKeySha256:publicKey.sha256},sources:{private:{commit:'a'.repeat(40)},public:{commit:'d'.repeat(40)}}};
  const prior={route:{route:'frontend',serviceInputsSha256:'c'.repeat(64)},package:{manifest,archive},sign:signed};
  const context={descriptor,prior,tools:{git:ref,python:ref,node:ref,gitExecPath:root},releaseIds:{private:1,public:2}};
  return {...context,root,input:frontendPublicationInput(context)};
}
test('publication derives exact original sources, service and signed bytes without manual evidence',()=>{const f=fixture();assert.equal(f.input.baseCandidateId,f.descriptor.operation.priorCandidateId);assert.deepEqual(f.input.signed,f.prior.sign);assert.equal('review' in f.input,false);});
test('invalid signature refuses before command or publication',()=>{const f=fixture();assert.throws(()=>verifyFrontendPublicationInput(f.input,f.descriptor),/signature-invalid/);});
test('wrong service, source, helper or key identity refuses before signature acceptance',()=>{
  for(const mutate of [f=>f.input.baseCandidateId='e'.repeat(64),f=>f.input.sourceCommits.public='e'.repeat(40),f=>f.input.helperHashes['release-delivery-frontend.py']='e'.repeat(64),f=>f.input.trustedPublicKeySha256='e'.repeat(64)]){const f=fixture();mutate(f);assert.throws(()=>verifyFrontendPublicationInput(f.input,f.descriptor),/changed/);}
});
test('unsigned replacement package and full route are refused before publication',()=>{const f=fixture();f.prior.package.manifest={...f.prior.sign.manifest,sha256:'0'.repeat(64)};assert.throws(()=>frontendPublicationInput(f),/signed-package-input-changed/);f.prior.route.route='full';assert.throws(()=>frontendPublicationInput(f),/route-required/);});
test('durable aggregate survives lost parent response with original readback identity',()=>{
  const f=fixture(),key=randomUUID(),context={descriptor:f.descriptor,intent:{key,input:f.input,inputSha256:'9'.repeat(64)},journal:{directory:f.root}};
  const specs=['archive','manifest','signature'].map(role=>({role,...f.input.signed[role],name:`nova-2.3.1-frontend.${{archive:'tgz',manifest:'json',signature:'sig'}[role]}`,bytes:readFileSync(f.input.signed[role].path).length}));
  const assets=specs.map((spec,i)=>{const directory=join(f.root,`frontend-publication-${key}-${spec.role}`,'first','0-readback');mkdirSync(directory,{recursive:true});const path=join(directory,spec.name);writeFileSync(path,readFileSync(spec.path));return {operationId:f.descriptor.operation.id,key,inputSha256:context.intent.inputSha256,role:spec.role,asset:{id:i+100,name:spec.name,bytes:spec.bytes,sha256:spec.sha256,authenticatedDownloadVerified:true,adoptedExisting:false,localPath:path}};});
  const output={kind:'nova-delivery-frontend-publication',operationId:f.descriptor.operation.id,key,inputSha256:context.intent.inputSha256,frontendId:f.input.signed.frontendId,releaseIds:f.releaseIds,assets,hostEffects:false,savedReplyAccepted:false,browserAccepted:false};
  const directory=join(f.root,'delivery-evidence');mkdirSync(directory);const path=join(directory,`${key}-frontend-publication.json`),bytes=Buffer.from(JSON.stringify(output)+'\n');writeFileSync(path,bytes);
  const original=retainedFrontendPublication(context,specs,f.releaseIds),resumed=retainedFrontendPublication(context,specs,f.releaseIds);
  assert.deepEqual(resumed,original);assert.equal(resumed.receipt.sha256,sha256(bytes));assert.deepEqual(readFileSync(path),bytes);
  assert.equal(resumed.output.assets[0].asset.localPath,assets[0].asset.localPath);
  writeFileSync(assets[0].asset.localPath,'changed');assert.throws(()=>retainedFrontendPublication(context,specs,f.releaseIds),/changed|hash|Hash/);
});
