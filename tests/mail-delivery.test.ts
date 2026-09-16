import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { Accounts } from '../apps/service/accounts';
import { MailDeliveryService } from '../apps/service/mail-delivery';
import { startServer } from '../apps/service/http';
import { Providers, accountCapabilities } from '../apps/service/providers';
import type { MailDeliveryReview } from '../packages/domain/mail-delivery';
import type { ConnectedAccount } from '../packages/domain/accounts';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
function fixture(provider:'google'|'microsoft',respond:(url:URL,init:RequestInit)=>Promise<Response>|Response) {
  const directory=mkdtempSync(join(tmpdir(),'edition3-delivery-'));let store=new Store(directory);
  const scopes=provider==='google'?['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose']:['Mail.ReadWrite','Mail.Send'];
  const account:ConnectedAccount={id:randomUUID(),generation:randomUUID(),provider,subject:'mail-fixture',email:'studio@example.test',label:'Studio',revision:1,state:'connected',scopes,capabilities:accountCapabilities(provider,scopes),connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.internalWrite('accounts:item:'+account.id,account);
  store.internalWrite('accounts:credential:'+account.id,{generation:account.generation,configuration:provider==='google'?{provider,clientId:'fixture.apps.googleusercontent.com'}:{provider,clientId:randomUUID(),tenant:'common',callbackPort:4389},tokens:{accessToken:'fixture-token-only',expiresAt:Date.now()+3600000,scopes}});
  const calls:{url:URL;init:RequestInit}[]=[];
  const providers=new Providers((async(input:any,init:RequestInit={})=>{const url=new URL(String(input));calls.push({url,init});return respond(url,init);}) as typeof fetch);
  let accounts=new Accounts(store,providers),delivery=new MailDeliveryService(store,accounts);
  const message={from:account.email,to:['maya@example.test'],cc:['alex@example.test'],bcc:['private@example.test'],subject:'Planning — café',bodyText:'Keep every word.\n<literal> 😀',bodyHtml:'<p>Keep every word.</p><p>&lt;literal&gt; 😀</p>',attachments:[]};
  const input=()=>({epoch:store.epoch,requestId:randomUUID(),accountId:account.id,generation:account.generation,writerId:randomUUID(),mode:'draft' as 'draft'|'send',message});
  const confirm=(review:MailDeliveryReview)=>({epoch:store.epoch,requestId:randomUUID(),operationId:review.id,expectedRevision:review.revision,digest:review.digest!,decision:'confirm' as const});
  return {directory,account,calls,input,confirm,get store(){return store;},get delivery(){return delivery;},get accounts(){return accounts;},
    async restart(){await delivery.close();await accounts.close();store.close();store=new Store(directory);accounts=new Accounts(store,providers);delivery=new MailDeliveryService(store,accounts);},
    async close(){await delivery.close();await accounts.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('original Gmail reply fields, alias, quote, Unicode, Bcc and exact attachment bytes reach one reviewed MIME draft',async()=>{
  let raw='';
  const f=fixture('google',(url,init)=>{
    if(url.pathname.endsWith('/settings/sendAs'))return json({sendAs:[{sendAsEmail:'alias@example.test',verificationStatus:'accepted'}]});
    if(url.pathname.endsWith('/messages/source'))return json({id:'source',threadId:'thread',payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Planning — café'},{name:'From',value:'Maya <maya@example.test>'},{name:'Message-ID',value:'<source@example.test>'},{name:'Content-Type',value:'text/plain; charset=iso-8859-1'}],body:{data:Buffer.from('caf\xe9 source','latin1').toString('base64url')}}});
    if(url.pathname.endsWith('/drafts')&&init.method==='POST'){const value=JSON.parse(String(init.body));assert.equal(value.message.threadId,'thread');raw=Buffer.from(value.message.raw,'base64url').toString();return json({id:'draft-1',message:{id:'draft-message',threadId:'thread'}});}
    throw Error('Unexpected fixture request');
  });
  try {
    const bytes=Buffer.from([0,1,2,255,254,17]);
    const input=f.input();input.message={...input.message,from:'alias@example.test',reply:{threadId:'thread',messageId:'source',quote:true},attachments:[{name:'notes — café.bin',mimeType:'application/octet-stream',base64:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]} as any;
    const prepared=await f.delivery.prepare('device-a',input);assert.equal(prepared.state,'prepared');assert.match(prepared.message.bodyText,/café source/);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
    assert.doesNotMatch(JSON.stringify(prepared),new RegExp(bytes.toString('base64')));
    const command=f.confirm(prepared),saved=await f.delivery.confirm('device-a',command);assert.equal(saved.state,'saved');assert.equal(saved.providerDraftId,'draft-1');
    const repeated=await f.delivery.confirm('device-a',command);assert.equal(repeated.id,saved.id);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
    assert.match(raw,/From: alias@example.test/);assert.match(raw,/Bcc: private@example.test/);assert.match(raw,/In-Reply-To: <source@example.test>/);assert.match(raw,/References: <source@example.test>/);assert.ok(raw.includes(bytes.toString('base64')));
    const parts=[...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r]*\r\n)*?\r\n([A-Za-z0-9+/=\r\n]+)/g)].map(match=>Buffer.from(match[1].replace(/\s/g,''),'base64').toString());
    assert.ok(parts.some(part=>part===prepared.message.bodyText));assert.ok(parts.some(part=>part===prepared.message.bodyHtml));
    for(const name of readdirSync(f.directory).filter(name=>name.startsWith('workspace.sqlite')))assert.equal(readFileSync(join(f.directory,name)).includes(Buffer.from('private@example.test')),false);
  }finally{await f.close();}
});

test('lost send response remains uncertain through exact retry and restart; no second send is dispatched',async()=>{
  let sends=0;const f=fixture('google',(_url,init)=>{if(init.method==='POST'){sends++;throw Error('Response lost after provider accepted');}throw Error('Unexpected read');});
  try {const input={...f.input(),mode:'send' as const},prepared=await f.delivery.prepare('device-a',input),command=f.confirm(prepared);
    assert.equal((await f.delivery.confirm('device-a',command)).state,'uncertain');assert.equal(sends,1);
    assert.equal((await f.delivery.confirm('device-a',command)).state,'uncertain');assert.equal(sends,1);
    await f.restart();const kept=f.delivery.read('device-a',{epoch:f.store.epoch,operationId:prepared.id});assert.equal(kept.state,'uncertain');assert.equal(kept.message.bodyText,input.message.bodyText);assert.equal(sends,1);
    await assert.rejects(f.delivery.confirm('device-a',f.confirm(kept)),/changed/);
    assert.throws(()=>f.delivery.read('device-b',{epoch:f.store.epoch,operationId:prepared.id}),/unavailable/);
  }finally{await f.close();}
});

test('exact source changes, missing permission, altered review digests and header injection never dispatch a write',async()=>{
  let changed=false,writes=0;const f=fixture('google',(_url,init)=>{if(init.method==='POST'){writes++;return json({id:'unexpected'});}return json({id:'source',threadId:'thread',payload:{mimeType:'text/plain',headers:[{name:'Message-ID',value:'<source@example.test>'},{name:'Subject',value:changed?'Changed':'Planning — café'},{name:'From',value:'maya@example.test'}],body:{data:Buffer.from('source').toString('base64url')}}});});
  try {const input={...f.input(),message:{...f.input().message,reply:{threadId:'thread',messageId:'source',quote:false}}};
    await assert.rejects(f.delivery.prepare('device-a',{...input,message:{...input.message,subject:'Injected\r\nBcc: attacker@example.test'}}));
    const review=await f.delivery.prepare('device-a',input);assert.equal(review.state,'prepared');
    await assert.rejects(f.delivery.confirm('device-a',{...f.confirm(review),digest:'0'.repeat(64)}),/changed/);
    changed=true;assert.equal((await f.delivery.confirm('device-a',f.confirm(review))).state,'failed');assert.equal(writes,0);
    f.store.internalWrite('accounts:item:'+f.account.id,{...f.account,capabilities:{...f.account.capabilities,mailDraft:false}});
    await assert.rejects(f.delivery.prepare('device-a',f.input()),/permission/);assert.equal(writes,0);
  }finally{await f.close();}
});

test('a confirmed final send result is kept when account generation changes while the request is in flight',async()=>{
  const response=deferred<Response>(),entered=deferred<void>();const f=fixture('google',()=>{entered.resolve();return response.promise;});
  try {const prepared=await f.delivery.prepare('device-a',{...f.input(),mode:'send'}),pending=f.delivery.confirm('device-a',f.confirm(prepared));await entered.promise;
    f.store.internalWrite('accounts:item:'+f.account.id,{...f.account,generation:randomUUID(),state:'disconnected'});response.resolve(json({id:'accepted-on-old-account',threadId:'sent-thread'}));
    const result=await pending;assert.equal(result.state,'accepted');assert.equal(result.providerMessageId,'accepted-on-old-account');assert.equal(result.generation,f.account.generation);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('original Outlook reply creates and updates the same immutable draft while retaining all recipients',async()=>{
  let version='seed',draftBody:any;const f=fixture('microsoft',(url,init)=>{
    assert.equal(new Headers(init.headers).get('Prefer'),'IdType="ImmutableId"');
    if(url.pathname.endsWith('/messages/source'))return json({id:'source',conversationId:'thread',subject:'Original',from:{emailAddress:{address:'maya@example.test'}},body:{contentType:'text',content:'Original source'},internetMessageId:'<source@example.test>',isDraft:false});
    if(url.pathname.endsWith('/createReply'))return json({id:'draft-immutable',isDraft:true,conversationId:'thread',changeKey:version},201);
    if(url.pathname.endsWith('/messages/draft-immutable')&&init.method==='PATCH'){draftBody=JSON.parse(String(init.body));version='updated';return json({id:'draft-immutable',isDraft:true,conversationId:'thread',changeKey:version});}
    if(url.pathname.endsWith('/messages/draft-immutable'))return json({id:'draft-immutable',isDraft:true,conversationId:'thread',changeKey:version});
    if(url.pathname.endsWith('/send'))return new Response(null,{status:202});throw Error('Unexpected fixture URL');
  });
  try {const input=f.input(),prepared=await f.delivery.prepare('device-a',{...input,mode:'draft',message:{...input.message,reply:{threadId:'thread',messageId:'source',quote:false}}});assert.equal(prepared.state,'prepared');
    const result=await f.delivery.confirm('device-a',f.confirm(prepared));assert.equal(result.state,'saved');assert.equal(result.providerDraftId,'draft-immutable');
    assert.deepEqual(draftBody.bccRecipients,[{emailAddress:{address:'private@example.test'}}]);assert.equal(draftBody.body.content,input.message.bodyHtml);assert.equal(draftBody.subject,input.message.subject);
    assert.deepEqual(f.calls.filter(call=>['POST','PATCH'].includes(call.init.method??'')).map(call=>call.url.pathname.split('/').pop()),['createReply','draft-immutable']);
  }finally{await f.close();}
});

test('external Outlook reply-draft edits stop the following update instead of overwriting provider writing',async()=>{
  const f=fixture('microsoft',(url,init)=>{
    if(url.pathname.endsWith('/messages/source'))return json({id:'source',conversationId:'thread',subject:'Original',from:{emailAddress:{address:'maya@example.test'}},body:{contentType:'text',content:'Original source'},internetMessageId:'<source@example.test>',isDraft:false});
    return init.method==='POST'?json({id:'draft',isDraft:true,conversationId:'thread',changeKey:'created'},201):json({id:'draft',isDraft:true,conversationId:'thread',changeKey:'edited-elsewhere'});
  });
  try{const input=f.input(),prepared=await f.delivery.prepare('device-a',{...input,message:{...input.message,reply:{threadId:'thread',messageId:'source',quote:false}}});const result=await f.delivery.confirm('device-a',f.confirm(prepared));assert.equal(result.state,'interrupted');assert.equal(result.providerDraftId,'draft');assert.equal(f.calls.filter(call=>call.init.method==='PATCH').length,0);assert.match(result.detail??'',/changed/);}finally{await f.close();}
});

test('read-only Gmail reconciliation confirms the exact operation marker without sending again',async()=>{
  let sends=0,operationId='';const f=fixture('google',(url,init)=>{
    if(init.method==='POST'){sends++;throw Error('Lost response');}
    if(url.pathname.endsWith('/messages')){assert.equal(url.searchParams.get('q'),`rfc822msgid:${operationId}@edition3.invalid`);return json({messages:[{id:'sent-exact'}]});}
    return json({id:'sent-exact',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:`<${operationId}@edition3.invalid>`},{name:'X-Edition3-Operation',value:operationId}]}});
  });
  try{const input={...f.input(),mode:'send' as const},prepared=await f.delivery.prepare('device-a',input);operationId=prepared.id;await f.delivery.confirm('device-a',f.confirm(prepared));
    const result=await f.delivery.reconcile('device-a',{epoch:f.store.epoch,operationId});assert.equal(result.state,'accepted');assert.equal(result.providerMessageId,'sent-exact');assert.equal(sends,1);
    assert.equal((await f.delivery.prepare('device-a',{...input,requestId:randomUUID()})).id,operationId);assert.equal(sends,1);
    await assert.rejects(f.delivery.prepare('device-a',{...input,requestId:randomUUID(),message:{...input.message,bodyText:'Changed writing'}}),/already has/);
  }finally{await f.close();}
});

test('a lost Gmail send response with a replaced Message-ID reconciles after service restart without another dispatch',async()=>{
  let sends=0,operationId='',raw='',createdAt='';
  const f=fixture('google',(url,init)=>{
    if(init.method==='POST'){
      sends++;raw=Buffer.from(Buffer.from(JSON.parse(String(init.body)).raw,'base64url').toString().replace(`<${operationId}@edition3.invalid>`,'<gmail-replaced@mail.gmail.com>')).toString('base64url');
      throw Error('Lost response after Gmail accepted the immutable send');
    }
    if(url.pathname.endsWith('/messages')){
      if(url.searchParams.get('q')?.startsWith('rfc822msgid:'))return json({messages:[]});
      assert.equal(url.searchParams.get('q'),`after:${Math.floor(Date.parse(createdAt)/1000)-300}`);
      return json({messages:[{id:'sent-after-restart',threadId:'sent-thread'}]});
    }
    assert(url.pathname.endsWith('/messages/sent-after-restart'));
    const identity={id:'sent-after-restart',threadId:'sent-thread',labelIds:['SENT'],internalDate:String(Date.parse(createdAt))};
    return json(url.searchParams.get('format')==='raw'?{...identity,raw}:{...identity,payload:{headers:[{name:'X-Edition3-Operation',value:operationId}]}});
  });
  try{
    const input={...f.input(),mode:'send' as const},review=await f.delivery.prepare('device-a',input);operationId=review.id;createdAt=review.createdAt;
    assert.equal((await f.delivery.confirm('device-a',f.confirm(review))).state,'uncertain');
    await f.restart();assert.equal(f.delivery.read('device-a',{epoch:f.store.epoch,operationId}).state,'uncertain');
    const recovered=await f.delivery.reconcile('device-a',{epoch:f.store.epoch,operationId});assert.equal(recovered.state,'accepted');assert.equal(recovered.providerMessageId,'sent-after-restart');assert.equal(sends,1);
    await f.delivery.reconcile('device-a',{epoch:f.store.epoch,operationId});await f.delivery.prepare('device-a',{...input,requestId:randomUUID()});assert.equal(sends,1);
  }finally{await f.close();}
});

for(const includeFrom of [true,false]) test(`unknown Outlook creation recovers its exact marked draft ${includeFrom?'with':'without'} From without duplicating it`,async()=>{
  let creates=0,sends=0,operationId='',savedBody:any;
  const f=fixture('microsoft',(url,init)=>{
    if(url.pathname.endsWith('/messages')&&init.method==='POST'){creates++;savedBody=JSON.parse(String(init.body));throw Error('Lost create response');}
    if(url.pathname.endsWith('/messages'))return json({value:[{id:'recovered-draft'}]});
    if(url.pathname.endsWith('/send')){sends++;return new Response(null,{status:202});}
    return json({id:'recovered-draft',isDraft:true,changeKey:'created',parentFolderId:'drafts',subject:savedBody.subject,body:savedBody.body,...(includeFrom?{from:{emailAddress:{address:'studio@example.test'}}}:{}),toRecipients:savedBody.toRecipients,ccRecipients:savedBody.ccRecipients,bccRecipients:savedBody.bccRecipients,singleValueExtendedProperties:savedBody.singleValueExtendedProperties});
  });
  try{const prepared=await f.delivery.prepare('device-a',f.input());operationId=prepared.id;
    assert.equal((await f.delivery.confirm('device-a',f.confirm(prepared))).state,'uncertain');assert.equal(creates,1);assert.equal(sends,0);
    const recovered=await f.delivery.reconcile('device-a',{epoch:f.store.epoch,operationId});assert.equal(recovered.state,'saved');assert.equal(recovered.providerDraftId,'recovered-draft');assert.equal(sends,0);
    assert.equal(creates,1);assert.equal(sends,0);
  }finally{await f.close();}
});

test('a draft found during uncertain Outlook MIME-send reconciliation never authorizes another send',async()=>{
  let sends=0,operationId='';const f=fixture('microsoft',(url,init)=>{
    if(url.pathname.endsWith('/sendMail')){sends++;throw Error('Lost accepted response');}
    return json({value:[{id:'unconfirmed',internetMessageId:`<${operationId}@edition3.invalid>`,isDraft:true,parentFolderId:'drafts'}]});
  });
  try{const prepared=await f.delivery.prepare('device-a',{...f.input(),mode:'send'});operationId=prepared.id;assert.equal((await f.delivery.confirm('device-a',f.confirm(prepared))).state,'uncertain');
    const result=await f.delivery.reconcile('device-a',{epoch:f.store.epoch,operationId:prepared.id});assert.equal(result.state,'uncertain');assert.equal(sends,1);await assert.rejects(f.delivery.confirm('device-a',f.confirm(result)),/changed/);
  }finally{await f.close();}
});

test('shutdown retains a late confirmed Outlook reply draft and prevents the subsequent update',async()=>{
  const response=deferred<Response>(),entered=deferred<void>();let updates=0;const f=fixture('microsoft',(url,init)=>{
    if(url.pathname.endsWith('/messages/source'))return json({id:'source',conversationId:'thread',subject:'Original',from:{emailAddress:{address:'maya@example.test'}},body:{contentType:'text',content:'Original source'},internetMessageId:'<source@example.test>',isDraft:false});
    if(init.method==='PATCH')updates++;entered.resolve();return response.promise;
  });
  try{const input=f.input(),prepared=await f.delivery.prepare('device-a',{...input,message:{...input.message,reply:{threadId:'thread',messageId:'source',quote:false}}}),pending=f.delivery.confirm('device-a',f.confirm(prepared));await entered.promise;
    const stopping=f.delivery.close();response.resolve(json({id:'kept-draft',isDraft:true,conversationId:'thread',changeKey:'created'},201));const result=await pending;await stopping;
    assert.equal(result.state,'interrupted');assert.equal(result.providerDraftId,'kept-draft');assert.equal(updates,0);await f.restart();assert.equal(f.delivery.read('device-a',{epoch:f.store.epoch,operationId:prepared.id}).state,'interrupted');
  }finally{await f.close();}
});

test('the authenticated HTTP delivery route requires an exact reviewed confirm and preserves one provider result',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'edition3-delivery-http-'));let writes=0;
  const providers=new Providers((async(_url,init)=>{assert.equal(init?.method,'POST');writes++;return json({id:'http-draft',message:{id:'http-message'}});}) as typeof fetch);
  const service=await startServer({directory,port:0,providers});
  try{
    const accountId=randomUUID(),generation=randomUUID(),scopes=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose'];
    service.store.internalWrite('accounts:item:'+accountId,{id:accountId,generation,provider:'google',subject:'fixture',email:'fixture@example.test',label:'Fixture',revision:1,state:'connected',scopes,capabilities:accountCapabilities('google',scopes),connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    service.store.internalWrite('accounts:credential:'+accountId,{generation,configuration:{provider:'google',clientId:'fixture.apps.googleusercontent.com'},tokens:{accessToken:'fixture-only',expiresAt:Date.now()+3600000,scopes}});
    const session=await fetch(service.origin+'/api/session',{method:'POST',headers:{'X-Edition3-Client':'1'}}),cookie=session.headers.get('set-cookie')!.split(';')[0];await session.json();
    const post=(path:string,value:unknown,authenticated=true)=>fetch(service.origin+'/api/mail/delivery/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Edition3-Client':'1',...(authenticated?{Cookie:cookie}:{})},body:JSON.stringify(value)});
    const input={epoch:service.store.epoch,requestId:randomUUID(),accountId,generation,writerId:randomUUID(),mode:'draft',message:{from:'fixture@example.test',to:['recipient@example.test'],subject:'Exact HTTP review',bodyText:'Kept writing'}};
    assert.equal((await post('prepare',input,false)).status,401);assert.equal((await post('prepare',{...input,providerToken:'injected'})).status,400);
    const response=await post('prepare',input);assert.equal(response.status,200);const review=await response.json() as MailDeliveryReview;assert.equal(review.state,'prepared');assert.equal(writes,0);
    const command={epoch:input.epoch,requestId:randomUUID(),operationId:review.id,expectedRevision:review.revision,digest:review.digest,decision:'confirm'};
    assert.equal((await post('confirm',{...command,bodyText:'replacement'})).status,400);assert.equal(writes,0);
    assert.equal((await (await post('confirm',command)).json()).state,'saved');assert.equal((await (await post('confirm',command)).json()).providerDraftId,'http-draft');assert.equal(writes,1);
    assert.equal((await (await post('read',{epoch:input.epoch,operationId:review.id})).json()).message.bodyText,'Kept writing');
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('cancelled reviews, foreign attachment paths and oversized Outlook uploads leave provider mail unchanged',async()=>{
  let writes=0;const f=fixture('microsoft',()=>{writes++;throw Error('Unexpected provider call');});
  try{
    const input=f.input();const prepared=await f.delivery.prepare('device-a',input);assert.equal(prepared.state,'prepared');
    const cancelled=await f.delivery.confirm('device-a',{...f.confirm(prepared),decision:'cancel'});assert.equal(cancelled.state,'cancelled');
    await assert.rejects(f.delivery.prepare('device-a',{...f.input(),message:{...input.message,attachments:[{name:'file',mimeType:'text/plain',path:'/private/secret',bytes:0,base64:'',sha256:createHash('sha256').update('').digest('hex')}]}}));
    const bytes=Buffer.alloc(3*1024*1024,1);
    await assert.rejects(f.delivery.prepare('device-a',{...f.input(),message:{...input.message,attachments:[{name:'large.bin',mimeType:'application/octet-stream',base64:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}}),/large-attachment upload/);
    assert.equal(writes,0);
  }finally{await f.close();}
});

test('Outlook sends the exact reviewed MIME in one request without creating or sending a mutable provider draft',async()=>{
  let raw='';const f=fixture('microsoft',(url,init)=>{assert.equal(url.pathname,'/v1.0/me/sendMail');assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('Content-Type'),'text/plain');raw=Buffer.from(String(init.body),'base64').toString();return new Response(null,{status:202});});
  try{const input={...f.input(),mode:'send' as const},review=await f.delivery.prepare('device-a',input);assert.equal(review.state,'prepared');const result=await f.delivery.confirm('device-a',f.confirm(review));assert.equal(result.state,'accepted');assert.equal(f.calls.length,1);assert.match(raw,/Bcc: private@example.test/);assert.match(raw,new RegExp('X-Edition3-Operation: '+review.id));assert.ok(raw.includes(Buffer.from(input.message.bodyText).toString('base64')));assert.match(result.detail??'',/Delivery.*not confirmed/);}finally{await f.close();}
});

test('Outlook reply MIME stays bound to the reviewed source and an exact Sent marker reconciles a lost response',async()=>{
  let operationId='',sends=0;const f=fixture('microsoft',(url,init)=>{
    if(url.pathname.endsWith('/messages/source'))return json({id:'source',conversationId:'thread',subject:'Original',from:{emailAddress:{address:'maya@example.test'}},body:{contentType:'text',content:'Original source'},internetMessageId:'<source@example.test>',isDraft:false});
    if(url.pathname.endsWith('/reply')){assert.equal(url.pathname,'/v1.0/me/messages/source/reply');const raw=Buffer.from(String(init.body),'base64').toString();assert.match(raw,/In-Reply-To: <source@example.test>/);sends++;throw Error('Response lost');}
    if(url.pathname.endsWith('/messages'))return json({value:[{id:'sent',internetMessageId:`<${operationId}@edition3.invalid>`,isDraft:false,parentFolderId:'sentitems'}]});
    if(url.pathname.endsWith('/sentitems'))return json({id:'sentitems'});
    return json({id:'sent',isDraft:false,parentFolderId:'sentitems',internetMessageHeaders:[{name:'X-Edition3-Operation',value:operationId}]});
  });
  try{const input=f.input(),review=await f.delivery.prepare('device-a',{...input,mode:'send',message:{...input.message,reply:{threadId:'thread',messageId:'source',quote:false}}});operationId=review.id;
    assert.equal((await f.delivery.confirm('device-a',f.confirm(review))).state,'uncertain');assert.equal(sends,1);
    const recovered=await f.delivery.reconcile('device-a',{epoch:f.store.epoch,operationId});assert.equal(recovered.state,'accepted');assert.equal(recovered.providerMessageId,'sent');assert.equal(sends,1);
  }finally{await f.close();}
});

test('small Outlook compose and reply attachments keep exact bytes through the original draft flows',async()=>{
  const bytes=Buffer.from([0,255,3,128]),attachment={name:'fixture.bin',mimeType:'application/octet-stream',bytes:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};let calls=0;
  const f=fixture('microsoft',(url,init)=>{
    if(url.pathname.endsWith('/messages/source'))return json({id:'source',conversationId:'thread',subject:'Original',from:{emailAddress:{address:'maya@example.test'}},body:{contentType:'text',content:'Original source'},internetMessageId:'<source@example.test>',isDraft:false});
    calls++;
    if(url.pathname.endsWith('/createReply')){assert.equal(new Headers(init.headers).get('Content-Type'),'text/plain');assert.ok(Buffer.from(String(init.body),'base64').toString().includes(bytes.toString('base64')));return json({id:'reply-file-draft',isDraft:true,conversationId:'thread',changeKey:'created'},201);}
    const payload=JSON.parse(String(init.body));assert.equal(payload.attachments[0].contentBytes,bytes.toString('base64'));assert.equal(payload.attachments[0].name,'fixture.bin');return json({id:'file-draft',isDraft:true,changeKey:'created'},201);
  });
  try{const input=f.input();for(const reply of [undefined,{threadId:'thread',messageId:'source',quote:false}]){
    const review=await f.delivery.prepare('device-a',{...f.input(),message:{...input.message,attachments:[attachment],...(reply?{reply}:{})}});assert.equal(review.state,'prepared');assert.equal((await f.delivery.confirm('device-a',f.confirm(review))).state,'saved');}
    assert.equal(calls,2);
  }finally{await f.close();}
});

test('account replacement during review cannot publish an actionable old-account confirmation',async()=>{
  const response=deferred<Response>(),entered=deferred<void>();let writes=0;const f=fixture('google',(_url,init)=>{if(init.method==='POST')writes++;entered.resolve();return response.promise;});
  try{const input=f.input(),pending=f.delivery.prepare('device-a',{...input,message:{...input.message,from:'alias@example.test'}});await entered.promise;
    f.store.internalWrite('accounts:item:'+f.account.id,{...f.account,generation:randomUUID()});response.resolve(json({sendAs:[{sendAsEmail:'alias@example.test',verificationStatus:'accepted'}]}));
    const review=await pending;assert.equal(review.state,'failed');assert.equal(review.digest,undefined);assert.equal(writes,0);
  }finally{await f.close();}
});

test('Gmail reply subject changes are resolved before dispatch and wrong returned thread identities stay unconfirmed',async()=>{
  let writes=0;const f=fixture('google',(_url,init)=>{
    if(init.method==='POST'){writes++;return json({id:'wrong-draft',message:{id:'message',threadId:'wrong-thread'}});}
    return json({id:'source',threadId:'thread',payload:{mimeType:'text/plain',headers:[{name:'Message-ID',value:'<source@example.test>'},{name:'From',value:'maya@example.test'},{name:'Subject',value:'Original'}],body:{data:Buffer.from('source').toString('base64url')}}});
  });
  try{const input=f.input(),message={...input.message,reply:{threadId:'thread',messageId:'source',quote:false}};
    assert.equal((await f.delivery.prepare('device-a',{...input,message})).state,'failed');assert.equal(writes,0);
    const review=await f.delivery.prepare('device-a',{...f.input(),message:{...message,subject:'Re: Original'}});assert.equal(review.state,'prepared');assert.equal((await f.delivery.confirm('device-a',f.confirm(review))).state,'uncertain');assert.equal(writes,1);
  }finally{await f.close();}
});

test('a definitive provider rejection permits a corrected review while a lost response remains protected',async()=>{
  const f=fixture('google',()=>json({error:{message:'Raw provider details are not exposed'}},400));
  try{const input={...f.input(),mode:'send' as const},review=await f.delivery.prepare('device-a',input),rejected=await f.delivery.confirm('device-a',f.confirm(review));assert.equal(rejected.state,'failed');assert.match(rejected.detail??'',/provider rejected/);assert.doesNotMatch(JSON.stringify(rejected),/Raw provider details/);
    const corrected=await f.delivery.prepare('device-a',{...input,requestId:randomUUID(),message:{...input.message,subject:'Corrected subject'}});assert.equal(corrected.state,'prepared');assert.notEqual(corrected.id,review.id);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('an expired review can be cancelled and prepared again without trapping the original writing',async()=>{
  let writes=0;const f=fixture('google',()=>{writes++;throw Error('Unexpected provider write');});
  const now=Date.now();const delivery=new MailDeliveryService(f.store,f.accounts,()=>now+31*60000);
  try{
    const input=f.input(),review=await f.delivery.prepare('device-a',input);
    await assert.rejects(delivery.confirm('device-a',f.confirm(review)),/expired/);
    assert.equal((await delivery.confirm('device-a',{...f.confirm(review),decision:'cancel'})).state,'cancelled');
    const refreshed=await delivery.prepare('device-a',{...input,requestId:randomUUID()});
    assert.equal(refreshed.state,'prepared');assert.notEqual(refreshed.id,review.id);
    assert.equal(refreshed.writerId,review.writerId);assert.equal(refreshed.message.bodyText,input.message.bodyText);assert.equal(writes,0);
  }finally{await delivery.close();await f.close();}
});
