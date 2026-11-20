import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sha256} from '../scripts/release-plan.mjs';
import {fullHostIdentity,fullHostOptionsSchema,fullFactsSpec,verifyFullFacts,verifyFullCompletion,verifyFullPremaintenance,collectFullOnlineCapacity,createFullCapacityAdapter,buildFullHostProgram,FULL_HELPERS,FULL_APPLICATION_HELPERS,FULL_SAME_SCHEMA60_HELPERS,fullHelpersForQualification,fullHelpersForBinding} from '../scripts/release-delivery-full-host.mjs';
import {fullHostFixture} from '../support/full-host-fixture.mjs';
const copy=v=>structuredClone(v);
const {facts,values,completed,key,options,descriptor}=fullHostFixture();
test('original phase gives stable distinct lease and worker identities',()=>{
  assert.equal(fullHostIdentity(key,'lease'),fullHostIdentity(key,'lease'));assert.notEqual(fullHostIdentity(key,'lease'),fullHostIdentity(key,'plan'));
  assert.notEqual(fullHostIdentity(key,'execute'),fullHostIdentity('1a4ddd43-464a-4285-90d4-f2b626fc3046','execute'));
  assert.throws(()=>fullHostIdentity(key,'new-attempt'));assert.throws(()=>fullHostIdentity('arbitrary','lease'));
});
test('host authority is strict and new runtime or helper qualification cannot be asserted',()=>{
  assert.deepEqual(fullHostOptionsSchema.parse(options),options);
  assert.throws(()=>fullHostOptionsSchema.parse({...options,stageParent:'/tmp'}));
  assert.throws(()=>fullHostOptionsSchema.parse({...options,hostConfiguration:{...options.hostConfiguration,path:'/etc/nova-update/../other'}}));
  assert.throws(()=>fullHostOptionsSchema.parse({...options,rehearsalPassed:true}));
  assert.throws(()=>fullFactsSpec({...descriptor,operation:{...descriptor.operation,agentVersion:'2026.10.1'}},options,key),/unsupported-runtime-transition/);
  assert.throws(()=>fullFactsSpec({...descriptor,operation:{...descriptor.operation,changeClass:'updater'}},options,key),/recovery-qualification/);
});
test('runtime sources or prior-runtime rehearsal cannot admit target startup or dispatch host work',async()=>{
  const changed={...descriptor,operation:{...descriptor.operation,priorAgentVersion:'2026.9.6'}};
  const runtime={qualification:{passed:true,actualSettledQualification:true},syntheticNative:{passed:true}};
  const gap=/actual-settled-runtime-qualification-producer-required/;
  assert.throws(()=>fullFactsSpec(changed,options,key),gap);
  const signed={route:'full',priorCandidateId:changed.operation.priorCandidateId,candidateId:'b'.repeat(64),runtime};
  changed.operation.candidateId=signed.candidateId;
  assert.throws(()=>verifyFullPremaintenance({signed,capacity:{targetCandidateId:signed.candidateId}},changed),gap);
  let effects=0;const run=async()=>{effects++;throw Error('No host calls permitted');};
  const context={descriptor:changed,prior:{sign:signed,route:{route:'full'},recovery:{kind:'nova-delivery-full-rehearsal',completion:completed,values}}};
  await assert.rejects(collectFullOnlineCapacity(context,{options,run}),gap);
  await assert.rejects(createFullCapacityAdapter({options,run}).input(context),gap);
  assert.equal(effects,0);
});
test('historical closed lease remains distinct from actual accepted running base',()=>{
  const spec=fullFactsSpec(descriptor,options,key),v=copy(facts);v.base=spec.base;v.review.leaseId=spec.leaseId;
  v.health={status:'ready',candidateId:spec.base.candidateId,version:spec.base.priorVersion};v.accessContext={workspaceEpoch:spec.workspaceEpoch};
  assert.equal(verifyFullFacts(v,spec,v.observedAtMilliseconds).candidateId,spec.base.candidateId);
  assert.throws(()=>verifyFullFacts(v,spec,v.observedAtMilliseconds+900001),/expired/);
  assert.throws(()=>verifyFullFacts(v,spec,v.observedAtMilliseconds-1),/expired/,'future facts require genuine catch-up before synchronous admission');
  const bad=copy(v);bad.protectedHashes[options.acceptedInstallation.path]='0'.repeat(64);assert.throws(()=>verifyFullFacts(bad,spec,v.observedAtMilliseconds),/binding/);
  const held=copy(v);held.operatorStatus.held=true;assert.throws(()=>verifyFullFacts(held,spec,v.observedAtMilliseconds),/idle/);
});
test('synthetic completed rehearsal validates only with its exact original bindings',()=>{
  const verified=verifyFullCompletion(completed,values);assert.ok(verified.proofRaw.length>0);assert.deepEqual(JSON.parse(verified.proofRaw),completed.completedProof.proof);
});
test('completed receipt cannot change lease, helper, native return, or finite worker profile',()=>{
  for(const change of [v=>v.unit.TimeoutStartUSec='infinity',v=>v.unit.Restart='on-failure',v=>v.operator.id=key,
    v=>v.completedProof.originalReturned=false,v=>v.helperHashes['install.py']='0'.repeat(64),v=>v.socketStatus.held=true]){
    const bad=copy(completed);change(bad);assert.throws(()=>verifyFullCompletion(bad,values));
  }
  assert.throws(()=>verifyFullCompletion(completed,{...values,executionUnit:'different.service'}));
});
test('changed raw saved-work proof and unsupported programs fail closed',()=>{
  const bad=copy(completed);bad.proofRawBase64=Buffer.from('{}').toString('base64');assert.throws(()=>verifyFullCompletion(bad,values),/raw-proof/);
  assert.throws(()=>buildFullHostProgram('arbitrary.py',{}),/fixed-program/);
  const program=buildFullHostProgram('collect-facts.py',fullFactsSpec(descriptor,options,key));
  assert.ok(program.includes('hashlib.sha256(s).hexdigest()'));assert.ok(program.includes('signal.alarm(110)'));
  assert.ok(program.indexOf('hashlib.sha256(s).hexdigest()')<program.indexOf('exec(compile'));
  assert.equal(Object.keys(FULL_HELPERS).length,7);
});

test('same schema60 facts use the distinct reviewed closure and bind the current review marker',()=>{
 const marker={format:1,kind:'schema-60-same-runtime',schemaVersion:60,apiVersion:1,agentVersion:'2026.9.8'};
 const spec=fullFactsSpec(descriptor,options,key,null,marker),v=copy(facts);
 assert.deepEqual(spec.sameSchemaQualification,marker);assert.equal(Object.hasOwn(spec,'applicationTransition'),false);
 assert.deepEqual(spec.helperHashes,FULL_SAME_SCHEMA60_HELPERS);assert.notDeepEqual(spec.helperHashes,FULL_APPLICATION_HELPERS);
 v.base=spec.base;v.review.leaseId=spec.leaseId;v.review.helperHashes=copy(spec.helperHashes);v.review.sameSchemaQualification=marker;
 assert.equal(verifyFullFacts(v,spec,v.observedAtMilliseconds).candidateId,spec.base.candidateId);
 for(const change of [x=>delete x.review.sameSchemaQualification,x=>x.review.sameSchemaQualification={...marker,schemaVersion:55},
  x=>x.review.applicationTransition={},x=>x.review.helperHashes=copy(FULL_APPLICATION_HELPERS),x=>x.operatorStatus.held=true]){
  const bad=copy(v);change(bad);assert.throws(()=>verifyFullFacts(bad,spec,v.observedAtMilliseconds));
 }
 for(const bad of [{...marker,apiVersion:2},{...marker,agentVersion:'2026.9.9'},{...marker,passed:true}])assert.throws(()=>fullHelpersForQualification(bad));
 assert.deepEqual(fullHelpersForQualification(),FULL_HELPERS);
});

test('metadata stage generated same schema60 packet reaches the exact Python admission and capacity boundary',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-metadata-family-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'delivery-evidence'));
 const put=(name,bytes)=>{const path=join(root,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
 const ssh=put('ssh-config',Buffer.from('Host test\n')),transport=put('transport.json',Buffer.from(JSON.stringify({format:1,hostAlias:'test',sshConfig:ssh})));
 const f=fullHostFixture(),now=Date.now(),marker={format:1,kind:'schema-60-same-runtime',schemaVersion:60,apiVersion:1,agentVersion:'2026.9.8'};
 const helpers=Object.fromEntries(Object.keys(FULL_SAME_SCHEMA60_HELPERS).map(name=>[name,sha256(readFileSync(new URL('../deploy/update-runner/'+name,import.meta.url)))]));
 const binding={sameSchemaQualification:marker,helpers};
 assert.deepEqual(fullHelpersForBinding(binding),helpers);
 assert.throws(()=>fullHelpersForBinding({sameSchemaQualification:marker}),/bound-helpers-required/);
 assert.throws(()=>fullHelpersForBinding({...binding,helpers:{...helpers,'recovery.py':'0'.repeat(64)}}),/helper-qualification-capability-required/);
 const spec=fullFactsSpec(f.descriptor,f.options,f.key,null,marker,helpers),facts=copy(f.facts);
 facts.observedAtMilliseconds=now;facts.base=spec.base;facts.review.leaseId=spec.leaseId;facts.review.helperHashes=copy(spec.helperHashes);facts.review.sameSchemaQualification=marker;
 const input={options:f.options,sourceCommit:f.descriptor.sources.private.commit,helperHashes:copy(spec.helperHashes),
  signed:{startupQualification:{binding}},
  artifacts:{private:{frozenSourceDirectory:fileURLToPath(new URL('../',import.meta.url))}}};
 let generated=null,calls=0,effects=0;
 const decode=program=>{const encoded=program.match(/v=json.loads\(base64.b64decode\('([^']+)'/)[1];const value=JSON.parse(Buffer.from(encoded,'base64'));assert.equal(sha256(Buffer.from(value.source,'base64')),value.sha256);return value;};
 const adapter=createFullCapacityAdapter({transport,options:f.options,clock:()=>now,
  storeReceipt:(_journal,key,name,bytes)=>put('delivery-evidence/'+key+'-'+name,bytes),
  run:async(_transport,program)=>{calls++;const value=decode(program);if(value.data.packet){generated=value;throw Error('captured-metadata-boundary');}
   assert.deepEqual(value.data,spec);return{stdout:JSON.stringify(facts),stderr:'',exitCode:0,uncertain:false};}});
 await assert.rejects(adapter.execute({descriptor:f.descriptor,intent:{key:f.key,input},journal:{directory:root},beforeNewEffect:async()=>{effects++;throw Error('Host effects forbidden');}}),/captured-metadata-boundary/);
 assert.equal(calls,2);assert.equal(effects,0);assert.equal(generated.data.mode,'plan');
 assert.deepEqual(generated.data.packet.facts.review.sameSchemaQualification,marker);
 assert.deepEqual(generated.data.packet.facts.review.helperHashes,helpers);
 assert.equal(Object.keys(generated.data.files).length,12);
 const checker=String.raw`import ast,base64,hashlib,json,pathlib,re,sys
v=json.loads(sys.stdin.read());source=base64.b64decode(v['source'],validate=True)
assert hashlib.sha256(source).hexdigest()==v['sha256']
functions={'need','sha','enc','helper_family','checked_payload','metadata_capacity'}
assignments={'FROZEN_HELPERS','FROZEN_APPLICATION_HELPERS','FROZEN_SAME_SCHEMA60_FAMILIES'}
nodes=[n for n in ast.parse(source).body if (isinstance(n,ast.FunctionDef) and n.name in functions) or (isinstance(n,ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name) and n.targets[0].id in assignments)]
s={'ast':ast,'base64':base64,'hashlib':hashlib,'json':json,'re':re,'P':pathlib.PurePosixPath}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'actual-generated-admission','exec'),s)
try:
 payload=s['checked_payload'](v['data']);capacity=s['metadata_capacity'](payload,4096,2**40)
 print(json.dumps({'passed':True,'helpers':len(payload)-1,'capacity':capacity}))
except RuntimeError as error:
 print(json.dumps({'passed':False,'reason':str(error)}))
`;
 const check=value=>{const checked=spawnSync(process.env.NOVA_TEST_PYTHON??(process.platform==='win32'?'python':'python3'),['-I','-B','-c',checker],
  {input:JSON.stringify(value),encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:1024**2});
  assert.ifError(checked.error);assert.equal(checked.status,0,checked.stderr);assert.equal(checked.stderr,'');return JSON.parse(checked.stdout);};
 const good=check(generated);assert.equal(good.passed,true);assert.equal(good.helpers,11);assert.equal(good.capacity.operatingFloorBytes,1879048192);
 assert.equal(good.capacity.fullRehearsalCapacityAdmitted,false);assert.equal(good.capacity.fullMaintainedPlanStillRequired,true);
 const enc=value=>Buffer.from(JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)+'\n');
 for(const mutate of [r=>delete r.sameSchemaQualification,r=>r.helperHashes=copy(FULL_APPLICATION_HELPERS),r=>r.helperHashes['recovery.py']='0'.repeat(64),
  ...(!isDeepStrictEqual(helpers,FULL_SAME_SCHEMA60_HELPERS)?[r=>r.helperHashes=copy(FULL_SAME_SCHEMA60_HELPERS)]:[]),r=>r.sameSchemaQualification={...marker,schemaVersion:55},
  r=>r.applicationTransition={format:1,kind:'schema-55-to-60-same-runtime',fromSchemaVersion:55,toSchemaVersion:60,apiVersion:1,fromAgentVersion:'2026.9.8',toAgentVersion:'2026.9.8'}]){
  const bad=copy(generated.data),review=bad.packet.facts.review;mutate(review);const raw=enc(review);
  bad.files['operator-review.json']=raw.toString('base64');Object.assign(bad.packet.files['operator-review.json'],{sha256:sha256(raw),bytes:raw.length});
  bad.packetSha256=sha256(enc(bad.packet));const rejected=check(decode(buildFullHostProgram('metadata-stage.py',bad)));
  assert.equal(rejected.passed,false);assert.match(rejected.reason,/helper-(family|qualification-marker)/);
 }
});
