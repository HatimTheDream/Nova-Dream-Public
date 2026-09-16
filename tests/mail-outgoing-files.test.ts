import {inboxReplySource} from '../apps/client/src/dreamclaw/inbox-reply-source';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {simpleParser} from 'mailparser';
import {Store} from '../apps/service/store';
import {MailFiles} from '../apps/service/mail-files';
import {MailDeliveryService} from '../apps/service/mail-delivery';
import {removeDraftInlineImages} from '../apps/service/mail-mime';
import {accountCapabilities,ProviderError} from '../apps/service/providers';
import type {MailDeliveryReview,MailAttachment} from '../packages/domain/mail-delivery';
import type {Accounts} from '../apps/service/accounts';
const file=(name:string,text:string|Buffer):MailAttachment=>{const bytes=Buffer.from(text);return {name,mimeType:name.endsWith('.png')?'image/png':'text/plain',bytes:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};};
function fixture(provider:'google'|'microsoft') {
 const directory=mkdtempSync(join(tmpdir(),'e3-outgoing-files-'));let store=new Store(directory),files=new MailFiles(store);
 const scopes=provider==='google'?['https://www.googleapis.com/auth/gmail.modify']:['Mail.ReadWrite','Mail.Send'];
 const account={id:randomUUID(),generation:randomUUID(),provider,email:'owner@example.test',state:'connected',capabilities:accountCapabilities(provider,scopes)};
 let sequence=0,graph:any,raw=Buffer.alloc(0),providerFiles:any[]=[],drop='',rejectRead=false,sourceDraft=false;
 const effects:{method:string;path:string;body:any}[]=[];
 const parseRaw=async()=>{const parsed=await simpleParser(raw,{keepCidLinks:true});return {id:'draft',message:{id:'message-'+sequence,threadId:'thread',labelIds:['DRAFT'],raw:raw.toString('base64url'),payload:{mimeType:'multipart/mixed',headers:parsed.headerLines.map(header=>({name:header.key,value:header.line.slice(header.line.indexOf(':')+1).trim()})),parts:[{mimeType:'text/plain',body:{data:Buffer.from(parsed.text??'').toString('base64url')}},...parsed.attachments.map(a=>({filename:a.filename,mimeType:a.contentType,body:{size:a.size}}))]}}};};
 const request=async(path:string,init:RequestInit={})=>{
  const url=new URL(path,'https://fixture.invalid'),method=init.method??'GET';
  if(method==='GET'){
   if(url.pathname==='/messages/source')return provider==='google'?{id:'source',threadId:'thread',labelIds:sourceDraft?['DRAFT']:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Files'},{name:'From',value:'maya@example.test'},{name:'Message-ID',value:'<source@example.test>'}],body:{data:Buffer.from('Please send the files.').toString('base64url')}}}:{id:'source',conversationId:'thread',subject:'Files',from:{emailAddress:{address:'maya@example.test'}},body:{contentType:'text',content:'Please send the files.'},internetMessageId:'<source@example.test>',isDraft:false};
   if(provider==='google'&&url.pathname==='/drafts/draft')return parseRaw();
   if(provider==='microsoft'&&url.pathname==='/messages/draft/attachments')return {value:structuredClone(providerFiles)};
   if(provider==='microsoft'&&url.pathname==='/messages/draft'){if(rejectRead){rejectRead=false;throw new ProviderError('permission','Read permission was lost after file addition');}return {...structuredClone(graph),'@odata.etag':`W/"${sequence}"`};}
   throw Error('Unexpected read '+path);
  }
  const body=init.body?provider==='google'||!String(init.body).startsWith('RnJvb')?(()=>{try{return JSON.parse(String(init.body));}catch{return String(init.body);}})():String(init.body):undefined;
  let result:any;sequence++;
  if(provider==='google'){
   raw=Buffer.from(body.message?.raw??body.raw,'base64url');result=url.pathname.endsWith('send')?{id:'sent',threadId:'thread'}:{id:'draft',message:{id:'message-'+sequence,threadId:'thread'}};
  }else if(method==='POST'&&url.pathname==='/messages'){
   graph={...body,id:'draft',isDraft:true,changeKey:String(sequence),conversationId:'thread',parentFolderId:'drafts',from:{emailAddress:{address:account.email}},hasAttachments:!!body.attachments?.length};
   providerFiles=(body.attachments??[]).map((f:any,index:number)=>({...f,id:'original-'+index,size:Buffer.from(f.contentBytes,'base64').length}));result=graph;
  }else if(method==='POST'&&url.pathname==='/messages/source/createReply'){
   const mime=await simpleParser(Buffer.from(String(init.body),'base64'),{keepCidLinks:true});
   graph={id:'draft',isDraft:true,changeKey:String(sequence),conversationId:'thread',parentFolderId:'drafts',from:{emailAddress:{address:account.email}},subject:mime.subject,body:{contentType:'html',content:mime.html||''},toRecipients:[{emailAddress:{address:'maya@example.test'}}],ccRecipients:[],bccRecipients:[],hasAttachments:!!mime.attachments.length};
   providerFiles=mime.attachments.map((a,index)=>({id:'reply-'+index,'@odata.type':'#microsoft.graph.fileAttachment',name:a.filename,contentType:a.contentType,size:a.size,contentBytes:a.content.toString('base64')}));result=graph;
  }else if(method==='POST'&&url.pathname==='/messages/draft/attachments'){
   const added={...body,id:'added-'+sequence,size:Buffer.from(body.contentBytes,'base64').length};providerFiles.push(added);graph.changeKey=String(sequence);result=added;
  }else if(method==='DELETE'&&url.pathname.startsWith('/messages/draft/attachments/')){
   providerFiles=providerFiles.filter(f=>f.id!==decodeURIComponent(url.pathname.split('/').pop()!));graph.changeKey=String(sequence);result=null;
  }else if(method==='PATCH'&&url.pathname==='/messages/draft'){
   graph={...graph,...body,changeKey:String(sequence)};result=graph;
  }else if(method==='POST'&&url.pathname==='/messages/draft/send'){graph.isDraft=false;result=null;}
  else throw Error('Unexpected effect '+method+' '+path);
  effects.push({method,path:url.pathname,body});
  if(drop===method){drop='';throw new ProviderError('unavailable','Response lost after provider effect');}
  if(drop==='read-after-add'&&url.pathname.endsWith('/attachments')){drop='';rejectRead=true;}
  return structuredClone(result);
 };
 const accounts={state:()=>({accounts:[account]}),mailOperation:async(_id:string,_generation:string,_permissions:unknown,_signal:AbortSignal,run:any)=>run(account,request,()=>{})} as unknown as Pick<Accounts,'state'|'mailOperation'>;
 let delivery=new MailDeliveryService(store,accounts);const writerId=randomUUID();
 const input=(refs:any[]=[],previous?:MailDeliveryReview,reply=false)=>({epoch:store.epoch,requestId:randomUUID(),accountId:account.id,generation:account.generation,writerId,mode:'draft' as 'draft'|'send',files:refs,...(previous?{previous:{operationId:previous.id,expectedRevision:previous.revision,digest:previous.digest!}}:{}),message:{from:account.email,to:['maya@example.test'],cc:[],bcc:[],subject:'Files',bodyText:'Review the complete file selection.',bodyHtml:'<p>Review the complete file selection.</p>',attachments:[],...(reply?{reply:{threadId:'thread',messageId:'source',quote:true}}:{})}});
 const upload=(attachment:MailAttachment)=>{const value=files.upload('device',{epoch:store.epoch,requestId:randomUUID(),file:attachment});return {kind:'upload' as const,id:value.id,sha256:value.file.sha256};};
 const confirm=(review:MailDeliveryReview,decision:'confirm'|'cancel'='confirm')=>({epoch:store.epoch,requestId:randomUUID(),operationId:review.id,expectedRevision:review.revision,digest:review.digest!,decision});
 return {input,upload,confirm,effects,account,sourceDraft(){sourceDraft=true;},get files(){return files;},get store(){return store;},get delivery(){return delivery;},get raw(){return raw;},get providerFiles(){return providerFiles;},drop(method:string){drop=method;},async restart(){await delivery.close();store.close();store=new Store(directory);files=new MailFiles(store);delivery=new MailDeliveryService(store,accounts);},async close(){await delivery.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('encrypted outgoing files are exact, idempotent, device/epoch-owned and usable after restart',async()=>{
 const f=fixture('google');try{const original=file('private.txt','Private selected bytes'),input={epoch:f.store.epoch,requestId:randomUUID(),file:original};const saved=f.files.upload('device',input);assert.deepEqual(f.files.upload('device',input),saved);assert.equal(saved.file.base64,undefined);
 assert.throws(()=>f.files.read('other',{epoch:f.store.epoch,id:saved.id,bytes:true}),/not been received/);assert.throws(()=>f.files.read('device',{epoch:randomUUID(),id:saved.id}),/recovery/);
 assert.throws(()=>f.files.upload('device',{...input,file:{...original,base64:Buffer.from('changed').toString('base64')}}),/changed/);
 await f.restart();assert.deepEqual(f.files.read('device',{epoch:f.store.epoch,id:saved.id,sha256:original.sha256,bytes:true}).file,original);assert.equal(f.effects.length,0);
 }finally{await f.close();}
});
for(const provider of ['google','microsoft'] as const)test(`${provider}: original new and reply drafts deliver exact selected file references without browser byte payloads`,async()=>{
 const f=fixture(provider);try{const attachment=file('outgoing.txt','Exact outgoing bytes'),ref=f.upload(attachment),input=f.input([ref],undefined,true);assert.equal(input.message.attachments.length,0);
 const prepared=await f.delivery.prepare('device',input);assert.equal(prepared.state,'prepared',prepared.detail);assert.equal(prepared.message.attachments[0].sha256,attachment.sha256);assert.equal(f.effects.length,0);
 f.upload(file('unreviewed.txt','Must never enter the prepared message'));
 const saved=await f.delivery.confirm('device',f.confirm(prepared));assert.equal(saved.state,'saved',saved.detail);assert.equal(f.effects.length,1);
 if(provider==='google'){const mime=await simpleParser(f.raw);assert.equal(mime.inReplyTo,'<source@example.test>');assert.equal(mime.attachments.length,1);assert.equal(mime.attachments[0].content.toString(),'Exact outgoing bytes');}
 else{assert.equal(f.providerFiles.length,1);assert.equal(Buffer.from(f.providerFiles[0].contentBytes,'base64').toString(),'Exact outgoing bytes');}
 }finally{await f.close();}
});
for(const lost of ['POST','DELETE','read-after-add'])test(`Outlook: ${lost} loss during file replacement recovers one exact effect then continues the same draft`,async()=>{
 const f=fixture('microsoft');try{
  const firstRef=f.upload(file('old.txt','Old file')),keepRef=f.upload(file('keep.txt','Keep this file'));
  let review=await f.delivery.prepare('device',f.input([firstRef,keepRef]));const first=await f.delivery.confirm('device',f.confirm(review));assert.equal(first.state,'saved',first.detail);
  const newRef=f.upload(file('new.txt','New reviewed bytes'));review=await f.delivery.prepare('device',f.input([keepRef,newRef],first));assert.equal(review.state,'prepared',review.detail);
  f.drop(lost);const uncertain=await f.delivery.confirm('device',f.confirm(review));assert.equal(uncertain.state,'uncertain',uncertain.detail);
  const count=f.effects.length;await f.restart();const recovered=await f.delivery.reconcile('device',{epoch:f.store.epoch,operationId:review.id});assert.equal(recovered.state,'interrupted',recovered.detail);assert.equal(f.effects.length,count);
  const saved=await f.delivery.confirm('device',f.confirm(recovered));assert.equal(saved.state,'saved',saved.detail);assert.equal(saved.providerDraftId,first.providerDraftId);
  assert.deepEqual(f.providerFiles.map(item=>item.name).sort(),['keep.txt','new.txt']);assert.equal(f.providerFiles.find(item=>item.name==='keep.txt').id,'original-1');
  assert.equal(f.effects.filter(effect=>effect.method==='POST'&&effect.path.endsWith('/attachments')).length,1);assert.equal(f.effects.filter(effect=>effect.method==='DELETE').length,1);assert.equal(f.effects.filter(effect=>effect.method==='PATCH').length,1);
 }finally{await f.close();}
});
test('Gmail saved file selection removes old files, keeps ancestor references and rejects another message or device',async()=>{
 const f=fixture('google');try{
  const ref=f.upload(file('first.txt','Original')),second=f.upload(file('second.txt','Keep'));const first=await f.delivery.confirm('device',f.confirm(await f.delivery.prepare('device',f.input([ref,second]))));
  const savedRef={kind:'saved',operationId:first.id,digest:first.digest!,index:1,sha256:first.message.attachments[1].sha256};
  await assert.rejects(f.delivery.prepare('other',f.input([savedRef],first)),/unavailable/);
  await assert.rejects(f.delivery.prepare('device',{...f.input([savedRef]),writerId:randomUUID()}),/original message/);
  const update=await f.delivery.prepare('device',f.input([savedRef],first));assert.equal(update.state,'prepared',update.detail);const saved=await f.delivery.confirm('device',f.confirm(update));assert.equal(saved.state,'saved',saved.detail);
  const again=await f.delivery.prepare('device',f.input([savedRef],saved));assert.equal(again.state,'prepared',again.detail);
  const mime=await simpleParser(f.raw);assert.deepEqual(mime.attachments.map(a=>a.filename),['second.txt']);assert.equal(mime.attachments[0].content.toString(),'Keep');
 }finally{await f.close();}
});
test('inline file removal edits only matching parsed image elements while keeping untouched HTML exact',()=>{
 const html='<p class="keep">Stay &amp; keep</p><IMG alt="a > b" SRC="cid:art&#64;example.test"><img src=cid:other@example.test><a href="cid:art@example.test">Keep link text</a>';
 assert.equal(removeDraftInlineImages(html,['art@example.test']),'<p class="keep">Stay &amp; keep</p><img src=cid:other@example.test><a href="cid:art@example.test">Keep link text</a>');
 assert.equal(removeDraftInlineImages(html,[]),html);
});

test('a file-only Gmail message keeps exact bytes while a completely empty message is rejected',async()=>{
 const f=fixture('google');try{const input=f.input([f.upload(file('only.txt','The file is the message'))]);input.message.subject='';input.message.bodyText='';input.message.bodyHtml='';const prepared=await f.delivery.prepare('device',input);assert.equal(prepared.state,'prepared',prepared.detail);const saved=await f.delivery.confirm('device',f.confirm(prepared));assert.equal(saved.state,'saved',saved.detail);assert.equal((await simpleParser(f.raw)).attachments[0].content.toString(),'The file is the message');await assert.rejects(f.delivery.prepare('device',{...input,requestId:randomUUID(),writerId:randomUUID(),files:[]}),/subject or message/);}finally{await f.close();}
});

test('reply source selection skips Gmail and Outlook drafts and retains the original external-sender preference',()=>{
 const received={id:'received',from:'maya@example.test',labelIds:['INBOX']},ownSent={id:'sent',from:'owner@example.test',labelIds:['SENT']},gmailDraft={id:'gdraft',from:'maya@example.test',labelIds:['DRAFT']},outlookDraft={id:'odraft',from:'maya@example.test',isDraft:true};
 const own=new Set(['owner@example.test']);assert.equal(inboxReplySource([received,ownSent,gmailDraft,outlookDraft],own,value=>value),received);assert.equal(inboxReplySource([ownSent,gmailDraft],own,value=>value),ownSent);assert.equal(inboxReplySource([gmailDraft,outlookDraft],own,value=>value),null);
});
test('the service rejects a forged reply to an unsent Gmail draft before any provider mutation',async()=>{
 const f=fixture('google');try{f.sourceDraft();const review=await f.delivery.prepare('device',f.input([f.upload(file('safe.txt','Kept'))],undefined,true));assert.equal(review.state,'failed');assert.match(review.detail??'',/received or sent/);assert.equal(f.effects.length,0);}finally{await f.close();}
});
