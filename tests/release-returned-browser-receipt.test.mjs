import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {returnedBrowserRequestSchema,retainedBrowserReceipt} from '../scripts/release-delivery-browser-receipt.mjs';

function request(){
 const ref={path:resolve('receipt.json'),sha256:'a'.repeat(64)},source={root:resolve('operator'),repository:'owner/application',branch:'operator/browser-receipt-collection',commit:'b'.repeat(40)};
 return {format:1,kind:'nova-returned-browser-receipt-request',operationId:randomUUID(),historical:{root:resolve('historical'),manifest:ref},
  operatorSources:{private:source,public:source},ciRuns:{private:1,public:2},predecessorGrantSha256:'c'.repeat(64),
  owner:Object.fromEntries(['request','session','launcher','intent','stdout','exit','childResult'].map(n=>[n,ref])),
  browser:{key:randomUUID(),inputSha256:'d'.repeat(64),...Object.fromEntries(['raw','screenshot','closed','unit','original','prepared'].map(n=>[n,ref]))}};
}

test('browser receipt collection requires the original operation, completed process evidence and qualified sources',()=>{
 const q=request();assert.deepEqual(returnedBrowserRequestSchema.parse(q),q);
 for(const change of [v=>delete v.predecessorGrantSha256,v=>delete v.owner.exit,v=>delete v.owner.childResult,v=>delete v.browser.unit,
  v=>delete v.browser.screenshot,v=>delete v.browser.original,v=>v.operatorSources.public.branch='main',
  v=>v.browser.raw.sha256='bad',v=>v.durationMs=10000,v=>v.browser.startAnother=true]){
  const changed=structuredClone(q);change(changed);assert.throws(()=>returnedBrowserRequestSchema.parse(changed));
 }
});

test('a different reservation, input or filesystem root stops before any browser transport',()=>{
 const q=request(),row={key:q.browser.key,inputSha256:q.browser.inputSha256,input:{installed:{route:'full'},original:q.browser.original,prepared:q.browser.prepared,operationId:q.operationId}};
 const j={directory:resolve('journal'),deliveryPhase:()=>row};
 assert.throws(()=>retainedBrowserReceipt(j,q.operationId,q),/session-root-changed/);
 for(const change of [v=>v.browser.key=randomUUID(),v=>v.browser.inputSha256='e'.repeat(64),v=>v.operationId=randomUUID()]){
  const changed=structuredClone(q);change(changed);assert.throws(()=>retainedBrowserReceipt(j,q.operationId,changed),/original-reservation-changed/);
 }
});
