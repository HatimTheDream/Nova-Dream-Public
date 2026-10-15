/** Data-only delivery initialization around the existing producers and journal.
 * A caller's stable operation ID owns immutable configuration and any resume.
 * This module never signs, contacts the host, installs or publishes source. */
import {constants,openSync,writeFileSync,fsyncSync,closeSync,existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute,posix,relative} from 'node:path';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {readEvidenceFile,readReleaseInputFile,releaseTimelineSchema,assessTimeline,sha256} from './release-plan.mjs';
import {validateJournalDirectory} from './release-coordinate.mjs';
import {deliveryDescriptorSchema} from './release-delivery-journal.mjs';
import {deliveryTargetSchema,deliveryAdapterIdentity,deliveryAdapterSourceFiles,deliveryTargetIdentity,validateSourceTools,fixedCommand} from './release-delivery-adapters.mjs';
import {verifyCandidate} from './candidate.mjs';
import {verifyRetainedCandidate} from './release-delivery-package.mjs';
import {frontendRegular,validateFrontendManifest} from './frontend-contract.mjs';
import {loadSelectedFeedContract} from './release-delivery-full.mjs';
import {verifyInstalledIdentity} from './release-delivery-installed-identity.mjs';
import {validateInstalledIdentityRequest} from './release-delivery-assistant-full.mjs';
import {assistantAcceptanceInput,verifySavedAssistantReply} from './release-delivery-assistant.mjs';
import {verifyRuntimeQualificationReference} from './release-delivery-runtime-retained.mjs';
import {FULL_HELPERS} from './release-delivery-full-host.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),commit=z.string().regex(/^[a-f0-9]{40}$/);
const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const ref=z.object({path,sha256:hash}).strict();
const source=z.object({root:path,repository:z.string(),branch:z.literal('main')}).strict();
export const deliveryStartInputSchema=z.object({format:z.literal(1),operationId:z.uuid(),profile:ref,
 sourceCommits:z.object({private:commit,public:commit}).strict(),outputRoot:path,timeline:releaseTimelineSchema,
 observationBudgetMs:z.number().int().min(60000).max(86400000)}).strict();
export const deliveryProfileSchema=z.object({format:z.literal(1),target:ref,targetIdentity:hash,
 sources:z.object({private:source,public:source}).strict(),
 accepted:z.object({identity:ref,result:ref,pair:ref,bundle:ref}).strict(),
 qualificationEvidence:z.array(ref).max(32).default([]),
 previousDelivery:z.object({operationId:z.uuid(),descriptorSha256:hash,assistantReceipt:ref,publicationReceipt:ref,
  sourceCandidates:z.object({private:ref,public:ref}).strict(),browserAccepted:z.literal(false)}).strict().optional()}).strict();
const need=(v,r)=>{if(!v)throw Error(r);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const encoded=v=>Buffer.from(canonical(v)+'\n');
const json=(r,maximum=2*1024**2)=>JSON.parse(readEvidenceFile(ref.parse(r),{maximum}));
const reference=(path,raw=frontendRegular(path,128*1024**2))=>({path:resolve(path),sha256:sha256(raw)});
const normalizedRef=r=>({path:resolve(r.path),sha256:r.sha256});
const fullRepository='HatimTheDream/Nova-Dream',publicRepository='HatimTheDream/Nova-Dream-Public';
const gitBlob=raw=>createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');

/** Equal existing bytes reconcile a lost response; partial/conflicting bytes
 * refuse. No file is overwritten and no unknown external effect is retried. */
function exactFile(path,raw){
 need(raw.length<=2*1024**2,'initialization-record-too-large');
 const r=reference(path,raw);
 if(existsSync(path)){readEvidenceFile(r,{maximum:2*1024**2});return r;}
 let fd;try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}
 catch(error){if(error.code==='EEXIST'){readEvidenceFile(r,{maximum:2*1024**2});return r;}throw error;}
 try{writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}return r;
}
function nextSequence(n){need(Number.isSafeInteger(n)&&n>=0&&n<Number.MAX_SAFE_INTEGER,'predecessor-sequence-invalid');return n+1;}
function newerVersion(next,prior){const parse=v=>/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v)?v.split('.').map(Number):null;const a=parse(next),b=parse(prior);return a&&b&&a.some((n,i)=>n>b[i]&&a.slice(0,i).every((x,j)=>x===b[j]));}
function signature(raw,signature,key){need(signature.length===64&&key.asymmetricKeyType==='ed25519'&&verify(null,raw,key,signature),'predecessor-signature-invalid');}

export function validateAcceptedProfile(profile,target,{candidate=verifyCandidate}={}){
 const bases={};need(target.bases,'accepted-candidates-required');
 for(const side of ['private','public']){
  const base=target.bases[side];need(base.manifest.path===join(base.directory,'dist','candidate.json'),'accepted-manifest-path-changed');
  readEvidenceFile(base.manifest);bases[side]=candidate(base.directory);need(bases[side].id===base.candidateId,'accepted-candidate-changed');
 }
 const identity=json(profile.accepted.identity),request=validateInstalledIdentityRequest(identity.request);
 verifyInstalledIdentity(identity,request);const operation=request.operation;
 need(operation.candidateId===bases.private.id&&operation.version===bases.private.manifest.version&&operation.buildVersion===bases.private.manifest.buildVersion,'accepted-service-base-changed');
 need(bases.public.manifest.version===operation.version&&bases.public.manifest.buildVersion===operation.buildVersion,'accepted-public-base-changed');
 const resultRaw=readEvidenceFile(profile.accepted.result,{maximum:4096}),result=JSON.parse(resultRaw);
 need(profile.accepted.result.sha256===identity.installationProof.installerResult?.sha256
  &&identity.installationProof.installerResult.path===`/var/lib/nova-update/staging/${operation.bundleSha256}/attempts/${request.jobId}/result.json`
  &&same(result,{format:1,jobId:request.jobId,candidateId:operation.candidateId,priorCandidateId:operation.priorCandidateId,outcome:'completed',savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true}),'accepted-original-result-changed');
 const pair=json(profile.accepted.pair),bundle=json(profile.accepted.bundle,128*1024**2);
 need(profile.accepted.bundle.sha256===operation.bundleSha256&&pair.candidateId===operation.candidateId&&pair.priorCandidateId===operation.priorCandidateId
  &&profile.accepted.pair.sha256===identity.installationProof.reviewedPairSha256&&bundle.format===1&&Array.isArray(bundle.files),'accepted-pair-bundle-changed');
 const names=new Set();for(const entry of bundle.files){need(!names.has(entry.name),'accepted-bundle-duplicate-member');names.add(entry.name);const raw=Buffer.from(entry.data,'base64');need(raw.toString('base64')===entry.data&&sha256(raw)===entry.sha256,'accepted-bundle-member-corrupt');
  if(entry.name==='reviewed-pair.json')need(entry.sha256===profile.accepted.pair.sha256,'accepted-pair-member-changed');
  if(entry.name==='app.tgz')need(entry.sha256===pair.archiveSha256&&raw.length===pair.archiveBytes,'accepted-application-member-changed');
 }
 need(names.has('reviewed-pair.json')&&names.has('app.tgz'),'accepted-pair-members-missing');
 need(target.assistantHost&&same(target.assistantHost,request.runtime),'accepted-runtime-target-changed');
 if(target.full?.host)need(same(target.full.host.hostConfiguration,request.runtime.hostConfig),'accepted-host-configuration-changed');
 for(const r of profile.qualificationEvidence)readEvidenceFile(r,{maximum:2*1024**2});
 if(profile.previousDelivery)for(const r of [profile.previousDelivery.assistantReceipt,profile.previousDelivery.publicationReceipt,...Object.values(profile.previousDelivery.sourceCandidates)])readEvidenceFile(r,{maximum:2*1024**2});
 return {bases,identity,operation,pair};
}

/** Exact committed package and adapter blobs. Git calls are read-only. The
 * production graph is compared as raw Git bytes, not normalized working text. */
export async function qualifyDeliverySources(input,profile,target,accepted,{command=fixedCommand,tools=validateSourceTools,adapterFiles=deliveryAdapterSourceFiles,readAdapter=name=>readFileSync(new URL(name,import.meta.url))}={}){
 need(target.sourceTools&&target.artifactTools,'configured-source-tools-required');tools(target.sourceTools);
 for(const value of Object.values(target.artifactTools))if(value?.path)readEvidenceFile(value,{maximum:128*1024**2});
 const sources={},packages={},locks={},names=adapterFiles();
 need(names.length>0&&new Set(names).size===names.length,'adapter-source-list-invalid');
 for(const side of ['private','public']){
  const configured=profile.sources[side],repository=side==='private'?fullRepository:publicRepository,prefix=side==='private'?'edition3/':'';
  need(configured.repository===repository,'canonical-independent-repository-required');
  const baseCommit=accepted.bases[side].manifest.frontendCompatibility?.sourceRevision;commit.parse(baseCommit);
  const value={...configured,commit:input.sourceCommits[side],baseCommit};sources[side]=value;
  const git=args=>command(target.sourceTools.git.path,['-C',value.root,...args],{gitExecPath:target.sourceTools.gitExecPath});
  need((await git(['rev-parse','--show-object-format'])).trim()==='sha1','unsupported-source-object-format');
  need((await git(['rev-parse','--verify',value.commit+'^{commit}'])).trim()===value.commit,'exact-committed-source-required');
  await git(['merge-base','--is-ancestor',baseCommit,value.commit]);
  need([`https://github.com/${repository}.git`,`https://github.com/${repository}`,`git@github.com:${repository}.git`].includes((await git(['remote','get-url','--push','origin'])).trim()),'configured-source-remote-changed');
  const expected=new Map(names.map(name=>[posix.normalize(prefix+'scripts/'+name),gitBlob(readAdapter(name))]));
  const rows=(await git(['ls-tree','-r','--format=%(objectname)%x09%(path)',value.commit,'--',...expected.keys()])).trim().split(/\r?\n/).filter(Boolean).map(row=>row.split('\t'));
  need(rows.length===expected.size&&rows.every(([oid,name])=>expected.get(name)===oid)&&new Set(rows.map(x=>x[1])).size===rows.length,'committed-adapter-identity-changed');
  packages[side]=JSON.parse(await git(['show',`${value.commit}:${prefix}package.json`]));locks[side]=JSON.parse(await git(['show',`${value.commit}:${prefix}package-lock.json`]));
  const pkg=packages[side],lock=locks[side];
  need(pkg.name==='nova-dream-edition-3'&&pkg.scripts?.['release:deliver']==='node scripts/release-deliver.mjs'
   &&/^\d+\.\d+\.\d+$/.test(pkg.version??'')&&/^\d+\.\d+\.\d+$/.test(pkg.edition3?.buildVersion??'')
   &&lock.version===pkg.version&&lock.packages?.['']?.version===pkg.version,'committed-package-metadata-invalid');
 }
 need(same(packages.private,packages.public)&&same(locks.private,locks.public),'paired-committed-package-mismatch');
 need(newerVersion(packages.private.version,accepted.operation.version)&&newerVersion(packages.private.edition3.buildVersion,accepted.operation.buildVersion),'new-installer-version-required');
 return {sources,package:packages.private};
}

export async function deriveDeliveryConfiguration(input,profile,{command=fixedCommand,clock=Date.now,sourceOptions={},acceptedOptions={},feedContract=loadSelectedFeedContract,adapterIdentity=deliveryAdapterIdentity}={}){
 const target=deliveryTargetSchema.parse(json(profile.target,256*1024));
 need(deliveryTargetIdentity({target:profile.target})===profile.targetIdentity,'configured-target-identity-changed');
 const accepted=validateAcceptedProfile(profile,target,acceptedOptions);
 const qualified=await qualifyDeliverySources(input,profile,target,accepted,{command,...sourceOptions});
 const version=qualified.package.version,buildVersion=qualified.package.edition3.buildVersion;
 const createdAt=new Date(input.timeline.startedAtMs).toISOString(),expiresAt=new Date(input.timeline.startedAtMs+7*86400000).toISOString();
 const keyRef=target.full?.signing.publicKey??target.signing?.publicKey;need(keyRef,'configured-public-key-required');
 const key=createPublicKey(readEvidenceFile(keyRef,{maximum:16384}));need(key.asymmetricKeyType==='ed25519','configured-public-key-invalid');
 if(target.full){
  need(same(target.full.signing.publicKey,keyRef),'configured-full-key-changed');
  const envelope=json(target.full.signing.previousFeed,128*1024),raw=Buffer.from(envelope.payload,'base64'),sig=Buffer.from(envelope.signature,'base64');
  need(raw.toString('base64')===envelope.payload&&sig.toString('base64')===envelope.signature,'predecessor-envelope-invalid');signature(raw,sig,key);
  const contract=await feedContract(target.bases.private,{operation:{priorCandidateId:accepted.operation.candidateId}}),previous=contract.updateManifestSchema.parse(JSON.parse(raw));
  need(previous.channel===target.full.feed.channel&&previous.releases.some(r=>r.candidateId===accepted.operation.candidateId&&r.bundle.sha256===profile.accepted.bundle.sha256),'accepted-feed-predecessor-changed');
  target.full.feed={channel:previous.channel,sequence:nextSequence(previous.sequence),createdAt,expiresAt};
  target.full.bundleUrl=`https://github.com/${fullRepository}/releases/download/nova-v${version}/nova-${version}-operator-bundle.json`;
  target.full.dependenciesUrl=`https://github.com/${fullRepository}/releases/download/nova-v${version}/nova-${version}-app-dependencies.tgz`;
  if(target.full.host)Object.assign(target.full.host,{acceptedInstallation:accepted.identity.installationProof.installerResult,priorVersion:accepted.operation.version,priorBuildVersion:accepted.operation.buildVersion,priorJobId:accepted.identity.jobId});
  // Format3's accepted native anchor is distinct from the selected prior service.
  // The maintained runtime collector validates that configured anchor before admission.
  if(target.full.dependencyTransport&&target.full.dependencyTransport.format!==3)Object.assign(target.full.dependencyTransport,{selectedPair:profile.accepted.pair,selectedInstaller:profile.accepted.result,selectedBundle:profile.accepted.bundle});
 }
 if(target.frontend){
  need(target.signing&&same(target.signing.publicKey,keyRef)&&target.frontendHost,'configured-frontend-target-required');let sequence=1;
  if(target.signing.previousManifest!=='initial'){
   const raw=readEvidenceFile(target.signing.previousManifest,{maximum:128*1024});signature(raw,readEvidenceFile(target.signing.previousSignature,{maximum:64}),key);
   const previous=validateFrontendManifest(JSON.parse(raw),{admission:false});
   need(newerVersion(version,previous.frontendVersion)&&newerVersion(buildVersion,previous.frontendBuildVersion),'new-frontend-version-required');
   sequence=nextSequence(previous.sequence);
  }
  target.frontend={artifactUrl:`https://github.com/${publicRepository}/releases/download/v${version}/nova-${version}-frontend.tgz`,sequence,createdAt,expiresAt};
  target.frontendHost.baseVersion=accepted.operation.version;
 }
 let agentVersion=accepted.operation.agentVersion;
 if(target.full?.dependencyTransport?.format===3){const runtime=json(target.full.dependencyTransport.runtime.metadata);need(runtime.fromVersion===agentVersion,'configured-runtime-prior-changed');agentVersion=runtime.toVersion;}
 const operation={id:input.operationId,stage:'draft',candidateId:null,publicCandidateId:null,priorCandidateId:accepted.operation.candidateId,workspaceEpoch:accepted.operation.workspaceEpoch,
  version,buildVersion,agentVersion,priorAgentVersion:accepted.operation.agentVersion,sourceCommits:input.sourceCommits,bundleSha256:null,trustedPublicKeySha256:keyRef.sha256,changeClass:agentVersion===accepted.operation.agentVersion?'application':'runtime',helperHashes:null};
 return {target:deliveryTargetSchema.parse(target),operation,sources:qualified.sources,adapterIdentity:adapterIdentity(),targetIdentity:profile.targetIdentity,preparedAtMs:clock()};
}

/** No journal or host effect here. An existing complete request can be reopened
 * after a lost response without resetting the operation or original timeline. */
export async function initializeDeliveryInput(inputPath,{clock=Date.now,protect=validateJournalDirectory,derive=deriveDeliveryConfiguration,afterWrite=()=>{}}={}){
 const raw=readReleaseInputFile(resolve(inputPath)),input=deliveryStartInputSchema.parse(JSON.parse(raw)),inputSha256=sha256(encoded(input));
 const profile=deliveryProfileSchema.parse(json(input.profile,256*1024));
 for(const source of Object.values(profile.sources)){
  const nested=relative(resolve(source.root),resolve(input.outputRoot));
  need(nested!==''&&(nested.startsWith('..'+posix.sep)||nested.startsWith('..\\')||isAbsolute(nested)),'private-output-overlaps-source-checkout');
 }
 const root=protect(resolve(input.outputRoot),{create:true}),directory=join(root,'request-'+input.operationId),journalDirectory=join(root,'journal-'+input.operationId);
 protect(directory,{create:true});const recordPath=join(directory,'initialization.json');let record;
 if(existsSync(recordPath)){
  record=JSON.parse(frontendRegular(recordPath,2*1024**2));
  need(record.format===1&&record.kind==='nova-delivery-initialization'&&record.inputSha256===inputSha256&&same(record.input,input)
   &&same(record.profile,input.profile)&&record.adapterIdentity===deliveryAdapterIdentity()&&record.directory===directory&&record.journalDirectory===journalDirectory,'original-initialization-input-changed');
 }else{
  need(!existsSync(journalDirectory),'existing-journal-without-initialization');
  need(input.timeline.startedAtMs===input.timeline.original.issuedAtMs&&input.timeline.lastCheckpointAtMs===input.timeline.startedAtMs
   &&input.timeline.revisions.length===0&&input.timeline.reviews.length===0&&clock()>=input.timeline.startedAtMs-5000&&clock()-input.timeline.startedAtMs<=300000,'actual-original-start-required');assessTimeline(input.timeline,{nowMs:clock()});
  const prepared=await derive(input,profile,{clock});assessTimeline(input.timeline,{nowMs:clock()});
  const targetRaw=encoded(prepared.target),target=reference(join(directory,'target.json'),targetRaw);
  const descriptor=deliveryDescriptorSchema.parse({format:1,operation:prepared.operation,sources:prepared.sources,target,targetIdentity:prepared.targetIdentity,adapterIdentity:prepared.adapterIdentity,timeline:input.timeline,observationBudgetMs:input.observationBudgetMs});
  record={format:1,kind:'nova-delivery-initialization',input,inputSha256,profile:input.profile,adapterIdentity:prepared.adapterIdentity,directory,journalDirectory,
   target:{reference:target,value:prepared.target},descriptor:{reference:reference(join(directory,'descriptor.json'),encoded(descriptor)),value:descriptor}};
  exactFile(recordPath,encoded(record));afterWrite('initialization');
 }
 const parsed=deliveryDescriptorSchema.parse(record.descriptor.value);deliveryTargetSchema.parse(record.target.value);
 need(parsed.operation.id===input.operationId&&same(parsed.operation.sourceCommits,input.sourceCommits)&&same(parsed.timeline,input.timeline)
  &&same(parsed.target,record.target.reference)&&record.target.reference.path===join(directory,'target.json')&&record.descriptor.reference.path===join(directory,'descriptor.json')
  &&sha256(encoded(record.target.value))===record.target.reference.sha256&&sha256(encoded(parsed))===record.descriptor.reference.sha256,'original-initialization-record-changed');
 exactFile(record.target.reference.path,encoded(record.target.value));afterWrite('target');
 need(deliveryTargetIdentity(parsed)===parsed.targetIdentity&&parsed.targetIdentity===profile.targetIdentity,'configured-target-identity-changed');
 exactFile(record.descriptor.reference.path,encoded(parsed));afterWrite('descriptor');
 return {operationId:input.operationId,journalDirectory,descriptor:record.descriptor.reference,initialization:reference(recordPath),preparedOnly:true};
}

/** Export only actual completed producer records. Browser proof is deliberately
 * separate. This is an immutable returned profile, never a selected global pointer. */
function retainedSavedReply(journal,descriptor,parent,prior){
 const id=descriptor.operation.id,input=assistantAcceptanceInput({descriptor,prior});
 need(parent.current.externalId===id&&same(parent.input,input)&&parent.inputSha256===sha256(canonical(input))
  &&Number.isSafeInteger(parent.createdAtMs),'successor-assistant-parent-changed');
 const children={};
 for(const name of ['session','create','draft','submit','saved-reply']){
  const child=journal.deliveryPhase(id,'assistant/'+name);
  need(child?.state==='completed'&&child.validation?.state!=='failed'&&child.current?.externalId===child.key&&child.current.receipt
   &&same(json(child.current.receipt),child.current.output)&&child.input.parentKey===parent.key&&child.input.parentInputSha256===parent.inputSha256
   &&child.input.deadlineAtMs===parent.createdAtMs+300000&&child.input.priorResultsSha256===sha256(canonical(children)),'successor-assistant-child-changed');
  children[name]=child.current.output;
 }
 const proof=verifySavedAssistantReply(children['saved-reply'].evidence,{input,session:children.session,conversation:children.create.conversation,
  submission:children.submit.requestBody,expectedReply:`Nova verification ${parent.key} passed.`,originalOperationId:children.submit.operationId});
 // The saved command operationId is intentionally distinct from the outer
 // delivery ID, matching the maintained Assistant producer's exact spread order.
 need(same(parent.current.output,{format:1,kind:'nova-delivery-saved-assistant-reply',operationId:id,key:parent.key,inputSha256:parent.inputSha256,
  originalDeadlineAtMs:parent.createdAtMs+300000,...proof}),'successor-saved-assistant-proof-changed');
}
export async function exportSuccessorProfile(journal,id){
 const descriptor=journal.loadDelivery(id).descriptor,directory=dirname(descriptor.target.path),recordPath=join(directory,'initialization.json');
 if(!existsSync(recordPath))return {gap:'data-profile-initialization-unavailable'};
 const record=JSON.parse(frontendRegular(recordPath,2*1024**2));
 need(record.kind==='nova-delivery-initialization'&&record.input.operationId===id&&same(record.descriptor.reference,reference(join(directory,'descriptor.json'))),'successor-original-initialization-changed');
 const profile=deliveryProfileSchema.parse(json(record.profile,256*1024)),target=deliveryTargetSchema.parse(json(descriptor.target,256*1024));
 const phase=name=>{const p=journal.deliveryPhase(id,name);need(p?.state==='completed'&&p.validation?.state!=='failed'&&p.current?.output,'successor-phase-not-accepted');return p;};
 const installation=journal.deliveryPhase(id,'installation'),assistant=journal.deliveryPhase(id,'assistant');
 if(installation?.state!=='completed'||assistant?.state!=='completed')return {gap:'installation-and-saved-assistant-reply-required'};
 const accepted=phase('assistant');need(accepted.current.receipt&&same(json(accepted.current.receipt),accepted.current.output),'successor-saved-assistant-evidence-changed');
 const route=phase('route').current.output,sign=phase('sign').current.output,installed=phase('installation').current.output;
 const publication=phase('publication');need(publication.current.receipt&&same(json(publication.current.receipt),publication.current.output)
  &&publication.current.output.operationId===id,'successor-publication-evidence-changed');
 retainedSavedReply(journal,descriptor,accepted,{route,sign,installation:installed,publication:publication.current.output});
 const repositories=phase('artifacts').current.output.repositories,actualBases={},sourceCandidates={};
 for(const side of ['private','public']){
  const actual=verifyRetainedCandidate(repositories[side],descriptor.sources[side]);
  need(actual.manifest.version===descriptor.operation.version&&actual.manifest.buildVersion===descriptor.operation.buildVersion,'successor-candidate-version-changed');
  const manifest=reference(join(repositories[side].applicationDirectory,'dist','candidate.json'));
  actualBases[side]={directory:repositories[side].applicationDirectory,candidateId:actual.id,manifest};sourceCandidates[side]=manifest;
 }
 if(route.route==='full'){
  const identity=verifyInstalledIdentity(installed.acceptanceIdentity,validateInstalledIdentityRequest(installed.acceptanceIdentity?.request));
  need(installed.acceptanceIdentityReceipt&&same(json(installed.acceptanceIdentityReceipt),identity),'successor-installed-identity-receipt-changed');
  need(identity.operationId===id&&identity.candidateId===actualBases.private.candidateId&&identity.request.operation.version===descriptor.operation.version
   &&identity.request.operation.buildVersion===descriptor.operation.buildVersion,'successor-accepted-operation-changed');
  const rawBase64=identity.installationProof.installerResultBytesBase64;
  if(typeof rawBase64!=='string')return {gap:'original-installer-result-bytes-unavailable'};
  const result=Buffer.from(rawBase64,'base64');need(result.length<=4096&&result.toString('base64')===rawBase64&&sha256(result)===identity.installationProof.installerResult.sha256,'successor-original-result-bytes-changed');
  target.bases=actualBases;
  const published=publication.current.output;
  need(published.kind==='nova-delivery-full-publication'&&same(published.evidence?.feed,sign.signedFeed)
   &&same(published.evidence?.publicKey,sign.publicKey)&&same(sign.publicKey,target.full.signing.publicKey),'successor-published-feed-changed');
  readEvidenceFile(sign.signedFeed,{maximum:128*1024});readEvidenceFile(published.evidence.receipt);
  const pair=reference(join(sign.directory,'reviewed-pair.json'));need(pair.sha256===identity.installationProof.reviewedPairSha256&&sign.bundle.sha256===identity.request.operation.bundleSha256,'successor-signed-pair-changed');
  if(target.full.dependencyTransport?.format===3){
   need(identity.request.operation.agentVersion===descriptor.operation.agentVersion&&descriptor.operation.agentVersion==='2026.9.8'
    &&identity.request.operation.priorAgentVersion===descriptor.operation.priorAgentVersion&&descriptor.operation.priorAgentVersion==='2026.9.6',
   'successor-runtime-installation-changed');
   const proof=verifyRuntimeQualificationReference(sign.runtime,descriptor.operation,FULL_HELPERS),original=target.full.dependencyTransport;
   need(sign.runtime.qualificationBinding.candidateId===actualBases.private.candidateId
    &&same(proof.request.parent,original.runtimeQualification.parent)&&same(proof.request.producer,original.runtimeQualification.producer)
    &&proof.qualifiedTarget.candidateId===original.nativeAnchor.candidateId,'successor-original-runtime-qualification-changed');
   const qualification=normalizedRef(sign.runtime.qualification);
   if(!profile.qualificationEvidence.some(r=>same(r,qualification)))profile.qualificationEvidence.push(qualification);
   // A completed transition's accepted service is now9.8. The successor uses the
   // existing unchanged-runtime route; the original descriptor/proof stays intact.
   const {nativeAnchor,runtimeQualification,runtime,...unchanged}=original;
   target.full.dependencyTransport={...unchanged,format:2,mode:'retained-native-metadata-successor'};
  }
  profile.accepted={identity:normalizedRef(installed.acceptanceIdentityReceipt),result:exactFile(join(directory,'accepted-installer-result.json'),result),pair,bundle:normalizedRef(sign.bundle)};
  target.full.signing.previousFeed=normalizedRef(sign.signedFeed);
  if(target.full.host)Object.assign(target.full.host,{acceptedInstallation:identity.installationProof.installerResult,priorVersion:identity.request.operation.version,priorBuildVersion:identity.request.operation.buildVersion,priorJobId:identity.jobId});
  if(target.full.dependencyTransport)Object.assign(target.full.dependencyTransport,{selectedPair:pair,selectedInstaller:profile.accepted.result,selectedBundle:profile.accepted.bundle});
  if(target.frontendHost)target.frontendHost.baseVersion=identity.request.operation.version;
 }else{
  need(route.route==='frontend'&&target.signing&&sign.manifest&&sign.signature,'successor-frontend-evidence-unavailable');
  const raw=readEvidenceFile(sign.manifest,{maximum:128*1024}),manifest=validateFrontendManifest(JSON.parse(raw),{admission:false});
  signature(raw,readEvidenceFile(sign.signature,{maximum:64}),createPublicKey(readEvidenceFile(target.signing.publicKey,{maximum:16384})));
  need(manifest.base.candidateId===target.bases.private.candidateId&&manifest.sourceRevision===descriptor.sources.private.commit
   &&manifest.frontendVersion===descriptor.operation.version&&manifest.frontendBuildVersion===descriptor.operation.buildVersion,'successor-frontend-source-changed');
  const published=publication.current.output;
  need(published.kind==='nova-delivery-frontend-publication'&&published.frontendId===manifest.frontendId&&['manifest','signature'].every(role=>
   published.assets?.some(a=>a.role===role&&a.asset?.sha256===sign[role].sha256&&a.asset.authenticatedDownloadVerified===true)),'successor-published-frontend-changed');
  target.signing.previousManifest=normalizedRef(sign.manifest);target.signing.previousSignature=normalizedRef(sign.signature);
 }
 validateAcceptedProfile(profile,target);
 profile.previousDelivery={operationId:id,descriptorSha256:record.descriptor.reference.sha256,assistantReceipt:normalizedRef(accepted.current.receipt),
  publicationReceipt:normalizedRef(publication.current.receipt),sourceCandidates,browserAccepted:false};
 profile.target=exactFile(join(directory,'successor-target.json'),encoded(deliveryTargetSchema.parse(target)));
 const output=exactFile(join(directory,'successor-profile.json'),encoded(deliveryProfileSchema.parse(profile)));
 return {profile:output,operationId:id,browserAccepted:false,mutableSelectionUpdated:false};
}
