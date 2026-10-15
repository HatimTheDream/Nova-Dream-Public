// This isolated composition test mocks independently qualified host primitives;
// the real publication orchestrator, receipt storage and identity checks execute.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
let measured,staged;
const ledgerChecks=[];
mock.module('../scripts/release-coordinate.mjs',{namedExports:{validateJournalDirectory:(p,o)=>{assert.equal(o.create,false);assert.ok(p?.endsWith('target-publication-ledger'));ledgerChecks.push(p);return p;}}});
mock.module('../scripts/release-delivery-full-host.mjs',{namedExports:{verifyFullPremaintenanceArtifacts:input=>({bytes:Object.fromEntries([['bundle',input.signed.bundle],['dependencies',input.signed.dependencies.archive],['manifest',input.signed.signedFeed]].map(([role,ref])=>[role,readFileSync(ref.path).length]))}),verifyFullCompletion:()=>{},fullHostOptionsSchema:{parse:v=>v},collectFullOnlineCapacity:async()=>measured}});
mock.module('../scripts/release-delivery-install.mjs',{namedExports:{buildFullCoordinatorDescriptor:(c,v)=>({input:{operation:{id:c.descriptor.operation.id},evidence:{publication:v.evidence,capacity:v.capacityEvidence}}})}});
mock.module('../scripts/release-delivery-full-prestage.mjs',{namedExports:{advanceFullPrestage:async()=>staged,verifyFullProtectedAssets:()=>{}}});
const {createFullPublicationAdapter}=await import('../scripts/release-delivery-full-publication.mjs');

test('original publication continues after lost public commit without asset, stage, commit or push duplication',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-full-publish-resume-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(name,value)=>{const path=join(root,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return{path,sha256:sha(bytes)};};
 const id=randomUUID(),key=randomUUID(),sourceCommits={private:'a'.repeat(40),public:'b'.repeat(40)},tools=Object.fromEntries(['python','node','git'].map(n=>[n,put(n,Buffer.from('synthetic '+n))]));tools.gitExecPath=root;
 const descriptor={operation:{id,version:'8.1.0',buildVersion:'1.0.801',priorCandidateId:'c'.repeat(64),trustedPublicKeySha256:'d'.repeat(64),sourceCommits},sources:Object.fromEntries(['private','public'].map(side=>[side,{commit:sourceCommits[side],root:join(root,side),branch:'main'}]))};
 const bundle=put('bundle',Buffer.from('synthetic bundle')),archive=put('dependencies',Buffer.from('synthetic dependencies')),signedFeed=put('signed-feed',Buffer.from('synthetic signed feed independently qualified'));
 const sign={route:'full',bundle,dependencies:{archive},signedFeed,publicKey:put('publickey',Buffer.from('synthetic public key')),sequence:9};
 const prior={route:{route:'full'},sign,package:{bundle,dependencies:sign.dependencies},artifacts:{repositories:{private:{archive:put('app',Buffer.from('synthetic app'))}}},capacity:{},recovery:{kind:'nova-delivery-full-rehearsal',completion:{},values:{},evidence:{proof:put('proof',{}),review:put('review',{})}}};
 const options={host:{},publicationLedgerDirectory:join(root,'target-publication-ledger'),signing:{previousFeed:put('previous-feed',{})}},storeReceipt=(_j,k,n,raw)=>{const path=join(root,'delivery-evidence',k+'-'+n);mkdirSync(dirname(path),{recursive:true});if(existsSync(path))assert.deepEqual(readFileSync(path),raw);else writeFileSync(path,raw);return{path,sha256:sha(raw)};};
 const c={descriptor,prior,journal:{directory:root},beforeNewEffect:async()=>{}};
 measured={state:'completed',evidence:{observation:put('capacity',{})},recoveryEvidence:prior.recovery.evidence};staged={state:'completed',receipt:put('stage',{}),output:{fixtureOnly:true}};
 const calls=[],commits=new Map(),pushes=new Set();let lost=false;
 const command=async(_executable,args)=>{
  const program=args[1],action=args[2],request=JSON.parse(readFileSync(args[4]));calls.push({program,action,role:request.spec?.role,side:request.side,phase:request.phase});
  assert.equal(request.ledgerDirectory,options.publicationLedgerDirectory);
  if(program.endsWith('release-delivery-full-publication.py')){
   const spec=request.spec;assert.equal(action,'execute');const local=join(request.outputDirectory,'first','0-readback',spec.name);mkdirSync(dirname(local),{recursive:true});writeFileSync(local,readFileSync(spec.path));
   return JSON.stringify({state:'completed',externalId:'10:'+key,receipt:null,output:{operationId:id,key,inputSha256:c.intent.inputSha256,role:spec.role,asset:{name:spec.name,bytes:spec.bytes,sha256:spec.sha256,id:20,authenticatedDownloadVerified:true,localPath:local}}});
  }
  if(action==='readback')return JSON.stringify({state:'completed',output:{publicFeedReadVerified:true,publicFeedSha256:signedFeed.sha256,sequence:9}});
  const side=request.side,name='Nova-Dream'+(side==='public'?'-Public':''),commit={repository:name,sourceCommit:sourceCommits[side],feedParentCommit:sourceCommits[side],feedCommit:(side==='private'?'e':'f').repeat(40),changedOnly:(side==='private'?'edition3/':'')+'updates/stable.json',feedSha256:signedFeed.sha256,sequence:9,unrelatedIndexPreserved:true,pushed:false};
  let value;
  if(request.phase==='commit'){
   if(action==='execute'){assert.equal(commits.has(side),false);commits.set(side,commit);if(side==='public'&&!lost){lost=true;throw Error('lost commit response');}}
   else assert.equal(action,'observe');value=commits.get(side);assert.ok(value);
  }else{assert.equal(action,'execute');assert.equal(pushes.has(side),false);assert.deepEqual(request.commit,commits.get(side));pushes.add(side);value={...commit,pushed:true};}
  return JSON.stringify({state:'completed',externalId:name+':'+key+':'+request.phase,output:value,receipt:put('child-'+side+'-'+request.phase,value)});
 };
 const adapter=createFullPublicationAdapter({tools,releaseIds:{private:10,public:11},options,transport:put('transport',{}),base:{},command,storeReceipt,clock:()=>1000});
 c.input=await adapter.input(c);c.intent={key,input:c.input,inputSha256:sha(Buffer.from(JSON.stringify(c.input)))};await adapter.validate(c);
 assert.equal((await adapter.execute(c)).state,'uncertain');const before=calls.length,result=await adapter.observe(c);
 assert.equal(result.state,'completed');await adapter.verify(result,c);
 assert.deepEqual(calls.slice(before).map(x=>[x.side,x.phase,x.action]),[['public','commit','observe'],['public','push','execute'],[undefined,undefined,'readback']]);
 assert.equal(calls.filter(x=>x.role).length,4);assert.equal(commits.size,2);assert.equal(pushes.size,2);
 const complete=calls.length;assert.equal((await adapter.observe(c)).state,'completed');assert.equal(calls.length,complete);
 assert.ok(ledgerChecks.length>=calls.length);assert.equal(new Set(ledgerChecks).size,1);
 assert.equal(result.output.applicationInstalled,false);assert.equal(result.output.savedReplyAccepted,false);assert.equal(result.output.browserAccepted,false);
});
