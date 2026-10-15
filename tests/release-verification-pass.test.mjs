import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { withVerificationPass, verificationOnce, verificationEffect } from '../scripts/release-verification-pass.mjs';

test('one active read-only call tree reuses a check; separate calls and escaped contexts do not', async () => {
  let calls=0, escaped; const namespace={}, binding={operation:'original',hash:'a'};
  const read=c=>verificationOnce(c,namespace,binding,()=>++calls);
  await withVerificationPass({},async c=>{escaped=c;assert.equal(read(c),1);await withVerificationPass({...c},async child=>assert.equal(read(child),1));});
  assert.equal(read(escaped),2);
  await withVerificationPass({},async c=>assert.equal(read(c),3));
});

test('effect boundaries force fresh reads, suspend nested reuse and invalidate after a lost response', async () => {
  let calls=0;const namespace={},read=c=>verificationOnce(c,namespace,{},()=>++calls);
  await withVerificationPass({},async c=>{
    assert.equal(read(c),1);assert.equal(read(c),1);
    await assert.rejects(verificationEffect(c,async effect=>{
      assert.equal(read(effect),2);
      await withVerificationPass(effect,async nested=>{assert.equal(read(nested),3);assert.equal(read(nested),4);});
      throw Error('lost response');
    }),/lost response/);
    assert.equal(read(c),5);assert.equal(read(c),5);
  });
});

test('changed exact inputs and failed checks never reuse another result', async () => {
  let calls=0;const namespace={},binding={hash:'first'};
  await withVerificationPass({},async c=>{
    const read=()=>verificationOnce(c,namespace,binding,()=>{calls++;if(binding.hash==='bad')throw Error('hash mismatch');return binding.hash;});
    assert.equal(read(),'first');binding.hash='second';assert.equal(read(),'second');
    binding.hash='bad';assert.throws(read,/hash mismatch/);assert.throws(read,/hash mismatch/);assert.equal(calls,4);
  });
});

test('changed content is re-read after writes and on a subsequent resume', async t => {
  const root=mkdtempSync(join(tmpdir(),'nova-verification-pass-'));t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
  const path=join(root,'archive'),namespace={};writeFileSync(path,'original');
  const read=c=>verificationOnce(c,namespace,{path,expected:'original'},()=>{const bytes=readFileSync(path,'utf8');assert.equal(bytes,'original');return bytes;});
  await withVerificationPass({},async c=>{
    read(c);await verificationEffect(c,()=>writeFileSync(path,'corrupt!'));
    assert.throws(()=>read(c),/corrupt/);
  });
  await assert.rejects(withVerificationPass({},async c=>read(c)),/corrupt/);
});

test('bounded map does not retain unbounded keys and asynchronous checks are rejected', async () => {
  let reads=0;
  await withVerificationPass({},async c=>{
    for(let i=0;i<40;i++){const key={};verificationOnce(c,key,{},()=>++reads);verificationOnce(c,key,{},()=>++reads);}
    assert.equal(reads,48);
    assert.throws(()=>verificationOnce(c,{}, {large:'x'.repeat(2*1024**2)},()=>0),/unbounded/);
    assert.throws(()=>verificationOnce(c,{}, {},()=>Promise.resolve(1)),/synchronous/);
  });
});

test('a pass older than thirty seconds cannot reuse earlier content', async t => {
  let now=0,calls=0;t.mock.method(performance,'now',()=>now);const namespace={};
  await withVerificationPass({},async c=>{
    const read=()=>verificationOnce(c,namespace,{},()=>++calls);
    assert.equal(read(),1);now=29999;assert.equal(read(),1);now=30000;assert.equal(read(),2);
  });
});

test('an explicit read-only inspection inside an effect is isolated and ends before the effect continues', async () => {
  let reads=0;const key={},read=c=>verificationOnce(c,key,{},()=>++reads);
  await withVerificationPass({},async c=>{
    read(c);
    await verificationEffect(c,async effect=>{
      await withVerificationPass(effect,async inspection=>{assert.equal(read(inspection),2);assert.equal(read(inspection),2);},{readOnly:true});
      assert.equal(read(effect),3);assert.equal(read(effect),4);
      await withVerificationPass(effect,async inspection=>{assert.equal(read(inspection),5);assert.equal(read(inspection),5);},{readOnly:true});
    });
    assert.equal(read(c),6);
  });
});
