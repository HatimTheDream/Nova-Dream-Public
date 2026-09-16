import test from 'node:test';
import assert from 'node:assert/strict';
import access from '../apps/desktop/companion-access.cjs';
const apps=[{name:'Calculator',bundleId:'com.apple.calculator',executable:'/System/Applications/Calculator.app/Contents/MacOS/Calculator'}];

test('access preferences require explicit scope and duration; no implicit full desktop or indefinite grant',()=>{
  for(const raw of [undefined,{}, {scope:'desktop'}, {scope:'desktop',duration:0}, {scope:'all',duration:'persistent'}])assert.throws(()=>access.selection(raw,apps));
  assert.throws(()=>access.selection({scope:'apps',duration:'persistent'},[]));
  assert.equal(access.active(0),false);assert.equal(access.active(undefined),false);assert.equal(access.active(null),true);
});
test('selected-app persistent access retains the application ceiling without rolling timed grants',()=>{
  const persistent=access.launchPolicy(access.selection({scope:'apps',duration:'persistent'},apps));
  assert.equal(persistent.mode,'standard');assert.match(persistent.manifest,/com\.apple\.calculator/);
  assert.match(persistent.manifest,/display: false/);assert.doesNotMatch(persistent.manifest,/expires_after|idle_timeout/);
  assert.ok(!persistent.tools.includes('get_desktop_state'));
  const timed=access.launchPolicy(access.selection({scope:'apps',duration:15},apps));
  assert.equal(timed.mode,'bounded');assert.match(timed.manifest,/expires_after: 15m\nidle_timeout: 15m/);
});
test('full desktop uses normal driver policy and the remote interface remains a fixed GUI tool set',()=>{
  const grant=access.selection({scope:'desktop',duration:'persistent'},apps),policy=access.launchPolicy(grant);
  assert.deepEqual(grant.apps,[]);assert.equal(policy.mode,'standard');assert.equal(policy.manifest,undefined);
  assert.ok(policy.tools.includes('get_desktop_state'));assert.ok(policy.tools.includes('type_text'));assert.ok(policy.tools.includes('scroll'));
  assert.ok(!policy.tools.includes('shell_execute'));assert.ok(!policy.tools.includes('set_config'));
});
test('remembered access is bound to the exact workspace, device and epoch; timed grants are never restored',()=>{
  const connection={deviceId:'device-one',epoch:'epoch-one'},origin='https://nova.example';
  const grant={...access.selection({scope:'apps',duration:'persistent'},apps),...connection,origin};
  const config={connection,origin,access:grant};assert.equal(access.remembered(config).scope,'apps');
  for(const changed of [{origin:'https://other.example'},{connection:{...connection,deviceId:'other'}},{connection:{...connection,epoch:'other'}},{connection:null},{access:{...grant,duration:15}},{access:{...grant,apps:[{...apps[0],executable:'relative'}]}}])assert.equal(access.remembered({...config,...changed}),null);
});
