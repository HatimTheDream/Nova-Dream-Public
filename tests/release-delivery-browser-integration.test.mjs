import test from 'node:test';
import assert from 'node:assert/strict';
import {withBrowserPreparation,deliveryPhaseIntegrationGaps} from '../scripts/release-delivery-adapters.mjs';
const context={descriptor:{operation:{id:'operation'}}};
test('browser preparation failure stops publication as an explicit gap',async()=>{
 let writes=0;const adapter=withBrowserPreparation({execute:async()=>writes++,observe:async()=>writes++},async()=>{throw Error('browser-original-session-closed');});
 const result=await adapter.execute(context);
 assert.equal(result.state,'gap');assert.equal(result.reason,'browser-original-session-closed');assert.equal(writes,0);
});
test('publication observation cannot launch or repeat original publication',async()=>{
 const calls=[];const adapter=withBrowserPreparation({execute:async()=>calls.push('execute'),observe:async()=>calls.push('observe')},async(_c,inspectOnly)=>{calls.push(inspectOnly);});
 await adapter.observe(context);assert.deepEqual(calls,[true,'observe']);
});
test('uncertain publication is not mislabeled as a browser preparation gap',async()=>{
 const adapter=withBrowserPreparation({execute:async()=>{throw Error('lost-publish-response');}},async()=>{});
 await assert.rejects(adapter.execute(context),/lost-publish-response/);
});
test('browser capability declaration alone cannot satisfy producer integration',()=>{
 assert.deepEqual(deliveryPhaseIntegrationGaps('browser',{browserCapability:'available'}),['browser-reload-producer-not-integrated']);
 assert.deepEqual(deliveryPhaseIntegrationGaps('browser',{browserCapability:'available',browserTools:{}}),[]);
 assert.equal(deliveryPhaseIntegrationGaps('browser',{browserCapability:'unavailable',browserTools:{}})[0],'browser-capability-unavailable');
});

