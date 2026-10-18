/** Synthetic portable source admission only. No real release/native evidence. */
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ReleaseJournal} from '../scripts/release-coordinate.mjs';
import {sha256} from '../scripts/release-plan.mjs';
import {verifyCandidate} from '../scripts/candidate.mjs';
import {createDependencyPairProducer} from '../scripts/release-delivery-dependencies.mjs';
import {createMaintainedDependencyTransport} from '../scripts/release-delivery-dependency-transport.mjs';
export const raw=value=>Buffer.from(JSON.stringify(value)+'\n');
const reference=path=>({path,sha256:sha256(readFileSync(path))});
const schema=readFileSync(new URL('../scripts/release-coordinate.mjs',import.meta.url),'utf8').match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}',String(0x4e56524c));
const startup=['gateway.js','http.js','runtime.js','software-updates.js','store.js','update-maintenance.js','update-native-idle.js','update-native-startup.js'].map(x=>'dist/service/apps/service/'+x);
const helpers=['install.py','recovery.py','codex_log_retention.py','app_dependencies.py','workspace_key.py','verify-session-bindings.mjs'];
export function dependencyFixture(t,{format=1,change,runHook,includeHost=false}={}){
 const root=mkdtempSync(join(tmpdir(),'nova-dependency-portable-')),journal=Object.create(ReleaseJournal.prototype);journal.directory=root;journal.readOnly=false;journal.db=new DatabaseSync(join(root,'journal.sqlite'));journal.db.exec(schema);
 t.after(()=>{journal.close();if(dirname(root)!==resolve(tmpdir()))throw Error('fixture-cleanup-scope');rmSync(root,{recursive:true,force:true});});
 const put=(path,bytes)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.isBuffer(bytes)?bytes:raw(bytes));return reference(path);};
 const parser=readFileSync(new URL('../deploy/update-runner/app_dependencies.py',import.meta.url)),helperBytes=Object.fromEntries(helpers.map(n=>[n,n==='app_dependencies.py'?parser:Buffer.from('# synthetic helper '+n+'\n')]));
 const candidate=(side,base=false)=>{
  const directory=join(root,side+(base?'-base':'-target')),commit=(side==='private'?'a':'b').repeat(40);
  const pkg={name:'nova-dream-edition-3',type:'module',version:base?'2.3.5':'2.4.0',edition3:{buildVersion:base?'1.0.292':'1.0.293',schemaVersion:!base&&change==='schema'?56:55,apiVersion:1,appId:'fixture.nova'},dependencies:{fixture:'1.0.0'},engines:{node:'>=22.19.0'},scripts:{build:'node build.mjs',postinstall:'node prepare.mjs',...(!base&&[2,4].includes(format)?{'release:deliver':'node scripts/release-deliver.mjs'}:{})}};
  if(format===4)Object.assign(pkg.scripts,{test:'tsx --test --test-concurrency=2 tests/*.test.ts tests/*.test.mjs',quality:base?'npm run typecheck && npm test && npm run security:audit && npm run validate:release && npm run build':'node scripts/quality.mjs',...(!base?{'test:quality':'tsx --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs'}:{})});
  const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies},'node_modules/fixture':{version:'1.0.0'}}};
  put(join(directory,'package.json'),pkg);const lockRef=put(join(directory,'package-lock.json'),lock);
  const files={'dist/client/index.html':Buffer.from('<html/>'),'dist/service/apps/service/main.js':Buffer.from(base?'oldBackend()':'newBackend()'),...Object.fromEntries(startup.map(n=>[n,Buffer.from(!base&&change==='startup'&&n===startup[0]?'changed startup':'unchanged '+n)]))};
  const plugin='dist/service/apps/service/worker-plugin/';for(const n of ['index.js','identity.js','journal.js'])files[plugin+n]=Buffer.from('export {};');
  files[plugin+'openclaw.plugin.json']=raw({id:'edition3-worker'});files[plugin+'package.json']=raw({openclaw:{extensions:['./index.js']}});
  for(const n of ['dist/service/apps/service/assignments.js','dist/service/apps/service/runtime-child.js','dist/service/packages/domain/worker.js'])files[n]=Buffer.from('export {};');
  const manifest=put(join(directory,'dist/candidate.json'),{version:pkg.version,...pkg.edition3,artifacts:Object.entries(files).map(([path,b])=>({path,sha256:put(join(directory,path),b).sha256})),frontendCompatibility:{format:2,eligibility:'client-behavior',sourceRevision:commit,serviceInputsSha256:(base?'c':'d').repeat(64)}});
  const verified=verifyCandidate(directory),archive=put(join(root,side+(base?'-base':'')+'.tgz'),Buffer.from('synthetic application archive '+side+(base?' base':''))),repository='fixture/'+side;
  const metadata={candidateId:verified.id,archiveSha256:archive.sha256},frozenSourceDirectory=join(directory,'frozen-source'),sourceHashes={};
  for(const [n,b]of Object.entries(helperBytes))sourceHashes['deploy/update-runner/'+n]=put(join(frozenSourceDirectory,'deploy/update-runner',n),b);
  if(includeHost){const host=Buffer.from('// synthetic host.mjs');sourceHashes['scripts/host.mjs']=put(join(frozenSourceDirectory,'scripts/host.mjs'),host);put(join(directory,'scripts/host.mjs'),host);}
  if(!base&&[2,4].includes(format))sourceHashes['scripts/release-deliver.mjs']=put(join(frozenSourceDirectory,'scripts/release-deliver.mjs'),readFileSync(new URL('../scripts/release-deliver.mjs',import.meta.url)));
  if(!base&&format===4)sourceHashes['scripts/quality.mjs']=put(join(frozenSourceDirectory,'scripts/quality.mjs'),readFileSync(new URL('../scripts/quality.mjs',import.meta.url)));
  return{directory,applicationDirectory:directory,candidateId:verified.id,manifest,sourceCommit:commit,repository,archive,metadata:put(join(directory,'metadata.json'),metadata),ciSourceReceipt:put(join(directory,'ci.json'),{sourceCommit:commit,repository,application:{...metadata,packageLockSha256:lockRef.sha256}}),frozenSourceDirectory,sourceHashes,pkg,lock};
 };
 const artifacts={private:candidate('private'),public:candidate('public')},base=candidate('private',true),publicBase=candidate('public',true);
 const oldMetadata=put(join(root,'old-metadata.json'),{format:1,dependencyGraphSha256:sha256('synthetic graph'),platform:'linux',arch:'x64',nodeVersion:'22.23.2',nodeAbi:127,packageLockSha256:reference(join(base.directory,'package-lock.json')).sha256});
 const pair={format:1,candidateId:base.candidateId,priorCandidateId:'e'.repeat(64),archiveSha256:base.archive.sha256,archiveBytes:readFileSync(base.archive.path).length,helpers:Object.fromEntries(helpers.filter(n=>n!=='install.py').map(n=>[n,sha256(helperBytes[n])])),applicationDependencies:JSON.parse(readFileSync(oldMetadata.path)),startupBarrier:{format:1,target:Object.fromEntries(startup.map(n=>[n,sha256(readFileSync(join(base.directory,n)))]))}};
 const selectedPair=put(join(root,'selected-pair.json'),pair),selectedInstaller=put(join(root,'selected-installer.json'),{format:1,outcome:'completed',candidateId:change==='selected-baseline'?'f'.repeat(64):base.candidateId,savedWorkVerified:true,accountsVerified:true,recoveryVerified:true,healthVerified:true});
 const selectedBundle=put(join(root,'selected-bundle.json'),{format:1,files:Object.entries({...helperBytes,'app.tgz':readFileSync(base.archive.path),'reviewed-pair.json':readFileSync(selectedPair.path)}).map(([name,b])=>({name,data:b.toString('base64'),sha256:sha256(b)}))});
 const helper=put(join(root,'app_dependencies.py'),parser),nativeInput=put(join(root,'native-input.json'),{format:1,kind:'metadata-only-dependency-successor',helper,oldMetadata,nativeReceipt:put(join(root,'synthetic-native.json'),{synthetic:true}),acceptedPair:selectedPair,acceptedInstaller:selectedInstaller,acceptedBundle:selectedBundle,acceptedCandidate:base.candidateId,transition:{fromVersion:'2.3.5',fromBuild:'1.0.292',toVersion:'2.4.0',toBuild:'1.0.293'}});
 const options={format,mode:'retained-native-metadata-successor',...([2,4].includes(format)?{metadataPolicy:format===4?'release-deliver-quality-script-v1':'release-deliver-script-v1'}:{}),python:put(join(root,'synthetic-python-not-executable'),Buffer.from('fixture; never execute')),helper,nativeInput,selectedPair,selectedInstaller,selectedBundle};
 const now=Date.now(),commits=Object.fromEntries(Object.entries(artifacts).map(([side,v])=>[side,v.sourceCommit])),descriptor={format:1,operation:{id:randomUUID(),stage:'draft',candidateId:null,publicCandidateId:null,priorCandidateId:base.candidateId,workspaceEpoch:randomUUID(),version:'2.4.0',buildVersion:'1.0.293',agentVersion:'2026.9.8',priorAgentVersion:'2026.9.8',sourceCommits:commits,bundleSha256:null,trustedPublicKeySha256:'a'.repeat(64),changeClass:'application',helperHashes:null},sources:Object.fromEntries(Object.entries(artifacts).map(([side,a])=>[side,{root:a.directory,repository:a.repository,commit:a.sourceCommit,baseCommit:'c'.repeat(40),branch:'main'}])),target:put(join(root,'target.json'),{fixtureOnly:true}),targetIdentity:'b'.repeat(64),adapterIdentity:'c'.repeat(64),observationBudgetMs:14400000,timeline:{startedAtMs:now,original:{id:randomUUID(),step:'total',issuedAtMs:now,remainingMs:[600000,1200000],confidence:'low',basis:'Synthetic portable test.',reason:'No actual release evidence.',nextCheckpointAtMs:now+300000},revisions:[],reviews:[],lastCheckpointAtMs:now}};
 journal.initializeDelivery(descriptor,now);const route={route:'full',baseCandidateId:base.candidateId,targetCandidateId:artifacts.private.candidateId,publicCandidateId:artifacts.public.candidateId},intent=journal.reserveDeliveryPhase(descriptor.operation.id,'package',{route,artifacts,options:{}},now).intent,calls=[];
 const storeReceipt=(j,key,name,bytes)=>{const path=join(j.directory,'delivery-evidence',key+'-'+name);if(existsSync(path)){if(!readFileSync(path).equals(bytes))throw Error('immutable-fixture-receipt-changed');return reference(path);}return put(path,bytes);};
 const run=async(...args)=>{calls.push(args);if(runHook)return runHook(...args);throw Error('Synthetic admission must not run a command');};
 const transport=createMaintainedDependencyTransport({options,base,storeReceipt,run}),context={journal,descriptor,intent,beforeNewEffect:async()=>{}};
 return{root,put,storeReceipt,journal,descriptor,intent,route,context,options,base,publicBase,artifacts,calls,transport,producer:createDependencyPairProducer({maintained:transport})};
}
