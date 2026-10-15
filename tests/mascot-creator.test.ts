import test from 'node:test';
import assert from 'node:assert/strict';
import { createMascotAppearance, defaultMascotAppearance, mascotOptions, originalMascotOptions, resolveMascotAppearance } from '../packages/domain/mascot-appearance.js';
import { normalizeCreatorLocks, shuffleCreatorAppearance, creatorColors, creatorChoices } from '../apps/client/src/nova/square-lynx/creator-state.js';
import { renderMascot } from '../apps/client/src/nova/square-lynx/mascot-art.js';

test('revision 3 appends stable numbered choices, while old recipes retain their own catalogue',()=>{
 for(const key of creatorChoices){
  assert.equal(mascotOptions[key].length,20);
  assert.deepEqual(mascotOptions[key].slice(0,originalMascotOptions[key].length),originalMascotOptions[key]);
  const added=mascotOptions[key].at(-1)!;
  const current=createMascotAppearance({...defaultMascotAppearance,[key]:added});
  assert.equal(resolveMascotAppearance(current).status,'ready');
  assert.equal(resolveMascotAppearance({...current,catalogRevision:'nova-mascot-2'}).status,'invalid');
  const old=Object.freeze({...current,catalogRevision:'nova-mascot-2',appearance:Object.freeze({...defaultMascotAppearance})});
  const before=JSON.stringify(old);assert.equal(resolveMascotAppearance(old).status,'ready');assert.equal(JSON.stringify(old),before);
 }
});
test('shuffle protects exact independently locked fields and frame survives None',()=>{
 const appearance={...defaultMascotAppearance,glasses:'none' as const,fur:'#123456',eyes:'#654321',glassesColor:'#abcdef'};
 const locks=normalizeCreatorLocks({fur:true,eyes:true,face:true,glassesColor:true});
 for(const seed of [0,.2,.6,.99]){
  const next=shuffleCreatorAppearance(appearance,locks,()=>seed);
  for(const key of ['fur','eyes','face','glassesColor'] as const) assert.equal(next[key],appearance[key]);
  assert.notEqual(next.outfit,appearance.outfit);
 }
 const all=normalizeCreatorLocks(Object.fromEntries([...creatorChoices,...creatorColors].map(key=>[key,true])));
 assert.deepEqual(shuffleCreatorAppearance(appearance,all),appearance);
 const unlocked=shuffleCreatorAppearance(appearance,normalizeCreatorLocks(null),()=>.9);
 assert.notEqual(unlocked.glassesColor,appearance.glassesColor);
 assert.deepEqual(appearance,{...defaultMascotAppearance,glasses:'none',fur:'#123456',eyes:'#654321',glassesColor:'#abcdef'});
});
test('legacy palette lock is presentation-only and malformed preference accessors are not evaluated',()=>{
 const migrated=normalizeCreatorLocks({colors:true,face:true});
 for(const key of creatorColors)assert.equal(migrated[key],true);
 assert.equal(migrated.face,true);assert.equal(migrated.pattern,false);
 let calls=0;const source=Object.defineProperty({},'fur',{get(){calls++;return true;}});
 assert.equal(normalizeCreatorLocks(source).fur,false);assert.equal(calls,0);
});
test('all extended frames accept frame ink without changing any non-eyewear artwork',()=>{
 for(const glasses of mascotOptions.glasses){
  const original=renderMascot({...defaultMascotAppearance,glasses},{uid:'frame'});
  const color=renderMascot({...defaultMascotAppearance,glasses,glassesColor:'#13579b'},{uid:'frame'});
  if(glasses==='none')assert.equal(color,original);else assert.notEqual(color,original);
  assert.doesNotMatch(color,/undefined|NaN|<script|foreignObject/);
 }
});
