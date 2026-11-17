/** Normal authenticated SSH transport for the fixed remote browser caller. */
import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {runInstallTransport,releaseTransportSchema} from './release-adapters.mjs';
import {canonicalBrowser,writeBrowserOnce} from './release-delivery-browser-primitives.mjs';
import {verifyLinkedBrowserRecord} from './release-delivery-browser-continuation.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=v=>sha256(canonicalBrowser(v));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const names=['release-delivery-browser-primitives.mjs','release-delivery-browser-checks.mjs','release-delivery-browser-remote-worker.mjs'];
const transportTimings=new WeakMap();
export async function remoteBrowserCall(original,transport,mode,extra={},run=runInstallTransport,monotonic=()=>performance.now()){
  const config=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport))),closure=readEvidenceFile(original.binding.options.playwright,{maximum:2*1024**2});
  const sources=Object.fromEntries(names.map(name=>{const bytes=readFileSync(new URL(name,import.meta.url));return [name,{base64:bytes.toString('base64'),sha256:sha256(bytes)}];}));
  const data={mode,original,sources,closure:closure.toString('base64'),...extra};
  const helper=readFileSync(new URL('release-delivery-browser-remote.py',import.meta.url),'utf8');
  const program=`import base64,json\nDATA=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(data)).toString('base64')}'))\n`+helper;
  const started=monotonic(),result=await run(config,program,{captureDiagnostics:true}),transportElapsedMs=monotonic()-started;
  need(result.uncertain!==true&&typeof result.stdout==='string'&&!result.diagnosticsTruncated,'browser-remote-response-unavailable');
  const output=JSON.parse(result.stdout);if(output.state==='gap')throw Error(output.reason);
  need(result.exitCode===0,'browser-remote-caller-failed');
  // This duration belongs to the local transport; host timestamps remain on the host clock.
  const observed={...output,transportElapsedMs};
  transportTimings.set(observed,{started,monotonic});return observed;
}
function keepStatus(dir,status,original){
  need(status.operationId===original.binding.operationId&&status.originalSha256===sha256(readFileSync(join(dir,'original.json'))),'browser-remote-status-binding-changed');
  for(const [name,value]of Object.entries(status.files))if(value&&name!=='heartbeat'&&name!=='acceptance')writeBrowserOnce(join(dir,name+'.json'),value);
  return status;
}
export function verifyRemoteBrowserSessionAlive(status,original,dir,now=Date.now()){
  const beat=status.files.heartbeat,hostNow=status.observedAtMs,timing=transportTimings.get(status);
  const localElapsedMs=timing?timing.monotonic()-timing.started:NaN;
  need(!status.files.failed&&!status.files.closed&&now<original.deadlineAtMs&&beat?.operationId===original.binding.operationId
    &&beat.originalSha256===sha256(readFileSync(join(dir,'original.json')))&&beat.browserAlive===true&&beat.transport==='remote-direct'
    &&Number.isSafeInteger(hostNow)&&Number.isSafeInteger(beat.atMs)&&beat.atMs<=hostNow
    &&Number.isFinite(localElapsedMs)&&localElapsedMs>=0&&hostNow-beat.atMs+localElapsedMs<=10000
    &&status.unitState.includes('ActiveState=active\n')&&status.unitState.includes(`MainPID=${beat.pid}\n`),'browser-original-remote-session-unavailable');
}
function verifyRemoteLaunchPlan(response,original){
  const plan=response?.plan,options=original.binding.options;
  need(response?.state==='planned'&&response.existingOperation===false&&plan?.operationId===original.binding.operationId
    &&response.planSha256===hash(plan)&&plan.originalSha256===sha256(Buffer.from(canonicalBrowser(original)+'\n'))
    &&canonicalBrowser(plan.node)===canonicalBrowser(options.node)&&canonicalBrowser(plan.executable)===canonicalBrowser(options.executable)
    &&plan.playwrightSha256===options.playwright.sha256
    &&(!original.binding.sessionId||(plan.sessionId===original.binding.sessionId&&plan.directory===options.directoryRoot+'/'+plan.sessionId&&plan.unit==='nova-browser-'+plan.sessionId)),'browser-remote-plan-binding-changed');
  return {operationId:original.binding.operationId,planSha256:response.planSha256,originalSha256:plan.originalSha256};
}
export async function prepareRemoteBrowser(kept,context,{options,transport,inspectOnly=false,clock=Date.now,run}={}){
  const {dir}=kept,reservation=kept.binding.publicationContinuation?.browserReservation;
  // A fixed reservation may be materialized after a crash, but never restarted.
  if(reservation){
    const fixed={binding:kept.binding,startedAtMs:reservation.startedAtMs,deadlineAtMs:reservation.deadlineAtMs};
    verifyLinkedBrowserRecord(fixed);
    if(!kept.record)need(clock()>=reservation.startedAtMs&&clock()<reservation.deadlineAtMs,'browser-original-deadline-exhausted');
  }
  if(!kept.record){need(!inspectOnly,'browser-original-preparation-not-dispatched');await context.beforeNewEffect();
    const now=clock(),startedAtMs=reservation?.startedAtMs??now,deadlineAtMs=reservation?.deadlineAtMs??now+options.timeoutMs;
    need(now>=startedAtMs&&now<deadlineAtMs,'browser-original-deadline-exhausted');
    if(kept.binding.publicationContinuation)need(deadlineAtMs<=kept.binding.publicationContinuation.expiresAtMs,'browser-successor-budget-exceeds-grant');
    writeBrowserOnce(kept.path,{binding:kept.binding,startedAtMs,deadlineAtMs});}
  const original=read(kept.path),launch=join(dir,'remote-launch-intent.json'),planPath=join(dir,'remote-plan.json');
  need(canonicalBrowser(original.binding)===canonicalBrowser(kept.binding),'browser-original-binding-changed');
  if(reservation)verifyLinkedBrowserRecord(original);
  if(!existsSync(launch)){
    need(!inspectOnly,'browser-original-preparation-not-dispatched');
    // Expiry before intent dispatch cannot create any remote browser effect.
    need(clock()>=original.startedAtMs&&clock()<original.deadlineAtMs,'browser-original-deadline-exhausted');
    let plan;
    if(reservation&&existsSync(planPath))plan=read(planPath);
    else{
      plan=await remoteBrowserCall(original,transport,'plan',{},run);need(plan.state==='planned'&&!plan.existingOperation,'browser-remote-operation-already-exists');
      if(reservation)verifyRemoteLaunchPlan(plan,original);
      writeBrowserOnce(planPath,plan);
    }
    const intent=reservation?verifyRemoteLaunchPlan(plan,original):{operationId:original.binding.operationId,planSha256:plan.planSha256,originalSha256:plan.plan.originalSha256};
    await context.beforeNewEffect();need(clock()<original.deadlineAtMs,'browser-original-deadline-exhausted');
    writeBrowserOnce(launch,intent);await remoteBrowserCall(original,transport,'start',{intent},run);
  }else if(reservation){
    need(existsSync(planPath)&&canonicalBrowser(read(launch))===canonicalBrowser(verifyRemoteLaunchPlan(read(planPath),original)),'browser-remote-launch-intent-changed');
  }
  if(clock()>=original.deadlineAtMs){
    const status=keepStatus(dir,await remoteBrowserCall(original,transport,'status',{},run),original);
    if(status.files.failed)throw Error(status.files.failed.reason);
    need(!status.files.closed,'browser-original-session-closed');throw Error('browser-original-deadline-exhausted');
  }
  const deadline=Math.min(clock()+90000,original.deadlineAtMs);
  while(clock()<deadline){
    const status=keepStatus(dir,await remoteBrowserCall(original,transport,'status',{},run),original);
    if(status.files.failed)throw Error(status.files.failed.reason);
    if(status.files.prepared){verifyRemoteBrowserSessionAlive(status,original,dir,clock());const path=join(dir,'prepared.json');return {path,sha256:sha256(readFileSync(path))};}
    need(!status.files.closed,'browser-original-session-closed');await sleep(1500);
  }
  throw Error('browser-original-response-unavailable');
}
export async function remoteBrowserAcceptance(context,{options,transport,dir,input,observeOnly=false,run,verifyBeforeCleanup}={}){
  const original=read(join(dir,'original.json')),path=join(dir,'accept-request.json'),request={key:context.intent.key,input};
  if(!existsSync(path)){
    if(observeOnly)return null;
    need(Date.now()<original.deadlineAtMs,'browser-original-deadline-exhausted');
    await context.beforeNewEffect();writeBrowserOnce(path,request);await remoteBrowserCall(original,transport,'request',{request},run);
  }else need(canonicalBrowser(read(path))===canonicalBrowser(request),'browser-original-request-changed');
  // Dispatch keeps the original deadline. Terminal evidence remains collectible
  // after an interrupted response; collection never creates another request.
  const deadline=Date.now()+(observeOnly?15000:180000);
  while(Date.now()<deadline){
    const status=keepStatus(dir,await remoteBrowserCall(original,transport,'status',{},run),original);
    if(status.files.failed)throw Error(status.files.failed.reason);
    if(status.files.acceptance&&status.files.closed&&/ActiveState=(inactive|failed)\n/.test(status.unitState)&&status.unitState.includes('MainPID=0\n')&&status.ownedPids?.length===0){
      const raw=status.files.acceptance;writeBrowserOnce(join(dir,'remote-acceptance.json'),raw);
      const chunks=[];let offset=0,total,digest;
      do{const part=await remoteBrowserCall(original,transport,'screenshot',{offset},run);
        need(part.offset===offset&&Number.isSafeInteger(part.bytes)&&part.bytes<=16*1024**2&&(!digest||digest===part.sha256)&&(!total||total===part.bytes),'browser-remote-screenshot-changed');
        total=part.bytes;digest=part.sha256;const bytes=Buffer.from(part.base64,'base64');need(bytes.length>0&&bytes.length<=49152,'browser-remote-screenshot-chunk-invalid');chunks.push(bytes);offset+=bytes.length;
      }while(offset<total);
      const image=Buffer.concat(chunks);need(offset===total&&sha256(image)===digest&&digest===raw.screenshot.sha256,'browser-remote-screenshot-hash-changed');
      const imagePath=join(dir,'accepted-ui.png');if(!existsSync(imagePath))writeFileSync(imagePath,image,{flag:'wx',mode:0o600});else need(sha256(readFileSync(imagePath))===digest,'browser-local-screenshot-changed');
      const closedPath=join(dir,'closed.json'),unitPath=join(dir,'remote-unit-closeout.json');
      writeBrowserOnce(unitPath,{operationId:input.operationId,unitState:status.unitState,ownedPids:status.ownedPids,originalSha256:status.originalSha256});
      const collected={...raw,screenshot:{path:imagePath,sha256:digest},closed:{path:closedPath,sha256:sha256(readFileSync(closedPath))},remoteUnitCloseout:{path:unitPath,sha256:sha256(readFileSync(unitPath))}};
      need(typeof verifyBeforeCleanup==='function','browser-remote-proof-verifier-required');await verifyBeforeCleanup(collected);
      const cleanup=await remoteBrowserCall(original,transport,'cleanup',{acceptanceSha256:sha256(Buffer.from(canonicalBrowser(raw)+'\n'))},run);
      need(cleanup.state==='cleaned'&&cleanup.cleanup.operationId===input.operationId&&cleanup.cleanup.evidencePreserved===true,'browser-remote-profile-cleanup-unconfirmed');
      const cleanupPath=join(dir,'remote-cleanup.json');writeBrowserOnce(cleanupPath,cleanup.cleanup);
      const output={...collected,remoteCleanup:{path:cleanupPath,sha256:sha256(readFileSync(cleanupPath))}};
      writeBrowserOnce(join(dir,'acceptance.json'),output);return output;
    }
    await sleep(1500);
  }
  throw Error('browser-original-response-unavailable');
}
