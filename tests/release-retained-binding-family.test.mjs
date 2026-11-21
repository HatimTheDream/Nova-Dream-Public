import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
  PARKED_CAPTURE_STARTUP_HELPERS as previousHelpers,
  PARKED_CAPTURE_STARTUP_SOURCES as previousSources,
  RETAINED_BINDINGS_STARTUP_HELPERS as currentHelpers,
  RETAINED_BINDINGS_STARTUP_SOURCES as currentSources,
  RETAINED_WINDOW_STARTUP_SOURCES as windowSources,
  COMPLETE_CAPTURE_STARTUP_HELPERS, buildStartupRetainedProgram,
  reviewedSameSchemaHelperFamilies, reviewedStartupSources, startupRetainedRequest,
} from '../scripts/release-delivery-startup-retained.mjs';

test('the retained bindings qualifier and its predecessor have separately registered sources and helpers',()=>{
  const changed=(before,after)=>Object.keys(before).filter(key=>before[key]!==after[key]).sort();
  assert.deepEqual(changed(previousSources,currentSources),['produce-startup-inputs.py','qualified-startup.py']);
  assert.deepEqual(changed(currentSources,windowSources),['produce-startup-inputs.py','qualified-startup.py']);
  assert.deepEqual(changed(previousHelpers,currentHelpers),['hosted_retained_configuration.py','install.py','operator_rehearsal.py']);
  for(const [name,hash] of Object.entries(currentHelpers)){
    const bytes=readFileSync(new URL('../deploy/update-runner/'+name,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,name);
  }
  const registered=reviewedSameSchemaHelperFamilies();
  for(const [sources,helpers,opposite] of [[previousSources,previousHelpers,currentSources],[currentSources,currentHelpers,previousSources],[windowSources,currentHelpers,currentSources]]){
    const producer={path:'/fixture/sources/qualified-startup.py',sha256:sources['qualified-startup.py']};
    const options={format:1,producer,parent:{path:'/fixture/evidence/parent-verified.json',sha256:'1'.repeat(64)}};
    assert.equal(reviewedStartupSources(producer),sources);
    assert.ok(registered.includes(helpers));
    assert.throws(()=>startupRetainedRequest(options),/parked-original-warm-evidence-required/);
    const crossed={...sources,'produce-startup-inputs.py':opposite['produce-startup-inputs.py']};
    assert.throws(()=>startupRetainedRequest(options,crossed),/parked-startup-source-family-changed/);
  }
});

test('parked collector binds the original and continued donor independently of the current release',()=>{
  const id='11111111-1111-4111-8111-111111111111', hash='1'.repeat(64);
  const ref={path:'/fixture/proof.json',sha256:hash};
  const warmAntecedent={format:2,kind:'verified-supplemental-warm-antecedent',operationId:id,
    continuationOperationId:id,jobId:id,epoch:id,originalInvocation:'a'.repeat(32),successorInvocation:'b'.repeat(32),
    priorCandidateId:hash,baselineSha256:hash,nativeOutputSha256:hash,projectionSha256:hash,
    consumptionSha256:hash,independentReviewSha256:hash};
  for(const role of ['parent','producer','warmSource','disposableRoles','seedReplicas','chain','outsideClosure',
    'originalFailedStderr','protectedCustody','terminal'])warmAntecedent[role]=ref;
  for(const [family,formal] of [[previousSources,previousHelpers],[currentSources,currentHelpers],[windowSources,currentHelpers]]){
    const request={format:1,kind:'collect-actual-retained-startup-proof',warmAntecedent,
      parent:{path:'/fixture/evidence/parent-verified.json',sha256:hash},
      producer:{path:'/fixture/qualified-startup.py',sha256:family['qualified-startup.py']}};
    const program=buildStartupRetainedProgram(request);
    const payload=JSON.parse(Buffer.from(/v=json.loads\(base64.b64decode\('([^']+)'/.exec(program)[1],'base64'));
    assert.deepEqual(payload.donorHelpers,{original:COMPLETE_CAPTURE_STARTUP_HELPERS,effective:previousHelpers});
    assert.deepEqual(payload.sameSchemaHelpers,formal);
    assert.throws(()=>buildStartupRetainedProgram({...request,donorHelpers:payload.donorHelpers}),/parked-request-original-paths/);
  }
});
