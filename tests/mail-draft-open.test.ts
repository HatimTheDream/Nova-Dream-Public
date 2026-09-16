import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonical } from '../packages/domain/contracts';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { Store, Fault } from '../apps/service/store';
import { MailDeliveryService } from '../apps/service/mail-delivery';
import { ProviderError, accountCapabilities, readScopes } from '../apps/service/providers';
import { resolveGmailDraft } from '../apps/service/provider-mail-open';
import { OPERATION_PROPERTY } from '../apps/service/provider-mail-delivery';
import type { Accounts } from '../apps/service/accounts';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailDeliveryReview } from '../packages/domain/mail-delivery';

async function fixture(provider:'google'|'microsoft') {
  const directory=mkdtempSync(join(tmpdir(),'e3-open-draft-'));let store=new Store(directory);
  const scopes=[...readScopes[provider],...(provider==='google'?['https://www.googleapis.com/auth/gmail.modify']:['Mail.ReadWrite','Mail.Send'])];
  const account:ConnectedAccount={id:randomUUID(),generation:randomUUID(),provider,email:'studio@example.test',subject:'owner',label:'Studio',state:'connected',revision:1,scopes,capabilities:accountCapabilities(provider,scopes),connectedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const inline=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG8sAAAAASUVORK5CYII=','base64'),file=Buffer.from('These are the original file bytes.');
  let sequence=1,sent=false,loseSend=false,delayRead:(()=>Promise<void>)|undefined;
  const compiler=new MailComposer({from:{name:'Studio Owner',address:account.email},to:[{name:'Maya, Chen',address:'maya@example.test'}],cc:[{name:'José',address:'jose@example.test'}],bcc:['hidden@example.test'],replyTo:[{name:'Studio Replies',address:'reply@example.test'}],subject:'Re: Studio review',text:'Keep the formatted message.',html:'<p>Keep the <strong>formatted</strong> message.</p><img src="cid:art@example.test">',inReplyTo:'<source@example.test>',references:['<root@example.test>','<source@example.test>'],attachments:[{filename:'notes.txt',content:file},{filename:'art.png',content:inline,contentType:'image/png',cid:'art@example.test',contentDisposition:'inline'}]}).compile();
  compiler.keepBcc=true;let raw=await compiler.build();
  const mime=await simpleParser(raw,{keepCidLinks:true});
  let graph:any={id:'provider-draft',isDraft:true,changeKey:'v1',conversationId:'thread',subject:'Re: Studio review',from:{emailAddress:{address:account.email,name:'Studio Owner'}},toRecipients:[{emailAddress:{address:'maya@example.test',name:'Maya, Chen'}}],ccRecipients:[{emailAddress:{address:'jose@example.test',name:'José'}}],bccRecipients:[{emailAddress:{address:'hidden@example.test'}}],replyTo:[{emailAddress:{address:'reply@example.test',name:'Studio Replies'}}],body:{contentType:'html',content:mime.html},hasAttachments:false};
  const files=[{id:'notes','@odata.type':'#microsoft.graph.fileAttachment',name:'notes.txt',contentType:'text/plain',size:file.length,contentBytes:file.toString('base64')},{id:'art','@odata.type':'#microsoft.graph.fileAttachment',name:'art.png',contentType:'image/png',size:inline.length,contentBytes:inline.toString('base64'),isInline:true,contentId:'art@example.test'}];
  const effects:{method:string;path:string;body:any}[]=[],reads:string[]=[];
  const request=async(path:string,init:RequestInit={})=>{
    const url=new URL(path,'https://fixture.invalid'),method=init.method??'GET';
    if(method==='GET') {
      reads.push(path);
      if(delayRead){const wait=delayRead;delayRead=undefined;await wait();}
      if(provider==='google') {
        if(url.pathname==='/drafts')return {drafts:sent?[]:[{id:'provider-draft',message:{id:'message-'+sequence,threadId:'thread'}}]};
        if(url.pathname==='/drafts/provider-draft') {
          if(sent)throw new ProviderError('not_found','No longer a draft');
          const parsed=await simpleParser(raw,{keepCidLinks:true});
          const message={id:'message-'+sequence,threadId:'thread',labelIds:['DRAFT']};
          if(url.searchParams.get('format')==='raw')return {id:'provider-draft',message:{...message,raw:raw.toString('base64url')}};
          return {id:'provider-draft',message:{...message,payload:{mimeType:'multipart/mixed',headers:parsed.headerLines.map(item=>({name:item.key,value:item.line.slice(item.line.indexOf(':')+1).trim()})),parts:[{mimeType:'text/plain',body:{data:Buffer.from(parsed.text??'').toString('base64url')}},...parsed.attachments.map(a=>({mimeType:a.contentType,filename:a.filename,body:{size:a.size}}))]}}};
        }
      } else {
        if(url.pathname==='/messages/provider-draft/attachments')return {value:structuredClone(files)};
        if(url.pathname==='/messages/provider-draft')return {...structuredClone(graph),'@odata.etag':`W/"v${sequence}"`};
      }
      throw new Error('Unexpected fixture read '+path);
    }
    const body=init.body?JSON.parse(String(init.body)):undefined;
    if((provider==='google'&&url.pathname==='/drafts/send')||(provider==='microsoft'&&url.pathname.endsWith('/send'))) {
      if(loseSend)throw new ProviderError('unavailable','Unconfirmed send');
      sent=true;graph.isDraft=false;effects.push({method,path,body});return provider==='google'?{id:'sent',threadId:'thread'}:null;
    }
    effects.push({method,path,body});sequence++;
    if(provider==='google') {assert.equal(body.id,'provider-draft');raw=Buffer.from(body.message.raw,'base64url');return {id:'provider-draft',message:{id:'message-'+sequence,threadId:'thread'}};}
    graph={...graph,...body,changeKey:'v'+sequence};return structuredClone(graph);
  };
  const accounts={state:()=>({accounts:[account]}),mailOperation:async(_id:string,_generation:string,_permissions:unknown,_signal:AbortSignal,run:any)=>run(account,request,()=>{})} as unknown as Pick<Accounts,'state'|'mailOperation'>;
  let delivery=new MailDeliveryService(store,accounts);
  const input=()=>({epoch:store.epoch,requestId:randomUUID(),accountId:account.id,generation:account.generation,writerId:randomUUID(),source:{messageId:provider==='google'?'message-'+sequence:'provider-draft',threadId:'thread'}});
  const edit=(review:MailDeliveryReview,body=true,mode:'draft'|'send'='draft')=>({epoch:store.epoch,requestId:randomUUID(),accountId:account.id,generation:account.generation,writerId:review.writerId,mode,previous:{operationId:review.id,expectedRevision:review.revision,digest:review.digest},preserveDraft:{body,attachments:true},message:{...review.message,bodyText:'Explicit plain text replacement.',bodyHtml:undefined,attachments:[]}});
  const confirm=(review:MailDeliveryReview,decision:'confirm'|'cancel'='confirm')=>({epoch:store.epoch,requestId:randomUUID(),operationId:review.id,expectedRevision:review.revision,digest:review.digest,decision});
  return {account,effects,reads,input,edit,confirm,files,request,get delivery(){return delivery;},get store(){return store;},get raw(){return raw;},get graph(){return graph;},get file(){return file;},get inline(){return inline;},markOperation(id:string){raw=Buffer.from(raw.toString().replace(/^Message-ID:.*$/mi,`Message-ID: <${id}@edition3.invalid>`)+'');raw=Buffer.from(`X-Edition3-Operation: ${id}\r\n`+raw.toString());graph.singleValueExtendedProperties=[{id:OPERATION_PROPERTY,value:id}];},loseSend(){loseSend=true;},delayRead(wait:()=>Promise<void>){delayRead=wait;},async restart(){await delivery.close();store.close();store=new Store(directory);delivery=new MailDeliveryService(store,accounts);},async close(){await delivery.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

for(const provider of ['google','microsoft'] as const) {
  test(`${provider}: opening and updating an existing draft preserves its formatted message, named recipients and exact files`,async()=>{
    const f=await fixture(provider);try {
      const input=f.input(),opened=await f.delivery.openDraft('device',input);
      assert.equal(opened.state,'saved',opened.detail);assert.equal(opened.providerDraftId,'provider-draft');assert.equal(f.effects.length,0);assert.match(opened.message.bodyHtml??'',/<strong>formatted<\/strong>/);
      assert.deepEqual(opened.message.to,['maya@example.test']);assert.deepEqual(opened.message.bcc,['hidden@example.test']);assert.equal(opened.message.attachments.length,2);
      assert.equal((await f.delivery.openDraft('device',input)).id,opened.id);
      const prepared=await f.delivery.prepare('device',f.edit(opened));assert.equal(prepared.state,'prepared',prepared.detail);
      assert.equal(prepared.message.bodyHtml,opened.message.bodyHtml);assert.equal(prepared.message.attachments.length,2);
      const saved=await f.delivery.confirm('device',f.confirm(prepared));assert.equal(saved.state,'saved',saved.detail);assert.equal(saved.providerDraftId,opened.providerDraftId);assert.equal(f.effects.length,1);
      if(provider==='google') {const parsed=await simpleParser(f.raw,{keepCidLinks:true});assert.equal(parsed.from?.value[0].name,'Studio Owner');assert.equal((Array.isArray(parsed.to)?parsed.to[0]:parsed.to)?.value[0].name,'Maya, Chen');assert.equal(parsed.inReplyTo,'<source@example.test>');assert.equal(parsed.replyTo?.value[0].address,'reply@example.test');assert.deepEqual(parsed.attachments.find(a=>a.filename==='notes.txt')?.content,f.file);assert.deepEqual(parsed.attachments.find(a=>a.cid==='art@example.test')?.content,f.inline);}
      else {assert.equal(f.graph.toRecipients[0].emailAddress.name,'Maya, Chen');assert.equal(f.graph.replyTo[0].emailAddress.address,'reply@example.test');assert.equal(f.graph.body.content,opened.message.bodyHtml);assert.equal(f.effects[0].body.attachments,undefined);assert.equal(f.files[1].isInline,true);}
    }finally{await f.close();}
  });
  test(`${provider}: retained draft files are exact, private, permission-bound reads that survive restart without provider calls`,async()=>{
    const f=await fixture(provider);try {
      const opened=await f.delivery.openDraft('owner',f.input()),before=f.reads.length;
      const fileIndex=opened.message.attachments.findIndex(file=>file.name==='notes.txt'),imageIndex=opened.message.attachments.findIndex(file=>file.name==='art.png');
      const input={epoch:f.store.epoch,operationId:opened.id,digest:opened.digest,index:fileIndex,sha256:opened.message.attachments[fileIndex].sha256};
      const file=f.delivery.readFile('owner',input);assert.deepEqual(Buffer.from(file.file.base64,'base64'),f.file);assert.equal(file.previewMimeType,undefined);
      const image=f.delivery.readFile('owner',{...input,index:imageIndex,sha256:opened.message.attachments[imageIndex].sha256});assert.equal(image.previewMimeType,'image/png');assert.equal(image.file.cid,'art@example.test');
      assert.throws(()=>f.delivery.readFile('other',input),/unavailable/);assert.throws(()=>f.delivery.readFile('owner',{...input,digest:'0'.repeat(64)}),/original saved message/);
      assert.throws(()=>f.delivery.readFile('owner',{...input,sha256:'0'.repeat(64)}),/not part/);assert.throws(()=>f.delivery.readFile('owner',{...input,epoch:randomUUID()}),/recovery/);
      await f.restart();assert.deepEqual(f.delivery.readFile('owner',input),file);assert.equal(f.delivery.read('owner',{epoch:f.store.epoch,operationId:opened.id}).revision,opened.revision);
      assert.equal(f.reads.length,before);assert.equal(f.effects.length,0);
      f.account.capabilities.mailRead=false;assert.throws(()=>f.delivery.readFile('owner',input),/mail reading/);f.account.capabilities.mailRead=true;
      f.account.generation=randomUUID();assert.throws(()=>f.delivery.readFile('owner',input),/connection changed/);
    }finally{await f.close();}
  });
  test(`${provider}: explicit plain-text editing retains files and requires an opened-draft content choice`,async()=>{
    const f=await fixture(provider);try {
      const opened=await f.delivery.openDraft('device',f.input()),bad=f.edit(opened);delete (bad as any).preserveDraft;
      await assert.rejects(f.delivery.prepare('device',bad),/formatting and files/);
      const prepared=await f.delivery.prepare('device',f.edit(opened,false));assert.equal(prepared.state,'prepared',prepared.detail);assert.equal(prepared.message.bodyText,'Explicit plain text replacement.');assert.equal(prepared.message.bodyHtml,undefined);assert.equal(prepared.message.attachments.length,2);assert.equal(f.effects.length,0);
    }finally{await f.close();}
  });
  test(`${provider}: reopening from another device fences the stale writer across restart without revealing its private proposal`,async()=>{
    const f=await fixture(provider);try {
      const first=await f.delivery.openDraft('one',f.input()),proposal=await f.delivery.prepare('one',f.edit(first,false));
      const blocked=await f.delivery.openDraft('two',f.input());assert.equal(blocked.state,'failed');assert.match(blocked.detail??'',/unfinished/);
      await f.delivery.confirm('one',f.confirm(proposal,'cancel'));
      const second=await f.delivery.openDraft('two',f.input());assert.equal(second.state,'saved',second.detail);assert.notEqual(second.message.bodyText,'Explicit plain text replacement.');
      await f.restart();assert.equal(f.delivery.read('one',{epoch:f.store.epoch,operationId:first.id}).superseded,true);
      await assert.rejects(f.delivery.prepare('one',f.edit(first)),/Another message/);
      assert.throws(()=>f.delivery.read('two',{epoch:f.store.epoch,operationId:first.id}),Fault);assert.equal(f.effects.length,0);
    }finally{await f.close();}
  });
  test(`${provider}: an unresolved saved-draft send cannot be bypassed by reopening the provider Drafts folder`,async()=>{
    const f=await fixture(provider);try {
      const opened=await f.delivery.openDraft('one',f.input()),prepared=await f.delivery.prepare('one',f.edit(opened,true,'send'));f.loseSend();
      const result=await f.delivery.confirm('one',f.confirm(prepared));assert.equal(result.state,'uncertain',result.detail);
      const reopened=await f.delivery.openDraft('two',f.input());assert.equal(reopened.state,'failed');assert.match(reopened.detail??'',/unfinished/);
      assert.equal(f.effects.filter(effect=>effect.path.endsWith('/send')).length,0);
    }finally{await f.close();}
  });
  test(`${provider}: legacy draft lineages without an ownership index retain their unfinished operation across restart`,async()=>{
    const f=await fixture(provider);try {
      const first=await f.delivery.openDraft('original',f.input()),prepared=await f.delivery.prepare('original',f.edit(first,false));
      const index='mail:delivery:draft-owner:'+createHash('sha256').update(canonical({epoch:f.store.epoch,accountId:f.account.id,draftId:'provider-draft'})).digest('hex');
      f.store.internalDelete(index);await f.restart();
      const blocked=await f.delivery.openDraft('new',f.input());assert.equal(blocked.state,'failed');assert.match(blocked.detail??'',/unfinished/);
      await f.delivery.confirm('original',f.confirm(prepared,'cancel'));
      const opened=await f.delivery.openDraft('new',f.input());assert.equal(opened.state,'saved',opened.detail);
      assert.equal(f.delivery.read('original',{epoch:f.store.epoch,operationId:first.id}).superseded,true);assert.equal(f.effects.length,0);
    }finally{await f.close();}
  });
  test(`${provider}: an operation marker blocks adoption when a create response lost its provider ID`,async()=>{
    const f=await fixture(provider);try {
      const id=randomUUID(),input=f.input();f.markOperation(id);
      f.store.internalWrite('mail:delivery:head:'+id,{device:'original',intentFingerprint:'fixture',completed:[],attempted:'create',review:{id,epoch:input.epoch,accountId:input.accountId,generation:input.generation,writerId:randomUUID(),state:'uncertain',mode:'draft',revision:3,updatedAt:new Date().toISOString()}});
      const opened=await f.delivery.openDraft('new',input);assert.equal(opened.state,'failed');assert.match(opened.detail??'',/unfinished/);assert.equal(f.effects.length,0);
    }finally{await f.close();}
  });
  test(`${provider}: changing account generation during an opening read prevents adoption`,async()=>{
    const f=await fixture(provider);try {
      f.delayRead(async()=>{f.account.generation=randomUUID();});
      const opened=await f.delivery.openDraft('one',f.input());assert.equal(opened.state,'failed');assert.equal(opened.providerDraftId,undefined);assert.equal(f.effects.length,0);
    }finally{await f.close();}
  });
}

test('Gmail draft lookup follows bounded pages and rejects a wrong conversation or repeated cursor',async()=>{
  const paths:string[]=[];
  const draft=await resolveGmailDraft(async path=>{paths.push(path);return paths.length===1?{drafts:[{id:'other',message:{id:'other'}}],nextPageToken:'page2'}:{drafts:[{id:'container',message:{id:'selected',threadId:'thread'}}]};},'selected','thread');
  assert.equal(draft,'container');assert.match(paths[1],/pageToken=page2/);
  await assert.rejects(resolveGmailDraft(async()=>({drafts:[{id:'container',message:{id:'selected',threadId:'wrong'}}]}),'selected','thread'),/another conversation/);
  await assert.rejects(resolveGmailDraft(async()=>({drafts:[],nextPageToken:'repeat'}),'selected','thread'),/repeated/);
});

test('Outlook opens a large valid draft attachment without losing its exact bytes', async () => {
  const f = await fixture('microsoft'), bytes = Buffer.alloc(3 * 1024 * 1024 - 1, 173);
  try {
    f.files[0].contentBytes = bytes.toString('base64'); f.files[0].size = bytes.length;
    const opened = await f.delivery.openDraft('device', f.input());
    assert.equal(opened.state, 'saved', opened.detail);
    assert.equal(opened.message.attachments[0].bytes, bytes.length);
    assert.equal(opened.message.attachments[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(f.effects.length, 0);
  } finally { await f.close(); }
});

for(const missingFrom of [undefined,null]) test(`Outlook drafts with ${missingFrom===null?'null':'omitted'} From reopen and update in their authenticated mailbox`,async()=>{
  const f=await fixture('microsoft');try {
    if(missingFrom===undefined)delete f.graph.from;else f.graph.from=null;
    const opened=await f.delivery.openDraft('owner',f.input());assert.equal(opened.state,'saved',opened.detail);assert.equal(opened.message.from,f.account.email);assert.equal(f.effects.length,0);
    const prepared=await f.delivery.prepare('owner',f.edit(opened));assert.equal(prepared.state,'prepared',prepared.detail);assert.equal(prepared.draft?.from,f.account.email);
    const saved=await f.delivery.confirm('owner',f.confirm(prepared));assert.equal(saved.state,'saved',saved.detail);assert.equal(saved.providerDraftId,opened.providerDraftId);assert.equal(f.effects.length,1);assert.equal(f.effects[0].body.from,undefined);
    const send=await f.delivery.prepare('owner',f.edit(saved,true,'send'));assert.equal(send.state,'prepared',send.detail);assert.equal(send.message.from,f.account.email);assert.equal(f.effects.length,1);
  }finally{await f.close();}
});

test('failed Outlook draft preparation shows its actual error and returns ownership to the same saved writing',async()=>{
  const f=await fixture('microsoft');try {
    const opened=await f.delivery.openDraft('owner',f.input());f.graph.from={emailAddress:{}};
    const failed=await f.delivery.prepare('owner',f.edit(opened));assert.equal(failed.state,'failed');assert.match(failed.detail??'',/could not be read completely/);assert.equal(failed.superseded,false);assert.equal(f.effects.length,0);
    const prior=f.delivery.read('owner',{epoch:f.store.epoch,operationId:opened.id});assert.equal(prior.canEditDraft,true);assert.equal(prior.superseded,false);
    f.graph.from={emailAddress:{address:f.account.email}};const retry=await f.delivery.prepare('owner',f.edit(prior));assert.equal(retry.state,'prepared',retry.detail);assert.equal(f.effects.length,0);
  }finally{await f.close();}
});
