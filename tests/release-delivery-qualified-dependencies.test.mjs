import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from '../scripts/release-plan.mjs';
import {verifyQualifiedApplicationDependencies,DEPENDENCY_PACK_PROBE_SHA} from '../scripts/release-delivery-qualified-dependencies.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'nova-qualified-dependency-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(name,value)=>{const path=join(root,name),raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,raw);return{path,sha256:sha256(raw)};};
 const archive=put('deps.tgz',Buffer.from('synthetic native archive; no execution claim outside this fixture'));
 const packageSha256=sha256('target package'),packageLockSha256=sha256('target lock'),producerSha256=sha256('pinned helper');
 const description={format:1,archiveBytes:readFileSync(archive.path).length,archiveSha256:archive.sha256,expandedBytes:100,fileCount:2,packageLockSha256,dependencyGraphSha256:sha256('different graph'),platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127};
 const metadata=put('metadata.json',description),runtime={node:'/runtime/node',nodeSha256:sha256('node22')};
 const binding={applicationTransition:{format:1,kind:'schema-55-to-60-same-runtime',fromSchemaVersion:55,toSchemaVersion:60,apiVersion:1,fromAgentVersion:'2026.9.8',toAgentVersion:'2026.9.8'},applicationDependencies:description,dependencyGraphSha256:description.dependencyGraphSha256,runtime};
 const receipt={format:1,kind:'qualified-application-dependency-pack',producerSha256,node:{path:runtime.node,sha256:runtime.nodeSha256,platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127},
  source:{packageSha256,packageLockSha256,dependencyGraphSha256:description.dependencyGraphSha256,inventoryBeforeSha256:sha256('inventory'),inventoryAfterSha256:sha256('inventory')},
  archive:{sha256:archive.sha256,bytes:description.archiveBytes},metadataSha256:metadata.sha256,description,
  execution:{probeSha256:DEPENDENCY_PACK_PROBE_SHA,identity:{platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127},exitCode:0},
  ...Object.fromEntries(['planRef','intentRef','closureRef'].map(n=>[n,{path:'/fixture/'+n+'.json',sha256:sha256(n),bytes:1}]))};
 const options={producerSha256,packageSha256,packageLockSha256},refs={archive,metadata,execution:put('execution.json',receipt)};
 return{refs,binding,options,receipt,put};
}
test('fresh dependency admission binds the exact native archive and actual startup description',t=>{
 const f=fixture(t),value=verifyQualifiedApplicationDependencies(f.refs,f.binding,f.options);
 assert.equal(value.newNativeDependenciesQualified,true);assert.equal(value.unchangedNativeDependencies,false);
 for(const change of [v=>v.producerSha256=sha256('other helper'),v=>v.node.nodeAbi=137,v=>v.node.sha256=sha256('other node'),
  v=>v.source.packageLockSha256=sha256('other lock'),v=>v.source.dependencyGraphSha256=sha256('other graph'),
  v=>v.source.inventoryAfterSha256=sha256('changed source'),v=>v.archive.bytes++,v=>v.execution.exitCode=1,
  v=>v.execution.probeSha256=sha256('other probe'),v=>delete v.closureRef]){
  const altered=structuredClone(f.receipt);change(altered);
  assert.throws(()=>verifyQualifiedApplicationDependencies({...f.refs,execution:f.put('negative.json',altered)},f.binding,f.options));
 }
 const b=structuredClone(f.binding);b.applicationDependencies.archiveSha256=sha256('unqualified archive');
 assert.throws(()=>verifyQualifiedApplicationDependencies(f.refs,b,f.options),/startup-binding/);
 writeFileSync(f.refs.archive.path,'changed native content');assert.throws(()=>verifyQualifiedApplicationDependencies(f.refs,f.binding,f.options));
});
