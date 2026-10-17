/** Remote execution of the same fixed browser checks; no tunnel or dependency installation. */
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonicalBrowser,sha256,verifyBrowserTool,writeBrowserOnce} from './release-delivery-browser-primitives.mjs';
import {verifyPlaywrightClosure,verifyInitialBrowserIdentity,verifySecondPage,ready,tasks,draft,ownedDraftCleanup,accept,untilOriginalDeadline} from './release-delivery-browser-checks.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},sleep=ms=>new Promise(r=>setTimeout(r,ms)),read=p=>JSON.parse(readFileSync(p,'utf8'));
const safe=e=>/^[a-z][a-z0-9-]{0,99}$/.test(e?.message??'')?e.message:'browser-dom-or-transport-check-failed';
export async function remoteBrowserWorker(originalPath){
  const dir=dirname(resolve(originalPath)),original=read(originalPath),binding=original.binding,options=binding.options;
  need(options.mode==='remote'&&options.baseUrl==='http://127.0.0.1:4383'&&['tasks-search-escape','tasks-search-focus'].includes(options.suite)
    &&Number.isSafeInteger(original.deadlineAtMs)&&original.deadlineAtMs===original.startedAtMs+options.timeoutMs
    &&options.timeoutMs>=300000&&options.timeoutMs<=1800000&&Date.now()<original.deadlineAtMs&&process.getuid()!==0,'browser-remote-input-invalid');
  verifyBrowserTool(options.node,{maximum:128*1024**2});verifyBrowserTool(options.executable,{maximum:512*1024**2});
  const closurePath=join(dir,'playwright-closure.json'),entry=verifyPlaywrightClosure({path:closurePath,sha256:options.playwright.sha256});
  writeBrowserOnce(join(dir,'worker-identity.json'),{pid:process.pid,operationId:binding.operationId,originalSha256:sha256(readFileSync(originalPath))});
  const milestone=name=>{
    const cgroup=readFileSync('/proc/self/cgroup','utf8').split('\n').find(line=>line.startsWith('0::'))?.slice(3);
    need(cgroup?.startsWith('/')&&!cgroup.split('/').includes('..'),'browser-memory-cgroup-invalid');
    const root='/sys/fs/cgroup'+cgroup;
    writeBrowserOnce(join(dir,'memory-'+name+'.json'),{operationId:binding.operationId,atMs:Date.now(),milestone:name,
      currentBytes:Number(readFileSync(root+'/memory.current','utf8').trim()),peakBytes:Number(readFileSync(root+'/memory.peak','utf8').trim()),
      stat:readFileSync(root+'/memory.stat','utf8'),events:readFileSync(root+'/memory.events','utf8')});
  };
  milestone('tools-verified');
  let context,oldPage,prepared,accepted,timer;
  try{
    const {chromium}=await import(pathToFileURL(entry).href);
    context=await chromium.launchPersistentContext(join(dir,'profile'),{executablePath:options.executable.path,headless:true,chromiumSandbox:true,
      viewport:{width:1280,height:800},acceptDownloads:false,timeout:30000});context.setDefaultTimeout(20000);
    oldPage=context.pages()[0]??await context.newPage();await oldPage.goto(options.baseUrl,{waitUntil:'domcontentloaded'});
    const initial=await ready(oldPage,options.baseUrl),initialContract=verifyInitialBrowserIdentity(initial,binding);
    milestone('first-page-ready');
    await tasks(oldPage);const field=await draft(oldPage);need(await field.inputValue()==='','browser-owned-profile-draft-not-empty');
    const text=`Nova release verification ${binding.operationId} — retained unsent draft`;await field.fill(text);
    const secondPage=await verifySecondPage(context,options,initial,milestone,initialContract);
    prepared={format:1,kind:'nova-pre-promotion-browser',bindingSha256:sha256(canonicalBrowser(binding)),startedAtMs:Date.now(),document:initial.identity,health:initial.health,epoch:initial.epoch,draft:text,secondPage};
    const heartbeat=()=>{const path=join(dir,'heartbeat.tmp');writeFileSync(path,canonicalBrowser({operationId:binding.operationId,originalSha256:sha256(readFileSync(originalPath)),
      pid:process.pid,atMs:Date.now(),browserAlive:!oldPage.isClosed(),tunnelAlive:true,transport:'remote-direct'})+'\n',{mode:0o600});renameSync(path,join(dir,'heartbeat.json'));};
    heartbeat();timer=setInterval(heartbeat,2000);writeBrowserOnce(join(dir,'prepared.json'),prepared);
    while(Date.now()<original.deadlineAtMs){
      if(existsSync(join(dir,'close-request.json'))){need(read(join(dir,'close-request.json')).operationId===binding.operationId,'browser-close-operation-changed');await ownedDraftCleanup(oldPage,prepared.draft);return;}
      if(existsSync(join(dir,'accept-request.json'))){accepted=await untilOriginalDeadline(()=>accept(context,oldPage,prepared,read(join(dir,'accept-request.json')),dir,original),original.deadlineAtMs);break;}
      await sleep(250);
    }
    need(accepted,'browser-original-deadline-exhausted');
  }catch(error){writeBrowserOnce(join(dir,'failed.json'),{operationId:binding.operationId,reason:safe(error),detail:String(error.message).slice(0,2000),atMs:Date.now()});}
  finally{clearInterval(timer);if(context)await context.close().catch(()=>{});
    milestone('browser-closed');
    writeBrowserOnce(join(dir,'closed.json'),{operationId:binding.operationId,atMs:Date.now(),browserClosed:!context||context.pages().length===0,tunnelClosed:true,transport:'remote-direct'});}
  if(accepted){const path=join(dir,'closed.json');writeBrowserOnce(join(dir,'acceptance.json'),{...accepted,closed:{path,sha256:sha256(readFileSync(path))}});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)remoteBrowserWorker(process.argv[2]).catch(error=>{
  const dir=dirname(resolve(process.argv[2]));if(!existsSync(join(dir,'failed.json')))writeBrowserOnce(join(dir,'failed.json'),{reason:safe(error),detail:String(error.message).slice(0,2000),atMs:Date.now()});
  if(!existsSync(join(dir,'worker-identity.json'))&&!existsSync(join(dir,'closed.json')))writeBrowserOnce(join(dir,'closed.json'),{operationId:read(process.argv[2]).binding.operationId,atMs:Date.now(),browserClosed:true,tunnelClosed:true,transport:'remote-direct'});
  process.exitCode=1;
});
