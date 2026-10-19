/** Inert portable inputs: no Git, SSH, private key file or deployment calls. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {sha256} from '../scripts/release-plan.mjs';
import {verifyCandidate} from '../scripts/candidate.mjs';
import {deliveryTargetIdentity,deliveryAdapterSourceFiles} from '../scripts/release-delivery-adapters.mjs';
import {frontendIdentity} from '../scripts/frontend-contract.mjs';
import {assistantAcceptanceInput,verifyAssistantReady,verifySavedAssistantReply} from '../scripts/release-delivery-assistant.mjs';
import * as feedContract from './full-contract/apps/service/update-feed.js';
const enc=v=>Buffer.from(JSON.stringify(v)+'\n');
export function initializeFixture(t,{version='3.2.0',buildVersion='1.0.400'}={}){
 const root=mkdtempSync(join(tmpdir(),'nova-delivery-initialize-'));
 t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
 const put=(name,value)=>{const p=join(root,name),raw=Buffer.isBuffer(value)?value:enc(value);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,raw);return{path:p,sha256:sha256(raw)};};
 const candidate=side=>{
  const directory=join(root,'base-'+side),revision=(side==='private'?'a':'b').repeat(40);
  const pkg={name:'nova-dream-edition-3',type:'module',version:'3.1.0',edition3:{buildVersion:'1.0.399',schemaVersion:1,apiVersion:1,appId:'synthetic'},scripts:{'release:deliver':'node scripts/release-deliver.mjs'}};
  put('base-'+side+'/package.json',pkg);put('base-'+side+'/package-lock.json',{version:pkg.version,packages:{'':{version:pkg.version}}});
  const artifacts=['dist/client/index.html','dist/service/apps/service/main.js'].map(path=>({path,sha256:put('base-'+side+'/'+path,Buffer.from('synthetic '+path)).sha256}));
  const manifest=put('base-'+side+'/dist/candidate.json',{version:pkg.version,...pkg.edition3,artifacts,frontendCompatibility:{format:2,eligibility:'client-behavior',sourceRevision:revision,serviceInputsSha256:'c'.repeat(64)}});
  return{directory,candidateId:verifyCandidate(directory).id,manifest};
 };
 const bases={private:candidate('private'),public:candidate('public')},jobId=randomUUID(),operationId=randomUUID(),idempotencyKey=randomUUID(),epoch=randomUUID();
 const pairRaw=enc({format:1,candidateId:bases.private.candidateId,priorCandidateId:'e'.repeat(64),archiveSha256:sha256('app'),archiveBytes:3}),pair=put('pair.json',pairRaw);
 const bundle=put('bundle.json',{format:1,files:[{name:'reviewed-pair.json',sha256:pair.sha256,data:pairRaw.toString('base64')},{name:'app.tgz',sha256:sha256('app'),data:Buffer.from('app').toString('base64')}]});
 const result={format:1,jobId,candidateId:bases.private.candidateId,priorCandidateId:'e'.repeat(64),outcome:'completed',savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true},resultRef=put('result.json',result);
 const runtime={hostConfig:{path:'/etc/nova-update/config.json',sha256:'d'.repeat(64)},startupReview:{path:'/opt/nova-release-tools/synthetic/startup-review.json',sha256:'f'.repeat(64)}};
 const request={format:1,operation:{format:1,operationId,idempotencyKey,candidateId:bases.private.candidateId,priorCandidateId:'e'.repeat(64),workspaceEpoch:epoch,version:'3.1.0',buildVersion:'1.0.399',priorVersion:'3.0.0',priorBuildVersion:'1.0.398',schemaVersion:1,apiVersion:1,agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',bundleSha256:bundle.sha256,rehearsalLeaseId:randomUUID(),rehearsalProofSha256:'e'.repeat(64)},jobId,
  requester:{path:'/opt/nova-release-tools/15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06/request_install.py',sha256:'15ae855d7025b9cc267b7a7529ac59c5fdcc1cf960e00104578ba79b3007dc06'},runtime};
 const identity={format:1,kind:'maintained-installed-acceptance-identity',readOnly:true,savedReplyAccepted:false,browserUiVerified:false,request,operationId,candidateId:request.operation.candidateId,priorCandidateId:request.operation.priorCandidateId,jobId,idempotencyKey,
  health:{candidateId:request.operation.candidateId,epoch,apiVersion:1,schemaVersion:1,serviceInputsSha256:'c'.repeat(64),processIdentity:randomUUID(),frontend:{source:'bundled',id:'c'.repeat(64)}},
  installationProof:{jobId,releaseId:bundle.sha256,candidateId:request.operation.candidateId,candidateFilesSha256:request.operation.candidateId,hostConfigSha256:runtime.hostConfig.sha256,reviewedPairSha256:pair.sha256,installerResult:{path:`/var/lib/nova-update/staging/${bundle.sha256}/attempts/${jobId}/result.json`,sha256:resultRef.sha256},installerResultBytesBase64:enc(result).toString('base64')},
  runtimeProof:{openclawVersion:'2026.9.8',configurationSha256:runtime.hostConfig.sha256},appProcess:{ActiveState:'active',SubState:'running',MainPID:22}};
 const identityRef=put('identity.json',identity),keys=generateKeyPairSync('ed25519'),publicKey=put('public.pem',Buffer.from(keys.publicKey.export({type:'spki',format:'pem'}))),now=Date.now();
 const feed={format:1,channel:'stable',sequence:12,createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),releases:[{candidateId:request.operation.candidateId,novaVersion:'3.1.0',agentVersion:'2026.9.8',fromCandidateId:'e'.repeat(64),platform:'linux',arch:'x64',nodeMajor:22,notes:[],compatibility:{reviewed:true,gatewayProtocol:4,fromNovaVersion:'3.0.0',fromAgentVersion:'2026.9.8',fromSchemaVersion:1,toSchemaVersion:1,pluginVersion:'3.1.0'},recovery:{pairedSnapshot:true,independentRestore:true,readinessTimeoutSeconds:300},bundle:{url:'https://example.invalid/bundle',bytes:readFileSync(bundle.path).length,sha256:bundle.sha256,runnerSha256:'e'.repeat(64)}}]};
 const feedRaw=enc(feed),signedFeed=put('feed.json',{payload:feedRaw.toString('base64'),signature:sign(null,feedRaw,keys.privateKey).toString('base64')});
 const executable=put('tool',Buffer.from('synthetic executable, never executed')),ssh=put('ssh.config',Buffer.from('Host synthetic\n HostName example.invalid\n')),transport=put('transport.json',{format:1,hostAlias:'synthetic',sshConfig:ssh});
 const target={format:1,transport,sourceTools:{git:executable,python:executable,gitExecPath:root},artifactTools:{git:executable,node:executable,python:executable,ciNodeSha256:'a'.repeat(64),nodeToolchain:{nodeVersion:'22.23.2',platform:process.platform,arch:'x64'}},bases,assistantHost:runtime,browserCapability:'unavailable',full:{bundleUrl:'https://example.invalid/old-bundle',dependenciesUrl:'https://example.invalid/old-deps',publicationLedgerDirectory:join(root,'ledger'),feed:{channel:'stable',sequence:12,createdAt:feed.createdAt,expiresAt:feed.expiresAt},signing:{privateKeyPath:join(root,'PRIVATE-KEY-DOES-NOT-EXIST'),publicKey,previousFeed:signedFeed}}};
 const targetRef=put('configured-target.json',target),profile={format:1,target:targetRef,targetIdentity:deliveryTargetIdentity({target:targetRef}),sources:{private:{root:join(root,'private'),repository:'HatimTheDream/Nova-Dream',branch:'main'},public:{root:join(root,'public'),repository:'HatimTheDream/Nova-Dream-Public',branch:'main'}},accepted:{identity:identityRef,result:resultRef,pair,bundle},qualificationEvidence:[]};
 const input={format:1,operationId:randomUUID(),profile:put('profile.json',profile),sourceCommits:{private:'1'.repeat(40),public:'2'.repeat(40)},outputRoot:join(root,'output'),timeline:{startedAtMs:now,original:{id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[60000,120000],confidence:'low',basis:'Synthetic fixture only',reason:'Original bounded fixture',nextCheckpointAtMs:now+300000},revisions:[],reviews:[],lastCheckpointAtMs:now},observationBudgetMs:60000};
 const packages=Object.fromEntries(['private','public'].map(side=>[side,{name:'nova-dream-edition-3',version,edition3:{buildVersion,schemaVersion:1,apiVersion:1,appId:'synthetic'},scripts:{'release:deliver':'node scripts/release-deliver.mjs'}}]));
 const locks=Object.fromEntries(['private','public'].map(side=>[side,{version,packages:{'':{version}}}]));
 const calls=[];let corruptSource=false;
 const command=async(executable,args)=>{
  calls.push(args);assert.equal(executable,target.sourceTools.git.path);assert.equal(args[0],'-C');const side=args[1]===profile.sources.private.root?'private':'public',a=args.slice(2),prefix=side==='private'?'edition3/':'';
  if(a[0]==='rev-parse')return a[1]==='--show-object-format'?'sha1\n':input.sourceCommits[side]+'\n';
  if(a[0]==='merge-base')return '';
  if(a[0]==='branch')return 'main\n';
  if(a[0]==='status')return '';
  if(a[0]==='remote')return `https://github.com/${profile.sources[side].repository}.git\n`;
  if(a[0]==='ls-tree')return deliveryAdapterSourceFiles().map(name=>{const raw=readFileSync(new URL('../scripts/'+name,import.meta.url)),oid=createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');return`${corruptSource?'0'.repeat(40):oid}\t${prefix}scripts/${name}`.replace(/scripts\/\.\.\//,'');}).join('\n')+'\n';
  if(a[0]==='show')return JSON.stringify(a[1].endsWith('package-lock.json')?locks[side]:packages[side]);
  throw Error('unexpected synthetic command');
 };
 const feedEvents=[];
 const protect=(path,{create=false}={})=>{assert.ok(resolve(path).startsWith(root));if(create)mkdirSync(path,{recursive:true,mode:0o700});return resolve(path);};
 return{root,put,input,profile,target,identity,request,result,resultRef,pair,bundle,feed,signedFeed,packages,locks,calls,command,protect,now,keys,
  feedEvents,corruptSource:()=>{corruptSource=true;},options:{command,clock:()=>now,prepareFeedDependencies:async()=>{feedEvents.push('prepare');},feedContract:async()=>{feedEvents.push('import');return feedContract;}}};
}

export function enableFrontendFixture(f){
 f.profile.accepted.feedDependencies={archive:f.put('accepted-feed-dependencies.tgz',Buffer.from('synthetic')),metadata:f.put('accepted-feed-dependencies.json',{})};
 f.target.frontend={artifactUrl:'https://example.invalid/ui.tgz',sequence:1,createdAt:new Date(f.now).toISOString(),expiresAt:new Date(f.now+86400000).toISOString()};
 f.target.frontendHost={baseVersion:'3.1.0',worker:{path:'/opt/synthetic/worker.py',sha256:'1'.repeat(64)},config:{path:'/etc/synthetic/config.json',sha256:'2'.repeat(64)}};
 f.target.signing={privateKeyPath:f.target.full.signing.privateKeyPath,publicKey:f.target.full.signing.publicKey,previousManifest:'initial'};
 f.profile.target=f.put('configured-target.json',f.target);f.input.profile=f.put('profile.json',f.profile);
}

/** Original phase records for export tests, never submitted to a real journal. */
export function completedDeliveryFixture(f,prepared,{route='full',legacy=false,runtimeFor=null}={}){
 const descriptor=JSON.parse(readFileSync(prepared.descriptor.path)),id=descriptor.operation.id,repositories={};
 for(const side of ['private','public']){
  const prefix='target-'+side,applicationDirectory=join(f.root,prefix),pkg=f.packages[side];
  f.put(prefix+'/package.json',pkg);f.put(prefix+'/package-lock.json',f.locks[side]);
  const artifacts=['dist/client/index.html','dist/service/apps/service/main.js'].map(path=>({path,sha256:f.put(prefix+'/'+path,Buffer.from('new synthetic '+path)).sha256}));
  f.put(prefix+'/dist/candidate.json',{version:pkg.version,...pkg.edition3,artifacts,frontendCompatibility:{format:2,eligibility:'client-behavior',sourceRevision:descriptor.sources[side].commit,serviceInputsSha256:'c'.repeat(64)}});
  const candidateId=verifyCandidate(applicationDirectory).id,archive=f.put(prefix+'/app.tgz',Buffer.from('newapp'));
  repositories[side]={applicationDirectory,candidateId,sourceCommit:descriptor.sources[side].commit,archive,
   metadata:f.put(prefix+'/metadata.json',{candidateId,archiveSha256:archive.sha256}),
   ciSourceReceipt:f.put(prefix+'/ci.json',{sourceCommit:descriptor.sources[side].commit,repository:descriptor.sources[side].repository,application:{candidateId,archiveSha256:archive.sha256}})};
 }
 const phases={},set=(name,output)=>phases[name]={state:'completed',validation:{state:'completed'},current:{output,receipt:f.put('phase-'+name+'.json',output)}};
 set('route',{route,targetCandidateId:repositories.private.candidateId,serviceInputsSha256:'c'.repeat(64)});set('artifacts',{repositories});
 if(route==='full'){
  const candidateId=repositories.private.candidateId,priorCandidateId=f.identity.candidateId,jobId=randomUUID(),app=readFileSync(repositories.private.archive.path);
  const pair=f.put('signed/reviewed-pair.json',{format:1,candidateId,priorCandidateId,archiveSha256:sha256(app),archiveBytes:app.length}),pairRaw=readFileSync(pair.path);
  const bundle=f.put('signed/bundle.json',{format:1,files:[{name:'reviewed-pair.json',sha256:pair.sha256,data:pairRaw.toString('base64')},{name:'app.tgz',sha256:sha256(app),data:app.toString('base64')}]});
  const result={...f.result,jobId,candidateId,priorCandidateId},raw=enc(result),identity=structuredClone(f.identity),op=identity.request.operation;
  Object.assign(op,{operationId:id,candidateId,priorCandidateId,version:descriptor.operation.version,buildVersion:descriptor.operation.buildVersion,bundleSha256:bundle.sha256,priorVersion:'3.1.0',priorBuildVersion:'1.0.399',agentVersion:descriptor.operation.agentVersion,priorAgentVersion:descriptor.operation.priorAgentVersion});
  identity.runtimeProof.openclawVersion=op.agentVersion;
  identity.request.jobId=jobId;Object.assign(identity,{operationId:id,jobId,candidateId,priorCandidateId});identity.health.candidateId=candidateId;
  Object.assign(identity.installationProof,{jobId,releaseId:bundle.sha256,candidateId,candidateFilesSha256:candidateId,reviewedPairSha256:pair.sha256,
   installerResult:{path:`/var/lib/nova-update/staging/${bundle.sha256}/attempts/${jobId}/result.json`,sha256:sha256(raw)},installerResultBytesBase64:raw.toString('base64')});
  if(legacy)delete identity.installationProof.installerResultBytesBase64;
  set('installation',{controllerCompleted:true,acceptanceIdentity:identity,acceptanceIdentityReceipt:f.put('accepted-new-identity.json',identity)});
  const feed=structuredClone(f.feed);feed.sequence++;Object.assign(feed.releases[0],{candidateId,novaVersion:op.version,fromCandidateId:priorCandidateId,agentVersion:op.agentVersion});
  Object.assign(feed.releases[0].compatibility,{pluginVersion:op.version,fromNovaVersion:'3.1.0',fromAgentVersion:op.priorAgentVersion});
  feed.releases[0].bundle={...feed.releases[0].bundle,sha256:bundle.sha256,bytes:readFileSync(bundle.path).length};
  const feedRaw=enc(feed),signedFeed=f.put('signed/feed.json',{payload:feedRaw.toString('base64'),signature:sign(null,feedRaw,f.keys.privateKey).toString('base64')});
  const dependencies={archive:f.put('synthetic-dependencies.tgz',Buffer.from('synthetic')),metadata:f.put('synthetic-dependencies.metadata.json',{})};
  set('package/pair',{kind:'maintained-qualified-update-pair',operationId:id,candidateId,priorCandidateId,sourceCommits:descriptor.operation.sourceCommits,dependencies,directory:join(f.root,'signed')});
  set('sign',{route,candidateId,priorCandidateId,sourceCommits:descriptor.operation.sourceCommits,dependencies,bundle,signedFeed,publicKey:f.target.full.signing.publicKey,...(runtimeFor?{runtime:runtimeFor({descriptor,repositories})}:{})});
  set('publication',{kind:'nova-delivery-full-publication',operationId:id,evidence:{receipt:f.put('paired-publication.json',{operationId:id,feedSha256:signedFeed.sha256}),feed:signedFeed,publicKey:f.target.full.signing.publicKey}});
 }else{
  const files=['.vite/manifest.json','index.html'].map(path=>({path,bytes:1,sha256:sha256('x')})),frontendId=frontendIdentity(files);
  const manifestValue={format:1,kind:'frontend',channel:'frontend-stable',sequence:1,createdAt:new Date(f.now).toISOString(),expiresAt:new Date(f.now+86400000).toISOString(),frontendId,frontendVersion:descriptor.operation.version,frontendBuildVersion:descriptor.operation.buildVersion,sourceRevision:descriptor.sources.private.commit,
   base:{candidateId:f.identity.candidateId,serviceInputsSha256:'c'.repeat(64),apiVersion:1,schemaVersion:1},artifact:{url:'https://example.invalid/ui.tgz',bytes:1,sha256:sha256('x')},files};
  const raw=enc(manifestValue),manifest=f.put('signed/frontend.json',raw),signature=f.put('signed/frontend.sig',sign(null,raw,f.keys.privateKey));
  set('sign',{route,frontendId,manifest,signature});set('installation',{state:'completed',operationId:id,journal:{phase:'completed',outcome:'selected',health:f.identity.health,frontendId}});
  set('publication',{kind:'nova-delivery-frontend-publication',operationId:id,frontendId,assets:[{role:'manifest',asset:{sha256:manifest.sha256,authenticatedDownloadVerified:true}},{role:'signature',asset:{sha256:signature.sha256,authenticatedDownloadVerified:true}}]});
 }
 const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),digest=v=>sha256(canonical(v));
 const input=assistantAcceptanceInput({descriptor,prior:Object.fromEntries(['route','sign','publication','installation'].map(n=>[n,phases[n].current.output]))}),key=randomUUID(),deviceId=randomUUID(),generation=randomUUID();
 const health=input.installedHealth,ready={health,access:{workspaceEpoch:health.epoch,recovery:false,recoveryLocal:false},acceptance:{candidateId:health.candidateId,epoch:health.epoch,heldFor:null,maintenanceHeld:false,nativeSuspended:false},service:{id:'openclaw',state:'ready',version:'2026.9.8'},
  state:{operations:[],conversations:[],connection:{state:'ready',modelAuthReady:true,grantedScopes:['operator.read','operator.write'],generation}},appProcess:{ActiveState:'active',SubState:'running',MainPID:100,ExecMainStartTimestampMonotonic:'123'},
  runtimeProof:{configurationSha256:'a'.repeat(64),openclawVersion:'2026.9.8',files:{node:{bytes:100,inode:1,sha256:'b'.repeat(64)},runtime:{bytes:200,inode:2,sha256:'c'.repeat(64)}}},installationProof:{installationSha256:input.installationSha256},fullRuntimeVerified:true};
 const session={deviceId,readiness:verifyAssistantReady(ready,input,null,{initial:true,full:true})},conversation={id:randomUUID(),nativeId:randomUUID()},submission={requestId:randomUUID(),epoch:health.epoch,conversationId:conversation.id,conversationRevision:1};
 const command={id:randomUUID(),...submission,deviceId,nativeId:conversation.nativeId,connectionGeneration:generation,state:'completed',nativeRunId:randomUUID(),text:`Nova verification ${key} passed.`};
 ready.state.operations=[command];const evidence={ready,operation:command,history:{nativeId:conversation.nativeId,activeRunIds:[],messages:[{id:randomUUID(),role:'assistant',text:command.text,runId:command.nativeRunId}]}};
 const outputs={session,create:{conversation},draft:{synthetic:true},submit:{requestBody:submission,operationId:command.id},'saved-reply':{evidence}},prior={};
 for(const [name,output]of Object.entries(outputs)){const childKey=randomUUID();set('assistant/'+name,output);Object.assign(phases['assistant/'+name],{key:childKey,input:{parentKey:key,parentInputSha256:digest(input),deadlineAtMs:f.now+300000,priorResultsSha256:digest(prior)}});phases['assistant/'+name].current.externalId=childKey;prior[name]=output;}
 const proof=verifySavedAssistantReply(evidence,{input,session,conversation,submission,expectedReply:command.text,originalOperationId:command.id});
 set('assistant',{format:1,kind:'nova-delivery-saved-assistant-reply',operationId:id,key,inputSha256:digest(input),originalDeadlineAtMs:f.now+300000,...proof});
 Object.assign(phases.assistant,{key,input,inputSha256:digest(input),createdAtMs:f.now});phases.assistant.current.externalId=id;
 return{descriptor,phases,repositories,journal:{loadDelivery:()=>({descriptor}),deliveryPhase:(_id,name)=>phases[name]},set};
}
