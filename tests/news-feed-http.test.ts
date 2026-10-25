import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/service/http';
import {phoneRouteAllowed} from '../apps/service/phone-policy';
import {emptyFeedSettings} from '../packages/domain/news-feed';
test('Feed state, exact receipts and source checks require the existing session and origin boundary',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-feed-http-')),server=await startServer({port:0,directory:dir,version:'test'});
 try{
  const base=server.origin;
  assert.equal((await fetch(base+'/api/home/news')).status,401);
  const session=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Edition3-Client':'1'},body:'{}'});
  const cookie=session.headers.get('set-cookie')!.split(';')[0],headers={Origin:base,'Content-Type':'application/json','X-Edition3-Client':'1',Cookie:cookie};
  const post=(path:string,value:unknown,override:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(value)});
  const state=await (await fetch(base+'/api/home/news',{headers})).json();assert.equal(state.stories.length,0);assert.equal(state.interpretation.status,'unconfigured');
  const command={requestId:randomUUID(),epoch:server.store.epoch,expectedRevision:state.value.revision,type:'settings',settings:{...emptyFeedSettings(),interests:['Writing']}};
  assert.equal((await post('/api/home/news',command,{Origin:'https://foreign.example'})).status,403);
  assert.equal((await post('/api/home/news',{...command,privateConversations:true})).status,400);
  const saved=await (await post('/api/home/news',command)).json();assert.equal(saved.state,'saved');
  assert.deepEqual(await (await post('/api/home/news/receipt',command)).json(),saved);
  const missing={requestId:randomUUID(),epoch:server.store.epoch,sourceId:'source:absent',profileRevision:saved.profileRevision};
  const refused=await (await post('/api/home/news/refresh',missing)).json();assert.equal(refused.state,'rejected');assert.equal(refused.source,null);
  assert.deepEqual(await (await post('/api/home/news/refresh/receipt',missing)).json(),refused);
  assert.deepEqual(await (await post('/api/home/news/refresh',missing)).json(),refused);
  assert.equal(server.store.internalList('home:news:refresh:').length,0);
 }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
});
test('paired-phone news paths are exact and add no neighboring permission routes',()=>{
 assert.equal(phoneRouteAllowed('/api/home/news','GET'),true);
 for(const path of ['/api/home/news','/api/home/news/receipt','/api/home/news/refresh','/api/home/news/refresh/receipt']){
  assert.equal(phoneRouteAllowed(path,'POST'),true);
  for(const suffix of ['/grant','/','-grant','?admin=1'])assert.equal(phoneRouteAllowed(path+suffix,'POST'),false);
  for(const method of ['PUT','DELETE','PATCH'])assert.equal(phoneRouteAllowed(path,method),false);
 }
 assert.equal(phoneRouteAllowed('/api/home/news/refresh','GET'),false);
});
