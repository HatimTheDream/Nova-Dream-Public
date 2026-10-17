/** Real-browser acceptance uses one retained, pre-publication browser. A lost
 * browser is an explicit gap; resuming never fabricates an old window. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { validateJournalDirectory } from './release-coordinate.mjs';
import { assistantAcceptanceInput } from './release-delivery-assistant.mjs';
import {prepareRemoteBrowser,remoteBrowserAcceptance} from './release-delivery-browser-remote.mjs';
import {verifyFullBundledIdentity,verifyDocumentIdentity,browserSelectorDiagnostics} from './release-delivery-browser-checks.mjs';

const ref = z.object({ path:z.string().min(1), sha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const localBrowserOptionsSchema = z.object({ format:z.literal(1), node:ref, executable:ref, playwright:ref, ssh:ref,
  baseUrl:z.literal('http://127.0.0.1:4383'), timeoutMs:z.number().int().min(300000).max(7200000),
  suite:z.enum(['tasks-search-escape','tasks-search-focus']) }).strict();
export const browserOptionsSchema=z.union([localBrowserOptionsSchema,z.object({format:z.literal(1),mode:z.literal('remote'),node:ref,executable:ref,playwright:ref,
  baseUrl:z.literal('http://127.0.0.1:4383'),timeoutMs:z.number().int().min(300000).max(1800000),suite:z.enum(['tasks-search-escape','tasks-search-focus']),
  user:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),directoryRoot:z.string().regex(/^\/opt\/[a-z][a-z0-9-]{1,63}$/)}).strict()]);
export const canonicalBrowser = v => JSON.stringify(v, (_key,x) => x && typeof x==='object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])) : x);
const need=(v,r)=>{if(!v)throw Error(r);};
const hash=v=>sha256(canonicalBrowser(v));
const safe=e=>/^[a-z][a-z0-9-]{0,99}$/.test(e?.message??'')?e.message:'browser-producer-response-unavailable';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function writeBrowserOnce(path,value) {
  const bytes=canonicalBrowser(value)+'\n';
  if(existsSync(path)){need(readFileSync(path,'utf8')===bytes,'browser-original-file-changed');return;}
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
export function browserBinding(context,options,transport) {
  const op=context.descriptor.operation;
  let fullTarget,priorBundledTarget;
  if(context.prior.route.route==='full'){
    const candidateId=context.prior.route.targetCandidateId;
    need(context.prior.sign?.candidateId===candidateId&&context.prior.sign.priorCandidateId===op.priorCandidateId
      &&(op.candidateId==null||op.candidateId===candidateId),'browser-full-target-binding-changed');
    fullTarget={candidateId,version:op.version,buildVersion:op.buildVersion};
    const target=JSON.parse(readEvidenceFile(context.descriptor.target)),base=target.bases?.private;
    need(base?.candidateId===op.priorCandidateId,'browser-prior-bundled-binding-changed');
    const manifest=JSON.parse(readEvidenceFile(base.manifest));
    priorBundledTarget={candidateId:base.candidateId,version:manifest.version,buildVersion:manifest.buildVersion};
  }
  return {format:1,operationId:context.descriptor.operation.id,descriptorSha256:hash(context.descriptor),
    options:browserOptionsSchema.parse(options),transport,route:context.prior.route.route,
    ...(fullTarget?{fullTarget,priorBundledTarget}:{}),
    priorCandidateId:context.descriptor.operation.priorCandidateId,epoch:context.descriptor.operation.workspaceEpoch};
}
function directory(context) {
  return validateJournalDirectory(join(context.journal.directory,'browser-session'),{create:true});
}
function original(context,options,transport) {
  const dir=directory(context),path=join(dir,'original.json');
  if(!existsSync(path))return {dir,path,binding:browserBinding(context,options,transport),record:null};
  const record=read(path),binding=browserBinding(context,options,transport);
  need(isDeepStrictEqual(record.binding,binding),'browser-original-binding-changed');
  need(Number.isSafeInteger(record.startedAtMs)&&record.deadlineAtMs===record.startedAtMs+options.timeoutMs,'browser-original-clock-changed');
  return {dir,path,binding,record};
}
async function waitResult(dir,name,budget=90000) {
  const deadline=Date.now()+budget,path=join(dir,name);
  while(Date.now()<deadline){
    if(existsSync(path))return read(path);
    if(existsSync(join(dir,'failed.json')))throw Error(read(join(dir,'failed.json')).reason);
    if(existsSync(join(dir,'closed.json')))throw Error('browser-original-session-closed');
    await sleep(250);
  }
  throw Error('browser-original-response-unavailable');
}
function proofReference(dir,name) {
  const path=join(dir,name);return {path,sha256:sha256(readFileSync(path))};
}
export function verifyBrowserSessionAlive(dir,record,now=Date.now()) {
  need(now<record.deadlineAtMs,'browser-original-deadline-exhausted');
  need(!existsSync(join(dir,'failed.json'))&&!existsSync(join(dir,'closed.json')),'browser-original-session-closed');
  const heartbeat=read(join(dir,'heartbeat.json'));
  need(heartbeat.originalSha256===sha256(readFileSync(join(dir,'original.json')))&&heartbeat.operationId===record.binding.operationId
    &&heartbeat.browserAlive===true&&heartbeat.tunnelAlive===true&&Number.isSafeInteger(heartbeat.pid)&&heartbeat.pid>1
    &&Number.isSafeInteger(heartbeat.atMs)&&heartbeat.atMs<=now&&now-heartbeat.atMs<=5000,'browser-original-session-unavailable');
  try{process.kill(heartbeat.pid,0);}catch{throw Error('browser-original-worker-unavailable');}
}
export async function prepareDeliveryBrowser(context,{options,transport,launch=spawn,clock=Date.now,inspectOnly=false,run}={}) {
  const kept=original(context,options,transport);
  if(options.mode==='remote')return prepareRemoteBrowser(kept,context,{options,transport,inspectOnly,clock,run});
  if(existsSync(join(kept.dir,'prepared.json'))){
    const prepared=read(join(kept.dir,'prepared.json'));
    need(prepared.bindingSha256===hash(kept.binding),'browser-preparation-binding-changed');
    verifyBrowserSessionAlive(kept.dir,kept.record,clock());
    return proofReference(kept.dir,'prepared.json');
  }
  if(!kept.record){
    need(!inspectOnly,'browser-original-preparation-not-dispatched');
    need(typeof context.beforeNewEffect==='function','browser-fresh-effect-gate-required');await context.beforeNewEffect();
    readEvidenceFile(options.node,{maximum:128*1024**2});
    const now=clock();writeBrowserOnce(kept.path,{binding:kept.binding,startedAtMs:now,deadlineAtMs:now+options.timeoutMs});
    // Reservation precedes spawn. Lost launch response is observed, never launched again.
    const output=openSync(join(kept.dir,'worker.log'),'a',0o600);
    try{const child=launch(options.node.path,[fileURLToPath(new URL('./release-delivery-browser-driver.mjs',import.meta.url)),kept.path],
      {cwd:kept.dir,detached:true,windowsHide:true,stdio:['ignore',output,output],shell:false});
      child.on('error',()=>{});child.unref();
    }finally{closeSync(output);}
  }
  const prepared=await waitResult(kept.dir,'prepared.json');
  need(prepared.bindingSha256===hash(kept.binding),'browser-preparation-binding-changed');
  verifyBrowserSessionAlive(kept.dir,read(kept.path),clock());
  return proofReference(kept.dir,'prepared.json');
}
export function browserAcceptanceInput(context,options,transport) {
  const installed=assistantAcceptanceInput(context),assistant=context.prior.assistant;
  need(assistant?.kind==='nova-delivery-saved-assistant-reply'&&typeof assistant.key==='string'
    &&assistant.savedReplyAccepted===true&&assistant.browserUiVerified===false,'browser-saved-assistant-reply-required');
  const kept=original(context,options,transport);
  need(kept.record&&existsSync(join(kept.dir,'prepared.json')),'browser-pre-promotion-session-required');
  const prepared=read(join(kept.dir,'prepared.json'));
  need(prepared.bindingSha256===hash(kept.binding),'browser-preparation-binding-changed');
  if(installed.route==='full')verifyFullBundledIdentity(installed.installedHealth,kept.binding.fullTarget);
  return {format:1,operationId:installed.operationId,installed,assistant,
    ...(installed.route==='full'?{fullTarget:kept.binding.fullTarget}:{}),
    original:proofReference(kept.dir,'original.json'),prepared:proofReference(kept.dir,'prepared.json')};
}
export function verifyBrowserAcceptance(output,input,{requireCleanup=true}={}) {
  const original=JSON.parse(readEvidenceFile(input.original)),prepared=JSON.parse(readEvidenceFile(input.prepared));
  need(original.binding.operationId===input.operationId&&original.binding.route===input.installed.route
    &&prepared.bindingSha256===hash(original.binding)&&prepared.epoch===original.binding.epoch
    &&prepared.document.candidateId===original.binding.priorCandidateId,'browser-preparation-proof-changed');
  need(output?.kind==='nova-real-browser-acceptance'&&output.operationId===input.operationId
    &&output.inputSha256===hash(input)&&output.accepted===true&&output.browserUiVerified===true
    &&output.gatewayCoverage==='not-tested-loopback-host-surface'
    &&output.savedReplySha256===input.assistant.replySha256
    &&output.savedMessageId===input.assistant.savedMessageId,'browser-acceptance-binding-changed');
  const expected=input.installed.installedHealth,loaded=output.loadedDocument;
  if(input.installed.route==='full'){
    need(isDeepStrictEqual(input.fullTarget,original.binding.fullTarget),'browser-full-target-binding-changed');
    verifyFullBundledIdentity(expected,input.fullTarget);
    verifyDocumentIdentity(loaded,expected,{route:'full'});
    need(isDeepStrictEqual(output.selectorDiagnostics,browserSelectorDiagnostics(expected)),'browser-selector-diagnostic-proof-changed');
  }else need(!expected.frontend?.blocked,'browser-service-identity-changed');
  need(loaded?.candidateId===expected.candidateId&&loaded.frontendId===expected.frontend.id
    &&loaded.version===expected.frontend.version&&loaded.buildVersion===expected.frontend.buildVersion
    &&isDeepStrictEqual(output.originalDocument,prepared.document),'browser-loaded-document-proof-changed');
  need(output.startedAtMs===prepared.startedAtMs&&output.startedAtMs>=original.startedAtMs
    &&Number.isSafeInteger(output.completedAtMs)&&output.completedAtMs>=output.startedAtMs
    &&output.completedAtMs<=original.deadlineAtMs,'browser-acceptance-original-deadline-changed');
  const names=['old-document-retained',input.installed.route==='frontend'?'old-lazy-module':'old-client-fence','new-document-identity','retained-draft-after-refresh','ui-behavior','saved-assistant-reply-visible','owned-draft-cleaned'];
  need(Array.isArray(output.checks)&&new Set(output.checks.map(c=>c.name)).size===output.checks.length
    &&names.every(name=>output.checks.filter(c=>c.name===name&&c.passed===true).length===1),'browser-required-check-missing');
  readEvidenceFile(output.screenshot,{maximum:16*1024**2});
  const closed=JSON.parse(readEvidenceFile(output.closed));
  need(closed.operationId===input.operationId&&closed.browserClosed===true&&closed.tunnelClosed===true,'browser-owned-process-closeout-incomplete');
  if(original.binding.options.mode==='remote'){
    const unit=JSON.parse(readEvidenceFile(output.remoteUnitCloseout));
    need(unit.operationId===input.operationId&&unit.originalSha256===input.original.sha256
      &&/ActiveState=(inactive|failed)\n/.test(unit.unitState)&&unit.unitState.includes('MainPID=0\n')&&unit.ownedPids?.length===0,'browser-remote-process-closeout-incomplete');
    if(requireCleanup){const cleanup=JSON.parse(readEvidenceFile(output.remoteCleanup));
      need(cleanup.operationId===input.operationId&&cleanup.evidencePreserved===true&&Array.isArray(cleanup.removed)
        &&cleanup.removed.every(name=>['profile','config','cache'].includes(name)),'browser-remote-cleanup-proof-changed');}
  }
}
export function createBrowserAcceptanceAdapter({options,transport,storeReceipt,run:remoteRun}={}) {
  const expected=context=>browserAcceptanceInput(context,options,transport);
  const validate=context=>need(isDeepStrictEqual(context.input,expected(context)),'browser-acceptance-input-changed');
  const run=async(context,observeOnly=false)=>{
    const kept=original(context,options,transport),input=expected(context),path=join(kept.dir,'accept-request.json');
    if(options.mode==='remote'){
      try{const output=await remoteBrowserAcceptance(context,{options,transport,dir:kept.dir,input,observeOnly,run:remoteRun,
        verifyBeforeCleanup:output=>verifyBrowserAcceptance(output,input,{requireCleanup:false})});
        if(!output)return {state:'uncertain',reason:'browser-original-request-not-dispatched',output:null,receipt:null,externalId:input.operationId};
        verifyBrowserAcceptance(output,input);const receipt=storeReceipt(context.journal,context.intent.key,'browser-acceptance.json',Buffer.from(canonicalBrowser(output)+'\n'));
        return {state:'completed',reason:'real-browser-acceptance-passed',output,receipt,externalId:input.operationId};
      }catch(error){return {state:'gap',reason:safe(error),output:null,receipt:null,externalId:input.operationId};}
    }
    if(!existsSync(path)){
      if(observeOnly)return {state:'uncertain',reason:'browser-original-request-not-dispatched',output:null,receipt:null,externalId:input.operationId};
      need(typeof context.beforeNewEffect==='function','browser-fresh-effect-gate-required');await context.beforeNewEffect();
      writeBrowserOnce(path,{key:context.intent.key,input});
    }else need(isDeepStrictEqual(read(path),{key:context.intent.key,input}),'browser-original-request-changed');
    try {
      const output=await waitResult(kept.dir,'acceptance.json',observeOnly?1000:180000);verifyBrowserAcceptance(output,input);
      const receipt=storeReceipt(context.journal,context.intent.key,'browser-acceptance.json',Buffer.from(canonicalBrowser(output)+'\n'));
      return {state:'completed',reason:'real-browser-acceptance-passed',output,receipt,externalId:input.operationId};
    }catch(error){return {state:'gap',reason:safe(error),output:null,receipt:null,externalId:input.operationId};}
  };
  return {input:async context=>expected(context),validate,execute:context=>run(context),observe:context=>run(context,true),inspect:context=>run(context,true),
    verify:async(value,context)=>{if(value.state==='completed'){verifyBrowserAcceptance(value.output,expected(context));
      need(isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)),value.output),'browser-receipt-changed');}}};
}
