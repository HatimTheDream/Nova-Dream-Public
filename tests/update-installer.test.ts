import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedUpdateInstaller, reviewedAssetResponse, updatePreflightLimits } from '../apps/service/update-installer.js';
import type { VerifiedUpdateRelease } from '../apps/service/update-feed.js';

const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const prior=(release:VerifiedUpdateRelease)=>({candidateId:release.fromCandidateId,workspaceEpoch:randomUUID()});
const file=(name:string,content:string)=>({name,data:Buffer.from(content).toString('base64'),sha256:hash(content)});
const runner=file('install.py','# Inert integrity fixture. This file must never execute.\n');
const companion=file('acceptance.py','# Another inert fixture.\n');
test('only the fixed GitHub release CDN redirect is followed without credentials',async()=>{
  const source='https://github.com/example/repo/releases/download/v1/runtime.tgz',cdn='https://release-assets.githubusercontent.com/github-production-release-asset/123/file?token=fixture';
  const calls:unknown[]=[];
  const fetcher=(async(url,init)=>{calls.push([url,init?.redirect,init?.credentials]);return url===source?new Response(null,{status:302,headers:{location:cdn}}):new Response('verified later by hash');}) as typeof fetch;
  await reviewedAssetResponse(source,new AbortController().signal,fetcher);assert.deepEqual(calls,[[source,'manual','omit'],[cdn,'error','omit']]);
  for(const location of ['http://127.0.0.1/private','https://evil.example/github-production-release-asset/a','https://user:secret@release-assets.githubusercontent.com/github-production-release-asset/a','https://release-assets.githubusercontent.com/other/a']){
    let count=0;await assert.rejects(reviewedAssetResponse(source,new AbortController().signal,(async()=>{count++;return new Response(null,{status:302,headers:{location}});}) as typeof fetch),/Untrusted/);assert.equal(count,1);
  }
});
function fixture(files=[runner,companion]){
  const directory=mkdtempSync(join(tmpdir(),'nova-update-installer-')),candidateId='b'.repeat(64),folder=join(directory,candidateId);
  const bytes=Buffer.from(JSON.stringify({format:1,files}));let requests=0;
  const release:VerifiedUpdateRelease={candidateId,fromCandidateId:'a'.repeat(64),novaVersion:'1.13.0',agentVersion:'2026.9.2',platform:'linux',arch:'x64',nodeMajor:24,notes:[],compatibility:{reviewed:true,gatewayProtocol:4,fromNovaVersion:'1.12.11',fromAgentVersion:'2026.9.2',fromSchemaVersion:55,toSchemaVersion:55,pluginVersion:'1.13.0'},recovery:{pairedSnapshot:true,independentRestore:true,readinessTimeoutSeconds:120},manifestSequence:1,manifestExpiresAt:9999999999999,bundle:{url:'https://updates.example.test/bundle.json',bytes:bytes.length,sha256:hash(bytes),runnerSha256:runner.sha256}};
  let respond:()=>Response|Promise<Response>=()=>new Response(bytes,{headers:{'content-length':String(bytes.length)}});
  const installer=new ManagedUpdateInstaller(directory,join(directory,'host.json'),join(directory,'must-not-exist-python'),(async(url,init)=>{
    requests++;assert.equal(url,release.bundle.url);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);return respond();
  }) as typeof fetch);
  return {directory,folder,bytes,release,installer,attempt:(jobId:string)=>join(folder,'attempts',jobId),requests:()=>requests,setResponse:(next:typeof respond)=>{respond=next;},close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('authenticated bundle bytes and every extracted file verify, and cached retries do not redownload',async()=>{
  const f=fixture(),progress:number[][]=[];
  try{
    await f.installer.prepare(f.release,(received,total)=>progress.push([received,total]));
    assert.deepEqual(readFileSync(join(f.folder,'bundle.json')),f.bytes);
    assert.equal(hash(readFileSync(join(f.folder,'install.py'))),runner.sha256);
    assert.equal(hash(readFileSync(join(f.folder,'acceptance.py'))),companion.sha256);
    assert.deepEqual(progress.at(-1),[f.bytes.length,f.bytes.length]);
    await f.installer.prepare(f.release,()=>{});assert.equal(f.requests(),1);
    assert.equal(existsSync(join(f.folder,'request.json')),false,'Preparation cannot start the runner.');
  }finally{f.close();}
});

test('paired runtime download is separately authenticated, reused, and checked again before execution',async()=>{
  const f=fixture(),runtime=Buffer.from('inert runtime archive integrity fixture');let requests=0;
  const release={...f.release,runtimeBundle:{url:'https://updates.example.test/runtime.tgz',bytes:runtime.length,sha256:hash(runtime)}};
  const folder=join(f.directory,release.bundle.sha256),progress:number[][]=[];
  const installer=new ManagedUpdateInstaller(f.directory,join(f.directory,'host.json'),'must-not-execute',(async(url)=>{requests++;return new Response(url===release.runtimeBundle.url?runtime:f.bytes);}) as typeof fetch);
  try{
    await installer.prepare(release,(a,b)=>progress.push([a,b]));
    assert.deepEqual(readFileSync(join(folder,'runtime.tgz')),runtime);assert.deepEqual(progress.at(-1),[f.bytes.length+runtime.length,f.bytes.length+runtime.length]);
    await installer.prepare(release,()=>{});assert.equal(requests,2);
    writeFileSync(join(folder,'runtime.tgz'),Buffer.alloc(runtime.length));
    await assert.rejects(installer.run(release,randomUUID(),()=>{},prior(release)),/Runtime package changed/);
    assert.equal(existsSync(join(folder,'attempts')),false,'Tampered runtime cannot start or record installation.');
  }finally{f.close();}
});

test('invalid runtime bytes cannot be accepted alongside a valid application package',async()=>{
  const f=fixture(),runtime=Buffer.from('runtime');
  const release={...f.release,runtimeBundle:{url:'https://updates.example.test/runtime.tgz',bytes:runtime.length,sha256:hash(runtime)}};
  const installer=new ManagedUpdateInstaller(f.directory,join(f.directory,'host.json'),'must-not-execute',(async(url)=>new Response(url===release.runtimeBundle.url?Buffer.from('invalid'):f.bytes)) as typeof fetch);
  try{await assert.rejects(installer.prepare(release,()=>{}),/Runtime package verification failed|runtime package exceeded/i);assert.equal(existsSync(join(f.directory,release.bundle.sha256,'attempts')),false);}finally{f.close();}
});

test('separate dependency and runtime closures verify, share reviewed bundle identity and retain total progress',async()=>{
  const f=fixture(),dependencies=Buffer.from('inert application dependencies'),runtime=Buffer.from('inert runtime');let requests=0;
  const release={...f.release,applicationDependenciesBundle:{url:'https://updates.example.test/dependencies.tgz',bytes:dependencies.length,sha256:hash(dependencies)},runtimeBundle:{url:'https://updates.example.test/runtime.tgz',bytes:runtime.length,sha256:hash(runtime)}};
  const folder=join(f.directory,release.bundle.sha256),progress:number[][]=[];
  const installer=new ManagedUpdateInstaller(f.directory,join(f.directory,'host.json'),'must-not-execute',(async url=>{requests++;return new Response(url===release.applicationDependenciesBundle.url?dependencies:url===release.runtimeBundle.url?runtime:f.bytes);}) as typeof fetch);
  try{
    await installer.prepare(release,(a,b)=>progress.push([a,b]));
    assert.deepEqual(readFileSync(join(folder,'app-dependencies.tgz')),dependencies);assert.deepEqual(readFileSync(join(folder,'runtime.tgz')),runtime);
    const total=f.bytes.length+dependencies.length+runtime.length;assert.deepEqual(progress.at(-1),[total,total]);assert.ok(progress.every(item=>item[1]===total));
    await installer.prepare(release,()=>{});assert.equal(requests,3);
    writeFileSync(join(folder,'app-dependencies.tgz'),Buffer.alloc(dependencies.length));
    await assert.rejects(installer.preflight(release,randomUUID(),{candidateId:release.fromCandidateId,workspaceEpoch:randomUUID()}),/dependencies package changed/);
    await assert.rejects(installer.run(release,randomUUID(),()=>{},prior(release)),/dependencies package changed/);
    assert.equal(existsSync(join(folder,'attempts')),false);
  }finally{f.close();}
});

test('a dependency-only closure selects the reviewed bundle folder and rejects invalid bytes or oversized declarations',async()=>{
  for(const invalid of [false,true]){
    const f=fixture(),dependencies=Buffer.from('dependency fixture');let requests=0;
    const release={...f.release,applicationDependenciesBundle:{url:'https://updates.example.test/dependencies.tgz',bytes:dependencies.length,sha256:hash(dependencies)}};
    const installer=new ManagedUpdateInstaller(f.directory,join(f.directory,'host.json'),'must-not-execute',(async url=>{requests++;return new Response(url===release.applicationDependenciesBundle.url?(invalid?Buffer.alloc(dependencies.length):dependencies):f.bytes);}) as typeof fetch);
    try{
      if(invalid)await assert.rejects(installer.prepare(release,()=>{}),/dependencies package verification failed/);
      else {await installer.prepare(release,()=>{});assert.ok(existsSync(join(f.directory,release.bundle.sha256,'app-dependencies.tgz')));assert.equal(existsSync(f.folder),false);}
      assert.equal(requests,2);
      await assert.rejects(installer.prepare({...release,applicationDependenciesBundle:{...release.applicationDependenciesBundle,bytes:512*1024*1024+1}},()=>{}),/supported size/);assert.equal(requests,2);
    }finally{f.close();}
  }
});

function preflightFixture(body:string,operation='--preflight'){
  const contents="const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.equal(process.argv[2],"+JSON.stringify(operation)+"); const request=JSON.parse(fs.readFileSync(process.argv[3],'utf8')); const identity=request.preflightIdentity; "+body;
  const runnerFile=file('install.py',contents),f=fixture([runnerFile,companion]);
  const release={...f.release,bundle:{...f.release.bundle,runnerSha256:runnerFile.sha256}};
  const installer=new ManagedUpdateInstaller(f.directory,join(f.directory,'host.json'),process.execPath,(async()=>new Response(f.bytes)) as typeof fetch);
  return {...f,release,installer};
}

test('read-only preflight binds a fresh exact workspace response without creating an installation request or result',async()=>{
  const f=preflightFixture("assert.deepEqual(Object.keys(request).sort(),['format','hostConfiguration','jobId','preflightIdentity','release']); console.log(JSON.stringify({format:1,preflight:'passed',...identity}));"),jobId=randomUUID(),prior={candidateId:f.release.fromCandidateId,workspaceEpoch:randomUUID()};
  try{
    await f.installer.prepare(f.release,()=>{});
    await f.installer.preflight(f.release,jobId,prior);await f.installer.preflight(f.release,jobId,prior);
    const entries=readdirSync(f.attempt(jobId));assert.equal(entries.length,2);assert.ok(entries.every(name=>/^preflight-[a-f0-9-]+\.json$/.test(name)));
    for(const name of entries){const request=JSON.parse(readFileSync(join(f.attempt(jobId),name),'utf8'));assert.deepEqual(request.preflightIdentity,prior);assert.equal(request.jobId,jobId);assert.deepEqual(request.release,f.release);}
    await assert.rejects(f.installer.preflight(f.release,jobId,{...prior,candidateId:'c'.repeat(64)}),/reviewed prior candidate/);
    writeFileSync(join(f.attempt(jobId),'request.json'),'retained original execution');
    await assert.rejects(f.installer.preflight(f.release,jobId,prior),/reconciled/);assert.equal(readFileSync(join(f.attempt(jobId),'request.json'),'utf8'),'retained original execution');
  }finally{f.close();}
});

test('preflight rejects wrong-workspace, malformed, excessive and unsuccessful runner responses without exposing stderr',async()=>{
  const bodies=[
    "console.log(JSON.stringify({format:1,preflight:'passed',...identity,candidateId:'c'.repeat(64)}));",
    "console.log(JSON.stringify({format:1,preflight:'passed',...identity,workspaceEpoch:require('node:crypto').randomUUID()}));",
    "console.log(JSON.stringify({format:1,preflight:'passed',...identity,unreviewed:true}));",
    "console.log('not json');",
    "console.log('{}\\n{}');",
    "process.stdout.write('x'.repeat(17000));",
    "process.stderr.write('secret-private-error '.repeat(1000));",
    "console.error('secret-private-error');process.exit(2);",
  ];
  for(const body of bodies){
    const f=preflightFixture(body),jobId=randomUUID();
    try{await f.installer.prepare(f.release,()=>{});await assert.rejects(f.installer.preflight(f.release,jobId,{candidateId:f.release.fromCandidateId,workspaceEpoch:randomUUID()}),error=>{assert.doesNotMatch(String(error),/secret-private-error/);return true;});assert.ok(readdirSync(f.attempt(jobId)).every(name=>name.startsWith('preflight-')));}finally{f.close();}
  }
});

test('read-only preflight terminates a stalled runner at the bounded deadline',async context=>{
  const f=preflightFixture('setInterval(()=>{},1000);'),jobId=randomUUID();
  try{
    await f.installer.prepare(f.release,()=>{});context.mock.timers.enable({apis:['setTimeout']});
    const pending=f.installer.preflight(f.release,jobId,{candidateId:f.release.fromCandidateId,workspaceEpoch:randomUUID()});
    const rejected=assert.rejects(pending,/preflight did not verify/);
    const deadline=performance.now()+5000;
    while(!existsSync(f.attempt(jobId))||!readdirSync(f.attempt(jobId)).some(name=>name.startsWith('preflight-'))){assert.ok(performance.now()<deadline,'Preflight request must be staged before its deadline is advanced.');await new Promise(resolve=>setImmediate(resolve));}
    context.mock.timers.tick(updatePreflightLimits.timeoutMs);await rejected;
    assert.ok(readdirSync(f.attempt(jobId)).every(name=>name.startsWith('preflight-')));
  }finally{context.mock.timers.reset();f.close();}
});

test('the actual execution request retains the original workspace identity after preflight',async()=>{
  const f=preflightFixture("assert.deepEqual(Object.keys(request).sort(),['expectedPrior','format','hostConfiguration','jobId','release']); assert.equal(request.expectedPrior.candidateId,request.release.fromCandidateId); fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[3]),'result.json'),JSON.stringify({format:1,jobId:request.jobId,candidateId:request.release.candidateId,priorCandidateId:request.expectedPrior.candidateId,outcome:'unchanged',unchangedVerified:true,healthVerified:true,reason:'Synthetic unchanged fixture.'}));",'--request');
  const jobId=randomUUID(),expectedPrior=prior(f.release);
  try{
    await f.installer.prepare(f.release,()=>{});
    assert.equal(await f.installer.run(f.release,jobId,()=>{},expectedPrior),'unchanged');
    const recorded=JSON.parse(readFileSync(join(f.attempt(jobId),'request.json'),'utf8'));
    assert.deepEqual(recorded.expectedPrior,expectedPrior);
    await assert.rejects(f.installer.run(f.release,randomUUID(),()=>{},{...expectedPrior,candidateId:'f'.repeat(64)}),/reviewed prior candidate/);
  }finally{f.close();}
});

test('interrupted download evidence is retained while a later attempt downloads and verifies anew',async()=>{
  const f=fixture(),partial=f.bytes.subarray(0,30);
  try{
    f.setResponse(()=>({status:200,redirected:false,url:f.release.bundle.url,headers:new Headers(),body:{async *[Symbol.asyncIterator](){yield partial;throw Error('Network lost mid-download');}}}) as unknown as Response);
    await assert.rejects(f.installer.prepare(f.release,()=>{}),/Network lost/);
    assert.deepEqual(readFileSync(join(f.folder,'bundle.json')),partial);
    f.setResponse(()=>new Response(f.bytes));await f.installer.prepare(f.release,()=>{});
    const retained=readdirSync(f.folder).filter(name=>/^incomplete-[a-f0-9-]+\.json$/.test(name));assert.equal(retained.length,1);
    assert.deepEqual(readFileSync(join(f.folder,retained[0])),partial);assert.deepEqual(readFileSync(join(f.folder,'bundle.json')),f.bytes);assert.equal(f.requests(),2);
  }finally{f.close();}
});

test('declared and streamed size, hash and response identity failures cannot extract an installer',async()=>{
  for(const kind of ['declared','overflow','truncated','hash','redirect','different-url','status'] as const){
    const f=fixture();
    try{
      const changed=Buffer.from(f.bytes);changed[changed.length-2]^=1;
      f.setResponse(()=>kind==='declared'?new Response(f.bytes,{headers:{'content-length':String(f.bytes.length+1)}})
        :kind==='overflow'?new Response(Buffer.concat([f.bytes,Buffer.from(' ')]))
          :kind==='truncated'?new Response(f.bytes.subarray(0,-1)):kind==='hash'?new Response(changed)
            :kind==='status'?new Response('unavailable',{status:503})
              :({status:200,redirected:kind==='redirect',url:kind==='different-url'?'https://other.example.test/bundle.json':f.release.bundle.url,headers:new Headers(),body:{async *[Symbol.asyncIterator](){yield f.bytes;}}}) as unknown as Response);
      await assert.rejects(f.installer.prepare(f.release,()=>{}));assert.equal(existsSync(join(f.folder,'install.py')),false,kind);
    }finally{f.close();}
  }
  const f=fixture();try{await assert.rejects(f.installer.prepare({...f.release,bundle:{...f.release.bundle,bytes:128*1024*1024+1}},()=>{}),/supported size/);assert.equal(f.requests(),0);}finally{f.close();}
});

test('signed but malformed file tables reject reserved paths, traversal, duplicates and invalid contents',async()=>{
  for(const files of [
    ...['bundle.json','runtime.tgz','app-dependencies.tgz','preflight-request.json','request.json','result.json','runner.log','attempts','../outside.py','sub/file.py','sub\\file.py','C:outside.py'].map(name=>[runner,file(name,'fixture')]),
    [runner,runner], [companion], [runner,{...companion,data:'eA'}], [runner,{...companion,sha256:'f'.repeat(64)}],
  ]){
    const f=fixture(files);try{await assert.rejects(f.installer.prepare(f.release,()=>{}));assert.equal(existsSync(join(f.directory,'outside.py')),false);assert.equal(existsSync(join(f.folder,'request.json')),false);}finally{f.close();}
  }
  const f=fixture();try{await assert.rejects(f.installer.prepare({...f.release,bundle:{...f.release.bundle,runnerSha256:'f'.repeat(64)}},()=>{}),/reviewed identity/);}finally{f.close();}
});

test('run admission revalidates both the bundle and companion files before any request or process',async()=>{
  for(const changed of ['bundle.json','install.py','acceptance.py']){
    const f=fixture();try{
      await f.installer.prepare(f.release,()=>{});writeFileSync(join(f.folder,changed),'tampered fixture');
      await assert.rejects(f.installer.run(f.release,randomUUID(),()=>assert.fail('Unverified content cannot report a running stage'),prior(f.release)),/changed/);
      assert.equal(existsSync(join(f.folder,'request.json')),false);assert.equal(existsSync(join(f.folder,'runner.log')),false);
    }finally{f.close();}
  }
  const f=fixture();try{
    await f.installer.prepare(f.release,()=>{});const jobId=randomUUID(),attempt=f.attempt(jobId),original='{ "retained": true }';mkdirSync(attempt,{recursive:true});writeFileSync(join(attempt,'request.json'),original);
    await assert.rejects(f.installer.run(f.release,jobId,()=>assert.fail('An earlier attempt cannot run again'),prior(f.release)),/reconciled/);
    assert.equal(readFileSync(join(attempt,'request.json'),'utf8'),original);assert.equal(existsSync(join(attempt,'runner.log')),false);
  }finally{f.close();}
});

test('reconciliation is read-only and requires exact job, pair and all acceptance proofs',async()=>{
  const f=fixture(),jobId=randomUUID();
  try{
    const attempt=f.attempt(jobId);mkdirSync(attempt,{recursive:true});assert.equal(await f.installer.reconcile(f.release,jobId),undefined);
    const receipt={format:1,jobId,candidateId:f.release.candidateId,priorCandidateId:f.release.fromCandidateId,outcome:'completed',savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true};
    for(const patch of [{jobId:randomUUID()},{candidateId:'e'.repeat(64)},{priorCandidateId:'e'.repeat(64)},{savedWorkVerified:false},{accountsVerified:false},{recoveryVerified:false},{healthVerified:false},{outcome:'installing'},{untrustedExtra:true}]){
      writeFileSync(join(attempt,'result.json'),JSON.stringify({...receipt,...patch}));await assert.rejects(f.installer.reconcile(f.release,jobId));
    }
    for(const outcome of ['completed','restored']){const bytes=JSON.stringify({...receipt,outcome});writeFileSync(join(attempt,'result.json'),bytes);assert.equal(await f.installer.reconcile(f.release,jobId),outcome);assert.equal(readFileSync(join(attempt,'result.json'),'utf8'),bytes);}
    assert.equal(f.requests(),0);assert.deepEqual(readdirSync(attempt),['result.json']);
  }finally{f.close();}
});

test('unchanged preflight proof is distinct from rollback and scoped to one immutable attempt',async()=>{
  const f=fixture(),jobId=randomUUID(),later=randomUUID();
  try{
    const attempt=f.attempt(jobId);mkdirSync(attempt,{recursive:true});
    const result={format:1,jobId,candidateId:f.release.candidateId,priorCandidateId:f.release.fromCandidateId,outcome:'unchanged',unchangedVerified:true,healthVerified:true,reason:'The update could not be prepared. The installed version is unchanged.'};
    for(const patch of [{unchangedVerified:false},{healthVerified:false},{priorCandidateId:'e'.repeat(64)},{recoveryVerified:true},{reason:'private\nlog'},{reason:'x'.repeat(201)}]){writeFileSync(join(attempt,'result.json'),JSON.stringify({...result,...patch}));await assert.rejects(f.installer.reconcile(f.release,jobId));}
    const original=JSON.stringify(result);writeFileSync(join(attempt,'result.json'),original);
    assert.equal(await f.installer.reconcile(f.release,jobId),'unchanged');assert.equal(await f.installer.reconcile(f.release,later),undefined);
    const second=f.attempt(later);mkdirSync(second);writeFileSync(join(second,'result.json'),JSON.stringify({...result,jobId:later}));
    assert.equal(await f.installer.reconcile(f.release,later),'unchanged');assert.equal(readFileSync(join(attempt,'result.json'),'utf8'),original);
    writeFileSync(join(attempt,'result.json'),JSON.stringify({...result,reasonCode:'insufficient_storage'}));
    assert.deepEqual(await f.installer.reconcile(f.release,jobId),{outcome:'unchanged',reasonCode:'insufficient_storage'});
    writeFileSync(join(attempt,'result.json'),JSON.stringify({...result,reasonCode:'unreviewed-exception-text'}));
    await assert.rejects(f.installer.reconcile(f.release,jobId));
  }finally{f.close();}
});

test('staging rejects redirected candidate directories and invalid identities',async t=>{
  const f=fixture();try{
    await assert.rejects(f.installer.prepare({...f.release,candidateId:'../outside'},()=>{}),/candidate identity/);assert.equal(f.requests(),0);
    const outside=join(f.directory,'outside');mkdirSync(outside);
    try{symlinkSync(outside,f.folder,process.platform==='win32'?'junction':'dir');}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('This host does not permit fixture symlinks.');return;}throw error;}
    await assert.rejects(f.installer.prepare(f.release,()=>{}),/path needs review/);assert.deepEqual(readdirSync(outside),[]);
  }finally{f.close();}
});
