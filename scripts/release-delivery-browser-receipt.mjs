import {readdirSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,readReleaseInputFile} from './release-plan.mjs';
import {createDeliveryRegistry, fixedCommand} from './release-delivery-adapters.mjs';
import {continuationRequestSchema, qualifyOperatorSources, saveContinuationEvidence, verifyOperatorCi, verifyContinuationGrant, verifyOriginalOwnerAbsent} from './release-delivery-continuation.mjs';
import {verifyBrowserAcceptance} from './release-delivery-browser.mjs';
import {exportSuccessorProfile} from './release-delivery-initialize.mjs';

const need=(v,why)=>{if(!v)throw Error(why);};
const digest=z.string().regex(/^[a-f0-9]{64}$/), ref=z.object({path:z.string().max(4096).refine(isAbsolute),sha256:digest}).strict();
const branch='operator/browser-receipt-collection', source=continuationRequestSchema.shape.operatorSources.shape.private.extend({branch:z.literal(branch)});
const owner=z.object(Object.fromEntries(['request','session','launcher','intent','stdout','exit','childResult'].map(k=>[k,ref]))).strict();
const browser=z.object({key:z.uuid(),inputSha256:digest,raw:ref,screenshot:ref,closed:ref,unit:ref,original:ref,prepared:ref}).strict();
export const returnedBrowserRequestSchema=z.object({format:z.literal(1),kind:z.literal('nova-returned-browser-receipt-request'),
 operationId:z.uuid(),historical:continuationRequestSchema.shape.historical,operatorSources:z.object({private:source,public:source}).strict(),
 ciRuns:continuationRequestSchema.shape.ciRuns,predecessorGrantSha256:digest,owner,browser}).strict();
const json=r=>JSON.parse(readEvidenceFile(r,{maximum:2*1024**2}));
const noObserver='browser-producer-response-unavailable';
function ownerClosed(journal,id,q,grant,now,assertAbsent){
 const r=q.owner,root=dirname(r.request.path),dir=dirname(r.intent.path),number=basename(dir),session=json(r.session),intent=json(r.intent),launcher=json(r.launcher);
 const stdout=json(r.stdout),exit=json(r.exit),child=json(r.childResult);
 need(same(r.request,json(grant.proof.request).owner.request)&&dirname(dir)===join(root,'observations')&&/^observation-[0-9]{4}$/.test(number)
  &&readdirSync(dirname(dir)).filter(n=>/^observation-[0-9]{4}$/.test(n)).sort().at(-1)===number,'browser-receipt-owner-path-changed');
 for(const [k,name] of Object.entries({intent:'intent.json',stdout:'stdout.json',exit:'exit.json',childResult:'default-child-result.json'}))
  need(r[k].path===join(dir,name),'browser-receipt-owner-path-changed');
 need(r.session.path===join(root,'session-'+number+'.json')&&dirname(r.launcher.path)===root&&basename(r.launcher.path).startsWith('waiting-launcher-')
  &&session.kind==='nova-storage-default-session'&&session.operationId===id&&session.mode==='resume'&&same(session.request,r.request)
  &&same(session.observationIntent,r.intent)&&same(intent.argv,session.argv)&&same(intent.request,r.request)&&intent.sameReleaseOperation===true
  &&session.operatorContinuation?.grantSha256===grant.sha256&&session.adapterIdentity===grant.proof.operator.adapterIdentity
  &&same(session.argv,[json(r.request).node.path,session.operatorContinuation.operatorEntry.path,'resume',journal.directory,id]),'browser-receipt-original-session-changed');
 need(exit.returnCode===2&&child.returnCode===2&&child.originalChildClosed===true&&child.automaticNewOperationPermitted===false&&child.logBoundExceeded===false
  &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds>=session.issuedAtMilliseconds&&exit.finishedAtMilliseconds<=now
  &&stdout.operationId===id&&stdout.complete===false&&stdout.acceptanceGap===noObserver&&stdout.phases.some(x=>x.phase==='browser'&&x.key===q.browser.key&&x.state==='gap'&&x.reason===noObserver),
  'browser-receipt-original-observer-closure-required');
 need(launcher.kind==='verified-waiting-release-launcher'&&launcher.mode==='resume'&&launcher.operationId===id&&launcher.worker.parentPid===launcher.owner.pid
  &&same(launcher.entry,session.operatorContinuation.operatorEntry)&&same(launcher.config,session.config)&&same(launcher.node,json(r.request).node)
  &&same(launcher.start,json(r.request).releaseInput)&&same(launcher.budget,json(r.request).storageBudget),'browser-receipt-original-launcher-changed');
 for(const p of [launcher.worker,launcher.owner])assertAbsent(p);
}
export function retainedBrowserReceipt(journal,id,q){
 const row=journal.deliveryPhase(id,'browser'),b=q.browser,i=row?.input;
 need(row?.key===b.key&&row.inputSha256===b.inputSha256&&same(i.original,b.original)&&same(i.prepared,b.prepared)
  &&q.operationId===id&&i.operationId===id&&i.installed.route==='full','browser-receipt-original-reservation-changed');
 const dir=dirname(b.original.path);need(dir===join(journal.directory,'browser-session'),'browser-receipt-session-root-changed');
 for(const [k,n] of Object.entries({raw:'remote-acceptance.json',screenshot:'accepted-ui.png',unit:'remote-unit-closeout.json',closed:'closed.json',original:'original.json',prepared:'prepared.json'}))
  need(b[k].path===join(dir,n),'browser-receipt-scope-changed');
 need(same(JSON.parse(readReleaseInputFile(join(dir,'accept-request.json'))),{key:row.key,input:i}),'browser-receipt-original-request-changed');
 const raw=json(b.raw),out={...raw,screenshot:b.screenshot,closed:b.closed,remoteUnitCloseout:b.unit};
 need(raw.screenshot.sha256===b.screenshot.sha256&&out.accepted===true&&out.windowCoverage&&out.completedAtMs<=json(b.original).deadlineAtMs,'browser-receipt-original-terminal-required');
 verifyBrowserAcceptance(out,i,{requireCleanup:false});return {row,out};
}
export async function inspectReturnedBrowser(journal,id,q,{clock=Date.now,assertAbsent=verifyOriginalOwnerAbsent}={}){
 const d=journal.loadDelivery(id).descriptor;
 const grant=verifyContinuationGrant(journal,id,{now:clock(),effect:false});
 need(grant.proof.kind==='nova-recovery-completion-continuation'&&grant.sha256===q.predecessorGrantSha256&&same(q.historical,json(grant.proof.request).historical)
  &&!journal.deliveryPostinstallRecovery(id)&&!journal.deliveryDisposition(id),'browser-receipt-original-operator-required');
 ownerClosed(journal,id,q,grant,clock(),assertAbsent);
 const {DELIVERY_PHASES}=await import('./release-delivery-journal.mjs');
 const {row,out}=retainedBrowserReceipt(journal,id,q),prior={};
 for(const name of DELIVERY_PHASES.filter(n=>n!=='browser')){
  const p=journal.deliveryPhase(id,name);need(p?.state==='completed'&&p.validation?.state!=='failed'&&p.current?.output,'browser-receipt-prerequisite-changed');prior[name]=p.current.output;
 }
 const coordinator=journal.intent(id);need(coordinator?.state==='completed'&&coordinator.externalJobId===journal.deliveryPhase(id,'installation').externalId
  &&same(prior.assistant,row.input.assistant)&&prior.assistant.savedReplyAccepted===true&&row.input.installed.operationId===id
  &&out.completedAtMs>=row.createdAtMs&&out.completedAtMs<=grant.proof.expiresAtMs&&row.validation?.state!=='failed'
  &&(row.state==='gap'&&row.current.reason===noObserver||row.state==='completed'),'browser-receipt-original-completion-required');
 const before=grant.proof.operator,dir=join(before.sources.private.root,'edition3','scripts');
 for(const item of before.sourceFiles)readEvidenceFile({path:resolve(dir,item.name),sha256:item.sha256},{maximum:8*1024**2});
 const historical=await import(pathToFileURL(join(dir,'release-delivery-browser.mjs')));
 let diagnostic;try{historical.verifyBrowserAcceptance(out,row.input,{requireCleanup:false});}catch(e){diagnostic=e;}
 need(diagnostic instanceof ReferenceError&&diagnostic.message==='dirname is not defined','browser-receipt-classified-original-failure-required');
 const oldAuthority=(await import(pathToFileURL(join(dir,'release-delivery-continuation.mjs')))).verifyContinuationStorageAuthority;
 await oldAuthority({journal,operationId:id,now:clock()});
 return {grant,d,row,out,prior,before,oldAuthority,diagnostic:diagnostic.message};
}
export async function reconcileBrowserReceipt(journal,id,requestRef,{clock=Date.now,command=fixedCommand,assertAbsent=verifyOriginalOwnerAbsent}={}){
 const q=returnedBrowserRequestSchema.parse(json(requestRef));
 const {grant,d,row,out,prior,before,oldAuthority,diagnostic}=await inspectReturnedBrowser(journal,id,q,{clock,assertAbsent});
 const operator=await qualifyOperatorSources(q,d,{command}),tools=json(d.target).sourceTools;operator.ci={};
 for(const side of ['private','public']){
  const s=operator.sources[side],runId=q.ciRuns[side];need(s.repository===before.sources[side].repository&&s.commit!==before.sources[side].commit,'browser-receipt-operator-lineage-changed');
  await command(tools.git.path,['-C',s.root,'merge-base','--is-ancestor',before.sources[side].commit,s.commit],{gitExecPath:tools.gitExecPath});
  const input=saveContinuationEvidence(journal,'browser-operator-ci-request-'+side,{format:1,source:s,runId,tools});
  const ci=JSON.parse(await command(tools.python.path,[fileURLToPath(new URL('release-operator-ci.py',import.meta.url)),'--request',input.path,'--request-sha256',input.sha256],{maximum:8*1024**2,timeoutMs:180000}));
  need(ci.run.id===runId,'browser-receipt-operator-ci-changed');operator.ci[side]=saveContinuationEvidence(journal,'browser-operator-ci-'+side,verifyOperatorCi(ci,s));
 }
 const registry=createDeliveryRegistry({clock}),adapter=registry.adapter('browser',d,prior,{journal});
 const context={journal,descriptor:d,prior,intent:row,input:row.input,beforeNewEffect:async()=>{throw Error('browser-receipt-new-effect-denied');}};
 await adapter.validate(context);
 const result=row.state==='completed'?row.current:await adapter.observe(context);
 need(result.state==='completed'&&result.reason==='real-browser-acceptance-passed'&&result.externalId===id,'browser-receipt-original-collection-pending');
 const {remoteCleanup,...observed}=result.output;
 need(remoteCleanup&&same(observed,out),'browser-receipt-collected-output-changed');await adapter.verify(result,context);
 const authority=saveContinuationEvidence(journal,'browser-receipt-collection',{format:1,kind:'original-browser-receipt-collection',operationId:id,request:requestRef,predecessorGrantSha256:grant.sha256,
  browser:q.browser,cleanup:remoteCleanup,output:result.receipt,originalFailure:diagnostic,operator,browserStarted:false,installationStarted:false});
 if(row.state!=='completed')journal.recordDeliveryObservation(id,'browser',{...result,key:row.key},clock());
 const status=journal.deliveryStatus(id,clock());need(status.complete,'browser-receipt-delivery-still-incomplete');
 if(journal.loadDelivery(id).state!=='completed')journal.completeDelivery(id,clock());
 const successor=await exportSuccessorProfile(journal,id,{operatorAuthority:oldAuthority});
 need(successor?.profile&&successor.browserAccepted===true,'browser-receipt-successor-required');
 return {...journal.deliveryStatus(id,clock()),successor,browserReceiptCollection:authority};
}
