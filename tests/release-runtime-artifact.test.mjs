import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,openSync,writeSync,closeSync,rmSync,linkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyRuntimeArtifact,runtimeTransition,RUNTIME_ARCHIVE_MAXIMUM} from '../scripts/release-runtime-artifact.mjs';

test('runtime verification streams an ordinary129MiB archive with exact size/hash and refuses substitutions',t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-runtime-stream-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'runtime.tgz'),fd=openSync(path,'wx'),block=Buffer.alloc(1024**2,37),hash=createHash('sha256');
 try{for(let i=0;i<129;i++){writeSync(fd,block);hash.update(block);}}finally{closeSync(fd);}
 const ref={path,sha256:hash.digest('hex')},size=129*1024**2;
 assert.deepEqual(verifyRuntimeArtifact(ref,size),{bytes:size,sha256:ref.sha256});
 assert.throws(()=>verifyRuntimeArtifact(ref,size-1),/size-or-link/);
 assert.throws(()=>verifyRuntimeArtifact(ref,RUNTIME_ARCHIVE_MAXIMUM+1),/size-bound/);
 assert.throws(()=>verifyRuntimeArtifact({...ref,sha256:'0'.repeat(64)},size),/content-changed/);
 const hard=join(root,'linked.tgz');linkSync(path,hard);assert.throws(()=>verifyRuntimeArtifact(ref,size),/size-or-link/);
});

test('only the signed9.6-to9.8 runtime profile is admitted',t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-runtime-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'runtime.tgz'),bytes=Buffer.from('runtime fixture');writeFileSync(path,bytes);const sha256=createHash('sha256').update(bytes).digest('hex');
 const description={format:1,fromVersion:'2026.9.6',toVersion:'2026.9.8',nodeVersion:'24.21.0',companion:{pluginVersion:'2026.9.8',codexVersion:'0.158.0'},archiveSha256:sha256,archiveBytes:bytes.length,expandedBytes:1000,fileCount:4};
 const runtime={archive:{path,sha256},description},release={agentVersion:'2026.9.8',runtimeBundle:{sha256,bytes:bytes.length}};
 assert.equal(runtimeTransition(runtime,release),description);
 for(const change of [v=>v.description.fromVersion='2026.9.2',v=>v.description.toVersion='2026.9.6',v=>v.description.nodeVersion='22.23.2',v=>v.description.companion.codexVersion='other',v=>v.description.expandedBytes=2*1024**3+1,v=>v.description.fileCount=100001]){
  const bad=structuredClone(runtime);change(bad);assert.throws(()=>runtimeTransition(bad,release));
 }
 assert.throws(()=>runtimeTransition(runtime,{...release,runtimeBundle:{sha256:'0'.repeat(64),bytes:bytes.length}}));
});
