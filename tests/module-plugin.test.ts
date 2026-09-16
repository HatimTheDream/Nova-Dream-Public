import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { registerModuleTools, type ModulePluginApi } from '../apps/service/module-plugin/index.js';
import { withModulePlugin } from '../apps/service/module-runtime-config.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
test('tool factory binds native session and server authority, excludes other agents, and rejects stale settings',async t=>{
 const received:any[]=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({input:JSON.parse(body),authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:'applied'}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const port=(server.address() as any).port,session:any={sessionId:randomUUID(),permissionMode:'workspace'};let factory:any;
 const api:ModulePluginApi={registrationMode:'full',pluginConfig:{epoch:randomUUID(),bundlePath:'/owned/plugin',url:`http://127.0.0.1:${port}/workspace`,token:'c'.repeat(64)},runtime:{version:'2026.9.2',agent:{session:{getSessionEntry:()=>session}}},registerTool:f=>factory=f};
 registerModuleTools(api);assert.equal(factory({agentId:'other',sessionId:session.sessionId,sessionKey:'foreign'}),null);assert.equal(factory({agentId:'main',sessionId:randomUUID(),sessionKey:'foreign'}),null);
 const tools=factory({agentId:'main',sessionId:session.sessionId,sessionKey:'agent:main:e3:one'});assert.deepEqual(tools.map((t:any)=>t.name),['nova_read','nova_write']);
 const result=await tools[1].execute('native-call',{operation:'records.save',input:{kind:'task'}});assert.equal(result.isError,false);assert.equal(received[0].input.nativeId,session.sessionId);assert.equal(received[0].input.permissionMode,'workspace');assert.equal(received[0].authorization,'Bearer '+'c'.repeat(64));
 await assert.rejects(tools[1].execute('native-call',{operation:'records.save',input:{},nativeId:randomUUID()}));
 session.permissionModePending=true;await assert.rejects(tools[1].execute('later',{operation:'records.save',input:{}}),/access setting changed/);assert.equal(received.length,1);
 api.registrationMode='discovery';factory=undefined;registerModuleTools(api);assert.equal(factory,undefined);
 api.registrationMode='tool-discovery';registerModuleTools(api);assert.equal(typeof factory,'function');
});
test('module plugin preserves owner configuration and follows paired-phone route policy',()=>{
 const epoch=randomUUID(),original:any={plugins:{allow:['owner'],load:{paths:['/owner','/old']},entries:{'edition3-workspace':{enabled:true,config:{bundlePath:'/old'}}}},tools:{deny:['exec']}};
 const config=withModulePlugin(original,epoch,'/new',{url:'http://127.0.0.1:4383/workspace',token:'b'.repeat(64)});assert.deepEqual(config.plugins?.load?.paths,['/owner','/new']);assert.deepEqual(config.tools,original.tools);assert.deepEqual(original.plugins.load.paths,['/owner','/old']);
 assert.equal(withModulePlugin({plugins:{enabled:false}},epoch,'/new',{url:'unused',token:'unused'}).plugins?.enabled,false);
 assert.equal(phoneRouteAllowed('/api/assistant/module-action','POST'),true);assert.equal(phoneRouteAllowed('/workspace','POST'),false);
});
test('source image readings reach the native model as image blocks without duplicating pixels into text or details',async t=>{
 const pixels=Buffer.from('fixture image bytes').toString('base64');
 const server=createServer(async(req,res)=>{for await(const _part of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({page:2,pages:4,view:'image',image:{mimeType:'image/jpeg',data:pixels,width:200,height:100},notes:['This page only.']}));});
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise<void>(ok=>server.close(()=>ok())));
 const sessionId=randomUUID();let factory:any;
 registerModuleTools({registrationMode:'full',pluginConfig:{epoch:randomUUID(),bundlePath:'/owned/plugin',url:`http://127.0.0.1:${(server.address() as any).port}/workspace`,token:'c'.repeat(64)},runtime:{version:'2026.9.2',agent:{session:{getSessionEntry:()=>({sessionId,permissionMode:'read-only'})}}},registerTool:fn=>factory=fn});
 const tool=factory({agentId:'edition3-assignment',sessionId,sessionKey:'agent:edition3-assignment:e3-assignment-fixture'})[0];
 const result=await tool.execute('source-call',{operation:'sources.read',input:{fileId:randomUUID(),page:2,view:'image'}});
 assert.equal(result.isError,false);assert.deepEqual(result.content[1],{type:'image',mimeType:'image/jpeg',data:pixels});
 assert(!result.content[0].text.includes(pixels));assert(!JSON.stringify(result.details).includes(pixels));assert.equal(result.details.page,2);
});
test('visual hook forwards actual image results only from the exact main session and run', async t => {
 const received:any[]=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({url:req.url,body:JSON.parse(body)});res.end('{}');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const sessionId=randomUUID(),epoch=randomUUID();let hook:any;
 registerModuleTools({registrationMode:'full',pluginConfig:{epoch,bundlePath:'/owned/plugin',url:`http://127.0.0.1:${(server.address() as any).port}/workspace`,token:'b'.repeat(64)},runtime:{version:'2026.9.2',agent:{session:{getSessionEntry:()=>({sessionId})}}},registerTool:()=>{},on:(name,fn)=>{assert.equal(name,'after_tool_call');hook=fn;}});
 const context={agentId:'main',sessionId,sessionKey:'agent:main:e3:test',runId:randomUUID(),toolCallId:'actual-call'},event={toolName:'computer-use.screenshot',result:{content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]}};
 await hook(event,{...context,sessionId:randomUUID()});await hook(event,{...context,agentId:'other'});await hook({...event,error:'failed'},context);await hook({...event,result:{path:'/private/file'}},context);assert.equal(received.length,0);
 await hook(event,context);assert.equal(received.length,1);assert.equal(received[0].url,'/workspace/observation');assert.equal(received[0].body.runId,context.runId);assert.equal(received[0].body.toolCallId,'actual-call');assert.equal(received[0].body.image.data,'aGVsbG8=');
});
