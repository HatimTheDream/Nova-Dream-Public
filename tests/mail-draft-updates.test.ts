import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { Accounts } from '../apps/service/accounts';
import { Providers, accountCapabilities } from '../apps/service/providers';
import { MailDeliveryService } from '../apps/service/mail-delivery';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailDeliveryReview } from '../packages/domain/mail-delivery';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function fixture(provider:'google'|'microsoft') {
  const directory=mkdtempSync(join(tmpdir(),'e3-draft-update-'));let store=new Store(directory);
  const scopes=provider==='google'?['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose']:['Mail.ReadWrite','Mail.Send'];
  const account:ConnectedAccount={id:randomUUID(),generation:randomUUID(),provider,subject:'fixture',email:'studio@example.test',label:'Fixture',revision:1,state:'connected',scopes,capabilities:accountCapabilities(provider,scopes),connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.internalWrite('accounts:item:'+account.id,account);
  store.internalWrite('accounts:credential:'+account.id,{generation:account.generation,configuration:provider==='google'?{provider,clientId:'fixture.apps.googleusercontent.com'}:{provider,clientId:randomUUID(),tenant:'common',callbackPort:4389},tokens:{accessToken:'fixture-only',expiresAt:Date.now()+3600000,scopes}});
  let sequence=0, raw='', headerList:{name:string;value:string}[]=[], plain='', graph:any;
  let drop:string|undefined,etag=true,race=false;
  const effects:{action:string;body:any}[]=[], calls:{method:string;path:string}[]=[];
  const files:any[]=[];
  const gmail=()=>({id:'draft',message:{id:`m${sequence}`,threadId:'thread',labelIds:['DRAFT'],payload:{mimeType:'text/plain',headers:headerList,body:{data:Buffer.from(plain).toString('base64url'),size:Buffer.byteLength(plain)}}}});
  const parsedMime=(value:string)=>{
    raw=Buffer.from(value,'base64url').toString();
    const split=raw.indexOf('\r\n\r\n');plain=/Content-Transfer-Encoding: base64/i.test(raw.slice(0,split))?Buffer.from(raw.slice(split+4).replace(/\s/g,''),'base64').toString():raw.slice(split+4).trimEnd();
    headerList=raw.slice(0,split).replace(/\r\n[ \t]+/g,' ').split('\r\n').map(line=>({name:line.slice(0,line.indexOf(':')),value:line.slice(line.indexOf(':')+1).trim()}));
  };
  const providers=new Providers((async(input:any,init:RequestInit={})=>{
    const url=new URL(String(input)),path=url.pathname.replace(/^\/gmail\/v1\/users\/me|^\/v1.0\/me/,''),method=init.method??'GET';calls.push({method,path});
    let result:Response;
    if(provider==='google') {
      if(method==='GET'&&path==='/drafts/draft')return json(gmail());
      if(method==='GET'&&path==='/drafts')return json({drafts:[{id:'draft',message:{id:`m${sequence}`}}]});
      if(method==='GET'&&path==='/messages')return json({messages:[{id:'sent'}]});
      if(method==='GET'&&path.startsWith('/messages/'))return json({...gmail().message,id:path.split('/').pop(),labelIds:path==='/messages/sent'?['SENT']:['DRAFT']});
      const payload=JSON.parse(String(init.body));
      if((method==='POST'&&path==='/drafts')||(method==='PUT'&&path==='/drafts/draft')) {
        if(method==='PUT')assert.equal(payload.id,'draft');sequence++;parsedMime(payload.message.raw);effects.push({action:method==='PUT'?'update':'create',body:structuredClone(payload)});result=json({id:'draft',message:{id:`m${sequence}`,threadId:'thread'}});
      }else if(method==='POST'&&path==='/drafts/send') {
        assert.equal(payload.id,'draft');parsedMime(payload.message.raw);effects.push({action:'send',body:structuredClone(payload)});result=json({id:'sent',threadId:'thread'});
      }else throw Error(`Unexpected Google ${method} ${path}`);
    }else{
      if(method==='GET'&&path==='/messages/draft/attachments')return json({value:files});
      if(method==='GET'&&path==='/messages/draft')return json({...graph,...(etag?{'@odata.etag':`W/"v${sequence}"`}:{})});
      if(method==='GET'&&path==='/messages')return json({value:graph&&!graph.isDraft?[graph]:[]});
      if(method==='GET'&&path==='/mailFolders/sentitems')return json({id:'sentitems'});
      if(method==='POST'&&path==='/messages') {
        const body=JSON.parse(String(init.body));sequence++;graph={...body,id:'draft',isDraft:true,changeKey:`v${sequence}`,parentFolderId:'drafts',from:{emailAddress:{address:account.email}},hasAttachments:false};effects.push({action:'create',body});result=json(graph,201);
      }else if(method==='PATCH'&&path==='/messages/draft') {
        if(race){race=false;sequence++;graph.changeKey=`v${sequence}`;}
        if(new Headers(init.headers).get('If-Match')!==`W/"v${sequence}"`)return json({error:'conflict'},412);
        const body=JSON.parse(String(init.body));sequence++;graph={...graph,...body,changeKey:`v${sequence}`};effects.push({action:'update',body});result=json(graph);
      }else if(method==='POST'&&path==='/messages/draft/send') {
        assert.equal(new Headers(init.headers).get('If-Match'),`W/"v${sequence}"`);
        assert.equal(new Headers(init.headers).get('Content-Length'),'0');assert.equal(init.body,undefined);
        graph={...graph,isDraft:false,parentFolderId:'sentitems'};effects.push({action:'send',body:structuredClone(graph)});result=new Response(null,{status:202});
      }else throw Error(`Unexpected Graph ${method} ${path}`);
    }
    if(drop===effects.at(-1)?.action){drop=undefined;throw Error('Response lost after effect');}
    return result;
  }) as typeof fetch);
  let accounts=new Accounts(store,providers),delivery=new MailDeliveryService(store,accounts);
  const writerId=randomUUID();
  const input=(body='Before')=>({epoch:store.epoch,requestId:randomUUID(),accountId:account.id,generation:account.generation,writerId,mode:'draft' as 'draft'|'send',message:{from:account.email,to:['maya@example.test'],cc:[],bcc:[],subject:'Draft subject',bodyText:body,attachments:[]}});
  const confirm=(review:MailDeliveryReview)=>({epoch:store.epoch,requestId:randomUUID(),operationId:review.id,expectedRevision:review.revision,digest:review.digest!,decision:'confirm' as const});
  const edit=(review:MailDeliveryReview,body='After',mode:'draft'|'send'='draft')=>({...input(body),mode,previous:{operationId:review.id,expectedRevision:review.revision,digest:review.digest!}});
  const save=async()=>{const prepared=await delivery.prepare('device',input());return delivery.confirm('device',confirm(prepared));};
  return {input,confirm,edit,save,account,effects,calls,files,get delivery(){return delivery;},get store(){return store;},get plain(){return plain;},get graph(){return graph;},
    drop(action:string){drop=action;},etag(value:boolean){etag=value;},race(){race=true;},
    externalEdit(){sequence++;if(provider==='google'){plain='Provider writing';headerList=headerList.filter(h=>h.name!=='Subject').concat({name:'Subject',value:'Changed remotely'});}else{graph.changeKey=`v${sequence}`;graph.subject='Changed remotely';graph.body={contentType:'text',content:'Provider writing'};}},
    async restart(){await delivery.close();await accounts.close();store.close();store=new Store(directory);accounts=new Accounts(store,providers);delivery=new MailDeliveryService(store,accounts);},
    async close(){await delivery.close();await accounts.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

for(const provider of ['google','microsoft'] as const) {
  test(`${provider}: saved draft edits retain its ID and lineage, then send the reviewed updated message`,async()=>{
    const f=fixture(provider);try {
      const first=await f.save();assert.equal(first.state,'saved');
      const edit=await f.delivery.prepare('device',f.edit(first));assert.equal(edit.state,'prepared');assert.equal(edit.draft?.changed,false);assert.equal(edit.previousOperationId,first.id);
      const updated=await f.delivery.confirm('device',f.confirm(edit));assert.equal(updated.state,'saved');assert.equal(updated.providerDraftId,first.providerDraftId);
      await assert.rejects(f.delivery.prepare('device',f.edit(first,'Stale window')),/saved mail operation/);
      const sending=await f.delivery.prepare('device',f.edit(updated,'Final reviewed body','send'));assert.equal(sending.state,'prepared');
      const sent=await f.delivery.confirm('device',f.confirm(sending));assert.equal(sent.state,'accepted');assert.equal(sent.providerDraftId,'draft');
      assert.deepEqual(f.effects.map(e=>e.action),provider==='google'?['create','update','send']:['create','update','update','send']);
      assert.equal(provider==='google'?f.plain.trim():f.effects.at(-1)!.body.body.content,'Final reviewed body');
      assert.equal(f.delivery.read('device',{epoch:f.store.epoch,operationId:first.id}).message.bodyText,'Before');
    }finally{await f.close();}
  });
  test(`${provider}: remote changes are disclosed in review and later changes prevent an overwrite`,async()=>{
    const f=fixture(provider);try{
      const first=await f.save();f.externalEdit();const review=await f.delivery.prepare('device',f.edit(first));
      assert.equal(review.state,'prepared');assert.equal(review.draft?.changed,true);assert.equal(review.draft?.bodyText,'Provider writing');
      f.externalEdit();const stopped=await f.delivery.confirm('device',f.confirm(review));assert.equal(stopped.state,'failed');assert.match(stopped.detail??'',/changed after review/);assert.equal(f.effects.length,1);
      const fresh=await f.delivery.prepare('device',f.edit(first,'Explicit replacement'));assert.equal(fresh.state,'prepared');
      assert.equal((await f.delivery.confirm('device',f.confirm(fresh))).state,'saved');assert.equal(f.effects.length,2);
    }finally{await f.close();}
  });
  test(`${provider}: a lost update response reconciles the same provider draft after restart without another update`,async()=>{
    const f=fixture(provider);try{
      const first=await f.save(),review=await f.delivery.prepare('device',f.edit(first));f.drop('update');const command=f.confirm(review);
      assert.equal((await f.delivery.confirm('device',command)).state,'uncertain');await f.restart();
      assert.equal((await f.delivery.confirm('device',command)).state,'uncertain');assert.equal(f.effects.length,2);
      const result=await f.delivery.reconcile('device',{epoch:f.store.epoch,operationId:review.id});assert.equal(result.state,'saved');assert.equal(result.providerDraftId,'draft');assert.equal(f.effects.length,2);
    }finally{await f.close();}
  });
  test(`${provider}: a lost saved-draft send reconciles Sent and never dispatches a second send`,async()=>{
    const f=fixture(provider);try{
      const first=await f.save(),review=await f.delivery.prepare('device',f.edit(first,'Send once','send'));f.drop('send');const command=f.confirm(review);
      assert.equal((await f.delivery.confirm('device',command)).state,'uncertain');await f.restart();
      const result=await f.delivery.reconcile('device',{epoch:f.store.epoch,operationId:review.id});assert.equal(result.state,'accepted');
      assert.equal((await f.delivery.confirm('device',command)).state,'accepted');assert.equal(f.effects.filter(e=>e.action==='send').length,1);
    }finally{await f.close();}
  });
}

test('Outlook checks inline attachments even when hasAttachments is false and never invents a missing ETag',async()=>{
  const f=fixture('microsoft');try{
    const first=await f.save();f.files.push({id:'inline',name:'inline.png',contentType:'image/png',size:3,contentBytes:'AQID','@odata.type':'#microsoft.graph.fileAttachment'});
    assert.equal((await f.delivery.prepare('device',f.edit(first))).state,'failed');assert.equal(f.effects.length,1);
    f.files.length=0;f.etag(false);const review=await f.delivery.prepare('device',f.edit(first));assert.equal(review.state,'prepared');
    const stopped=await f.delivery.confirm('device',f.confirm(review));assert.equal(stopped.state,'failed');assert.match(stopped.detail??'',/conditional draft version/);assert.equal(f.effects.length,1);
  }finally{await f.close();}
});

test('Outlook conditional rejection is a known failed update, and the original saved draft remains editable',async()=>{
  const f=fixture('microsoft');try{
    const first=await f.save(),review=await f.delivery.prepare('device',f.edit(first));f.race();
    const rejected=await f.delivery.confirm('device',f.confirm(review));assert.equal(rejected.state,'failed');assert.equal(f.effects.length,1);
    const fresh=await f.delivery.prepare('device',f.edit(first));assert.equal(fresh.draft?.changed,true);assert.equal((await f.delivery.confirm('device',f.confirm(fresh))).state,'saved');
  }finally{await f.close();}
});

test('Outlook lost update during draft-to-send recovers its saved stage and requires a new explicit confirmation to send',async()=>{
  const f=fixture('microsoft');try{
    const first=await f.save(),review=await f.delivery.prepare('device',f.edit(first,'Continue only after review','send'));
    f.drop('update');const original=f.confirm(review);
    assert.equal((await f.delivery.confirm('device',original)).state,'uncertain');
    assert.deepEqual(f.effects.map(effect=>effect.action),['create','update']);
    await f.restart();
    const recovered=await f.delivery.reconcile('device',{epoch:f.store.epoch,operationId:review.id});
    assert.equal(recovered.state,'interrupted');assert.equal(recovered.canEditDraft,true);
    assert.equal((await f.delivery.confirm('device',original)).state,'interrupted');
    assert.deepEqual(f.effects.map(effect=>effect.action),['create','update']);
    assert.equal((await f.delivery.confirm('device',f.confirm(recovered))).state,'accepted');
    assert.deepEqual(f.effects.map(effect=>effect.action),['create','update','send']);
    assert.equal(f.effects.at(-1)!.body.body.content,'Continue only after review');
  }finally{await f.close();}
});

test('two windows preparing the same saved-draft edit converge; another device cannot edit its operation',async()=>{
  const f=fixture('google');try{
    const first=await f.save(),input=f.edit(first);
    const [left,right]=await Promise.all([f.delivery.prepare('device',input),f.delivery.prepare('device',{...input,requestId:randomUUID()})]);
    assert.equal(left.id,right.id);assert.equal(f.effects.length,1);
    await assert.rejects(f.delivery.prepare('other-device',f.edit(first)),/unavailable/);
    await assert.rejects(f.delivery.prepare('device',{...f.edit(first),writerId:randomUUID()}),/current saved draft/);
    assert.equal((await f.delivery.confirm('device',f.confirm(left))).state,'saved');assert.equal(f.effects.length,2);
  }finally{await f.close();}
});
