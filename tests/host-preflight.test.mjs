import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fullHostPrerequisiteGaps,buildHostPrerequisiteProgram } from '../scripts/release-delivery-host-preflight.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'nova-host-preflight-'));t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
 const put=(name,value)=>{const path=join(root,name),raw=typeof value==='string'?value:JSON.stringify(value);writeFileSync(path,raw);return{path,sha256:digest(raw)};};
 const transport=put('transport.json',{format:1,hostAlias:'synthetic',sshConfig:put('ssh.config','synthetic; never execute')});
 const options={stageParent:'/opt/nova-release-tools/fixture-stages',hostConfiguration:{path:'/etc/nova-update/config.json',sha256:'a'.repeat(64)}};
 const value={format:1,kind:'full-host-directory-preflight',...options,readOnly:true,noHostWrites:true,passed:false,gaps:['full-host-stage-parent-missing'],directories:{},capacityAdmitted:false,recoveryAdmitted:false};
 return{transport,options,value};
}
test('missing configured parent produces a blocking gap before packaging',async t=>{
 const f=fixture(t);let calls=0;
 assert.deepEqual(await fullHostPrerequisiteGaps({...f,run:async(_target,program)=>{calls++;assert.match(program,/signal.alarm\(20\)/);return{exitCode:0,stdout:JSON.stringify(f.value)};}}),['full-host-stage-parent-missing']);
 assert.equal(calls,1);
});
test('corrupt observation cannot substitute another directory or admission claim',async t=>{
 const f=fixture(t);for(const change of [{stageParent:'/opt/nova-release-tools/other'},{capacityAdmitted:true},{hostConfiguration:{...f.options.hostConfiguration,sha256:'b'.repeat(64)}},{passed:true}])
  await assert.rejects(fullHostPrerequisiteGaps({...f,run:async()=>({exitCode:0,stdout:JSON.stringify({...f.value,...change})})}),/response-changed/);
});
test('lost transport is an explicit preflight gap and is never retried',async t=>{
 const f=fixture(t);let calls=0;
 assert.deepEqual(await fullHostPrerequisiteGaps({...f,run:async()=>{calls++;throw Error('timeout');}}),['full-host-prerequisite-observation-unavailable']);assert.equal(calls,1);
});
test('fixed payload binds exact options and source without a write command',t=>{
 const f=fixture(t),program=buildHostPrerequisiteProgram(f.options);
 const encoded=program.match(/v=json.loads\(base64.b64decode\('([^']+)'/)[1],payload=JSON.parse(Buffer.from(encoded,'base64'));
 assert.deepEqual(payload.input,{format:1,...f.options});assert.equal(digest(Buffer.from(payload.source,'base64')),payload.sha256);
 assert.doesNotMatch(Buffer.from(payload.source,'base64').toString(),/mkdir|unlink|chmod|chown|subprocess|systemctl/);
});
test('a complete directory observation permits preparation but rejects unsafe identity',async t=>{
 const f=fixture(t),identity=path=>({path,dev:1,ino:2,mode:0o40700,uid:0,gid:0});
 const value={...f.value,passed:true,gaps:[],directories:{'stage-parent':identity(f.options.stageParent),'lab-parent':identity('/var/lib/nova-operator-rehearsals'),'recovery-parent':identity('/var/lib/nova-recovery')}};
 const run=async()=>({exitCode:0,stdout:JSON.stringify(value)});
 assert.deepEqual(await fullHostPrerequisiteGaps({...f,run}),[]);
 value.directories['stage-parent'].mode=0o40777;
 await assert.rejects(fullHostPrerequisiteGaps({...f,run}),/directory-identity-changed/);
});
