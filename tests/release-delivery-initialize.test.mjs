import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,sign} from 'node:crypto';
import {initializeFixture,enableFrontendFixture,completedDeliveryFixture} from '../support/delivery-initialize-fixture.mjs';
import {deriveDeliveryConfiguration,initializeDeliveryInput,exportSuccessorProfile,validateAcceptedProfile} from '../scripts/release-delivery-initialize.mjs';
import {deliveryAdapterIdentity} from '../scripts/release-delivery-adapters.mjs';
import {verifyInstalledIdentity} from '../scripts/release-delivery-installed-identity.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {runtimeCommandFixture} from '../support/runtime-command-fixture.mjs';
import {FULL_HELPERS} from '../scripts/release-delivery-full-host.mjs';
import {canonicalBrowser,browserOptionsSchema} from '../scripts/release-delivery-browser.mjs';

const initialize=async(f,extra={})=>initializeDeliveryInput(f.put('input.json',f.input).path,{protect:f.protect,clock:()=>f.now,derive:(input,profile)=>deriveDeliveryConfiguration(input,profile,f.options),...extra});

// Inert retained browser evidence: exercises export verification, never launches a browser.
function completedBrowser(f,c){
 const digest=value=>sha256(canonicalBrowser(value)),installed=c.phases.assistant.input;
 const tool=f.target.artifactTools.node,options=browserOptionsSchema.parse({format:1,node:tool,executable:tool,playwright:tool,ssh:tool,
  baseUrl:'http://127.0.0.1:4383',timeoutMs:300000,suite:'tasks-search-escape'});
 const binding={format:1,operationId:f.input.operationId,route:installed.route,descriptorSha256:digest(c.descriptor),options,
  priorCandidateId:c.descriptor.operation.priorCandidateId,epoch:c.descriptor.operation.workspaceEpoch};
 const original=f.put('browser-original.json',{binding,startedAtMs:f.now,deadlineAtMs:f.now+300000});
 const document={candidateId:binding.priorCandidateId,frontendId:f.identity.health.frontend.id,version:'3.1.0',buildVersion:'1.0.399'};
 const prepared=f.put('browser-prepared.json',{bindingSha256:digest(binding),epoch:binding.epoch,document,startedAtMs:f.now+1});
 const input={format:1,operationId:f.input.operationId,installed,assistant:c.phases.assistant.current.output,original,prepared};
 const health=installed.installedHealth,output={format:1,kind:'nova-real-browser-acceptance',operationId:f.input.operationId,
  inputSha256:digest(input),accepted:true,browserUiVerified:true,gatewayCoverage:'not-tested-loopback-host-surface',
  savedReplySha256:input.assistant.replySha256,savedMessageId:input.assistant.savedMessageId,originalDocument:document,
  loadedDocument:{candidateId:health.candidateId,frontendId:health.frontend.id,version:health.frontend.version,buildVersion:health.frontend.buildVersion},
  startedAtMs:f.now+1,completedAtMs:f.now+100,
  checks:['old-document-retained',installed.route==='frontend'?'old-lazy-module':'old-client-fence','new-document-identity',
   'retained-draft-after-refresh','ui-behavior','saved-assistant-reply-visible','owned-draft-cleaned'].map(name=>({name,passed:true})),
  screenshot:f.put('browser-screenshot.png',Buffer.from('inert screenshot fixture')),
  closed:f.put('browser-closed.json',{operationId:f.input.operationId,browserClosed:true,tunnelClosed:true})};
 c.set('browser',output);c.phases.browser.input=input;
 return {input,output};
}

test('browser-accepted successor retains exact verified browser evidence separately from the saved reply',async t=>{
 const f=initializeFixture(t);enableFrontendFixture(f);
 const v=await initialize(f),c=completedDeliveryFixture(f,v,{route:'frontend'}),browser=completedBrowser(f,c);
 const out=await exportSuccessorProfile(c.journal,f.input.operationId,f.options),p=JSON.parse(readFileSync(out.profile.path));
 assert.equal(out.browserAccepted,true);assert.equal(p.previousDelivery.browserAccepted,true);
 assert.deepEqual(p.previousDelivery.browserReceipt,c.phases.browser.current.receipt);
 assert.deepEqual(p.previousDelivery.assistantReceipt,c.phases.assistant.current.receipt);
 assert.notDeepEqual(p.previousDelivery.browserReceipt,p.previousDelivery.assistantReceipt);
 assert.deepEqual(JSON.parse(readFileSync(p.previousDelivery.browserInput.path)),browser.input);
 assert.equal(p.previousDelivery.browserInput.sha256,sha256(readFileSync(p.previousDelivery.browserInput.path)));
 validateAcceptedProfile(p,JSON.parse(readFileSync(p.target.path)));
 assert.deepEqual(await exportSuccessorProfile(c.journal,f.input.operationId,f.options),out);
 writeFileSync(browser.output.screenshot.path,'changed proof');
 assert.throws(()=>validateAcceptedProfile(p,JSON.parse(readFileSync(p.target.path))),/hash|changed|mismatch/i);
});

test('browser export rejects completed claims with corrupt identity, missing checks or changed retained proof',async t=>{
 for(const corruption of ['identity','checks','proof']){
  const f=initializeFixture(t);enableFrontendFixture(f);
  const v=await initialize(f),c=completedDeliveryFixture(f,v,{route:'frontend'}),browser=completedBrowser(f,c);
  if(corruption==='identity')browser.output.loadedDocument.frontendId='0'.repeat(64);
  if(corruption==='checks')browser.output.checks=browser.output.checks.filter(check=>check.name!=='retained-draft-after-refresh');
  if(corruption==='proof')writeFileSync(browser.output.screenshot.path,'changed proof');
  c.set('browser',browser.output);c.phases.browser.input=browser.input;
  await assert.rejects(exportSuccessorProfile(c.journal,f.input.operationId,f.options),
   corruption==='identity'?/browser-loaded-document-proof-changed/:corruption==='checks'?/browser-required-check-missing/:/hash|changed|mismatch/i);
  assert.equal(existsSync(join(f.input.outputRoot,'request-'+f.input.operationId,'successor-profile-browser-accepted.json')),false);
 }
});

test('late browser acceptance exports a distinct immutable profile and preserves the earlier unaccepted profile bytes',async t=>{
 const f=initializeFixture(t);enableFrontendFixture(f);
 const v=await initialize(f),c=completedDeliveryFixture(f,v,{route:'frontend'});
 const before=await exportSuccessorProfile(c.journal,f.input.operationId,f.options),bytes=readFileSync(before.profile.path);
 const earlier=JSON.parse(bytes);assert.equal(before.browserAccepted,false);assert.equal(earlier.previousDelivery.browserAccepted,false);
 assert.equal('browserInput' in earlier.previousDelivery,false);assert.equal('browserReceipt' in earlier.previousDelivery,false);
 completedBrowser(f,c);
 const after=await exportSuccessorProfile(c.journal,f.input.operationId,f.options),accepted=JSON.parse(readFileSync(after.profile.path));
 assert.equal(after.browserAccepted,true);assert.notEqual(after.profile.path,before.profile.path);assert.notEqual(after.profile.sha256,before.profile.sha256);
 assert.deepEqual(readFileSync(before.profile.path),bytes);assert.equal(sha256(bytes),before.profile.sha256);
 assert.equal(accepted.previousDelivery.operationId,earlier.previousDelivery.operationId);
 assert.deepEqual(accepted.previousDelivery.assistantReceipt,earlier.previousDelivery.assistantReceipt);
 assert.deepEqual(accepted.target,earlier.target);
 validateAcceptedProfile(earlier,JSON.parse(readFileSync(earlier.target.path)));
 validateAcceptedProfile(accepted,JSON.parse(readFileSync(accepted.target.path)));
 assert.deepEqual(await exportSuccessorProfile(c.journal,f.input.operationId,f.options),after);
 assert.deepEqual(readFileSync(before.profile.path),bytes);
});

test('full export prepares dependencies then imports before writing successor and preserves legacy output bytes',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v);
 assert.equal(c.phases.sign.current.output.directory,undefined);
 const output=join(f.input.outputRoot,'request-'+f.input.operationId,'successor-profile.json'),events=[];
 const options={...f.options,prepareFeedDependencies:async()=>{events.push('prepare');assert.equal(existsSync(output),false);},
  feedContract:async(...args)=>{events.push('import');assert.equal(existsSync(output),false);return f.options.feedContract(...args);}};
 const first=await exportSuccessorProfile(c.journal,f.input.operationId,options);
 assert.deepEqual(events,['prepare','import']);
 const original=JSON.parse(readFileSync(output));delete original.accepted.feedDependencies;
 writeFileSync(output,JSON.stringify(original)+'\n');const legacyBytes=readFileSync(output);
 const resumed=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 assert.deepEqual(readFileSync(output),legacyBytes);assert.equal(resumed.profile.path,first.profile.path);
});
test('failed normal import prevents successor publication',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v);
 await assert.rejects(exportSuccessorProfile(c.journal,f.input.operationId,{...f.options,feedContract:async()=>{throw Error('synthetic-import-gap');}}),/synthetic-import-gap/);
 assert.equal(existsSync(join(f.input.outputRoot,'request-'+f.input.operationId,'successor-profile.json')),false);
});
test('frontend export retains accepted dependency references for the next initialization',async t=>{
 const f=initializeFixture(t);enableFrontendFixture(f);
 const dependencies={archive:f.put('accepted-deps.tgz',Buffer.from('synthetic')),metadata:f.put('accepted-deps.json',{})};
 f.profile.accepted.feedDependencies=dependencies;f.input.profile=f.put('profile-ready.json',f.profile);
 const v=await initialize(f),c=completedDeliveryFixture(f,v,{route:'frontend'}),out=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 assert.deepEqual(JSON.parse(readFileSync(out.profile.path)).accepted.feedDependencies,dependencies);
});
test('generic committed versions, independent bases, signed sequence and current runtime derive without effects',async t=>{
 const f=initializeFixture(t),v=await deriveDeliveryConfiguration(f.input,f.profile,f.options);
 assert.equal(v.operation.version,'3.2.0');assert.equal(v.operation.buildVersion,'1.0.400');assert.equal(v.sources.private.baseCommit,'a'.repeat(40));assert.equal(v.sources.public.baseCommit,'b'.repeat(40));assert.equal(v.target.full.feed.sequence,13);
 assert.equal(v.target.full.bundleUrl,'https://github.com/HatimTheDream/Nova-Dream/releases/download/nova-v3.2.0/nova-3.2.0-operator-bundle.json');assert.equal(v.operation.priorAgentVersion,'2026.9.8');assert.equal(v.operation.agentVersion,'2026.9.8');
 assert.equal(v.adapterIdentity,deliveryAdapterIdentity());assert.ok(f.calls.every(a=>['rev-parse','branch','status','merge-base','remote','ls-tree','show'].includes(a[2])));assert.equal(existsSync(f.target.full.signing.privateKeyPath),false);
});

test('wrong branch, changed HEAD and tracked edits refuse before dependency preparation or feed import',async t=>{
 for(const [kind,expected] of [['branch','configured-source-branch-changed'],['head','configured-source-head-changed'],['index','configured-source-index-not-clean']]){
  const f=initializeFixture(t);const command=async(tool,args,options)=>{
   const a=args.slice(2);
   if(kind==='branch'&&a[0]==='branch')return 'preparation\n';
   if(kind==='head'&&a[0]==='rev-parse'&&a[1]==='HEAD')return 'f'.repeat(40)+'\n';
   if(kind==='index'&&a[0]==='status')return ' M package.json\n';
   return f.command(tool,args,options);
  };
  await assert.rejects(deriveDeliveryConfiguration(f.input,f.profile,{...f.options,command}),new RegExp(expected));
  assert.deepEqual(f.feedEvents,[]);
 }
});
test('another release version is input data only',async t=>{const f=initializeFixture(t,{version:'4.7.3',buildVersion:'2.0.11'}),v=await deriveDeliveryConfiguration(f.input,f.profile,f.options);assert.equal(v.operation.version,'4.7.3');assert.match(v.target.full.dependenciesUrl,/nova-4\.7\.3-app-dependencies/);});
test('actual paired committed package mismatch refuses',async t=>{const f=initializeFixture(t);f.packages.public.version='3.2.1';f.locks.public.version='3.2.1';f.locks.public.packages[''].version='3.2.1';await assert.rejects(deriveDeliveryConfiguration(f.input,f.profile,f.options),/paired-committed-package/);});
test('wrong exact committed adapter blob refuses before output',async t=>{const f=initializeFixture(t);f.corruptSource();await assert.rejects(deriveDeliveryConfiguration(f.input,f.profile,f.options),/committed-adapter-identity/);assert.equal(existsSync(f.input.outputRoot),false);});
test('wrong configured target identity refuses',async t=>{const f=initializeFixture(t);f.profile.targetIdentity='0'.repeat(64);await assert.rejects(deriveDeliveryConfiguration(f.input,f.profile,f.options),/target-identity/);});
test('accepted installer bytes cannot be replaced by a passing claim',t=>{const f=initializeFixture(t),r=f.put('wrong-result.json',{...f.result,jobId:randomUUID()});f.profile.accepted.result=r;assert.throws(()=>validateAcceptedProfile(f.profile,f.target),/accepted-original-result/);});
test('reusing or downgrading installer version refuses',async t=>{const f=initializeFixture(t,{version:'3.1.0',buildVersion:'1.0.399'});await assert.rejects(deriveDeliveryConfiguration(f.input,f.profile,f.options),/new-installer-version/);});
test('interrupted initialization resumes the same descriptor and original timestamps',async t=>{
 const f=initializeFixture(t);let writes=0;
 await assert.rejects(initialize(f,{afterWrite:phase=>{if(phase==='initialization'){writes++;throw Error('synthetic interrupted');}}}),/interrupted/);
 const record=JSON.parse(readFileSync(join(f.input.outputRoot,'request-'+f.input.operationId,'initialization.json'))),calls=f.calls.length;
 const resumed=await initialize(f,{derive:()=>{throw Error('must not derive again');}});
 assert.equal(writes,1);assert.equal(f.calls.length,calls);assert.equal(resumed.descriptor.sha256,record.descriptor.reference.sha256);assert.equal(JSON.parse(readFileSync(resumed.descriptor.path)).timeline.startedAtMs,f.now);
 assert.equal(existsSync(resumed.journalDirectory),false);
});
test('lost successful preparation response returns original operation without effects',async t=>{const f=initializeFixture(t),a=await initialize(f),b=await initialize(f,{derive:()=>{throw Error('duplicate initialization');}});assert.deepEqual(a,b);assert.equal(existsSync(a.journalDirectory),false);});
test('changed request and corrupt partial output cannot reuse original initialization',async t=>{
 const f=initializeFixture(t),v=await initialize(f);f.input.sourceCommits.private='3'.repeat(40);await assert.rejects(initialize(f),/original-initialization-input/);
 f.input.sourceCommits.private='1'.repeat(40);writeFileSync(v.descriptor.path,'partial');await assert.rejects(initialize(f),/hash|changed|mismatch/i);
});
test('retained original installer bytes admit, changed content/hash refuse, legacy proof remains valid',t=>{
 const f=initializeFixture(t);verifyInstalledIdentity(f.identity,f.request);const old=structuredClone(f.identity);delete old.installationProof.installerResultBytesBase64;verifyInstalledIdentity(old,f.request);
 for(const raw of [Buffer.from('not json'),Buffer.from(JSON.stringify({...f.result,savedWorkVerified:false}))]){const changed=structuredClone(f.identity);changed.installationProof.installerResultBytesBase64=raw.toString('base64');assert.throws(()=>verifyInstalledIdentity(changed,f.request));}
});
test('successor export requires actual installation and saved reply separately',async t=>{
 const f=initializeFixture(t),v=await initialize(f),descriptor=JSON.parse(readFileSync(v.descriptor.path));
 const journal={loadDelivery:()=>({descriptor}),deliveryPhase:()=>null};assert.deepEqual(await exportSuccessorProfile(journal,f.input.operationId),{gap:'installation-and-saved-assistant-reply-required'});
});
test('full successor exports actual accepted candidates, original result and published feed; lost response returns same bytes',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v),a=await exportSuccessorProfile(c.journal,f.input.operationId,f.options),b=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 assert.notEqual(c.phases.assistant.current.output.operationId,f.input.operationId);assert.equal(c.phases.assistant.current.externalId,f.input.operationId);
 assert.deepEqual(a,b);const profile=JSON.parse(readFileSync(a.profile.path)),target=JSON.parse(readFileSync(profile.target.path));
 assert.equal(profile.previousDelivery.publicationReceipt.sha256,c.phases.publication.current.receipt.sha256);assert.equal(profile.previousDelivery.browserAccepted,false);
 assert.equal(target.bases.private.directory,c.repositories.private.applicationDirectory);assert.notEqual(target.bases.private.candidateId,f.target.bases.private.candidateId);
 assert.equal(target.full.signing.previousFeed.sha256,c.phases.sign.current.output.signedFeed.sha256);assert.equal(profile.accepted.result.sha256,c.phases.installation.current.output.acceptanceIdentity.installationProof.installerResult.sha256);
 validateAcceptedProfile(profile,target);
});
test('saved reply export verifies the original child graph and refuses a replacement request',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v);
 c.phases['assistant/submit'].input.parentKey=randomUUID();await assert.rejects(exportSuccessorProfile(c.journal,f.input.operationId,f.options),/assistant-child/);
});
test('completed install and reply cannot substitute for actual completed publication',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v);c.phases.publication.state='uncertain';
 await assert.rejects(exportSuccessorProfile(c.journal,f.input.operationId,f.options),/phase-not-accepted/);assert.equal(existsSync(join(f.input.outputRoot,'request-'+f.input.operationId,'successor-profile.json')),false);
});
test('different published feed refuses successor export',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v);c.set('publication',{...c.phases.publication.current.output,evidence:{...c.phases.publication.current.output.evidence,feed:f.signedFeed}});
 await assert.rejects(exportSuccessorProfile(c.journal,f.input.operationId,f.options),/published-feed/);
});
test('an exported accepted full profile initializes a subsequent release through data changes only',async t=>{
 const f=initializeFixture(t),first=await initialize(f),c=completedDeliveryFixture(f,first),successor=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 const profile=JSON.parse(readFileSync(successor.profile.path));f.input.operationId=randomUUID();f.input.profile=successor.profile;f.input.sourceCommits={private:'3'.repeat(40),public:'4'.repeat(40)};
 for(const side of ['private','public']){f.packages[side].version='3.3.0';f.packages[side].edition3.buildVersion='1.0.401';f.locks[side].version='3.3.0';f.locks[side].packages[''].version='3.3.0';}
 const next=await deriveDeliveryConfiguration(f.input,profile,f.options);
 assert.equal(next.operation.version,'3.3.0');assert.equal(next.operation.priorCandidateId,c.repositories.private.candidateId);assert.equal(next.sources.private.baseCommit,'1'.repeat(40));assert.equal(next.sources.public.baseCommit,'2'.repeat(40));assert.equal(next.target.full.feed.sequence,14);
});
test('frontend successor refuses reusing the already selected UI version',async t=>{
 const f=initializeFixture(t);enableFrontendFixture(f);const v=await initialize(f),c=completedDeliveryFixture(f,v,{route:'frontend'}),out=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 await assert.rejects(deriveDeliveryConfiguration({...f.input,operationId:randomUUID()},JSON.parse(readFileSync(out.profile.path)),f.options),/new-frontend-version/);
});
test('older accepted proof lacks raw installer bytes and yields explicit export gap',async t=>{
 const f=initializeFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v,{legacy:true});assert.deepEqual(await exportSuccessorProfile(c.journal,f.input.operationId,f.options),{gap:'original-installer-result-bytes-unavailable'});
});
test('frontend successor preserves accepted service bases and updates only signed UI predecessor',async t=>{
 const f=initializeFixture(t);enableFrontendFixture(f);const v=await initialize(f),c=completedDeliveryFixture(f,v,{route:'frontend'}),out=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 const p=JSON.parse(readFileSync(out.profile.path)),target=JSON.parse(readFileSync(p.target.path));
 assert.deepEqual(target.bases,f.target.bases);assert.deepEqual(p.accepted,f.profile.accepted);assert.equal(target.full.signing.previousFeed.sha256,f.signedFeed.sha256);
 assert.equal(target.signing.previousManifest.sha256,c.phases.sign.current.output.manifest.sha256);assert.equal(target.signing.previousSignature.sha256,c.phases.sign.current.output.signature.sha256);
 assert.notEqual(p.previousDelivery.sourceCandidates.private.path,target.bases.private.manifest.path);
});
test('private initialization output cannot land in either configured source checkout',async t=>{
 const f=initializeFixture(t);f.input.outputRoot=join(f.profile.sources.public.root,'operator-data');await assert.rejects(initialize(f),/private-output-overlaps/);assert.equal(existsSync(f.input.outputRoot),false);
});

function runtimeInitializationFixture(t){
 const f=initializeFixture(t),r=runtimeCommandFixture(t);
 f.identity.request.operation.agentVersion='2026.9.6';f.identity.request.operation.priorAgentVersion='2026.9.6';f.identity.runtimeProof.openclawVersion='2026.9.6';
 f.profile.accepted.identity=f.put('accepted-prior96.json',f.identity);
 f.feed.releases[0].agentVersion='2026.9.6';f.feed.releases[0].compatibility.fromAgentVersion='2026.9.6';
 const raw=Buffer.from(JSON.stringify(f.feed)+'\n');f.target.full.signing.previousFeed=f.put('prior96-feed.json',{payload:raw.toString('base64'),signature:sign(null,raw,f.keys.privateKey).toString('base64')});
 f.target.full.dependencyTransport=r.transportOptions;
 f.profile.target=f.put('configured-target.json',f.target);f.input.profile=f.put('profile.json',f.profile);
 const runtimeFor=({descriptor,repositories})=>{
  const proof=structuredClone(r.proof);proof.workspaceEpoch=descriptor.operation.workspaceEpoch;proof.prior.candidateId=descriptor.operation.priorCandidateId;
  proof.scenarios.find(s=>s.scenario==='prior-rollback').candidateId=descriptor.operation.priorCandidateId;proof.helpers={...FULL_HELPERS};
  return {...r.transportOptions.runtime,description:r.runtime,qualification:f.put('retained-runtime-qualified.json',proof),
   qualificationBinding:{candidateId:repositories.private.candidateId,priorCandidateId:descriptor.operation.priorCandidateId,nativeAnchorCandidateId:r.nativeAnchor.candidateId,sourceCommits:descriptor.operation.sourceCommits}};
 };
 return{f,r,runtimeFor};
}
test('format3 initialization preserves a separate native anchor acceptance and actual prior identity',async t=>{
 const{f,r}=runtimeInitializationFixture(t),before=structuredClone(r.transportOptions),v=await deriveDeliveryConfiguration(f.input,f.profile,f.options);
 assert.notEqual(before.nativeAnchor.candidateId,f.identity.candidateId);
 assert.deepEqual(v.target.full.dependencyTransport,before);assert.equal(v.operation.priorCandidateId,f.identity.candidateId);
 assert.equal(v.operation.priorAgentVersion,'2026.9.6');assert.equal(v.operation.agentVersion,'2026.9.8');assert.equal(v.operation.changeClass,'runtime');
 assert.notDeepEqual(v.target.full.dependencyTransport.selectedPair,f.profile.accepted.pair);assert.deepEqual(r.transportOptions,before);
});
test('format1 and format2 still bind the selected accepted pair instead of stale configured refs',async t=>{
 for(const format of[1,2]){const f=initializeFixture(t),r=runtimeCommandFixture(t),options={...r.transportOptions};
  delete options.nativeAnchor;delete options.runtimeQualification;delete options.runtime;Object.assign(options,{format,mode:'retained-native-metadata-successor'});if(format===1)delete options.metadataPolicy;
  f.target.full.dependencyTransport=options;f.profile.target=f.put('configured-target.json',f.target);
  const v=await deriveDeliveryConfiguration(f.input,f.profile,f.options);
  for(const [name,accepted]of[['selectedPair','pair'],['selectedInstaller','result'],['selectedBundle','bundle']])assert.deepEqual(v.target.full.dependencyTransport[name],f.profile.accepted[accepted]);
 }
});
test('a completed runtime delivery exports format2 with new accepted refs and original qualification provenance',async t=>{
 const{f,r,runtimeFor}=runtimeInitializationFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v,{runtimeFor});
 const originalTarget=readFileSync(JSON.parse(readFileSync(v.descriptor.path)).target.path),out=await exportSuccessorProfile(c.journal,f.input.operationId,f.options);
 const profile=JSON.parse(readFileSync(out.profile.path)),target=JSON.parse(readFileSync(profile.target.path)),options=target.full.dependencyTransport;
 assert.equal(options.format,2);assert.equal(options.mode,'retained-native-metadata-successor');
 for(const name of['nativeAnchor','runtimeQualification','runtime'])assert.equal(name in options,false);
 for(const [name,accepted]of[['selectedPair','pair'],['selectedInstaller','result'],['selectedBundle','bundle']])assert.deepEqual(options[name],profile.accepted[accepted]);
 assert.deepEqual(profile.qualificationEvidence,[c.phases.sign.current.output.runtime.qualification]);assert.notDeepEqual(options.selectedPair,r.transportOptions.selectedPair);
 assert.deepEqual(readFileSync(JSON.parse(readFileSync(v.descriptor.path)).target.path),originalTarget);validateAcceptedProfile(profile,target);
 assert.deepEqual(await exportSuccessorProfile(c.journal,f.input.operationId,f.options),out);
 for(const side of['private','public']){f.packages[side].version='3.3.0';f.packages[side].edition3.buildVersion='1.0.401';f.locks[side].version='3.3.0';f.locks[side].packages[''].version='3.3.0';}
 f.input.operationId=randomUUID();f.input.sourceCommits={private:'3'.repeat(40),public:'4'.repeat(40)};
 const next=await deriveDeliveryConfiguration(f.input,profile,f.options);
 assert.equal(next.operation.agentVersion,'2026.9.8');assert.equal(next.operation.priorAgentVersion,'2026.9.8');assert.equal(next.operation.changeClass,'application');
});
test('runtime successor refuses missing, changed or wrongly bound original qualification before output',async t=>{
 for(const kind of['missing','corrupt','different-request','wrong-installed-runtime']){const{f,runtimeFor}=runtimeInitializationFixture(t),v=await initialize(f),c=completedDeliveryFixture(f,v,{runtimeFor});
  const runtime=c.phases.sign.current.output.runtime;
  if(kind==='missing')delete c.phases.sign.current.output.runtime;
  if(kind==='corrupt')writeFileSync(runtime.qualification.path,'corrupt');
  if(kind==='different-request'){const proof=JSON.parse(readFileSync(runtime.qualification.path));proof.request.parent.sha256='f'.repeat(64);runtime.qualification=f.put('wrong-runtime-proof.json',proof);}
  if(kind==='wrong-installed-runtime'){const identity=c.phases.installation.current.output.acceptanceIdentity;identity.request.operation.agentVersion='2026.9.6';identity.runtimeProof.openclawVersion='2026.9.6';c.phases.installation.current.output.acceptanceIdentityReceipt=f.put('wrong-installed-runtime.json',identity);}
  await assert.rejects(exportSuccessorProfile(c.journal,f.input.operationId,f.options),/runtime|hash|changed|mismatch|saved-assistant/i);
  assert.equal(existsSync(join(f.input.outputRoot,'request-'+f.input.operationId,'successor-profile.json')),false);
 }
});
