/** Fixed real-browser procedure. The daemon owns exactly one private browser
 * context and localhost SSH tunnel. Requests are immutable and operation-bound. */
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { releaseTransportSchema } from './release-adapters.mjs';
import { browserOptionsSchema, canonicalBrowser, writeBrowserOnce } from './release-delivery-browser.mjs';
import {verifyBrowserTool} from './release-delivery-browser-primitives.mjs';

import {verifyPlaywrightClosure,verifyBrowserHealth,verifyDocumentIdentity,verifySecondPage,ready,tasks,draft,ownedDraftCleanup,accept,untilOriginalDeadline} from './release-delivery-browser-checks.mjs';
export {verifyPlaywrightClosure,verifyBrowserHealth,verifyDocumentIdentity} from './release-delivery-browser-checks.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=v=>sha256(canonicalBrowser(v)),read=p=>JSON.parse(readFileSync(p,'utf8'));
const safe=e=>/^[a-z][a-z0-9-]{0,99}$/.test(e?.message??'')?e.message:'browser-dom-or-transport-check-failed';
async function freePort() {
  const server=createServer();await new Promise((ok,bad)=>{server.once('error',()=>bad(Error('browser-required-loopback-port-busy')));server.listen(4383,'127.0.0.1',ok);});
  await new Promise(ok=>server.close(ok));
}
async function waitPort(tunnel) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){need(tunnel.exitCode===null,'browser-ssh-tunnel-exited');
    const connected=await new Promise(ok=>{const socket=connect({host:'127.0.0.1',port:4383});socket.setTimeout(250);
      socket.once('connect',()=>{socket.destroy();ok(true);});socket.once('error',()=>{socket.destroy();ok(false);});socket.once('timeout',()=>{socket.destroy();ok(false);});});
    if(connected)return;await sleep(200);}
  throw Error('browser-ssh-tunnel-unavailable');
}
export async function runBrowserDriver(originalPath) {
  const dir=dirname(resolve(originalPath)),original=read(originalPath),binding=original.binding,options=browserOptionsSchema.parse(binding.options);
  const transport=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(binding.transport)));
  need(Number.isSafeInteger(original.deadlineAtMs)&&original.deadlineAtMs===original.startedAtMs+options.timeoutMs
    &&Date.now()<original.deadlineAtMs,'browser-original-deadline-exhausted');
  for(const item of [options.node,options.ssh])verifyBrowserTool(item,{maximum:128*1024**2});
  verifyBrowserTool(options.executable,{maximum:512*1024**2});
  readEvidenceFile(transport.sshConfig,{maximum:65536});const entry=verifyPlaywrightClosure(options.playwright);
  writeBrowserOnce(join(dir,'worker-identity.json'),{pid:process.pid,operationId:binding.operationId,originalSha256:sha256(readFileSync(originalPath))});
  let tunnel,context,oldPage,prepared,accepted,heartbeatTimer;
  try{
    await freePort();tunnel=spawn(options.ssh.path,['-F',transport.sshConfig.path,'-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-N',
      '-L','127.0.0.1:4383:127.0.0.1:4383',transport.hostAlias],{shell:false,windowsHide:true,stdio:'ignore'});
    tunnel.on('error',()=>{});await waitPort(tunnel);
    const {chromium}=await import(pathToFileURL(entry).href);
    context=await chromium.launchPersistentContext(join(dir,'profile'),{executablePath:options.executable.path,headless:true,chromiumSandbox:true,
      viewport:{width:1280,height:800},acceptDownloads:false,timeout:30000});
    context.setDefaultTimeout(20000);oldPage=context.pages()[0]??await context.newPage();
    await oldPage.goto(options.baseUrl,{waitUntil:'domcontentloaded'});const initial=await ready(oldPage,options.baseUrl);
    verifyBrowserHealth(initial.health,{candidateId:binding.priorCandidateId,epoch:binding.epoch},initial.epoch);verifyDocumentIdentity(initial.identity,initial.health);
    await tasks(oldPage);const field=await draft(oldPage);need(await field.inputValue()==='','browser-owned-profile-draft-not-empty');
    const text=`Nova release verification ${binding.operationId} — retained unsent draft`;await field.fill(text);
    const secondPage=await verifySecondPage(context,options,initial);
    prepared={format:1,kind:'nova-pre-promotion-browser',bindingSha256:hash(binding),startedAtMs:Date.now(),
      document:initial.identity,health:initial.health,epoch:initial.epoch,draft:text,secondPage};
    const heartbeat=()=>{const temporary=join(dir,'heartbeat.tmp');writeFileSync(temporary,canonicalBrowser({operationId:binding.operationId,
      originalSha256:sha256(readFileSync(originalPath)),pid:process.pid,atMs:Date.now(),browserAlive:!oldPage.isClosed(),tunnelAlive:tunnel.exitCode===null})+'\n',{mode:0o600});
      renameSync(temporary,join(dir,'heartbeat.json'));};
    heartbeat();heartbeatTimer=setInterval(heartbeat,2000);writeBrowserOnce(join(dir,'prepared.json'),prepared);
    while(Date.now()<original.deadlineAtMs){
      need(tunnel.exitCode===null,'browser-original-tunnel-lost');
      if(existsSync(join(dir,'close-request.json'))){need(read(join(dir,'close-request.json')).operationId===binding.operationId,'browser-close-operation-changed');
        await ownedDraftCleanup(oldPage,prepared.draft);return;}
      if(existsSync(join(dir,'accept-request.json'))){accepted=await untilOriginalDeadline(()=>accept(context,oldPage,prepared,read(join(dir,'accept-request.json')),dir,original),original.deadlineAtMs);break;}
      await sleep(250);
    }
    if(!accepted)throw Error('browser-original-deadline-exhausted');
  }catch(error){writeBrowserOnce(join(dir,'failed.json'),{operationId:binding.operationId,reason:safe(error),detail:String(error.message).slice(0,2000),atMs:Date.now()});}
  finally{
    clearInterval(heartbeatTimer);
    if(context)await context.close().catch(()=>{});
    if(tunnel&&tunnel.exitCode===null){tunnel.kill();await Promise.race([new Promise(r=>tunnel.once('exit',r)),sleep(5000)]);}
    writeBrowserOnce(join(dir,'closed.json'),{operationId:binding.operationId,atMs:Date.now(),browserClosed:!context||context.pages().length===0,
      tunnelClosed:!tunnel||tunnel.exitCode!==null||tunnel.signalCode!==null});
  }
  if(accepted){const path=join(dir,'closed.json');writeBrowserOnce(join(dir,'acceptance.json'),{...accepted,closed:{path,sha256:sha256(readFileSync(path))}});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runBrowserDriver(process.argv[2]).catch(error=>{
    const dir=dirname(resolve(process.argv[2]));
    if(!existsSync(join(dir,'failed.json')))writeBrowserOnce(join(dir,'failed.json'),{reason:safe(error),detail:String(error.message).slice(0,2000),atMs:Date.now()});
    if(!existsSync(join(dir,'worker-identity.json'))&&!existsSync(join(dir,'closed.json')))
      writeBrowserOnce(join(dir,'closed.json'),{operationId:read(process.argv[2]).binding.operationId,atMs:Date.now(),browserClosed:true,tunnelClosed:true});
    process.stderr.write(safe(error)+'\n');process.exitCode=1;
  });
}
