import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { bendPixels, completeFarArm } from '../apps/client/src/nova/lynx-pixel/raster';
import { createLynxAppearance, resolveLynxAppearance } from '../packages/domain/lynx-appearance';
import { motionPhase } from '../packages/domain/lynx-motion';

test('each anatomical limb keeps an independent eight-frame trajectory in all directions',()=>{
  const rig=JSON.parse(readFileSync('apps/client/src/nova/lynx-pixel/assets/walk-rig-p02.json','utf8'));
  assert.equal(rig.length,8);
  for(const view of rig){
    assert.equal(new Set(Object.values(view.parts)).size,4);assert.equal(view.frames.length,8);
    for(const frame of view.frames)for(const keys of Object.values(frame.limbs) as {sourceY:number;targetY:number;dx:number}[][]){
      assert.ok(keys.every((key,i)=>Number.isFinite(key.dx)&&(!i||key.targetY>keys[i-1].targetY)));
    }
    for(const limb of ['rightArm','leftArm','rightLeg','leftLeg'])assert.ok(new Set(view.frames.map((f:any)=>JSON.stringify(f.limbs[limb]))).size>=4,view.direction+' '+limb);
  }
});
test('leg deformation preserves rigid paw pixels below the ankle and never wraps across image edges',()=>{
  const pixels=new Uint8ClampedArray(128*128*4);
  for(let y=110;y<119;y++)for(let x=60;x<70;x++)pixels.set([x,y,99,255],(y*128+x)*4);
  const keys=[{sourceY:88,targetY:88,dx:0},{sourceY:101,targetY:100,dx:2},{sourceY:110,targetY:106,dx:5},{sourceY:127,targetY:123,dx:5}];
  const result=bendPixels(pixels,keys);
  for(let y=110;y<119;y++)for(let x=60;x<70;x++)assert.deepEqual(result.slice(((y-4)*128+x+5)*4,((y-4)*128+x+5)*4+4),pixels.slice((y*128+x)*4,(y*128+x)*4+4));
  assert.equal(result.filter((v,i)=>i%4===3&&v===255).length,90);
});
test('hidden far-arm reconstruction retains original visible pixels and does not borrow its pose',()=>{
  const far=new Uint8ClampedArray(128*128*4),near=new Uint8ClampedArray(far.length);
  for(let y=62;y<96;y++)for(let x=53;x<65;x++)near.set([64,61,62,255],(y*128+x)*4);
  for(let y=84;y<94;y++)for(let x=77;x<81;x++)far.set([17,32,49,255],(y*128+x)*4);
  const output=completeFarArm(far,near,[75,65],[59,62]);
  for(let p=0;p<far.length;p+=4)if(far[p+3])assert.deepEqual(output.slice(p,p+4),far.slice(p,p+4));
  assert.ok(output.filter((v,i)=>i%4===3&&v).length>40);
  assert.ok(output[(70*128+76)*4+3]);
});
test('suit modules cover eight directions and optional neckwear preserves old saved recipes exactly',async()=>{
  const old=createLynxAppearance(),resolved=resolveLynxAppearance(old);
  assert.equal(resolved.status,'ready');if(resolved.status==='ready')assert.deepEqual(resolved.recipe,old);
  assert.equal(Object.hasOwn(old,'neckwear'),false);
  for(const outerwear of ['navy-blazer','charcoal-blazer'])assert.equal(resolveLynxAppearance({...old,outerwear,shirt:'dress-shirt',trousers:'navy-trousers',neckwear:'burgundy-tie'}).status,'ready');
  for(const name of ['blazer','suit-trousers','dress-shirt']){
    const {data,info}=await sharp(`apps/client/src/nova/lynx-pixel/assets/nova-lynx-${name}-p02.png`).raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,1024);assert.equal(info.height,128);
    for(let d=0;d<8;d++){let count=0;for(let y=0;y<128;y++)for(let x=d*128;x<(d+1)*128;x++){const a=data[(y*1024+x)*4+3];assert.ok(a===0||a===255);if(a)count++;}assert.ok(count>100,name+' '+d);}
  }
});
test('seated transitions clamp to stable endpoints and reduced motion snaps to the intended pose',()=>{
  assert.equal(motionPhase('sit-down',0).seated,0);assert.equal(motionPhase('sit-down',.3).seated,.5);assert.equal(motionPhase('sit-down',5).seated,1);
  assert.equal(motionPhase('stand-up',0).seated,1);assert.equal(motionPhase('stand-up',5).seated,0);
  assert.equal(motionPhase('sit-down',0,true).seated,1);assert.equal(motionPhase('stand-up',0,true).seated,0);
});
