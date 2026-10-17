import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../scripts/release-plan.mjs';
import { prepareDeliveryBrowser, canonicalBrowser, writeBrowserOnce, browserOptionsSchema, verifyBrowserAcceptance, verifyBrowserSessionAlive, createBrowserAcceptanceAdapter } from '../scripts/release-delivery-browser.mjs';
import { verifyBrowserHealth, verifyDocumentIdentity, verifyPlaywrightClosure } from '../scripts/release-delivery-browser-driver.mjs';
import {remoteBrowserAcceptance} from '../scripts/release-delivery-browser-remote.mjs';
import {verifyBrowserTool} from '../scripts/release-delivery-browser-primitives.mjs';

const hash=v=>sha256(canonicalBrowser(v));
test('streamed tool verification covers later chunks and enforces exact size bounds',t=>{
  const {root}=fixture(t),path=join(root,'binary'),bytes=Buffer.alloc(3*64*1024+17,42);
  bytes[bytes.length-1]=219;writeFileSync(path,bytes);
  const ref={path,sha256:sha256(bytes)};
  assert.deepEqual(verifyBrowserTool(ref,{maximum:bytes.length}),{...ref,bytes:bytes.length});
  assert.throws(()=>verifyBrowserTool(ref,{maximum:bytes.length-1}),/browser-reference-not-bounded-file/);
  bytes[bytes.length-2]^=1;writeFileSync(path,bytes);
  assert.throws(()=>verifyBrowserTool(ref,{maximum:bytes.length}),/browser-reference-sha256-changed/);
});
function fixture(t) {
  const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'nova-browser-'));
  t.after(()=>{assert.equal(dirname(root),parent);assert.ok(root.startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
  const file=join(root,'tool');writeFileSync(file,'tool');const ref={path:file,sha256:sha256('tool')};
  const options={format:1,node:ref,executable:ref,playwright:ref,ssh:ref,baseUrl:'http://127.0.0.1:4383',timeoutMs:300000,suite:'tasks-search-escape'};
  const context={journal:{directory:root},descriptor:{operation:{id:randomUUID(),priorCandidateId:sha256('prior'),workspaceEpoch:randomUUID()}},
    prior:{route:{route:'frontend'}},beforeNewEffect:async()=>{}};
  return {root,ref,options,context};
}
test('pre-promotion browser reservation survives launch response loss without duplicate browser',async t=>{
  const {root,options,context,ref}=fixture(t);let launches=0;
  const launch=()=>{launches++;const dir=join(root,'browser-session'),original=JSON.parse(readFileSync(join(dir,'original.json')));
    writeBrowserOnce(join(dir,'heartbeat.json'),{operationId:original.binding.operationId,originalSha256:sha256(readFileSync(join(dir,'original.json'))),pid:process.pid,atMs:Date.now(),browserAlive:true,tunnelAlive:true});
    writeBrowserOnce(join(dir,'prepared.json'),{bindingSha256:hash(original.binding)});return {on(){},unref(){}};};
  const a=await prepareDeliveryBrowser(context,{options,transport:ref,launch});
  const b=await prepareDeliveryBrowser(context,{options,transport:ref,launch});assert.deepEqual(a,b);assert.equal(launches,1);
  await assert.rejects(prepareDeliveryBrowser(context,{options:{...options,suite:'tasks-search-focus'},transport:ref,launch}),/browser-original-binding-changed/);
  assert.equal(launches,1);
});
test('expired, closed or stale original browser cannot admit publication',async t=>{
  const {root,options,context,ref}=fixture(t);
  const launch=()=>{const dir=join(root,'browser-session'),original=JSON.parse(readFileSync(join(dir,'original.json')));
    writeBrowserOnce(join(dir,'heartbeat.json'),{operationId:original.binding.operationId,originalSha256:sha256(readFileSync(join(dir,'original.json'))),pid:process.pid,atMs:Date.now()-6000,browserAlive:true,tunnelAlive:true});
    writeBrowserOnce(join(dir,'prepared.json'),{bindingSha256:hash(original.binding)});return {on(){},unref(){}};};
  await assert.rejects(prepareDeliveryBrowser(context,{options,transport:ref,launch}),/browser-original-session-unavailable/);
  const dir=join(root,'browser-session'),record=JSON.parse(readFileSync(join(dir,'original.json')));
  assert.throws(()=>verifyBrowserSessionAlive(dir,record,record.deadlineAtMs),/browser-original-deadline-exhausted/);
  writeBrowserOnce(join(dir,'closed.json'),{});assert.throws(()=>verifyBrowserSessionAlive(dir,record),/browser-original-session-closed/);
});
test('observation cannot start a missing original browser',async t=>{
  const {root,options,context,ref}=fixture(t);
  await assert.rejects(prepareDeliveryBrowser(context,{options,transport:ref,inspectOnly:true}),/browser-original-preparation-not-dispatched/);
  assert.equal(existsSync(join(root,'browser-session','original.json')),false);
});
test('observing a reserved browser phase cannot dispatch a missing acceptance request',async t=>{
  const {root,options,context,ref}=fixture(t),op=context.descriptor.operation;
  Object.assign(op,{version:'2.7.7',buildVersion:'1.0.304'});
  const health={candidateId:op.priorCandidateId,epoch:op.workspaceEpoch,processIdentity:randomUUID(),serviceInputsSha256:sha256('service')};
  context.prior={route:{route:'frontend',serviceInputsSha256:health.serviceInputsSha256},sign:{frontendId:sha256('new')},publication:{frontendId:sha256('new')},
    installation:{state:'completed',operationId:op.id,journal:{phase:'completed',outcome:'selected',health,frontendId:sha256('new')}},
    assistant:{kind:'nova-delivery-saved-assistant-reply',key:randomUUID(),savedReplyAccepted:true,browserUiVerified:false}};
  const launch=()=>{const dir=join(root,'browser-session'),original=JSON.parse(readFileSync(join(dir,'original.json')));
    writeBrowserOnce(join(dir,'heartbeat.json'),{operationId:op.id,originalSha256:sha256(readFileSync(join(dir,'original.json'))),pid:process.pid,atMs:Date.now(),browserAlive:true,tunnelAlive:true});
    writeBrowserOnce(join(dir,'prepared.json'),{bindingSha256:hash(original.binding)});return {on(){},unref(){}};};
  await prepareDeliveryBrowser(context,{options,transport:ref,launch});
  const adapter=createBrowserAcceptanceAdapter({options,transport:ref,storeReceipt:()=>{throw Error('unexpected-write');}});
  context.intent={key:randomUUID(),input:await adapter.input(context)};let effects=0;context.beforeNewEffect=async()=>{effects++;};
  const observed=await adapter.observe(context);assert.equal(observed.state,'uncertain');assert.equal(effects,0);
  assert.equal(existsSync(join(root,'browser-session','accept-request.json')),false);
});
test('an acknowledged lost original daemon is not replaced',async t=>{
  const {root,options,context,ref}=fixture(t);let launches=0;
  const launch=()=>{launches++;writeBrowserOnce(join(root,'browser-session','failed.json'),{reason:'browser-original-session-lost'});return {on(){},unref(){}};};
  await assert.rejects(prepareDeliveryBrowser(context,{options,transport:ref,launch}),/browser-original-session-lost/);
  await assert.rejects(prepareDeliveryBrowser(context,{options,transport:ref,launch}),/browser-original-session-lost/);assert.equal(launches,1);
});
test('tool configuration refuses alternate origins and arbitrary browser suites',()=>{
  const ref={path:'/tool',sha256:'a'.repeat(64)},base={format:1,node:ref,executable:ref,playwright:ref,ssh:ref,baseUrl:'http://127.0.0.1:4383',timeoutMs:300000,suite:'tasks-search-escape'};
  assert.equal(browserOptionsSchema.safeParse({...base,baseUrl:'https://example.com'}).success,false);
  assert.equal(browserOptionsSchema.safeParse({...base,suite:'run-any-script'}).success,false);
});
test('readiness rejects wrong candidate, process, blocked selection and changed workspace',()=>{
  const h={application:'nova-dream-edition-3',status:'ready',candidateId:sha256('candidate'),processIdentity:randomUUID(),serviceInputsSha256:sha256('service'),
    frontend:{id:sha256('frontend'),version:'2.7.6',buildVersion:'1.0.303'}};
  const e={...h,epoch:randomUUID()};verifyBrowserHealth(h,e,e.epoch);
  for(const changed of [{candidateId:sha256('wrong')},{processIdentity:randomUUID()},{frontend:{...h.frontend,blocked:true}},{frontend:{...h.frontend,id:sha256('wrong')}}])
    assert.throws(()=>verifyBrowserHealth({...h,...changed},e,e.epoch));
  assert.throws(()=>verifyBrowserHealth(h,e,randomUUID()),/browser-workspace-epoch-changed/);
});
test('document proof is bound to selected assets and both version identities',()=>{
  const health={candidateId:sha256('backend'),frontend:{id:sha256('ui'),version:'2.7.6',buildVersion:'1.0.303'}};
  const doc={candidateId:health.candidateId,frontendId:health.frontend.id,version:'2.7.6',buildVersion:'1.0.303',assets:'/frontend/assets/'};
  verifyDocumentIdentity(doc,health);assert.throws(()=>verifyDocumentIdentity({...doc,frontendId:sha256('old')},health));
});
test('acceptance requires screenshot integrity, all browser checks and owned process closure',t=>{
  const {root}=fixture(t),image=join(root,'screen.png'),closed=join(root,'closed.json'),id=randomUUID();writeFileSync(image,'pixels');
  writeFileSync(closed,JSON.stringify({operationId:id,browserClosed:true,tunnelClosed:true}));
  const binding={operationId:id,route:'frontend',epoch:randomUUID(),priorCandidateId:sha256('base'),options:{}},document={candidateId:binding.priorCandidateId};
  const originalPath=join(root,'original.json'),preparedPath=join(root,'prepared.json');
  writeFileSync(originalPath,JSON.stringify({binding,startedAtMs:100,deadlineAtMs:300}));
  writeFileSync(preparedPath,JSON.stringify({bindingSha256:hash(binding),epoch:binding.epoch,document,startedAtMs:110}));
  const expected={candidateId:binding.priorCandidateId,frontend:{id:sha256('ui'),version:'2.7.6',buildVersion:'1.0.303'}};
  const input={operationId:id,installed:{route:'frontend',installedHealth:expected},assistant:{replySha256:sha256('reply'),savedMessageId:'message'},
    original:{path:originalPath,sha256:sha256(readFileSync(originalPath))},prepared:{path:preparedPath,sha256:sha256(readFileSync(preparedPath))}};
  const out={kind:'nova-real-browser-acceptance',operationId:id,inputSha256:hash(input),accepted:true,browserUiVerified:true,
    gatewayCoverage:'not-tested-loopback-host-surface',savedReplySha256:input.assistant.replySha256,savedMessageId:'message',
    startedAtMs:110,completedAtMs:200,originalDocument:document,
    loadedDocument:{candidateId:expected.candidateId,frontendId:expected.frontend.id,version:expected.frontend.version,buildVersion:expected.frontend.buildVersion},
    checks:['old-document-retained','old-lazy-module','new-document-identity','retained-draft-after-refresh','ui-behavior','saved-assistant-reply-visible','owned-draft-cleaned'].map(name=>({name,passed:true})),
    screenshot:{path:image,sha256:sha256('pixels')},closed:{path:closed,sha256:sha256(readFileSync(closed))}};
  verifyBrowserAcceptance(out,input);assert.throws(()=>verifyBrowserAcceptance({...out,checks:out.checks.slice(1)},input),/browser-required-check-missing/);
  assert.throws(()=>verifyBrowserAcceptance({...out,checks:[...out.checks,out.checks[0]]},input),/browser-required-check-missing/);
  assert.throws(()=>verifyBrowserAcceptance({...out,loadedDocument:{...out.loadedDocument,frontendId:sha256('wrong')}},input),/browser-loaded-document-proof-changed/);
  assert.throws(()=>verifyBrowserAcceptance({...out,completedAtMs:301},input),/browser-acceptance-original-deadline-changed/);
  writeFileSync(image,'changed');assert.throws(()=>verifyBrowserAcceptance(out,input));
});
test('a corrupt tool closure is rejected before importing executable code',t=>{
  const {root}=fixture(t),path=join(root,'manifest.json');writeFileSync(path,'{}');
  assert.throws(()=>verifyPlaywrightClosure({path,sha256:sha256('not-the-file')}));
});
test('remote terminal evidence remains observable after deadline without redispatch',async t=>{
  const {root,context}=fixture(t),id=context.descriptor.operation.id,transportPath=join(root,'transport.json'),closurePath=join(root,'closure.json'),sshPath=join(root,'ssh');
  writeFileSync(sshPath,'ssh');writeFileSync(transportPath,JSON.stringify({format:1,hostAlias:'fixture',sshConfig:{path:sshPath,sha256:sha256('ssh')}}));writeFileSync(closurePath,'{}');
  const transport={path:transportPath,sha256:sha256(readFileSync(transportPath))},options={playwright:{path:closurePath,sha256:sha256('{}')}};
  writeBrowserOnce(join(root,'original.json'),{binding:{operationId:id,options},startedAtMs:Date.now()-600000,deadlineAtMs:Date.now()-300000});
  const input={operationId:id};context.intent={key:randomUUID()};writeBrowserOnce(join(root,'accept-request.json'),{key:context.intent.key,input});
  let effects=0;context.beforeNewEffect=async()=>{effects++;};const modes=[];
  const run=async(_config,program)=>{const match=program.match(/base64\.b64decode\('([^']+)'\)/),payload=JSON.parse(Buffer.from(match[1],'base64').toString());modes.push(payload.mode);
    return {exitCode:2,stdout:JSON.stringify({state:'gap',reason:'browser-retained-terminal-observed'})};};
  await assert.rejects(remoteBrowserAcceptance(context,{options,transport,dir:root,input,observeOnly:true,run}),/browser-retained-terminal-observed/);
  assert.deepEqual(modes,['status']);assert.equal(effects,0);
});
test('rejected collected browser proof preserves the remote profile and evidence',async t=>{
  const {root,context}=fixture(t),id=context.descriptor.operation.id,transportPath=join(root,'transport.json'),closurePath=join(root,'closure.json'),sshPath=join(root,'ssh');
  writeFileSync(sshPath,'ssh');writeFileSync(transportPath,JSON.stringify({format:1,hostAlias:'fixture',sshConfig:{path:sshPath,sha256:sha256('ssh')}}));writeFileSync(closurePath,'{}');
  const transport={path:transportPath,sha256:sha256(readFileSync(transportPath))},options={playwright:{path:closurePath,sha256:sha256('{}')}};
  writeBrowserOnce(join(root,'original.json'),{binding:{operationId:id,options},startedAtMs:Date.now()-600000,deadlineAtMs:Date.now()-300000});
  const input={operationId:id};context.intent={key:randomUUID()};writeBrowserOnce(join(root,'accept-request.json'),{key:context.intent.key,input});
  const modes=[],pixels=Buffer.from('pixels'),raw={screenshot:{path:'/private/screen.png',sha256:sha256(pixels)}};
  const run=async(_config,program)=>{const match=program.match(/base64\.b64decode\('([^']+)'\)/),payload=JSON.parse(Buffer.from(match[1],'base64').toString());modes.push(payload.mode);
    const output=payload.mode==='status'?{state:'observed',operationId:id,originalSha256:sha256(readFileSync(join(root,'original.json'))),files:{closed:{operationId:id,browserClosed:true,tunnelClosed:true},acceptance:raw},unitState:'ActiveState=inactive\nMainPID=0\n',ownedPids:[]}
      :{state:'screenshot',sha256:sha256(pixels),bytes:pixels.length,offset:0,base64:pixels.toString('base64')};return {exitCode:0,stdout:JSON.stringify(output)};};
  await assert.rejects(remoteBrowserAcceptance(context,{options,transport,dir:root,input,observeOnly:true,run,verifyBeforeCleanup:()=>{throw Error('browser-proof-rejected');}}),/browser-proof-rejected/);
  assert.deepEqual(modes,['status','screenshot']);assert.equal(existsSync(join(root,'remote-cleanup.json')),false);
});
