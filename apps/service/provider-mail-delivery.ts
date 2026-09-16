import { recoverGmailDraft } from './gmail-draft-recovery.js';
import { recoverGmailSend } from './gmail-send-recovery.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectedAccount } from '../../packages/domain/accounts.js';
import type { MailDeliveryMessage, MailDeliveryStage, MailDraftSnapshot } from '../../packages/domain/mail-delivery.js';
import { readProviderDraft, verifyDraftAttachments } from './provider-mail-drafts.js';
import { canonical } from '../../packages/domain/contracts.js';
import { originalMicrosoftMessageBody } from './dreamclaw/mail-message.js';
import { originalMicrosoftMessageViews, htmlToText } from './dreamclaw/microsoft-mail.js';
import { mailAttachmentBytes, type MailReplySource } from './mail-mime.js';
import { ProviderError } from './providers.js';
import type { MailDraftEnvelope } from './provider-mail-open.js';

export type MailRequest = (path:string, init?:RequestInit, emptyStatuses?:number[]) => Promise<unknown>;
export type MailDeliveryProviderResult = { draftId?:string; messageId?:string; changeKey?:string };
const id=z.string().min(1).max(2000),text=z.string().max(2000000),header=z.object({name:z.string().max(1000),value:z.string().max(10000)});
const graphDraft=z.object({id,isDraft:z.boolean(),changeKey:id,conversationId:id.optional()});
function valid<T>(schema:z.ZodType<T>,value:unknown):T { const parsed=schema.safeParse(value);if(!parsed.success)throw new ProviderError('invalid_response','The provider result could not be verified. Check the saved operation before trying again.');return parsed.data; }
const fingerprint=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const messageId=(value?:string)=>value?.trim().match(/^<[^<>\s]+@[^<>\s]+>$/)?.[0];
function plainPart(part:any,html=false):string {
  if(part?.filename)return '';
  if(part?.mimeType===(html?'text/html':'text/plain')&&typeof part?.body?.data==='string') {
    const data=part.body.data;
    if(!/^[A-Za-z0-9_-]*={0,2}$/.test(data))throw new ProviderError('invalid_response','The reply source text could not be verified.');
    const contentType=part.headers?.find((item:any)=>String(item.name).toLowerCase()==='content-type')?.value??'';
    const charset=String(contentType).match(/charset\s*=\s*"?([^\s;"]+)/i)?.[1]??'utf-8';
    let decoded:string;try{decoded=new TextDecoder(charset,{fatal:true}).decode(Buffer.from(data,'base64url'));}catch{throw new ProviderError('invalid_response','The reply source character encoding could not be verified.');}
    return html?htmlToText(decoded):decoded;
  }
  for(const child of Array.isArray(part?.parts)?part.parts:[]) {const found=plainPart(child,html);if(found)return found;}return '';
}
export async function readDeliverySource(request:MailRequest,account:ConnectedAccount,reply:NonNullable<MailDeliveryMessage['reply']>):Promise<MailReplySource> {
  if(account.provider==='google') {
    const raw=valid(z.object({id,threadId:id,labelIds:z.array(z.string()).max(1000).optional(),payload:z.object({headers:z.array(header).max(1000)}).passthrough()}),await request(`/messages/${encodeURIComponent(reply.messageId)}?format=full`));
    if(raw.labelIds?.includes('DRAFT'))throw new ProviderError('permission','Choose a received or sent message as the reply source. An unsent draft must be opened for editing.');
    if(raw.id!==reply.messageId||raw.threadId!==reply.threadId)throw new ProviderError('invalid_response','This reply belongs to another conversation.');
    const get=(name:string)=>raw.payload.headers.find(item=>item.name.toLowerCase()===name)?.value??'';
    const source={messageId:raw.id,threadId:raw.threadId,subject:get('subject'),from:get('from'),internetMessageId:messageId(get('message-id')),references:(get('references').match(/<[^<>\s]+@[^<>\s]+>/g)??[]).slice(-50),text:plainPart(raw.payload)||plainPart(raw.payload,true)};
    return {...source,fingerprint:fingerprint(source)};
  }
  const raw=valid(z.object({id,conversationId:id,subject:text,from:z.object({emailAddress:z.object({address:id,name:z.string().optional()})}),body:z.object({contentType:z.string(),content:text}),internetMessageId:id.optional(),internetMessageHeaders:z.array(header).optional(),isDraft:z.boolean().optional()}).passthrough(),await request(`/messages/${encodeURIComponent(reply.messageId)}?$select=id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,body,internetMessageId,internetMessageHeaders,isDraft`));
  if(raw.id!==reply.messageId||raw.conversationId!==reply.threadId||raw.isDraft)throw new ProviderError('invalid_response','This reply source changed or belongs to another conversation.');
  const view=originalMicrosoftMessageViews([raw],reply.threadId)[0];
  const source={messageId:raw.id,threadId:raw.conversationId,subject:raw.subject,from:view.from,internetMessageId:messageId(raw.internetMessageId),text:view.bodyText};
  return {...source,fingerprint:fingerprint({...source,replyTo:raw.replyTo})};
}
export async function verifyDeliverySender(request:MailRequest,account:ConnectedAccount,from:string) {
  if(from.toLowerCase()===account.email.toLowerCase())return;
  if(account.provider==='microsoft')throw new ProviderError('permission','Choose the connected Outlook sender for this message.');
  const aliases=valid(z.object({sendAs:z.array(z.object({sendAsEmail:id,verificationStatus:z.string().optional(),isPrimary:z.boolean().optional()})).max(1000)}),await request('/settings/sendAs'));
  if(!aliases.sendAs.some(alias=>alias.sendAsEmail.toLowerCase()===from.toLowerCase()&&(alias.isPrimary||alias.verificationStatus==='accepted')))throw new ProviderError('permission','This Gmail sender is not a verified alias. Choose an available sender.');
}
export async function applyDeliveryStage(request:MailRequest,account:ConnectedAccount,operation:{id:string;mode:'draft'|'send';message:MailDeliveryMessage;rawMime:string;phase:MailDeliveryStage;providerDraftId?:string;providerChangeKey?:string;draft?:MailDraftSnapshot;envelope?:MailDraftEnvelope},before:()=>void):Promise<MailDeliveryProviderResult> {
  const {message}=operation;
  if(operation.phase==='update-draft'||operation.phase==='send-draft') {
    if(!operation.providerDraftId||!operation.draft)throw new ProviderError('invalid_response','The original saved draft is unavailable.');
    const current=await readProviderDraft(request,account,operation.providerDraftId);
    if(account.provider==='google'||operation.phase==='update-draft') {
      if(current.fingerprint!==operation.draft.fingerprint)throw new ProviderError('permission','The provider draft changed after review. Your proposed writing is kept; review the current saved draft.');
    }else if(current.changeKey!==operation.providerChangeKey)throw new ProviderError('permission','The provider draft changed before sending. Your writing is kept; check the saved operation.');
    if(account.provider==='google') {
      const threadId=message.reply?.threadId??(operation.envelope?.inReplyTo?operation.envelope.threadId:undefined);
      const payload={id:operation.providerDraftId,message:{raw:operation.rawMime,...(threadId?{threadId}:{})}};
      before();
      if(operation.phase==='send-draft') {
        const value=valid(z.object({id,threadId:id.optional()}),await request('/drafts/send',{method:'POST',body:JSON.stringify(payload)}));
        if(threadId&&value.threadId!==threadId)throw new ProviderError('invalid_response','Gmail did not confirm the original reply conversation. Check this operation.');
        return {draftId:operation.providerDraftId,messageId:value.id};
      }
      const value=valid(z.object({id,message:z.object({id,threadId:id.optional()})}),await request(`/drafts/${encodeURIComponent(operation.providerDraftId)}`,{method:'PUT',body:JSON.stringify(payload)}));
      if(value.id!==operation.providerDraftId||(threadId&&value.message.threadId!==threadId))throw new ProviderError('invalid_response','Gmail did not confirm updating the same saved draft. Check this operation.');
      return {draftId:value.id,messageId:value.message.id};
    }
    verifyDraftAttachments(current,message);
    // Keep the actual provider validator; never manufacture one from changeKey.
    // Live provider enforcement remains a release acceptance requirement.
    if(!current.etag||! /^(?:W\/)?"[^"\r\n]+"$/.test(current.etag))throw new ProviderError('permission','Outlook did not provide a conditional draft version. Your writing is kept; this draft cannot be changed or sent here yet.');
    const path=`/messages/${encodeURIComponent(operation.providerDraftId)}`;
    before();
    if(operation.phase==='send-draft') {
      const value=await request(path+'/send',{method:'POST',headers:{'If-Match':current.etag,'Content-Length':'0'}},[202]);
      if(value!==null)throw new ProviderError('invalid_response','Outlook did not confirm accepting the saved draft for sending.');
      return {draftId:current.id,messageId:current.id,changeKey:current.changeKey};
    }
    const body={...originalMicrosoftMessageBody(message,operation.envelope),internetMessageId:`<${operation.id}@edition3.invalid>`,singleValueExtendedProperties:[{id:OPERATION_PROPERTY,value:operation.id}]};
    const value=valid(graphDraft,await request(path,{method:'PATCH',headers:{'If-Match':current.etag},body:JSON.stringify(body)}));
    if(value.id!==current.id||!value.isDraft)throw new ProviderError('invalid_response','Outlook did not confirm updating the original saved draft.');
    return {draftId:value.id,messageId:value.id,changeKey:value.changeKey};
  }
  if(account.provider==='google') {
    before();
    const input={raw:operation.rawMime,...(message.reply?{threadId:message.reply.threadId}:{})};
    if(operation.mode==='draft') {
      const value=valid(z.object({id,message:z.object({id,threadId:id.optional()})}),await request('/drafts',{method:'POST',body:JSON.stringify({message:input})}));
      if(message.reply&&value.message.threadId!==message.reply.threadId)throw new ProviderError('invalid_response','Gmail did not confirm the original reply conversation. Check this saved operation.');
      return {draftId:value.id,messageId:value.message.id};
    }
    const value=valid(z.object({id,threadId:id.optional()}),await request('/messages/send',{method:'POST',body:JSON.stringify(input)}));
    if(message.reply&&value.threadId!==message.reply.threadId)throw new ProviderError('invalid_response','Gmail did not confirm the original reply conversation. Check this saved operation.');
    return {messageId:value.id};
  }
  if(operation.mode==='send') {
    // Dispatch the reviewed immutable bytes; an external edit to a provider
    // draft must never replace the message the user approved.
    const path=message.reply?`/messages/${encodeURIComponent(message.reply.messageId)}/reply`:'/sendMail';
    before();
    const value=await request(path,{method:'POST',headers:{'Content-Type':'text/plain'},body:Buffer.from(operation.rawMime,'base64url').toString('base64')},[202]);
    if(value!==null)throw new ProviderError('invalid_response','Outlook did not confirm accepting this send. Check the saved operation.');
    return {};
  }
  const marker={id:'String {159f5485-dbf0-457e-b3d4-bd5e744f04a3} Name Edition3Operation',value:operation.id};
  const body={...originalMicrosoftMessageBody(message),singleValueExtendedProperties:[marker]};
  if(operation.phase==='create') {
    const attachments=mailAttachmentBytes(message).map(file=>({'@odata.type':'#microsoft.graph.fileAttachment',name:file.name,contentType:file.mimeType,contentBytes:file.base64,...(file.cid?{contentId:file.cid}:{}),...(file.disposition==='inline'?{isInline:true}:{})}));
    before();
    const value=valid(graphDraft,await request('/messages',{method:'POST',body:JSON.stringify({...body,...(attachments.length?{attachments}:{})})}));
    if(!value.isDraft)throw new ProviderError('invalid_response','The provider returned a message that is not a draft.');
    return {draftId:value.id,messageId:value.id,changeKey:value.changeKey};
  }
  if(operation.phase==='create-reply') {
    before();
    const value=valid(graphDraft,await request(`/messages/${encodeURIComponent(message.reply!.messageId)}/createReply`,message.attachments.length ? {method:'POST',headers:{'Content-Type':'text/plain'},body:Buffer.from(operation.rawMime,'base64url').toString('base64')} : {method:'POST',body:'{}'}));
    if(!value.isDraft||value.conversationId!==message.reply!.threadId)throw new ProviderError('invalid_response','The provider reply draft belongs to a different conversation.');
    return {draftId:value.id,messageId:value.id,changeKey:value.changeKey};
  }
  if(!operation.providerDraftId||!operation.providerChangeKey)throw new ProviderError('invalid_response','The exact saved Outlook draft is unavailable.');
  const path=`/messages/${encodeURIComponent(operation.providerDraftId)}`;
  const current=valid(graphDraft,await request(path+'?$select=id,isDraft,changeKey,conversationId'));
  if(current.id!==operation.providerDraftId||!current.isDraft||current.changeKey!==operation.providerChangeKey)throw new ProviderError('permission','The provider draft changed after review. Your writing is kept; review the saved draft.');
  before();
  if(operation.phase==='update-reply') {
    const value=valid(graphDraft,await request(path,{method:'PATCH',body:JSON.stringify(body)}));
    if(value.id!==operation.providerDraftId||!value.isDraft)throw new ProviderError('invalid_response','The updated Outlook draft could not be verified.');
    return {draftId:value.id,messageId:value.id,changeKey:value.changeKey};
  }
  throw new ProviderError('invalid_response','This draft stage is not supported.');
}

export type MailReconciliation = { result?:MailDeliveryProviderResult; outcome?:'saved'|'accepted'|'interrupted'; completed?:MailDeliveryStage[]; detail:string };
export const OPERATION_PROPERTY='String {159f5485-dbf0-457e-b3d4-bd5e744f04a3} Name Edition3Operation';
export async function reconcileDelivery(request:MailRequest,account:ConnectedAccount,operation:{id:string;mode:'draft'|'send';message:MailDeliveryMessage;attempted?:MailDeliveryStage;completed:MailDeliveryStage[];providerDraftId?:string;providerChangeKey?:string;previousOperationId?:string;rawMime?:string;createdAt?:string}):Promise<MailReconciliation> {
  const inconclusive={detail:'The provider has not supplied enough evidence to confirm this operation. Your writing is kept; no message was sent again.'};
  if(account.provider==='google') {
    const query=new URLSearchParams({q:`rfc822msgid:${operation.id}@edition3.invalid`,maxResults:'10',...(operation.mode==='send'?{includeSpamTrash:'true'}:{})});
    let draftId:string|undefined,candidateId:string|undefined;
    if(operation.mode==='draft') {
      const page=valid(z.object({drafts:z.array(z.object({id,message:z.object({id})})).max(10).default([]),nextPageToken:z.string().optional()}),await request('/drafts?'+query));
      if(!page.drafts.length&&!page.nextPageToken&&operation.rawMime) return recoverGmailDraft(request,operation);
      if(page.drafts.length!==1||page.nextPageToken)return inconclusive;
      draftId=page.drafts[0].id;candidateId=page.drafts[0].message.id;
    }else{
      const page=valid(z.object({messages:z.array(z.object({id})).max(10).default([]),nextPageToken:z.string().optional()}),await request('/messages?'+query));
      if(!page.messages.length&&!page.nextPageToken&&operation.rawMime)return recoverGmailSend(request,operation);
      if(page.messages.length!==1||page.nextPageToken)return inconclusive;candidateId=page.messages[0].id;
    }
    const parameters=new URLSearchParams({format:'metadata'});parameters.append('metadataHeaders','Message-ID');parameters.append('metadataHeaders','X-Edition3-Operation');
    const value=valid(z.object({id,threadId:id.optional(),labelIds:z.array(z.string()).max(1000),payload:z.object({headers:z.array(header).max(1000)})}),await request(`/messages/${encodeURIComponent(candidateId)}?${parameters}`));
    const get=(key:string)=>value.payload.headers.find(item=>item.name.toLowerCase()===key)?.value;
    if(value.id!==candidateId||(operation.message.reply&&value.threadId!==operation.message.reply.threadId)||get('message-id')!==`<${operation.id}@edition3.invalid>`||get('x-edition3-operation')!==operation.id||!value.labelIds.includes(operation.mode==='send'?'SENT':'DRAFT'))return inconclusive;
    if(operation.previousOperationId&&operation.mode==='draft'&&draftId!==operation.providerDraftId)return inconclusive;
    return {result:{draftId,messageId:candidateId},outcome:operation.mode==='send'?'accepted':'saved',completed:[operation.previousOperationId?(operation.mode==='send'?'send-draft':'update-draft'):(operation.mode==='send'?'send':'create')],detail:operation.mode==='send'?'The provider confirms this exact message in Sent. Recipient delivery is not confirmed.':'The provider confirms this exact saved draft.'};
  }
  if(operation.mode==='send') {
    if(operation.previousOperationId&&operation.attempted!=='send-draft'&&!operation.completed.includes('send-draft')) {
      const draft=await reconcileDelivery(request,account,{...operation,mode:'draft'});
      if(draft.outcome==='saved')return {...draft,outcome:'interrupted',detail:'Outlook confirms the draft update. Sending has not started successfully; review the remaining send step.'};
      return inconclusive;
    }
    const query=new URLSearchParams({'$filter':`internetMessageId eq '<${operation.id}@edition3.invalid>'`,'$select':'id,internetMessageId,isDraft,parentFolderId','$top':'10'});
    const page=valid(z.object({value:z.array(z.object({id,internetMessageId:id,isDraft:z.boolean(),parentFolderId:id})).max(10),'@odata.nextLink':z.string().optional()}),await request('/messages?'+query));
    if(page.value.length!==1||page['@odata.nextLink'])return inconclusive;
    const candidate=page.value[0];if(candidate.isDraft||candidate.internetMessageId!==`<${operation.id}@edition3.invalid>`)return inconclusive;
    const message=valid(z.object({id,internetMessageHeaders:z.array(header).max(1000).default([]),isDraft:z.boolean(),parentFolderId:id,singleValueExtendedProperties:z.array(z.object({id,value:z.string()})).optional()}),await request(`/messages/${encodeURIComponent(candidate.id)}?$select=id,internetMessageHeaders,isDraft,parentFolderId${operation.previousOperationId?'&$expand='+encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${OPERATION_PROPERTY}')`):''}`));
    const sent=valid(z.object({id}),await request('/mailFolders/sentitems?$select=id'));
    const marked=operation.previousOperationId?message.id===operation.providerDraftId&&message.singleValueExtendedProperties?.some(value=>value.id===OPERATION_PROPERTY&&value.value===operation.id):message.internetMessageHeaders.some(value=>value.name.toLowerCase()==='x-edition3-operation'&&value.value===operation.id);
    if(message.id!==candidate.id||message.isDraft||message.parentFolderId!==sent.id||!marked)return inconclusive;
    return {result:{messageId:message.id},outcome:'accepted',completed:operation.previousOperationId?['update-draft','send-draft']:['send'],detail:'Outlook confirms this exact operation in Sent. Recipient delivery is not confirmed.'};
  }
  let candidateId=operation.providerDraftId;
  if(!candidateId) {
    const query=new URLSearchParams({'$filter':`singleValueExtendedProperties/Any(ep: ep/id eq '${OPERATION_PROPERTY}' and ep/value eq '${operation.id}')`,'$select':'id','$top':'10'});
    const page=valid(z.object({value:z.array(z.object({id})).max(10),'@odata.nextLink':z.string().optional()}),await request('/messages?'+query));
    if(page.value.length!==1||page['@odata.nextLink'])return inconclusive;candidateId=page.value[0].id;
  }
  const query=new URLSearchParams({'$select':'id,isDraft,changeKey,parentFolderId,subject,body,from,toRecipients,ccRecipients,bccRecipients','$expand':`singleValueExtendedProperties($filter=id eq '${OPERATION_PROPERTY}')`});
  const recipient=z.object({emailAddress:z.object({address:id})});
  const value=valid(graphDraft.extend({parentFolderId:id,subject:text,body:z.object({contentType:z.string(),content:text}),from:recipient.nullish(),toRecipients:z.array(recipient),ccRecipients:z.array(recipient),bccRecipients:z.array(recipient),singleValueExtendedProperties:z.array(z.object({id,value:z.string()})).optional()}),await request(`/messages/${encodeURIComponent(candidateId)}?${query}`));
  if(value.id!==candidateId)return inconclusive;
  const marked=value.singleValueExtendedProperties?.some(property=>property.id===OPERATION_PROPERTY&&property.value===operation.id);
  const known=operation.providerDraftId===candidateId;
  if(!known&&!marked)return inconclusive;
  const result={draftId:candidateId,messageId:candidateId,changeKey:value.changeKey};
  if(!value.isDraft)return inconclusive;
  const normalize=(addresses:string[])=>addresses.map(address=>address.toLowerCase()).sort();
  const same=(actual:typeof value.toRecipients,expected:string[])=>canonical(normalize(actual.map(item=>item.emailAddress.address)))===canonical(normalize(expected));
  const expected=originalMicrosoftMessageBody(operation.message);
  const matches=value.subject===expected.subject&&(value.from?.emailAddress.address??account.email).toLowerCase()===operation.message.from.toLowerCase()
    &&same(value.toRecipients,operation.message.to)&&same(value.ccRecipients,operation.message.cc)&&same(value.bccRecipients,operation.message.bcc)
    &&value.body.contentType.toLowerCase()===expected.body.contentType&&value.body.content===expected.body.content;
  const confirmedUnedited=known&&value.changeKey===operation.providerChangeKey&&operation.completed.includes(operation.previousOperationId?'update-draft':operation.message.reply?(operation.message.attachments.length?'create-reply':'update-reply'):'create');
  if(!confirmedUnedited&&(!marked||!matches))return inconclusive;
  if(operation.message.attachments.length||operation.completed.includes('update-files')){try{verifyDraftAttachments(await readProviderDraft(request,account,candidateId),operation.message);}catch{return inconclusive;}}
  const completed:MailDeliveryStage[]=operation.previousOperationId?[...(operation.completed.includes('update-files')?['update-files' as const]:[]),'update-draft']:operation.message.reply?['create-reply',...(operation.message.attachments.length?[]:['update-reply' as const])]:['create'];
  return {result,outcome:'saved',completed,detail:'Outlook confirms the saved draft.'};
}
