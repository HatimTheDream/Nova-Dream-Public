import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { dependencyFixture } from '../support/dependency-transport-fixture.mjs';
import { withVerificationPass } from '../scripts/release-verification-pass.mjs';

test('actual maintained transport reads selected bundle once per check, shared across thirty-five validations', async t=>{
  const f=dependencyFixture(t,{format:2}),original=fs.openSync;
  let opens=0;
  fs.openSync=function(path,...args){if(typeof path==='string'&&resolve(path)===resolve(f.options.selectedBundle.path))opens++;return original.call(this,path,...args);};
  syncBuiltinESMExports();
  try{
    // One check reads this same input in two independently maintained roles.
    await f.transport.validate(f.context);const perCheck=opens;assert.equal(perCheck,2);
    opens=0;
    await withVerificationPass(f.context,async c=>{for(let i=0;i<35;i++)await f.transport.validate(c);});
    assert.equal(opens,perCheck);
    t.diagnostic(JSON.stringify({transportValidations:35,selectedBundleReads:opens,withoutScopeExpected:35*perCheck}));
    await withVerificationPass(f.context,async c=>f.transport.validate(c));assert.equal(opens,2*perCheck);
    opens=0;
    await withVerificationPass(f.context,async c=>{
      await f.transport.validate(c);
      await f.transport.validate({...c,journal:{directory:f.root+'-other'}});
    });
    assert.equal(opens,2*perCheck,'another journal path must perform its own verification');
    fs.writeFileSync(f.options.selectedBundle.path,'corrupt');
    await assert.rejects(withVerificationPass(f.context,async c=>f.transport.validate(c)),/hash|changed/i);
    assert.equal(f.calls.length,0);
  }finally{fs.openSync=original;syncBuiltinESMExports();}
});
