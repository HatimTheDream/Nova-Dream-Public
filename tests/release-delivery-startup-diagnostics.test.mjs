import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {collectStartupWithDiagnostics} from '../scripts/release-delivery-adapters.mjs';
import {createMaintainedDependencyTransport} from '../scripts/release-delivery-dependency-transport.mjs';
import {QUALIFIED_STARTUP_SOURCES} from '../scripts/release-delivery-startup-retained.mjs';
import {startupCommandFixture} from '../support/startup-command-fixture.mjs';
function fixture(t){
 const f=startupCommandFixture(t,{schemaMigration:true,sources:QUALIFIED_STARTUP_SOURCES});
 const ssh=f.put(join(f.root,'diagnostic-ssh'),Buffer.from('Host fixture\n'));
 const transport=f.put(join(f.root,'diagnostic-transport.json'),{format:1,sshConfig:ssh,hostAlias:'fixture'});
 return{...f,transport,context:{journal:f.journal,descriptor:f.descriptor},now:1_800_000_000_000};
}
test('failed startup transport keeps bounded private diagnostics while preserving the rejection',async t=>{
 const f=fixture(t),stdout='x'.repeat(524289),stderr='y'.repeat(4097);let calls=0;
 await assert.rejects(collectStartupWithDiagnostics(f.context,{transport:f.transport,options:f.options,clock:()=>f.now,run:async(_target,_program,options)=>{
  calls++;assert.deepEqual(options,{captureDiagnostics:true});return{exitCode:1,uncertain:true,diagnosticsTruncated:true,stdout,stderr};
 }}),error=>{
  assert.equal(error.message,'actual-startup-proof-observation-unavailable');assert.ok(error.startupResponseReceipt.path.startsWith(join(f.root,'delivery-evidence')));
  const proof=JSON.parse(readFileSync(error.startupResponseReceipt.path));assert.equal(proof.kind,'operator-startup-transport-failure');assert.equal(proof.operationId,f.descriptor.operation.id);
  assert.equal(proof.exitCode,1);assert.equal(proof.uncertain,true);assert.equal(proof.diagnosticsTruncated,true);assert.equal(proof.hostWrites,false);
  assert.equal(proof.stdoutBytes,stdout.length);assert.equal(proof.stderrBytes,stderr.length);assert.equal(proof.stdoutTruncated,true);assert.equal(proof.stderrTruncated,true);
  assert.equal(Buffer.from(proof.stdoutRawBase64,'base64').length,524288);assert.equal(Buffer.from(proof.stderrRawBase64,'base64').length,4096);return true;
 });assert.equal(calls,1);
});
test('dependency startup collector receives actual journal context before failed qualification',async t=>{
 const f=fixture(t);let received;
 const transport=createMaintainedDependencyTransport({options:f.transportOptions,base:f.base,run:async()=>assert.fail('No worker command permitted'),startupSources:f.sources,
  startupCollector:async context=>{received=context;return collectStartupWithDiagnostics(context,{transport:f.transport,options:f.options,clock:()=>f.now,run:async()=>({exitCode:1,stdout:'',stderr:'synthetic transport refusal'})});}});
 await assert.rejects(transport.validate(f.context),error=>{assert.equal(error.message,'actual-startup-proof-observation-unavailable');const proof=JSON.parse(readFileSync(error.startupResponseReceipt.path));assert.equal(Buffer.from(proof.stderrRawBase64,'base64').toString(),'synthetic transport refusal');return true;});
 assert.equal(received,f.context);
});
test('valid startup observation returns the existing proof and creates no failure evidence',async t=>{
 const f=fixture(t),before=readdirSync(f.root);
 const proof=await collectStartupWithDiagnostics(f.context,{transport:f.transport,options:f.options,clock:()=>f.now,run:async()=>({exitCode:0,stdout:JSON.stringify({ok:true,value:{...f.proof,observedAtMilliseconds:f.now}}),stderr:''})});
 assert.deepEqual(proof,f.proof);assert.deepEqual(readdirSync(f.root),before);
});
