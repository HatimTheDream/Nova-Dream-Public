/** Normal authenticated SSH transport for the fixed remote browser caller. */
import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {runInstallTransport,releaseTransportSchema} from './release-adapters.mjs';
import {canonicalBrowser,writeBrowserOnce} from './release-delivery-browser-primitives.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=v=>sha256(canonicalBrowser(v));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const names=['release-delivery-browser-primitives.mjs','release-delivery-browser-checks.mjs','release-delivery-browser-remote-worker.mjs'];
export async function remoteBrowserCall(original,transport,mode,extra={},run=runInstallTransport){
  const config=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport))),closure=readEvidenceFile(original.binding.options.playwright,{maximum:2*1024**2});
  const sources=Object.fromEntries(names.map(name=>{const bytes=readFileSync(new URL(name,import.meta.url));return [name,{base64:bytes.toString('base64'),sha256:sha256(bytes)}];}));
  const data={mode,original,sources,closure:closure.toString('base64'),...extra};
  const helper=readFileSync(new URL('release-delivery-browser-remote.py',import.meta.url),'utf8');
  const program=`import base64,json\nDATA=json.loads(base64.b64decode('${Buffer.from(JSON.stringify(data)).toString('base64')}'))\n`+helper;
  const result=await run(config,program,{captureDiagnostics:true});
  need(typeof result.stdout==='string'&&!result.diagnosticsTruncated,'browser-remote-response-unavailable');
  const output=JSON.parse(result.stdout);if(output.state==='gap')throw Error(output.reason);
  need(result.exitCode===0,'browser-remote-caller-failed');return output;
}
function keepStatus(dir,status,original){
  need(status.operationId===original.binding.operationId&&status.originalSha256===sha256(readFileSync(join(dir,'original.json'))),'browser-remote-status-binding-changed');
  for(const [name,value]of Object.entries(status.files))if(value&&name!=='heartbeat'&&name!=='acceptance')writeBrowserOnce(join(dir,name+'.json'),value);
  return status;
}
function alive(status,original,dir){
  const beat=status.files.heartbeat,now=Date.now();
  need(!status.files.failed&&!status.files.closed&&now<original.deadlineAtMs&&beat?.operationId===original.binding.operationId
    &&beat.originalSha256===sha256(readFileSync(join(dir,'original.json')))&&beat.browserAlive===true&&beat.transport==='remote-direct'
    &&Number.isSafeInteger(beat.atMs)&&beat.atMs<=now+1000&&now-beat.atMs<=10000
    &&status.unitState.includes('ActiveState=active\n')&&status.unitState.includes(`MainPID=${beat.pid}\n`),'browser-original-remote-session-unavailable');
}
export async function prepareRemoteBrowser(kept,context,{options,transport,inspectOnly=false,clock=Date.now,run}={}){
  const {dir}=kept;
  if(!kept.record){need(!inspectOnly,'browser-original-preparation-not-dispatched');await context.beforeNewEffect();
    const now=clock();writeBrowserOnce(kept.path,{binding:kept.binding,startedAtMs:now,deadlineAtMs:now+options.timeoutMs});}
  const original=read(kept.path),launch=join(dir,'remote-launch-intent.json');
  if(!existsSync(launch)){
    need(!inspectOnly,'browser-original-preparation-not-dispatched');
    const plan=await remoteBrowserCall(original,transport,'plan',{},run);need(plan.state==='planned'&&!plan.existingOperation,'browser-remote-operation-already-exists');
    writeBrowserOnce(join(dir,'remote-plan.json'),plan);const intent={operationId:original.binding.operationId,planSha256:plan.planSha256,originalSha256:plan.plan.originalSha256};
    await context.beforeNewEffect();writeBrowserOnce(launch,intent);await remoteBrowserCall(original,transport,'start',{intent},run);
  }
  const deadline=Math.min(Date.now()+90000,original.deadlineAtMs);
  while(Date.now()<deadline){
    const status=keepStatus(dir,await remoteBrowserCall(original,transport,'status',{},run),original);
    if(status.files.failed)throw Error(status.files.failed.reason);
    if(status.files.prepared){alive(status,original,dir);const path=join(dir,'prepared.json');return {path,sha256:sha256(readFileSync(path))};}
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
