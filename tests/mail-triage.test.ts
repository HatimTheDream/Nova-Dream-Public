import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { Accounts } from '../apps/service/accounts';
import { Providers, accountCapabilities } from '../apps/service/providers';
import { MailTriageService } from '../apps/service/mail-triage';
import { startServer } from '../apps/service/http';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailTriageAction, MailTriagePlan } from '../packages/domain/mail-triage';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('triage HTTP routes require client authority, session and exact input contracts',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'edition3-triage-http-'));
  const server=await startServer({directory,port:0});
  try {
    const body=JSON.stringify({epoch:server.store.epoch,planId:randomUUID()});
    const missing=await fetch(server.origin+'/api/mail/triage/read',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(missing.status,403);
    const noSession=await fetch(server.origin+'/api/mail/triage/read',{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1'},body});assert.equal(noSession.status,401);
    const session=await fetch(server.origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1'},body:'{}'}),cookie=session.headers.get('set-cookie')!.split(';')[0];
    const extra=await fetch(server.origin+'/api/mail/triage/read',{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1',cookie},body:JSON.stringify({...JSON.parse(body),accountId:'another-account'})});assert.equal(extra.status,400);
  }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});
test('schema 10 upgrade keeps encrypted account and mail records and fences older services with the current schema',()=>{
  const directory=mkdtempSync(join(tmpdir(),'edition3-triage-upgrade-'));let store=new Store(directory);
  try {
    const epoch=store.epoch,kept={draft:'Existing provider draft',revision:7};store.internalWrite('mail:delivery:fixture',kept);store.close();
    const before=new DatabaseSync(join(directory,'workspace.sqlite'));before.exec('PRAGMA user_version=10');before.close();
    store=new Store(directory);assert.equal(store.epoch,epoch);assert.deepEqual(store.internalRead('mail:delivery:fixture'),kept);
    const after=new DatabaseSync(join(directory,'workspace.sqlite'));assert.equal((after.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,55);after.close();
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
function fixture(provider:'google'|'microsoft') {
  const directory=mkdtempSync(join(tmpdir(),'edition3-triage-'));let store=new Store(directory),now=Date.now();
  const scopes=provider==='google'?['https://www.googleapis.com/auth/gmail.modify']:['Mail.ReadWrite'];
  const account:ConnectedAccount={id:provider+':'+randomUUID().replaceAll('-',''),generation:randomUUID(),provider,subject:'fixture',email:'studio@example.test',label:'Studio',revision:1,state:'connected',scopes,capabilities:accountCapabilities(provider,scopes),connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.internalWrite('accounts:item:'+account.id,account);
  store.internalWrite('accounts:credential:'+account.id,{generation:account.generation,configuration:provider==='google'?{provider,clientId:'fixture.apps.googleusercontent.com'}:{provider,clientId:randomUUID(),tenant:'common',callbackPort:4389},tokens:{accessToken:'fixture-token-only',expiresAt:now+3600000,scopes}});
  const messages=new Map<string,any>();
  const add=(id:string,draft=false)=>messages.set(id,provider==='google'?{id,threadId:'thread',labelIds:draft?['DRAFT']:['INBOX','UNREAD'],internalDate:String(now),payload:{headers:[{name:'Subject',value:'Studio planning'},{name:'From',value:'maya@example.test'}]}}:{id,conversationId:'thread',isDraft:draft,isRead:false,flag:{flagStatus:'notFlagged'},categories:[],parentFolderId:'inbox-id',changeKey:'1','@odata.etag':'W/"1"',subject:'Studio planning',from:{emailAddress:{address:'maya@example.test'}},receivedDateTime:new Date(now).toISOString()});
  add('m1');add('m2');add('draft',true);
  const writes:{id:string;path:string;body:any;headers:Headers}[]=[];
  let failId='',loseId='',losePath='',page=false,evil=false,noEtag=false,onWrite:((id:string)=>void)|undefined;
  const providers=new Providers((async(raw:any,init:RequestInit={})=>{
    const url=new URL(String(raw)),path=url.pathname,id=decodeURIComponent(path.match(/\/messages\/([^/]+)/)?.[1]??'');
    const method=init.method??'GET';
    if(method==='GET') {
      if(path.endsWith('/labels'))return json({labels:[{id:'Label_1',name:'Studio',type:'user'}]});
      if(path.includes('/mailFolders/'))return json({id:path.includes('deleteditems')?'trash-id':'archive-id'});
      if(path.endsWith('/threads/thread'))return json({id:'thread',messages:[...messages.values()]});
      if(id){const value=structuredClone(messages.get(id));if(!value)return json({},404);if(noEtag)delete value['@odata.etag'];return json(value);}
      if(path.endsWith('/messages')) {
        const all=[...messages.values()],next=url.searchParams.has('$skiptoken');
        return json({value:page?(next?all.slice(1):all.slice(0,1)):all,...(page&&!next?{'@odata.nextLink':evil?'https://outside.invalid/v1.0/me/messages?secret=x':'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2'}:{})});
      }
      throw Error('Unexpected read '+path);
    }
    const body=init.body?JSON.parse(String(init.body)):{},m=messages.get(id);writes.push({id,path,body,headers:new Headers(init.headers)});
    if(id===failId)return json({},403);
    onWrite?.(id);
    if(provider==='google') {
      const labels=new Set<string>(m.labelIds);
      if(path.endsWith('/trash')){labels.add('TRASH');labels.delete('INBOX');labels.delete('SPAM');}
      else if(path.endsWith('/untrash'))labels.delete('TRASH');
      else {for(const label of body.addLabelIds??[])labels.add(label);for(const label of body.removeLabelIds??[])labels.delete(label);}
      m.labelIds=[...labels];
    }else {
      assert.equal(new Headers(init.headers).get('Prefer'),'IdType="ImmutableId"');
      if(path.endsWith('/move'))m.parentFolderId=body.destinationId;else Object.assign(m,body);
      m.changeKey=String(Number(m.changeKey)+1);m['@odata.etag']=`W/"${m.changeKey}"`;
    }
    if(id===loseId&&(!losePath||path.endsWith(losePath)))throw Error('Provider applied it, response lost');
    return json(m,path.endsWith('/move')?201:200);
  }) as typeof fetch);
  let accounts=new Accounts(store,providers),service=new MailTriageService(store,accounts,()=>now);
  const input=(action:MailTriageAction)=>({epoch:store.epoch,requestId:randomUUID(),writerId:randomUUID(),action,...(action.includes('organization')||action==='organize'?{organization:'Studio'}:{}),targets:[{provider:provider==='google'?'gmail' as const:'microsoft' as const,accountId:account.id,generation:account.generation,threadId:'thread'}]});
  const confirm=(plan:MailTriagePlan,decision:'apply'|'cancel'|'undo'|'acknowledge'='apply')=>({epoch:store.epoch,requestId:randomUUID(),planId:plan.id,expectedRevision:plan.revision,digest:decision==='undo'?plan.receipt!.undo.digest!:plan.digest,decision});
  return {account,messages,writes,input,confirm,add,get store(){return store;},get service(){return service;},set failId(value:string){failId=value;},set loseId(value:string){loseId=value;},set losePath(value:string){losePath=value;},set page(value:boolean){page=value;},set evil(value:boolean){evil=value;},set noEtag(value:boolean){noEtag=value;},set onWrite(value:((id:string)=>void)|undefined){onWrite=value;},advance(ms:number){now+=ms;},
    async restart(){await service.close();await accounts.close();store.close();store=new Store(directory);accounts=new Accounts(store,providers);service=new MailTriageService(store,accounts,()=>now);},
    async close(){await service.close();await accounts.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

for(const provider of ['google','microsoft'] as const)for(const action of ['mark-read','mark-unread','flag','unflag','archive','delete','organize','remove-organization'] as const)test(`${provider} original ${action} review changes exact non-draft messages and undo restores only its fields`,async()=>{
  const f=fixture(provider);
  try {
    for(const m of f.messages.values())if(m.id!=='draft') {
      if(action==='mark-unread'){if(provider==='google')m.labelIds=m.labelIds.filter((l:string)=>l!=='UNREAD');else m.isRead=true;}
      if(action==='unflag'){if(provider==='google')m.labelIds.push('STARRED');else m.flag.flagStatus='flagged';}
      if(action==='remove-organization'){if(provider==='google')m.labelIds.push('Label_1');else m.categories.push('Studio');}
    }
    const before=structuredClone([...f.messages.values()]),prepared=await f.service.prepare('device',f.input(action));
    assert.equal(prepared.status,'awaiting_confirmation');assert.equal(prepared.messageCount,2);assert.equal(f.writes.length,0);
    const command=f.confirm(prepared),result=await f.service.confirm('device',command);
    assert.equal(result.status,'completed');assert.equal(result.outcomes.filter(o=>o.state==='applied').length,2);assert.equal(result.canUndo,true);assert.ok(f.writes.every(w=>w.id!=='draft'));
    await f.service.confirm('device',command);assert.equal(f.writes.length,2);
    for(const m of f.messages.values())if(m.id!=='draft'){if(provider==='google')m.labelIds.push('Unrelated');else m.categories.push('Unrelated');}
    const undone=await f.service.confirm('device',f.confirm(result,'undo'));assert.equal(undone.receipt?.status,'undone');
    for(const original of before){const current=f.messages.get(original.id);if(original.id==='draft')assert.deepEqual(current,original);else if(provider==='google')assert.deepEqual([...current.labelIds].sort(),[...original.labelIds,'Unrelated'].sort());else{assert.equal(current.isRead,original.isRead);assert.deepEqual(current.flag,original.flag);assert.equal(current.parentFolderId,original.parentFolderId);assert.deepEqual(current.categories.sort(),[...original.categories,'Unrelated'].sort());}}
  }finally{await f.close();}
});

test('mixed thread state still includes the messages that need a change; changed membership stops the complete review before writes',async()=>{
  const f=fixture('google');try {
    f.messages.get('m1').labelIds.push('STARRED');const prepared=await f.service.prepare('device',f.input('flag'));assert.equal(prepared.messageCount,1);assert.equal(prepared.outcomes[0].messageId,'m2');
    f.add('new-arrival');const result=await f.service.confirm('device',f.confirm(prepared));assert.equal(result.status,'partial');assert.equal(result.outcomes[0].state,'failed');assert.equal(f.writes.length,0);
  }finally{await f.close();}
});
test('partial provider rejection and a lost response stay distinct across restart; checking never writes again',async()=>{
  const f=fixture('google');try {
    f.failId='m1';f.loseId='m2';const prepared=await f.service.prepare('device',f.input('flag')),command=f.confirm(prepared),result=await f.service.confirm('device',command);
    assert.deepEqual(result.outcomes.map(o=>o.state),['failed','uncertain']);assert.equal(result.canCheck,true);assert.equal(f.writes.length,2);
    await f.restart();await f.service.confirm('device',command);assert.equal(f.writes.length,2);
    await assert.rejects(f.service.prepare('device',f.input('unflag')),/unresolved/);
    const checked=await f.service.reconcile('device',{epoch:f.store.epoch,planId:prepared.id});assert.equal(checked.outcomes[1].state,'observed');assert.equal(checked.outcomes[1].undo,'unsupported');assert.equal(f.writes.length,2);assert.equal(checked.canCheck,false);
    assert.equal((await f.service.prepare('device',f.input('unflag'))).messageCount,1);
  }finally{await f.close();}
});
test('uncertain state mismatch is kept until an explicit read-and-acknowledge decision; no blind retry',async()=>{
  const f=fixture('google');try {
    f.loseId='m1';const result=await f.service.confirm('device',f.confirm(await f.service.prepare('device',f.input('flag'))));
    f.messages.get('m1').labelIds=f.messages.get('m1').labelIds.filter((l:string)=>l!=='STARRED');
    const checked=await f.service.reconcile('device',{epoch:f.store.epoch,planId:result.id});assert.equal(checked.canCheck,true);
    const acknowledged=await f.service.confirm('device',f.confirm(checked,'acknowledge'));assert.equal(acknowledged.outcomes[0].state,'observed');assert.equal(acknowledged.canCheck,false);assert.equal(f.writes.length,2);
  }finally{await f.close();}
});
test('undo stops when its touched field changed, while preserving other confirmed message results',async()=>{
  const f=fixture('microsoft');try {
    const result=await f.service.confirm('device',f.confirm(await f.service.prepare('device',f.input('flag'))));f.messages.get('m1').flag.flagStatus='complete';
    const undone=await f.service.confirm('device',f.confirm(result,'undo'));assert.equal(undone.outcomes[0].undo,'failed');assert.equal(undone.outcomes[1].undo,'undone');assert.equal(f.messages.get('m1').flag.flagStatus,'complete');assert.equal(f.writes.length,3);
  }finally{await f.close();}
});
test('Outlook verifies every conversation page, rejects foreign continuations, and requires a real category validator',async()=>{
  const f=fixture('microsoft');try {
    f.page=true;const prepared=await f.service.prepare('device',f.input('organize'));assert.equal(prepared.messageCount,2);
    f.noEtag=true;const result=await f.service.confirm('device',f.confirm(prepared));assert.equal(result.outcomes[0].state,'failed');assert.equal(f.writes.length,0);
    f.evil=true;await assert.rejects(f.service.prepare('device',f.input('flag')),/continuation/);assert.equal(f.writes.length,0);
  }finally{await f.close();}
});
test('lost Gmail untrash response keeps partial undo inspectable and never repeats either undo stage',async()=>{
  const f=fixture('google');try {
    const result=await f.service.confirm('device',f.confirm(await f.service.prepare('device',f.input('delete'))));f.loseId='m1';f.losePath='/untrash';
    const undone=await f.service.confirm('device',f.confirm(result,'undo'));assert.equal(undone.outcomes[0].undo,'uncertain');assert.equal(undone.outcomes[1].undo,'undone');const count=f.writes.length;
    await f.restart();const checked=await f.service.reconcile('device',{epoch:f.store.epoch,planId:result.id});assert.equal(checked.outcomes[0].undo,'observed');assert.equal(f.writes.length,count);assert.equal(f.messages.get('m1').labelIds.includes('INBOX'),false);
  }finally{await f.close();}
});
test('review authority, digest, expiry, disconnected accounts, and lost preparation replay do not dispatch writes',async()=>{
  const f=fixture('google');try {
    const input=f.input('flag'),prepared=await f.service.prepare('device',input);assert.equal((await f.service.prepare('device',input)).id,prepared.id);
    assert.throws(()=>f.service.read('other',{epoch:f.store.epoch,planId:prepared.id}),/unavailable/);
    await assert.rejects(f.service.confirm('device',{...f.confirm(prepared),digest:'0'.repeat(64)}),/changed/);
    await assert.rejects(f.service.confirm('device',{...f.confirm(prepared),epoch:randomUUID()}),/recovery/);
    f.advance(11*60000);await assert.rejects(f.service.confirm('device',f.confirm(prepared)),/expired/);
    const cancelled=await f.service.confirm('device',f.confirm(prepared,'cancel'));assert.equal(cancelled.status,'cancelled');
    f.store.internalWrite('accounts:item:'+f.account.id,{...f.account,state:'disconnected',generation:randomUUID()});await assert.rejects(f.service.prepare('device',f.input('flag')),/connection changed/);assert.equal(f.writes.length,0);
  }finally{await f.close();}
});
test('affirmative responses remain recorded when disconnect happens in flight',async()=>{
  const f=fixture('google');try {
    const prepared=await f.service.prepare('device',f.input('flag'));f.onWrite=()=>f.store.internalWrite('accounts:item:'+f.account.id,{...f.account,state:'disconnected',generation:randomUUID()});
    const result=await f.service.confirm('device',f.confirm(prepared));assert.ok(result.outcomes.some(o=>o.state==='applied'));assert.equal(result.outcomes.filter(o=>o.state==='uncertain').length,0);
  }finally{await f.close();}
});

for(const provider of ['google','microsoft'] as const)test(`${provider} rendered-mail opening changes only displayed non-draft messages and replays never overwrite Mark unread`,async()=>{
 const f=fixture(provider);try{
  const input={epoch:f.store.epoch,requestId:randomUUID(),target:f.input('mark-read').targets[0],messageIds:['m1','draft']};
  const result=await f.service.displayed('device',input);assert.equal(result.plan?.status,'completed');assert.deepEqual(f.writes.map(w=>w.id),['m1']);
  assert.equal(provider==='google'?f.messages.get('m2').labelIds.includes('UNREAD'):!f.messages.get('m2').isRead,true);
  if(provider==='google')f.messages.get('m1').labelIds.push('UNREAD');else f.messages.get('m1').isRead=false;
  await f.service.displayed('device',input);await f.restart();await f.service.displayed('device',input);assert.equal(f.writes.length,1);
  assert.equal(provider==='google'?f.messages.get('m1').labelIds.includes('UNREAD'):!f.messages.get('m1').isRead,true);
  await assert.rejects(f.service.displayed('device',{...input,requestId:randomUUID(),messageIds:['wrong-message']}),/changed/);
  await assert.rejects(f.service.displayed('device',{...input,requestId:randomUUID(),target:{...input.target,generation:randomUUID()}}),/connection changed/);assert.equal(f.writes.length,1);
  f.store.internalWrite('accounts:item:'+f.account.id,{...f.account,scopes:provider==='google'?['https://www.googleapis.com/auth/gmail.readonly']:['Mail.Read']});await assert.rejects(f.service.displayed('device',{...input,requestId:randomUUID(),messageIds:['m2']}),/permission/);assert.equal(f.writes.length,1);
 }finally{await f.close();}
});
test('rendered-mail rejection and response loss keep durable results without repeating a write',async()=>{
 const f=fixture('google');try{
  f.loseId='m1';const input={epoch:f.store.epoch,requestId:randomUUID(),target:f.input('mark-read').targets[0],messageIds:['m1']};
  const result=await f.service.displayed('device',input);assert.equal(result.plan?.outcomes[0].state,'uncertain');
  await f.restart();await f.service.displayed('device',input);assert.equal(f.writes.length,1);
  f.failId='m2';const denied=await f.service.displayed('device',{...input,requestId:randomUUID(),messageIds:['m2']});assert.equal(denied.plan?.outcomes[0].state,'failed');
  assert.ok(f.messages.get('m2').labelIds.includes('UNREAD'));
 }finally{await f.close();}
});
