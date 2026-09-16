import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { bindNativeApprovalReviewer, bindWorkerApprovalReviewer, installNativeApprovalCompatibility } from '../apps/service/openclaw-approval-compat';

// Unmodified MIT-licensed OpenClaw2026.9.2 bundle; adjacent license retained.
const source=readFileSync(new URL('./fixtures/openclaw-host-capability-2026.9.2.js.txt',import.meta.url),'utf8');
const workerSource=readFileSync(new URL('./fixtures/openclaw-principal-2026.9.2.js.txt',import.meta.url),'utf8');

test('worker launch binds only its authenticated live initiating device, never request or recovery identities',()=>{
 const corrected=bindWorkerApprovalReviewer(workerSource);
 const start=corrected.indexOf('ingressOpts: {')+'ingressOpts: {'.length;
 const end=corrected.indexOf('\n\t\t\t\t\tskillLibraryAuthoring,',start);
 const binding=corrected.slice(start,end);
 const evaluate=(params:any)=>new Script('({'+binding+'})').runInNewContext({params,normalizeOptionalString:(v:unknown)=>typeof v==='string'?v.trim()||undefined:undefined}).approvalReviewerDeviceId;
 const client={connect:{device:{id:' authenticated-owner '}},internal:{agentRunTracking:'plugin_subagent',pluginRuntimeOwnerId:'edition3-worker'}};
 assert.equal(evaluate({client,request:{approvalReviewerDeviceId:'model-invented'}}),'authenticated-owner');
 assert.equal(evaluate({client,isRestartRecoveryResumeRun:true}),undefined);
 assert.equal(evaluate({request:{approvalReviewerDeviceId:'model-invented'}}),undefined);
 assert.equal(evaluate({client:{...client,connect:{}}}),undefined);
 assert.equal(evaluate({client:{...client,internal:{...client.internal,pluginRuntimeOwnerId:'another-plugin'}}}),undefined);
 assert.equal(evaluate({client:{...client,internal:{...client.internal,agentRunTracking:'ordinary'}}}),undefined);
 assert(corrected.replace(binding,'')===workerSource,'Only the reviewer binding may change native bytes');
 assert.throws(()=>bindWorkerApprovalReviewer(workerSource+'\n'),/Unrecognized/);
 assert.throws(()=>bindWorkerApprovalReviewer(corrected),/Unrecognized/);
});
function nativeRequest(deviceId?:string){
 const corrected=bindNativeApprovalReviewer(source), start=corrected.indexOf('requestApproval: async (request) => {')+'requestApproval: '.length, end=corrected.indexOf(',\n\t\twaitForApproval:',start), sent:any[]=[], owners:string[]=[], releases:string[]=[];
 let active=true;
 const request=new Script('('+corrected.slice(start,end)+')').runInNewContext({
  attempt:{agentId:'main',...(deviceId?{approvalReviewerDeviceId:deviceId}:{})},delegatedAuthority:{},params:{pluginId:'codex'},
  assertActive:()=>{if(!active)throw Error('retired attempt');},
  registerMcpToolApprovalBinding:()=>()=>releases.push('released'),
  withCaller:async(fn:()=>unknown)=>fn(),
  withGatewayToolApprovalOwner:async(owner:string,fn:()=>unknown)=>{owners.push(owner);return fn();},
  callGatewayTool:async(...args:any[])=>{sent.push(args);return {id:'plugin:exact-native-request'};},
 });
 return {request,sent,owners,releases,retire:()=>{active=false;}};
}
const call=()=>({title:'Calculator action',description:'Start the bounded session',severity:'warning',toolName:'mcp__nova-calculator-qa__start_session',toolCallId:'call-1',mcpTool:{serverId:'nova-calculator-qa',toolName:'start_session'},isMcpToolApprovalActive:()=>true,timeoutMs:60000,allowedDecisions:['allow-once','deny']});

test('native MCP approvals bind the initiating device, preserve native authority and ignore supplied reviewer IDs',async()=>{
 const native=nativeRequest('owner-device');await native.request({...call(),approvalReviewerDeviceIds:['different-device']});
 assert.equal(native.sent.length,1);const [method,transport,payload,options]=native.sent[0];
 assert.equal(method,'plugin.approval.request');assert.equal(transport.timeoutMs,60000);assert.deepEqual([...payload.approvalReviewerDeviceIds],['owner-device']);
 assert.equal(payload.twoPhase,true);assert.deepEqual([...payload.allowedDecisions],['allow-once','deny']);assert.equal(payload.toolCallId,'call-1');assert.deepEqual(payload.mcpTool,call().mcpTool);assert.equal(options.requireAgentRuntimeIdentity,true);assert.equal(options.expectFinal,false);
 assert.deepEqual(native.owners,['codex']);assert.deepEqual(native.releases,['released']);
});

test('missing initiating device never borrows model-supplied authority; cancelled or retired calls never request approval',async()=>{
 const native=nativeRequest();await native.request({...call(),approvalReviewerDeviceIds:['invented-device']});assert.equal(native.sent[0][2].approvalReviewerDeviceIds,undefined);
 const cancelled=nativeRequest('owner'),abort=new AbortController();abort.abort();await assert.rejects(cancelled.request({...call(),signal:abort.signal}));assert.equal(cancelled.sent.length,0);
 const retired=nativeRequest('owner');retired.retire();await assert.rejects(retired.request(call()),/retired/);assert.equal(retired.sent.length,0);
});

test('compatibility refuses altered or already-modified native bytes',()=>{
 assert.throws(()=>bindNativeApprovalReviewer(source+'\n'),/Unrecognized/);
 assert.throws(()=>bindNativeApprovalReviewer(bindNativeApprovalReviewer(source)),/Unrecognized/);
 const corrected=bindNativeApprovalReviewer(source);assert.equal(corrected.replace('\t\t\t\t\t...attempt.approvalReviewerDeviceId ? { approvalReviewerDeviceIds: [attempt.approvalReviewerDeviceId] } : {},\n',''),source);
});

test('owned loading hook rejects an unexpected native bundle and leaves other modules unchanged',async()=>{
 const root=mkdtempSync(join(tmpdir(),'e3-native-compat-'));mkdirSync(join(root,'dist'));mkdirSync(join(root,'elsewhere'));writeFileSync(join(root,'package.json'),'{"type":"module"}');
 const changed=join(root,'dist','host-capability-unrecognized.js'),other=join(root,'elsewhere','host-capability-unrecognized.js');writeFileSync(changed,'export default 1;');writeFileSync(other,'export default 7;');const hook=installNativeApprovalCompatibility(join(root,'openclaw.mjs'));
 try{await assert.rejects(import(pathToFileURL(changed).href),/Unrecognized/);assert.equal((await import(pathToFileURL(other).href)).default,7);assert.equal(readFileSync(changed,'utf8'),'export default 1;');}finally{hook.deregister();rmSync(root,{recursive:true,force:true});}
});
