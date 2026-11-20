import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
import {browserBinding} from '../scripts/release-delivery-browser.mjs';
import {retainedWindowPolicy,verifyRetainedWindowPolicy} from '../scripts/release-delivery-browser-primitives.mjs';
import {createDeliveryRegistry} from '../scripts/release-delivery-adapters.mjs';

function fixture(t, version='2.28.46', buildVersion='1.0.419') {
  const dir=mkdtempSync(join(tmpdir(),'ordinary-browser-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const save=(name,object)=>{
    const raw=JSON.stringify(object),path=join(dir,name+'.json');
    writeFileSync(path,raw);return {path,sha256:sha256(raw)};
  };
  const id=randomUUID(),epoch=randomUUID(),oldId=sha256('prior'),nextId=sha256('target');
  const app=(candidateId,version,buildVersion)=>({candidateId,version,buildVersion});
  const old=app(oldId,'2.28.39','1.0.412'),next=app(nextId,version,buildVersion);
  const doc=a=>({...a,frontendId:a.candidateId,assets:`/__bundled/${a.candidateId}/`});
  const checks=['one-prior-document-and-unsent-draft','old-document-retained','old-client-fence','new-document-identity',
    'retained-draft-after-refresh','ui-behavior','owned-draft-cleaned'];
  const source={classificationComplete:true,unclassifiedRootCount:0,entryCount:5,inventorySha256:sha256('source'),
    metadataSha256:sha256('metadata'),projectionSha256:sha256('projection')};
  const units={browser:'private-browser',server:'private-server'};
  const plan={format:1,kind:'isolated-two-page-browser-memory-plan',fixtureId:id,inputSha256:sha256('fixture'),
    productionEffect:false,modelRequestsAllowed:false,source,apps:{prior:old,target:next},units};
  const item=(value)=>({fixtureId:id,...value});
  const files={'browser-done':item({accepted:false,sentModelRequests:0,memoryQualificationPassed:true,cgroup:'/system.slice/private-browser.service',checks}),
    'server-done':item({closed:true,cgroup:'/system.slice/private-server.service'}),'prior-ready':item({candidateId:oldId,epoch}),
    'target-ready':item({candidateId:nextId,epoch,atMs:12}),'switch':item({priorCandidateId:oldId,targetCandidateId:nextId,atMs:11}),
    'documents-prior-draft':item({documents:[doc(old)],draftRetained:true,atMs:10}),'motion-prior-first':item({reduced:true})};
  for(const [name,documents,atMs] of [['documents-new-page-ready',[doc(old),doc(next)],13],['documents-old-page-reloaded',[doc(next),doc(next)],14]])
    files[name]=item({documents,distinctPages:true,reducedMotion:[false,false],draftRetained:true,atMs});
  for(const name of checks)files['check-'+name]=item({name});
  for(const milestone of ['prior-draft-ready','new-page-ready','old-page-reloaded','browser-closed'])
    files['memory-'+milestone]=item({operationId:id,milestone,maxBytes:2**31,peakBytes:2**30,events:'oom 0\noom_kill 0'});
  const closed={ActiveState:'inactive',SubState:'dead',MainPID:'0',Result:'success',ExecMainStatus:'0'};
  const terminal={fixtureId:id,files,sourceAfterClosure:source,runHash:plan.inputSha256,originalOwnerPidsClosed:true,
    units:{browser:{...closed},server:{...closed}}};
  const review={format:1,kind:'retained-browser-window-qualification-review',status:'passed',independentReview:true,
    policy:retainedWindowPolicy,priorCandidateId:oldId,targetCandidateId:nextId};
  const tool=save('tool',{}),transport=save('transport',{format:1,hostAlias:'fixture',sshConfig:tool});
  const browserTools={format:1,mode:'remote',node:tool,executable:tool,playwright:tool,baseUrl:'http://127.0.0.1:4383',
    timeoutMs:300000,suite:'tasks-search-focus',user:'nova',directoryRoot:'/opt/nova-browser-data'};
  const base={directory:dir,candidateId:oldId,manifest:save('manifest',old)};
  const target={format:1,browserCapability:'available',browserTools,transport,bases:{private:base,public:base}};
  const prior={route:{route:'full',targetCandidateId:nextId},sign:{candidateId:nextId,priorCandidateId:oldId}};
  const descriptor={operation:{id:randomUUID(),workspaceEpoch:randomUUID(),priorCandidateId:oldId,candidateId:null,version:next.version,buildVersion:next.buildVersion}};
  function freeze(){
    review.plan=save('plan',plan);review.terminal=save('terminal',terminal);
    target.browserWindowQualification=save('review',review);descriptor.target=save('target',target);
  }
  const bind=()=>browserBinding({descriptor,prior},target.browserTools,transport);
  freeze();return {descriptor,prior,target,plan,terminal,review,save,freeze,bind};
}

test('normal package admission and signed browser consume one exact candidate-bound private review',async t=>{
  const f=fixture(t),registry=createDeliveryRegistry();
  const result=await registry.phasePreflight('package',f.descriptor,f.prior);
  assert.ok(result.includes('qualified-dependency-worker-transport-not-integrated')); // minimal test target has no packer
  const binding=f.bind();assert.equal(binding.windowPolicy.kind,retainedWindowPolicy);
  assert.equal(binding.windowPolicy.qualification.reviewSha256,f.target.browserWindowQualification.sha256);
  assert.equal(verifyRetainedWindowPolicy(binding.windowPolicy,binding),true);
  delete f.target.browserWindowQualification;f.descriptor.target=f.save('target',f.target);
  await assert.rejects(registry.phasePreflight('package',f.descriptor,f.prior),/ordinary-window-qualification-required/);
  assert.throws(f.bind,/ordinary-window-qualification-required/);
  f.descriptor.operation.version='2.28.45';f.descriptor.operation.buildVersion='1.0.418';
  assert.equal(f.bind().windowPolicy,undefined);
});

for (const [version, build, previousVersion, previousBuild] of [
  ['2.28.47', '1.0.420', '2.28.46', '1.0.419'],
  ['2.28.48', '1.0.421', '2.28.47', '1.0.420']
]) {
  test(`recovery update ${version} requires its own measured Tasks window and exact build`, t => {
    const f = fixture(t, version, build);
    const binding = f.bind();
    assert.equal(verifyRetainedWindowPolicy(binding.windowPolicy, binding), true);
    f.descriptor.operation.buildVersion = previousBuild;
    assert.throws(f.bind, /ordinary-window-qualification-required/);
    f.descriptor.operation.buildVersion = build;
    f.plan.apps.target.version = previousVersion;
    f.plan.apps.target.buildVersion = previousBuild;
    f.freeze();
    assert.throws(f.bind, /browser-qualification-plan-changed/);
  });
}

test('normal release rejects changed evidence, wrong candidates, bad geometry, over-budget workers and open units',t=>{
  const f=fixture(t);
  for(const [obj,key,value] of [[f.plan.apps.target,'version','2.28.45'],[f.review,'independentReview',false],
    [f.review,'targetCandidateId',sha256('other')],[f.terminal,'sourceAfterClosure',{}],
    [f.terminal.files['documents-new-page-ready'],'distinctPages',false],[f.terminal.files['documents-old-page-reloaded'],'draftRetained',false],
    [f.terminal.files['memory-browser-closed'],'peakBytes',2**31],[f.terminal.units.server,'MainPID','99']]){
    const original=obj[key];obj[key]=value;f.freeze();assert.throws(f.bind);obj[key]=original;
  }
  f.freeze();f.save('terminal',{});assert.throws(f.bind);
});
