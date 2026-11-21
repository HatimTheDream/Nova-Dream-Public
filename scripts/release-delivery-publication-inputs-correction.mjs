/** Reconcile an authenticated, unconsumed first asset reservation on the original full publication. */
import {readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {assetGrantKind,phases,children} from './release-delivery-publication-inputs-schema.mjs';
import {readEvidenceFile,readReleaseInputFile,sha256} from './release-plan.mjs';
import {verifyReservedPublicationAsset} from './release-publication-asset-reservation.mjs';

const need=(value,reason)=>{if(!value)throw Error(reason);};
const json=ref=>JSON.parse(readEvidenceFile(ref,{maximum:2*1024**2}));
const ref=path=>({path,sha256:sha256(readReleaseInputFile(path))});
const canonical=value=>JSON.stringify(value,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sum=value=>sha256(canonical(value));
const named=p=>({phase:p.phase,key:p.key,inputSha256:p.inputSha256,observationSha256:sum(p.current)});

function owner(journal,id,request,previous,admission,now,assertAbsent){
 const a=request.owner,predecessor=json(previous.proof.request);
 need(same(predecessor.owner.request,a.request)&&same(request.historical,predecessor.historical),'asset-previous-owner-required');
 const root=dirname(a.request.path),folder=join(root,'observations'),dir=join(folder,'observation-0003');
 need(same(readdirSync(folder).filter(n=>/^observation-[0-9]+$/.test(n)).sort(),['observation-0001','observation-0002','observation-0003']),
  'asset-original-owners-unclassified');
 for(const [key,name] of Object.entries({intent:'intent.json',exit:'exit.json',childResult:'default-child-result.json',stdout:'stdout.json'}))
  need(a[key].path===join(dir,name),'asset-original-owner-files-changed');
 need(a.session.path===join(root,'session-observation-0003.json')&&same(admission.admission.session,a.session),'asset-original-session-required');
 const original=json(a.request),intent=json(a.intent),session=json(a.session),launch=json(a.launcher),exit=json(a.exit),closed=json(a.childResult);
 const operator=previous.proof.operator,entry=join(operator.sources.private.root,'edition3','scripts','release-deliver.mjs');
 const expected=[original.node.path,entry,'resume',journal.directory,id];
 need(original.operationId===id&&same(intent,{argv:expected,request:a.request,sameReleaseOperation:true})
  &&same(session.argv,expected)&&session.operationId===id&&session.mode==='resume'&&session.kind==='nova-storage-default-session'
  &&same(session.request,a.request)&&same(session.observationIntent,a.intent)&&same(session.continuationDispatch,admission.admission.dispatch)
  &&session.operatorContinuation?.grantSha256===previous.sha256&&session.operatorContinuation.operatorAdapterIdentity===operator.adapterIdentity
  &&same(session.operatorContinuation.returnedRehearsalAdmission,previous.proof.storageAdmission)&&session.operatorContinuation.continuationStarted===false,
  'asset-original-operator-session-changed');
 need(dirname(a.launcher.path)===root&&a.launcher.path.startsWith(join(root,'waiting-launcher-'))&&launch.kind==='verified-waiting-release-launcher'
  &&launch.dispatchAuthority===false&&launch.mode==='resume'&&launch.operationId===id&&same(launch.node,original.node)&&same(launch.config,session.config)
  &&same(launch.start,original.releaseInput)&&same(launch.budget,original.storageBudget)&&launch.entry.path===entry
  &&resolve(launch.cwd)===resolve(operator.sources.private.root,'edition3')&&launch.worker.parentPid===launch.owner.pid,'asset-worker-identity-changed');
 for(const r of [launch.node,launch.entry,launch.runner,launch.config,session.sourceGraph])readEvidenceFile(r,{maximum:128*1024**2});
 need(acceptedObserverExit(exit,closed,readEvidenceFile(a.stdout,{maximum:1}),now)&&admission.recordedAtMs<=exit.finishedAtMilliseconds,'asset-original-observer-not-closed');
 const pids=[];
 for(const p of [launch.worker,launch.owner]){
  need(Number(p.created.match(/^\/Date\((\d+)\)\/$/)?.[1])<=session.issuedAtMilliseconds,'asset-owner-clock-changed');assertAbsent(p);pids.push(p.pid);
 }
 return {pids,closedAt:exit.finishedAtMilliseconds};
}

export function acceptedObserverExit(exit,closed,stdout,now){
 return exit.returnCode===4294967295&&closed.returnCode===exit.returnCode&&closed.originalChildClosed===true
  &&closed.logBoundExceeded===false&&closed.automaticNewOperationPermitted===false&&stdout.length===0
  &&Number.isSafeInteger(exit.finishedAtMilliseconds)&&exit.finishedAtMilliseconds<=now;
}

function assetRefs(journal,id,key){
 const prefix=join(journal.directory,'delivery-evidence',key+'-full-asset-app-');
 const assetRequest=ref(prefix+'request.json'),reservation=ref(prefix+'dispatch.json');
 const a=json(assetRequest),r=json(reservation);
 const out=join(journal.directory,'full-publication-'+key+'-app'),publication=journal.deliveryPhase(id,'publication');
 need(same(r,{format:1,operationId:id,key,role:'app',outputDirectory:out,automaticReplayPermitted:false})
  &&a.format===1&&a.operationId===id&&a.key===key&&a.inputSha256===publication.inputSha256&&a.outputDirectory===out&&a.spec.role==='app'
  &&a.ledgerDirectory===publication.input.ledgerDirectory&&same(a.releaseIds,publication.input.releaseIds)
  &&same(a.helperHashes,publication.input.helperHashes)&&same(a.applicationArchive,publication.input.applicationArchive)
  &&same(a.signed,publication.input.signed)&&same(a.tools,publication.input.tools)&&same(a.sourceCommits,publication.input.sourceCommits),
  'original-first-asset-request-and-reservation-required');
 return {assetRequest,reservation};
}

function storageMarker(journal,id,previous){
 const saved=journal.deliveryReturnedRehearsalAdmission(id);
 need(saved?.admission.grantSha256===previous.sha256,'asset-historical-storage-admission-required');
 return {eventId:saved.eventId,sha256:saved.sha256,session:saved.admission.session,dispatch:saved.admission.dispatch};
}

function phaseHistory(journal,id){
 const rows=[...phases,...children].map(n=>journal.deliveryPhase(id,n)),pack=journal.deliveryPhase(id,'package');
 need(rows.every(p=>p?.state==='completed'&&p.validation?.state!=='failed')&&rows.slice(phases.length).every(p=>p.input.parentKey===pack.key&&p.input.parentInputSha256===pack.inputSha256),
  'publication-original-phases-incomplete');
 return {prerequisites:rows.slice(0,phases.length).map(named),packageSubsteps:rows.slice(phases.length).map(named)};
}

export function publicationInputsSnapshot(journal,id,request,previous,{now,assertAbsent,history}){
 const retained=journal.loadDelivery(id),d=retained.descriptor;
 need(previous?.sha256===request.predecessorGrantSha256&&previous.proof.operationId===request.operationId&&request.operationId===id
  &&retained.state==='active'&&!journal.deliveryDisposition(id)&&now>=previous.recordedAtMs&&now<previous.proof.expiresAtMs
  &&previous.proof.expiresAtMs===retained.created_at+d.observationBudgetMs,'asset-active-original-window-required');
 const target=json(d.target);
 need(Number.isSafeInteger(target.browserTools.timeoutMs)&&now+target.browserTools.timeoutMs<=previous.proof.expiresAtMs,'browser-successor-budget-exceeds-grant');
 const known=journal.db.prepare('SELECT phase FROM delivery_phases WHERE operation_id=? ORDER BY phase').all(id).map(r=>r.phase);
 need(same(known,[...phases,...children,'publication'].sort())&&!journal.intent(id)&&!journal.db.prepare('SELECT id FROM operations WHERE id=?').get(id)
  &&!journal.db.prepare("SELECT id FROM delivery_events WHERE operation_id=? AND kind='rejected-producer-observation'").get(id),'asset-preinstallation-journal-required');
 const p=journal.deliveryPhase(id,'publication'),mark=storageMarker(journal,id,previous),admission=journal.deliveryReturnedRehearsalAdmission(id);
 const owners=owner(journal,id,request,previous,admission,now,assertAbsent);
 const latest=journal.db.prepare("SELECT id,at_ms,observation_json,observation_hash FROM delivery_observations WHERE operation_id=? AND phase='publication' ORDER BY id DESC LIMIT 1").get(id);
 need(latest&&latest.at_ms<=owners.closedAt&&sha256(latest.observation_json)===latest.observation_hash
  &&same({...JSON.parse(latest.observation_json),observedAtMs:latest.at_ms},p.current)&&p.validation?.state!=='failed'&&p.state==='uncertain'
  &&p.current.externalId===id&&p.current.reason==='full-publication-response-unavailable'&&p.current.receipt===null&&p.current.output===null,
  'asset-original-observation-required');
 const orig=assetRefs(journal,id,p.key),expected=[orig.assetRequest.path,orig.reservation.path];
 const files=readdirSync(join(journal.directory,'delivery-evidence')).filter(n=>n.startsWith(p.key+'-')).map(n=>join(journal.directory,'delivery-evidence',n));
 need(same(files.sort(),expected.sort()),'publication-asset-boundary-advanced');
 verifyReservedPublicationAsset({request:orig.assetRequest,reservation:orig.reservation,binding:request.localInputs,noPostPlan:request.assetPlan});
 return {...phaseHistory(journal,id),...history(journal,id),...orig,descriptorSha256:retained.descriptor_hash,targetIdentity:d.targetIdentity,originalAdapterIdentity:d.adapterIdentity,
  browser:request.browser,preparedBrowser:request.preparedBrowser,
  originalCreatedAtMs:retained.created_at,originalBudgetMs:d.observationBudgetMs,originalTimelineSha256:sum(d.timeline),
  snapshotSha256:sum(known.map(n=>journal.deliveryPhase(id,n))),ownerPids:owners.pids,
  publication:{...named(p),observationId:latest.id,storedObservationSha256:latest.observation_hash},storageAdmission:mark};
}

/** Later asset, feed and install observations can advance the same reservation. */
export function verifyOriginalPublicationObservation(current,original,row){
 need(current?.key===original.key&&current.inputSha256===original.inputSha256,'asset-original-publication-reservation-changed');
 need(row&&row.observation_hash===original.storedObservationSha256&&sha256(row.observation_json)===row.observation_hash
  &&sum({...JSON.parse(row.observation_json),observedAtMs:row.at_ms})===original.observationSha256,'asset-grant-observation-changed');
}

export function verifyPublicationInputsHistory(journal,id,p,req,previous,history){
 const d=journal.loadDelivery(id),current=journal.deliveryPhase(id,'publication');
 need(previous?.sha256===p.predecessorGrantSha256&&p.predecessorGrantSha256===req.predecessorGrantSha256
  &&req.operationId===p.operationId&&p.operationId===id&&same(req.localInputs,p.localInputs)&&same(req.assetPlan,p.assetPlan)
  &&same(p.browser,req.browser)&&same(p.preparedBrowser,req.preparedBrowser)
  &&same(req.operatorSources,p.operator.sources)&&same(p.storageAdmission,storageMarker(journal,id,previous))
  &&same(req.owner.session,p.storageAdmission.session)&&same(json(previous.proof.request).historical,req.historical)
  &&p.originalCreatedAtMs===d.created_at&&p.originalBudgetMs===d.descriptor.observationBudgetMs&&p.expiresAtMs===previous.proof.expiresAtMs
  &&p.descriptorSha256===d.descriptor_hash&&p.targetIdentity===d.descriptor.targetIdentity&&p.originalAdapterIdentity===d.descriptor.adapterIdentity
  &&p.originalTimelineSha256===sum(d.descriptor.timeline)&&same(history(journal,id,p.eventHighWaterMark),{eventHighWaterMark:p.eventHighWaterMark,historySha256:p.historySha256}),'asset-grant-original-history-changed');
 const row=journal.db.prepare("SELECT observation_json,observation_hash,at_ms FROM delivery_observations WHERE operation_id=? AND phase='publication' AND id=?").get(id,p.publication.observationId);
 verifyOriginalPublicationObservation(current,p.publication,row);
 const ledger=phaseHistory(journal,id),files=assetRefs(journal,id,current.key);
 need(same(ledger.prerequisites,p.prerequisites)&&same(ledger.packageSubsteps,p.packageSubsteps)&&same(files.assetRequest,p.assetRequest)&&same(files.reservation,p.reservation),
  'asset-grant-original-immutable-inputs-changed');
 for(const original of [p.assetPlan,p.localInputs,req.owner.exit,req.owner.childResult,p.browser.predecessor,p.browser.status,p.preparedBrowser])readEvidenceFile(original,{maximum:2*1024**2});
}

export function originalAssetRecovery(proof){
 if(proof?.kind!==assetGrantKind)return undefined;
 return {binding:proof.localInputs,assetRequest:proof.assetRequest,reservation:proof.reservation,noPostPlan:proof.assetPlan,expiresAtMs:proof.expiresAtMs};
}
