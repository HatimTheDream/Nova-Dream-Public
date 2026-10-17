/** Fixed DOM checks shared by local and remote task-owned browsers. */
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {readEvidenceFile,sha256,canonicalBrowser} from './release-delivery-browser-primitives.mjs';
const need=(v,r)=>{if(!v)throw Error(r);},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=v=>sha256(canonicalBrowser(v)),read=p=>JSON.parse(readFileSync(p,'utf8'));
const safe=e=>/^[a-z][a-z0-9-]{0,99}$/.test(e?.message??'')?e.message:'browser-dom-or-transport-check-failed';
export function verifyPlaywrightClosure(reference) {
  const manifest=JSON.parse(readEvidenceFile(reference,{maximum:2*1024**2}));
  need(manifest.format===1&&isAbsolute(manifest.entry)&&Array.isArray(manifest.files)&&manifest.files.length>10
    &&manifest.files.length<5000,'browser-playwright-closure-invalid');
  const paths=new Set();
  for(const item of manifest.files){need(isAbsolute(item.path)&&!paths.has(resolve(item.path)),'browser-playwright-closure-invalid');
    readEvidenceFile(item,{maximum:64*1024**2});paths.add(resolve(item.path));}
  need(paths.has(resolve(manifest.entry)),'browser-playwright-entry-unbound');
  // Both package trees must be complete; an added module cannot evade hashing.
  const roots=[...new Set([dirname(manifest.entry),join(dirname(dirname(manifest.entry)),'playwright-core')])];
  const walk=dir=>{need(!lstatSync(dir).isSymbolicLink(),'browser-playwright-symlink');for(const name of readdirSync(dir)){
    const path=join(dir,name),s=lstatSync(path);need(!s.isSymbolicLink(),'browser-playwright-symlink');
    if(s.isDirectory())walk(path);else need(s.isFile()&&paths.has(resolve(path)),'browser-playwright-unbound-file');}};
  roots.forEach(walk);return manifest.entry;
}
export function verifyFullBundledIdentity(health,target) {
  need(target&&/^[a-f0-9]{64}$/.test(target.candidateId)&&/^\d+\.\d+\.\d+$/.test(target.version)&&/^\d+\.\d+\.\d+$/.test(target.buildVersion)
    &&health?.candidateId===target.candidateId&&health.frontend?.source==='bundled'&&health.frontend.id===target.candidateId
    &&health.frontend.version===target.version&&health.frontend.buildVersion===target.buildVersion
    &&(health.frontend.blocked===undefined||typeof health.frontend.blocked==='boolean'),'browser-full-bundled-identity-changed');
}
export function browserSelectorDiagnostics(health) {
  return health.frontend?.blocked===true?[{code:'retained-frontend-selector-rejected',servedSource:'bundled',blocked:true}]:[];
}
export function verifyBrowserHealth(health,expected,epoch,{route,target}={}) {
  if(route==='full'){
    verifyFullBundledIdentity(expected,target);verifyFullBundledIdentity(health,target);
    need(health.frontend.blocked===expected.frontend.blocked,'browser-selector-diagnostic-changed');
  }
  need(health?.application==='nova-dream-edition-3'&&health.status==='ready'&&(route==='full'||!health.frontend?.blocked)
    &&health.candidateId===expected.candidateId,'browser-service-identity-changed');
  for(const name of ['processIdentity','serviceInputsSha256'])if(expected[name])need(health[name]===expected[name],'browser-service-identity-changed');
  if(expected.frontend)need(health.frontend?.id===expected.frontend.id&&health.frontend.version===expected.frontend.version
    &&health.frontend.buildVersion===expected.frontend.buildVersion,'browser-selected-interface-changed');
  if(expected.epoch)need(epoch===expected.epoch,'browser-workspace-epoch-changed');
}
export function verifyDocumentIdentity(document,health,{route}={}) {
  need(document.candidateId===health.candidateId&&document.frontendId===health.frontend.id
    &&document.version===health.frontend.version&&document.buildVersion===health.frontend.buildVersion
    &&typeof document.assets==='string'&&document.assets.startsWith('/'),'browser-loaded-document-identity-changed');
  if(route==='full')need(health.frontend.source==='bundled'&&document.assets===`/__bundled/${health.candidateId}/`,'browser-loaded-bundled-namespace-changed');
}
export async function documentIdentity(page) {
  return page.evaluate(()=>{const meta=name=>document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
    return {candidateId:meta('e3-candidate'),frontendId:meta('e3-frontend'),version:meta('e3-frontend-version'),buildVersion:meta('e3-frontend-build'),assets:meta('e3-assets')};});
}
export async function ready(page,baseUrl) {
  await page.locator('.app-shell').waitFor({state:'visible',timeout:45000});
  const identity=await documentIdentity(page),headers={'X-Edition3-Client':'1','X-Edition3-Candidate':identity.candidateId};
  const [h,s]=await Promise.all([page.request.get(baseUrl+'/api/health'),page.request.get(baseUrl+'/api/snapshot',{headers})]);
  need(h.ok()&&s.ok(),'browser-authenticated-readiness-unavailable');
  const health=await h.json(),snapshot=await s.json();return {health,epoch:snapshot.epoch,identity};
}
export function verifyInitialBrowserIdentity(initial,binding) {
  const contract=binding.route==='full'&&initial.health.frontend?.source==='bundled'?{route:'full',target:binding.priorBundledTarget}:{};
  if(contract.route==='full')need(contract.target?.candidateId===binding.priorCandidateId,'browser-prior-bundled-binding-changed');
  verifyBrowserHealth(initial.health,{...initial.health,candidateId:binding.priorCandidateId,epoch:binding.epoch},initial.epoch,contract);
  verifyDocumentIdentity(initial.identity,initial.health,contract);return contract;
}
export async function verifySecondPage(context,options,initial,milestone=()=>{},contract={}) {
  const page=await context.newPage();
  try{
    milestone('second-page-opened');
    await page.goto(options.baseUrl,{waitUntil:'domcontentloaded'});
    const second=await ready(page,options.baseUrl);
    verifyBrowserHealth(second.health,{...initial.health,epoch:initial.epoch},second.epoch,contract);
    verifyDocumentIdentity(second.identity,initial.health,contract);
    milestone('second-page-ready');
    return {simultaneousPages:context.pages().length,document:second.identity,verifiedAtMs:Date.now()};
  }finally{await page.close();}
}
async function nav(page,label) {
  const rail=page.locator('#main-navigation');
  if(!await rail.isVisible()){const show=page.getByRole('button',{name:'Show main navigation',exact:true});if(await show.isVisible())await show.click();}
  await page.locator('#main-navigation').getByRole('button',{name:label,exact:true}).click();
}
export async function tasks(page) {await nav(page,'Tasks');await page.getByRole('textbox',{name:'Search tasks',exact:true}).waitFor({state:'visible'});}
export async function draft(page) {return page.getByRole('textbox',{name:'Quick task title',exact:true});}
export async function ownedDraftCleanup(page,text) {
  await tasks(page);const field=await draft(page);need(await field.inputValue()===text,'browser-owned-draft-changed');await field.fill('');
  need(await field.inputValue()==='','browser-owned-draft-cleanup-unconfirmed');
}
async function assertUi(page,suite) {
  await tasks(page);const search=page.getByRole('textbox',{name:'Search tasks',exact:true});
  await search.fill('Nova acceptance search');await search.press('Escape');
  need(await search.inputValue()===''&&await search.evaluate(el=>document.activeElement===el),'browser-search-escape-failed');
  await search.fill('Nova acceptance search');await page.getByRole('button',{name:'Clear task search',exact:true}).click();
  need(await search.inputValue()===''&&await search.evaluate(el=>document.activeElement===el),'browser-search-clear-focus-failed');
  if(suite==='tasks-search-focus'){
    await page.locator('.breadcrumb').click();await page.keyboard.press('/');
    need(await search.inputValue()===''&&await search.evaluate(el=>document.activeElement===el),'browser-search-shortcut-focus-failed');
    const quick=await draft(page),kept=await quick.inputValue();await quick.press('End');await quick.press('/');
    need(await quick.inputValue()===kept+'/'&&await quick.evaluate(el=>document.activeElement===el),'browser-search-shortcut-intercepted-writing');
    await quick.fill(kept);need((await search.getAttribute('placeholder'))?.includes('/'),'browser-search-shortcut-hint-missing');
  }
}
export async function accept(context,oldPage,prepared,request,dir,original) {
  const input=request.input,options=original.binding.options,checks=[];
  need(input.operationId===original.binding.operationId&&input.prepared.sha256===sha256(readFileSync(join(dir,'prepared.json')))
    &&input.original.sha256===sha256(readFileSync(join(dir,'original.json'))),'browser-request-original-changed');
  const check=name=>checks.push({name,passed:true,atMs:Date.now()});
  const expected=input.installed.installedHealth,contract={route:input.installed.route,target:input.fullTarget};
  if(contract.route==='full'){
    need(hash(input.fullTarget)===hash(original.binding.fullTarget),'browser-full-target-binding-changed');
    verifyFullBundledIdentity(expected,input.fullTarget);
  }
  need(hash(await documentIdentity(oldPage))===hash(prepared.document),'browser-old-document-replaced');check('old-document-retained');
  if(input.installed.route==='frontend'){
    await nav(oldPage,'Content');await oldPage.getByRole('textbox',{name:'Search content records',exact:true}).waitFor({state:'visible'});
    need(hash(await documentIdentity(oldPage))===hash(prepared.document),'browser-old-document-replaced');check('old-lazy-module');
    await tasks(oldPage);need(await(await draft(oldPage)).inputValue()===prepared.draft,'browser-original-draft-lost');
    await oldPage.getByRole('button',{name:'Refresh',exact:true}).waitFor({state:'visible',timeout:45000});
  }else{
    await tasks(oldPage);need(await(await draft(oldPage)).inputValue()===prepared.draft,'browser-original-draft-lost');
    // Full releases retain their captured service identity and request fence.
    await oldPage.getByRole('button',{name:'Reload app',exact:true}).waitFor({state:'visible',timeout:45000});check('old-client-fence');
  }
  const newPage=await context.newPage();await newPage.goto(options.baseUrl,{waitUntil:'domcontentloaded'});
  const fresh=await ready(newPage,options.baseUrl);verifyBrowserHealth(fresh.health,expected,fresh.epoch,contract);verifyDocumentIdentity(fresh.identity,fresh.health,contract);check('new-document-identity');
  await oldPage.getByRole('button',{name:input.installed.route==='frontend'?'Refresh':'Reload app',exact:true}).click();
  await oldPage.waitForLoadState('domcontentloaded');const reloaded=await ready(oldPage,options.baseUrl);
  verifyBrowserHealth(reloaded.health,expected,reloaded.epoch,contract);verifyDocumentIdentity(reloaded.identity,reloaded.health,contract);
  await tasks(oldPage);need(await(await draft(oldPage)).inputValue()===prepared.draft,'browser-reloaded-draft-lost');check('retained-draft-after-refresh');
  await assertUi(newPage,options.suite);check('ui-behavior');
  const expectedReply=`Nova verification ${input.assistant.key} passed.`;
  need(sha256(expectedReply)===input.assistant.replySha256,'browser-original-reply-hash-changed');
  await nav(newPage,'Assistant');
  const show=newPage.getByRole('button',{name:'Show assistant sidebar',exact:true});if(await show.isVisible())await show.click();
  need(/^[a-f0-9-]{36}$/.test(input.assistant.conversationId),'browser-conversation-id-invalid');
  const historyPromise=newPage.waitForResponse(r=>r.url().includes('/api/assistant/history/'+input.assistant.conversationId)&&r.ok(),{timeout:30000});
  await newPage.locator(`[data-conversation-id="${input.assistant.conversationId}"] button.saved-draft`).click();
  const history=await(await historyPromise).json();
  need(history.nativeId===input.assistant.nativeId&&history.messages.some(m=>m.id===input.assistant.savedMessageId
    &&m.role==='assistant'&&m.text?.trim()===expectedReply),'browser-original-saved-message-missing');
  const message=newPage.getByRole('article',{name:'assistant message',exact:true}).filter({hasText:expectedReply});
  await message.waitFor({state:'visible',timeout:30000});need(await message.count()===1,'browser-original-reply-not-unique');check('saved-assistant-reply-visible');
  const screenshotPath=join(dir,'accepted-ui.png');await newPage.screenshot({path:screenshotPath,fullPage:false});
  await ownedDraftCleanup(oldPage,prepared.draft);check('owned-draft-cleaned');
  const healthFinal=await ready(oldPage,options.baseUrl);verifyBrowserHealth(healthFinal.health,expected,healthFinal.epoch,contract);
  return {format:1,kind:'nova-real-browser-acceptance',operationId:input.operationId,inputSha256:hash(input),
    accepted:true,browserUiVerified:true,gatewayCoverage:'not-tested-loopback-host-surface',
    startedAtMs:prepared.startedAtMs,completedAtMs:Date.now(),checks,loadedDocument:fresh.identity,originalDocument:prepared.document,
    ...(contract.route==='full'?{selectorDiagnostics:browserSelectorDiagnostics(healthFinal.health)}:{}),
    savedReplySha256:sha256(expectedReply),savedMessageId:input.assistant.savedMessageId,
    screenshot:{path:screenshotPath,sha256:sha256(readFileSync(screenshotPath))}};
}
export async function untilOriginalDeadline(operation,deadlineAtMs) {
  need(Date.now()<deadlineAtMs,'browser-original-deadline-exhausted');let timer;
  try{return await Promise.race([operation(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('browser-original-deadline-exhausted')),deadlineAtMs-Date.now());})]);}
  finally{clearTimeout(timer);}
}
