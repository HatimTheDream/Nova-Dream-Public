import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ManagedRuntime} from '../apps/service/runtime.js';
import {Store} from '../apps/service/store.js';
import type {AssistantConnection} from '../packages/domain/assistant.js';

// Explicit post-build lifecycle gate; source-only quality tests run separately.
const operation=process.env.NOVA_HISTORY_TEST_OPERATION??randomUUID();
if(!/^[a-zA-Z0-9_-]{1,80}$/.test(operation))throw Error('Invalid Feed lifecycle operation');
const namespace=fileURLToPath(new URL('../.tmp-qa/feed-native-lifecycle/'+operation+'/',import.meta.url));
mkdirSync(namespace,{recursive:true});
const compiledWorkerPaths=['worker-plugin/index.js','worker-plugin/journal.js','worker-plugin/identity.js','worker-plugin/package.json','worker-plugin/openclaw.plugin.json','worker-runtime-config.js','../../packages/domain/agent-capabilities.js','../../packages/domain/worker.js','../../packages/domain/worker-failure.js'];
function put(path:string,value:string|Buffer){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function bounded<T>(work:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Original synthetic readiness observation exceeded 10 seconds')),10000);})]);}finally{if(timer)clearTimeout(timer);}}

test('Actual owned runtime captures Feed identity only after readiness and never resurrects a revoked child', {timeout:45000}, async()=>{
 const compiled=fileURLToPath(new URL('../dist/service/apps/service/',import.meta.url));
 for(const path of compiledWorkerPaths)assert(existsSync(join(compiled,path)),'Maintained service build required before actual runtime qualification test: '+path);
 const directory=join(namespace,'owned'),entry=join(directory,'openclaw.mjs'),previous=process.env.E3_OPENCLAW_ENTRY;
 put(join(directory,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.8'}));
 put(entry,`import {createServer} from 'node:http';import {appendFileSync,writeFileSync} from 'node:fs';
appendFileSync('starts.txt','started\\n');let active=false;
const server=createServer((req,res)=>{if(req.url==='/work'){active=true;writeFileSync('synthetic-work.json',JSON.stringify({active,pid:process.pid}));}res.end(JSON.stringify({ready:true,active,pid:process.pid}));});
server.listen(Number(process.env.OPENCLAW_GATEWAY_PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
 process.env.E3_OPENCLAW_ENTRY=entry;
 const store=new Store(join(directory,'w')),entered=deferred(),gate=deferred();
 let first=true,connection:AssistantConnection={state:'disconnected',message:'Synthetic runtime child',methods:[],grantedScopes:[],modelAuthReady:false};
 const gateway={status:()=>connection,async configure(url:string,token?:string){
  if(first){first=false;entered.resolve();await gate.promise;}
  store.internalWrite('gateway:configuration',{url,token});connection={...connection,state:'ready',url,generation:randomUUID()};return connection;
 }};
 const runtime=new ManagedRuntime(store,gateway,5000);
 let passed=false;
 try{
  assert.deepEqual(runtime.feedQualification(),{id:'feed-native-unavailable',available:false});
  const starting=runtime.start();
  await bounded(Promise.race([entered.promise,starting.then(()=>{throw Error('Synthetic runtime did not reach its gateway readiness boundary');})]));
  assert.equal(runtime.feedQualification().available,false);gate.resolve();
  assert.equal((await bounded(starting)).state,'running');const captured=runtime.feedQualification();assert.equal(captured.available,true);assert.match(captured.id,/^[a-f0-9]{64}$/);
  const url=connection.url!.replace(/^ws:/,'http:');
  const work=await (await fetch(url+'/work',{signal:AbortSignal.timeout(2000)})).json() as {active:boolean;pid:number};
  assert.equal(work.active,true);assert.equal(work.pid,runtime.updateIdentity()!.pid);assert.deepEqual(runtime.feedQualification(),captured);
  const root=join(store.directory,'openclaw-runtime'),configPath=join(root,'openclaw.json'),configuration=readFileSync(configPath);
  put(configPath,configuration.toString()+'\n');assert.deepEqual(runtime.feedQualification(),{id:captured.id,available:false});
  put(configPath,configuration);assert.deepEqual(runtime.feedQualification(),{id:captured.id,available:false},'restored bytes cannot revive the revoked original capture');
  await runtime.stop();assert.equal(runtime.feedQualification().available,false);
  connection={...connection,state:'disconnected'};
  assert.equal((await bounded(runtime.start())).state,'running');const restarted=runtime.feedQualification();assert.equal(restarted.available,true);assert.notEqual(restarted.id,captured.id);
  const priorConnection=connection;connection={...connection,generation:randomUUID()};assert.deepEqual(runtime.feedQualification(),{id:restarted.id,available:false});
  connection=priorConnection;assert.deepEqual(runtime.feedQualification(),{id:restarted.id,available:false},'restored connection cannot revive a revoked child');
  assert.equal(readFileSync(join(root,'starts.txt'),'utf8'),'started\nstarted\n');
  assert.equal(connection.modelAuthReady,false,'runtime identity does not manufacture model or account access');passed=true;
 }finally{
  gate.resolve();try{await runtime.stop();}catch(error){passed=false;throw error;}
  finally{store.close();if(previous===undefined)delete process.env.E3_OPENCLAW_ENTRY;else process.env.E3_OPENCLAW_ENTRY=previous;
   put(join(directory,'RESULT.json'),JSON.stringify({operation,passed,syntheticChild:true,providerExecution:false,retained:true}));}
 }
});

