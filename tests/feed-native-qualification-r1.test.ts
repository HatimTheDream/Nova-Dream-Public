import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {feedRuntimeFingerprint} from '../apps/service/feed-runtime-files.js';
import {withWorkerPlugin} from '../apps/service/worker-runtime-config.js';
import {Store,Fault} from '../apps/service/store.js';
import {FeedSemanticHttp} from '../apps/service/feed-semantic-http.js';
import {assignmentRuntimeAgent} from '../packages/domain/agent-capabilities.js';

const operation=process.env.NOVA_HISTORY_TEST_OPERATION??randomUUID();
if(!operation||!/^[a-zA-Z0-9_-]{1,80}$/.test(operation))throw Error('Exact Feed qualification test operation required');
const namespace=fileURLToPath(new URL('../.tmp-qa/feed-native/'+operation+'/',import.meta.url));
mkdirSync(namespace,{recursive:true});
const compiledWorkerPaths=['worker-plugin/index.js','worker-plugin/journal.js','worker-plugin/identity.js','worker-plugin/package.json','worker-plugin/openclaw.plugin.json','worker-runtime-config.js','../../packages/domain/agent-capabilities.js','../../packages/domain/worker.js','../../packages/domain/worker-failure.js'];
function put(path:string,value:string|Buffer){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

function files(label:string){
 const directory=join(namespace,label),root=join(directory,'r'),serviceDirectory=join(directory,'compiled/apps/service'),entry=join(directory,'native/openclaw.mjs'),epoch=randomUUID(),version='2026.9.8';
 const input={root,serviceDirectory,entry,epoch,version};
 put(join(root,'edition3-runtime.identity'),'edition3-owned-gateway\n');
 const config=withWorkerPlugin({},epoch,join(serviceDirectory,'worker-plugin'),join(root,'assignment-receipts'));
 put(join(root,'openclaw.json'),JSON.stringify(config));
 put(entry,'// Synthetic identity bytes; this fixture does not execute a native provider.\n');
 put(join(dirname(entry),'package.json'),JSON.stringify({name:'openclaw',version}));
 for(const name of compiledWorkerPaths)
  put(join(serviceDirectory,name),name.endsWith('.json')?'{}':'// Synthetic '+name+'\n');
 return {input,config};
}

test('Feed file identity binds exact worker policy and code while mutable work stays outside the identity',()=>{
 const {input}=files('identity'),before=feedRuntimeFingerprint(input);
 assert.match(before,/^[a-f0-9]{64}$/);assert.equal(feedRuntimeFingerprint(input),before);
 put(join(input.root,'assignment-receipts/active.json'),JSON.stringify({id:randomUUID(),state:'running'}));
 put(join(input.root,'state/agents/edition3-assignment/sessions/active.jsonl'),'synthetic activity\n');
 assert.equal(feedRuntimeFingerprint(input),before,'active journal writes cannot revoke the unchanged worker identity');
 const code=join(input.serviceDirectory,'worker-plugin/index.js');put(code,readFileSync(code,'utf8')+'// changed\n');
 assert.notEqual(feedRuntimeFingerprint(input),before,'changed installed worker bytes must change identity');
});

test('Feed file qualification refuses missing oversized foreign-owner unknown-version and widened-policy inputs',()=>{
 const {input,config}=files('refusal');
 assert.throws(()=>feedRuntimeFingerprint({...input,version:'2026.9.9'}),/Unsupported/);
 const marker=join(input.root,'edition3-runtime.identity'),owner=readFileSync(marker);put(marker,'foreign-owner\n');assert.throws(()=>feedRuntimeFingerprint(input),/owner/);put(marker,owner);
 const worker=join(input.serviceDirectory,'worker-plugin/journal.js'),missing=worker+'.kept';renameSync(worker,missing);
 assert.throws(()=>feedRuntimeFingerprint(input));renameSync(missing,worker);
 const original=readFileSync(worker);put(worker,Buffer.alloc(2*1024*1024+1));assert.throws(()=>feedRuntimeFingerprint(input),/file is unavailable/);put(worker,original);
 const expanded=structuredClone(config) as any;expanded.agents.entries[assignmentRuntimeAgent].tools={allow:['exec']};
 put(join(input.root,'openclaw.json'),JSON.stringify(expanded));assert.throws(()=>feedRuntimeFingerprint(input),/policy/);
 put(join(input.root,'openclaw.json'),JSON.stringify(config));assert.match(feedRuntimeFingerprint(input),/^[a-f0-9]{64}$/);
});

test('Native Feed HTTP routes dispatch exact authenticated originals and recheck access after asynchronous results',async()=>{
 const epoch=randomUUID(),deviceId=randomUUID(),token='a'.repeat(43),candidate='b'.repeat(64),prefix='/api/home/news/semantic';
 let valid=true,hold:ReturnType<typeof deferred>|undefined;
 const calls:{kind:string;value:unknown;owner:{deviceId:string;epoch:string;authorize():void}}[]=[];
 const store={epoch,recoveryHeld:false,recoveryEffectsPaused:false,updateMaintenanceHeld:false,authenticate(value:string){if(!valid||value!==token)throw new Fault(401,'session_required','Original token revoked');return deviceId;}};
 const phone={enabled:false,authenticate(){throw Error('Unexpected phone auth');},checkAuthentication(){throw Error('Unexpected phone auth');}};
 const controller:any={nativeCapabilities(owner:any){owner.authorize();return {prepare:true,observe:true,reason:'available'};}};
 for(const kind of ['prepare','start','observe'])controller[kind]=async(owner:any,value:unknown)=>{owner.authorize();calls.push({kind,value,owner});await hold?.promise;return {kind,value};};
 const policy={enabled:true,closing:false,ownOrigin:'http://127.0.0.1:4383',cookieName:'e3_test',candidateId:candidate};
 const seam=new FeedSemanticHttp(store,phone,controller,()=>policy);
 const request=(suffix:string,value?:unknown,headers:Record<string,string>={})=>{
  const req=Readable.from(value===undefined?[]:[Buffer.from(JSON.stringify(value))]) as IncomingMessage;
  req.url=prefix+suffix;req.method=value===undefined?'GET':'POST';req.headers={host:'127.0.0.1:4383',origin:policy.ownOrigin,cookie:'e3_test='+token,'content-type':'application/json','x-edition3-client':'1','x-edition3-candidate':candidate,...headers};return req;
 };
 const descriptor={format:3,requestId:randomUUID(),epoch,kind:'interpret'},sha='c'.repeat(64);
 const command={...descriptor,expectedRevision:1,expectation:{preparedAt:1000,deadlineAt:181000,contractVersion:'adaptive-2',captureSha256:sha,modelInputSha256:sha,nativePolicySha256:sha}},id=randomUUID();
 const view=await seam.handle(request('/view'),'desktop');assert.deepEqual((view!.body as any).native,{prepare:true,observe:true,reason:'available'});
 for(const [path,value] of [['/prepare',descriptor],['/command',{kind:'start',command}],['/observe',{format:3,epoch,id}]] as const){const result=await seam.handle(request(path,value),'desktop');assert.equal(result!.status,200);result!.authorize();}
 assert.deepEqual(calls.map(call=>[call.kind,call.value]),[['prepare',descriptor],['start',command],['observe',id]]);
 assert(calls.every(call=>call.owner.deviceId===deviceId&&call.owner.epoch===epoch));
 const count=calls.length;await assert.rejects(seam.handle(request('/prepare',descriptor,{'x-edition3-candidate':'stale'}),'desktop'),(error:any)=>error.code==='client_update');
 store.updateMaintenanceHeld=true;await assert.rejects(seam.handle(request('/prepare',descriptor),'desktop'),(error:any)=>error.code==='update_maintenance');store.updateMaintenanceHeld=false;assert.equal(calls.length,count);
 hold=deferred();const pending=seam.handle(request('/prepare',descriptor),'desktop');await new Promise<void>(resolve=>setImmediate(resolve));valid=false;hold.resolve();await assert.rejects(pending,/Original token revoked/);
 valid=true;hold=undefined;const settled=await seam.handle(request('/observe',{format:3,epoch,id}),'desktop');valid=false;assert.throws(()=>settled!.authorize(),/Original token revoked/);
});
