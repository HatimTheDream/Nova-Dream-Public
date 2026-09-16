import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/service/http.js';

test('host work routes require the workspace session, origin and current epoch without importing ambient GitHub credentials',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'nova-work-http-')),server=await startServer({directory,port:0});
  t.after(async()=>{await server.close();rmSync(directory,{recursive:true,force:true});});
  const session=await fetch(server.origin+'/api/session',{method:'POST',headers:{'X-Edition3-Client':'1','Content-Type':'application/json'},body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0];
  for(const path of ['work/github','work/state','work/team','work/browser'])assert.equal((await fetch(server.origin+'/api/'+path)).status,401);
  const get=async(path:string)=>(await fetch(server.origin+'/api/'+path,{headers:{cookie}})).json();
  assert.equal((await get('work/github')).account,null);assert.deepEqual((await get('work/state')).checkouts,[]);assert.equal((await get('work/browser')).enabled,false);
  const post=(path:string,body:unknown,origin=server.origin)=>fetch(server.origin+'/api/'+path,{method:'POST',headers:{cookie,Origin:origin,'X-Edition3-Client':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
  const command={requestId:randomUUID(),epoch:server.store.epoch,action:'disconnect'};
  assert.equal((await post('work/github',command,'https://foreign.example')).status,403);
  assert.equal((await post('work/github',{...command,epoch:randomUUID()})).status,409);
  assert.equal((await post('work/github',command)).status,200);
  const team={requestId:randomUUID(),epoch:server.store.epoch,projectId:'missing',title:'Work',brief:'Check',steps:[{agentId:'a',role:'research'},{agentId:'b',role:'build'}]};
  assert.equal((await post('work/team/start',team)).status,409);assert.deepEqual((await get('work/team')).runs,[]);
});
