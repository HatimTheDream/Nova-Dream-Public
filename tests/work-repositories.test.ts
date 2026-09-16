import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { GitHubConnection } from '../apps/service/github.js';
import { WorkRepositories } from '../apps/service/work-repositories.js';
import { hostCommand, hostEnvironment, type HostCommand } from '../apps/service/host-command.js';
import { gitBranch, type GitPublication } from '../packages/domain/work-repositories.js';

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const repository={id:1,fullName:'sample/project',description:'Fixture',private:true,defaultBranch:'main',canPush:true,archived:false};
const api:typeof fetch=async()=>json({id:1,login:'sample',name:'Sample'});
async function fixture(t:any,run:HostCommand=hostCommand){
  const directory=await mkdtemp(join(tmpdir(),'nova-work-')),store=new Store(directory),github=new GitHubConnection(store,run,api),work=new WorkRepositories(store,github,run);
  t.after(async()=>{await work.close();await github.close();store.close();await rm(directory,{recursive:true,force:true});});
  store.internalWrite('work:github:credential',{token:'fixture-private-token',identity:{id:1,login:'sample',name:'Sample',email:'sample@example.invalid'},generation:'one',epoch:store.epoch});
  const id=randomUUID(),folder=join(work.root,id),conversationId=randomUUID();await mkdir(folder,{recursive:true});
  const env=hostEnvironment({GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:'Sample',GIT_AUTHOR_EMAIL:'sample@example.invalid',GIT_COMMITTER_NAME:'Sample',GIT_COMMITTER_EMAIL:'sample@example.invalid'});
  const git=async(...args:string[])=>(await hostCommand('git',args,{cwd:folder,env})).toString().trim();
  await git('init','--initial-branch=main');await writeFile(join(folder,'readme.md'),'original\n');await git('add','.');await git('commit','-m','Baseline');await git('remote','add','origin','https://github.com/sample/project.git');await git('switch','-c','nova/fixture');
  store.internalWrite('work:checkout:'+id,{id,repository,branch:'nova/fixture',baseBranch:'main',folder,state:'ready',message:'Ready',createdAt:1,accountId:1,operationId:randomUUID(),device:'owner',epoch:store.epoch});
  store.internalWrite('assistant:conversation:'+conversationId,{id:conversationId,workspace:{folder,environment:'local',path:folder},state:'ready',space:'work'});
  const settled=async(id:string)=>{for(let i=0;i<200;i++){const p=store.internalRead<GitPublication>('work:publication:'+id)!;if(!['prepared','running'].includes(p.state))return p;await new Promise(r=>setTimeout(r,10));}throw Error('Publication did not settle');};
  return {directory,store,github,work,id,folder,conversationId,git,settled};
}
test('review includes new files and commits exactly the reviewed content, without staging unrelated later writes',async t=>{
  const f=await fixture(t);await writeFile(join(f.folder,'readme.md'),'reviewed\n');await writeFile(join(f.folder,'new file.md'),'new\n');
  const review=await f.work.review(f.conversationId);assert.equal(review.files.length,2);assert(review.files.some(v=>v.patch.includes('+reviewed')));assert(review.files.some(v=>v.path==='new file.md'));
  assert.equal(await f.git('diff','--cached','--name-only'),'');
  const cmd={requestId:randomUUID(),epoch:f.store.epoch,conversationId:f.conversationId,fingerprint:review.fingerprint,title:'Reviewed change',body:'Checked locally',action:'commit'};
  const p=await f.work.publish('owner',cmd);const done=await f.settled(p.id);assert.equal(done.state,'complete');assert.equal(await f.git('show','HEAD:readme.md'),'reviewed');assert.equal(await f.git('status','--porcelain'),'');
  assert.equal((await f.work.publish('owner',cmd)).id,p.id);assert.equal(await f.git('rev-list','--count','HEAD'),'2');
  await assert.rejects(f.work.publish('owner',{...cmd,title:'A different intent'}),/identity/);
});
test('changed files, busy work, changed destinations and custom executable Git config cannot bypass review',async t=>{
  const f=await fixture(t);await writeFile(join(f.folder,'readme.md'),'first\n');const review=await f.work.review(f.conversationId);
  const cmd={requestId:randomUUID(),epoch:f.store.epoch,conversationId:f.conversationId,fingerprint:review.fingerprint,title:'Change',body:'',action:'commit'};
  await writeFile(join(f.folder,'readme.md'),'second\n');await assert.rejects(f.work.publish('owner',cmd),/changed since/);
  f.store.internalWrite('assistant:operation:active',{conversationId:f.conversationId,state:'running'});const current=await f.work.review(f.conversationId);assert.equal(current.canPublish,false);await assert.rejects(f.work.publish('owner',{...cmd,fingerprint:current.fingerprint}),/coding task/);f.store.internalDelete('assistant:operation:active');
  await f.git('remote','set-url','origin','https://github.com/somebody/else.git');await assert.rejects(f.work.review(f.conversationId),/destination changed/);await f.git('remote','set-url','origin','https://github.com/sample/project.git');
  await f.git('config','filter.bad.clean','echo unwanted');await assert.rejects(f.work.review(f.conversationId),/custom Git/);
});
test('uncertain pushes keep their receipt and never automatically repeat remote effects',async t=>{
  let pushes=0;const run:HostCommand=async(exe,args,options)=>{if(exe==='git'&&args.includes('push')){pushes++;throw Error('Connection lost');}return hostCommand(exe,args,options);};
  const f=await fixture(t,run),review=await f.work.review(f.conversationId),cmd={requestId:randomUUID(),epoch:f.store.epoch,conversationId:f.conversationId,fingerprint:review.fingerprint,title:'Publish',body:'',action:'push'};
  const p=await f.work.publish('owner',cmd);assert.equal((await f.settled(p.id)).state,'unknown');await f.work.publish('owner',cmd);assert.equal(pushes,1);await assert.rejects(f.work.publish('owner',{...cmd,requestId:randomUUID()}),/original publication/);
});
test('branch validation rejects ref injection and malformed components',()=>{
  for(const name of ['main','feature/foo','release-1.0'])assert(gitBranch.safeParse(name).success);
  for(const name of ['--upload-pack=bad','a b','../main','foo.lock','main@{0}','a//b','foo/.hidden','/main','main:other'])assert(!gitBranch.safeParse(name).success,name);
});
test('GitHub device flow isolates credentials, exposes only its owner code, encrypts the result and cleans temporary storage',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nova-github-')),store=new Store(directory);let release!:()=>void;
  const held=new Promise<void>(r=>release=r);const calls:{args:string[];env:NodeJS.ProcessEnv|undefined}[]=[];
  const run:HostCommand=async(_exe,args,opts)=>{calls.push({args,env:opts?.env});if(args.includes('login')){opts?.output?.('! First copy your one-time code: AB12-CD34');await held;return Buffer.from('');}return Buffer.from(args.includes('token')?'test-secret-token':'gh fixture');};
  const github=new GitHubConnection(store,run,api);t.after(async()=>{release();await github.close();store.close();await rm(directory,{recursive:true,force:true});});
  await github.action('one',{requestId:randomUUID(),epoch:store.epoch,action:'connect'});
  for(let i=0;i<100&&(await github.state('one')).attempt?.state!=='waiting';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await github.state('one')).attempt?.code,'AB12-CD34');assert.equal((await github.state('two')).attempt?.code,undefined);
  release();for(let i=0;i<100&&!(await github.state('one')).account;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await github.state('one')).account?.login,'sample');assert(!JSON.stringify(await github.state('one')).includes('test-secret-token'));assert(calls.find(c=>c.args.includes('login'))?.env?.GH_CONFIG_DIR?.startsWith(directory));
  await github.close();assert.deepEqual(await readdir(join(directory,'github-signin')),[]);assert(!(await readFile(join(directory,'workspace.sqlite'))).includes(Buffer.from('test-secret-token')));
  const c=store.internalRead<any>('work:github:credential')!;store.internalWrite('work:github:credential',{...c,epoch:randomUUID()});assert.equal(github.credential(),undefined);
});
