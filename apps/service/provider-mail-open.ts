import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { z } from 'zod';
import type { ConnectedAccount } from '../../packages/domain/accounts.js';
import { mailDeliveryMessageSchema, type MailDeliveryMessage, type MailDraftSnapshot } from '../../packages/domain/mail-delivery.js';
import { readProviderDraft } from './provider-mail-drafts.js';
import { OPERATION_PROPERTY, type MailRequest } from './provider-mail-delivery.js';
import { htmlToText } from './dreamclaw/microsoft-mail.js';
import { ProviderError } from './providers.js';
import { isBase64 } from '../../packages/domain/base64.js';

const id=z.string().min(1).max(2000), line=z.string().max(1000).refine(value=>!/[\r\n\0]/.test(value));
const namedAddress=z.object({address:line.pipe(z.email()),name:line.optional()});
export type DraftAddress=z.infer<typeof namedAddress>;
/** Read from the provider, never accepted as unverified composer headers. */
export type MailDraftEnvelope={from:DraftAddress;to:DraftAddress[];cc:DraftAddress[];bcc:DraftAddress[];replyTo:DraftAddress[];threadId:string;subject:string;inReplyTo?:string;references?:string[];priority?:'high'|'normal'|'low';operationId?:string};
export type ExistingProviderDraft={draft:MailDraftSnapshot;message:MailDeliveryMessage;envelope:MailDraftEnvelope};
const invalid=(message:string):never=>{throw new ProviderError('invalid_response',message+' Your original draft is unchanged.');};
function valid<T>(schema:z.ZodType<T>,value:unknown):T { const parsed=schema.safeParse(value);return parsed.success?parsed.data:invalid('The complete provider draft could not be verified.'); }
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function addresses(value?:AddressObject|AddressObject[]):DraftAddress[] {
  const result:DraftAddress[]=[];
  function visit(items:EmailAddress[],depth=0) {
    if(depth>10)invalid('This draft has too many nested recipient groups.');
    for(const item of items) {
      if(item.group)visit(item.group,depth+1);
      else result.push(valid(namedAddress,{address:item.address,name:item.name||undefined}));
      if(result.length>100)invalid('This draft has more than 100 recipients.');
    }
  }
  for(const item of value?Array.isArray(value)?value:[value]:[])visit(item.value);
  return result;
}
function headerIds(value:string|string[]|undefined):string[] {
  const values=value?(Array.isArray(value)?value:[value]):[];
  return valid(z.array(line.regex(/^<[^<>\s]+@[^<>\s]+>$/)).max(100),values);
}

export async function gmailDraftContent(raw:string,threadId:string) {
  const bytes=Buffer.from(raw,'base64url');
  if(bytes.length>40*1024*1024)invalid('This draft exceeds the current complete-message limit.');
  const parserOptions={skipHtmlToText:true,skipTextToHtml:true,skipTextLinks:true,keepCidLinks:true,skipImageLinks:true,keepDeliveryStatus:true,checksumAlgo:'sha256',maxHtmlLengthToParse:1000000};
  const parsed=await simpleParser(bytes,parserOptions);
  const from=addresses(parsed.from),to=addresses(parsed.to),cc=addresses(parsed.cc),bcc=addresses(parsed.bcc),replyTo=addresses(parsed.replyTo);
  if(from.length!==1)invalid('Choose a single sender for this provider draft.');
  const attachments=parsed.attachments.map((file,index)=>({name:file.filename||`attachment-${index+1}`,mimeType:file.contentType,base64:file.content.toString('base64'),bytes:file.content.length,sha256:sha(file.content),...(file.cid?{cid:file.cid}:{}),disposition:file.contentDisposition==='inline'?'inline' as const:'attachment' as const}));
  const html=typeof parsed.html==='string'?parsed.html:undefined;
  const message=valid(mailDeliveryMessageSchema,{from:from[0].address,to:to.map(a=>a.address),cc:cc.map(a=>a.address),bcc:bcc.map(a=>a.address),subject:parsed.subject??'',bodyText:parsed.text??htmlToText(html??''),...(html?{bodyHtml:html}:{}),attachments});
  const inReplyTo=headerIds(parsed.inReplyTo)[0],references=headerIds(parsed.references);
  const marker=z.uuid().safeParse(parsed.headers.get('x-edition3-operation'));
  const envelope:MailDraftEnvelope={from:from[0],to,cc,bcc,replyTo,threadId,subject:message.subject,...(inReplyTo?{inReplyTo}:{}),...(references.length?{references}:{}),...(parsed.priority?{priority:parsed.priority}:{}),...(marker.success&&parsed.messageId===`<${marker.data}@edition3.invalid>`?{operationId:marker.data}:{})};
  return {message,envelope,operationMarker:marker.success?marker.data:undefined};
}

/** Resolve a Gmail message to its actual draft container. IDs are different;
 * no guess, first-result fallback or truncated-list inference is permitted. */
export async function resolveGmailDraft(request:MailRequest,messageId:string,threadId:string):Promise<string> {
  let pageToken:string|undefined;const seen=new Set<string>();
  for(let page=0;page<100;page++) {
    const query=new URLSearchParams({maxResults:'100',...(pageToken?{pageToken}:{})});
    const value=valid(z.object({drafts:z.array(z.object({id,message:z.object({id,threadId:id.optional()})})).max(100).default([]),nextPageToken:id.optional()}),await request('/drafts?'+query));
    const matches=value.drafts.filter(draft=>draft.message.id===messageId);
    if(matches.length>1)invalid('The provider returned more than one container for this draft.');
    if(matches.length) {
      if(matches[0].message.threadId&&matches[0].message.threadId!==threadId)invalid('This draft belongs to another conversation.');
      return matches[0].id;
    }
    pageToken=value.nextPageToken;
    if(!pageToken)throw new ProviderError('not_found','This draft is no longer in its folder. Refresh Drafts; your kept writing is unchanged.');
    if(seen.has(pageToken))invalid('The provider repeated a draft-list page.');
    seen.add(pageToken);
  }
  return invalid('The draft list could not be searched completely.');
}

export async function readExistingProviderDraft(request:MailRequest,account:ConnectedAccount,input:{messageId:string;threadId:string}):Promise<ExistingProviderDraft> {
  const draftId=account.provider==='google'?await resolveGmailDraft(request,input.messageId,input.threadId):input.messageId;
  const draft=await readProviderDraft(request,account,draftId);
  if(draft.messageId!==input.messageId)invalid('This draft changed while it was being opened. Refresh Drafts.');
  if(account.provider==='google') {
    const value=valid(z.object({id,message:z.object({id,threadId:id,labelIds:z.array(z.string()).optional(),raw:z.string().max(54*1024*1024).regex(/^[A-Za-z0-9_-]*={0,2}$/)})}),await request(`/drafts/${encodeURIComponent(draftId)}?format=raw`));
    if(value.id!==draftId||value.message.id!==input.messageId||value.message.threadId!==input.threadId||value.message.labelIds&&!value.message.labelIds.includes('DRAFT'))invalid('This item changed or is no longer the selected Gmail draft.');
    const {message,envelope}=await gmailDraftContent(value.message.raw,input.threadId);
    return {draft,message,envelope};
  }

  const graphAddress=z.object({emailAddress:namedAddress});
  const value=valid(z.object({id,isDraft:z.boolean(),changeKey:id,conversationId:id,subject:line,from:graphAddress.nullish(),toRecipients:z.array(graphAddress),ccRecipients:z.array(graphAddress),bccRecipients:z.array(graphAddress),replyTo:z.array(graphAddress).default([]),importance:z.enum(['high','normal','low']).optional(),singleValueExtendedProperties:z.array(z.object({id,value:z.string()})).optional(),body:z.object({contentType:z.enum(['text','html','Text','HTML']),content:z.string().max(1000000)})}),await request(`/messages/${encodeURIComponent(draftId)}?$select=id,isDraft,changeKey,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,importance,body&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${OPERATION_PROPERTY}')`)}`));
  if(value.id!==draftId||!value.isDraft||value.changeKey!==draft.changeKey||value.conversationId!==input.threadId)invalid('This Outlook draft changed or belongs to another conversation.');
  const page=valid(z.object({value:z.array(z.object({id,name:line.min(1),contentType:line,size:z.number().int().nonnegative(),contentBytes:z.string().max(14*1024*1024).optional(),isInline:z.boolean().optional(),contentId:line.optional(),'@odata.type':z.string()})).max(100),'@odata.nextLink':z.string().optional()}),await request(`/messages/${encodeURIComponent(draftId)}/attachments`));
  if(page['@odata.nextLink'])invalid('The complete Outlook attachment list could not be verified.');
  const attachments=page.value.map(file=>{
    if(file['@odata.type']!=='#microsoft.graph.fileAttachment'||typeof file.contentBytes!=='string'||!isBase64(file.contentBytes))invalid('This draft needs the linked-file or large-file workflow.');
    const bytes=Buffer.from(file.contentBytes!,'base64');if(bytes.length!==file.size)invalid('An Outlook attachment changed while opening the draft.');
    return {name:file.name,mimeType:file.contentType,base64:file.contentBytes!,bytes:bytes.length,sha256:sha(bytes),...(file.contentId?{cid:file.contentId.replace(/^<|>$/g,'')}:{}),...(file.isInline?{disposition:'inline' as const}:{})};
  });
  const marker=z.uuid().safeParse(value.singleValueExtendedProperties?.find(item=>item.id===OPERATION_PROPERTY)?.value);
  const envelope:MailDraftEnvelope={from:value.from?.emailAddress??{address:account.email},to:value.toRecipients.map(a=>a.emailAddress),cc:value.ccRecipients.map(a=>a.emailAddress),bcc:value.bccRecipients.map(a=>a.emailAddress),replyTo:value.replyTo.map(a=>a.emailAddress),threadId:input.threadId,subject:value.subject,priority:value.importance,...(marker.success?{operationId:marker.data}:{})};
  const html=value.body.contentType.toLowerCase()==='html';
  const message=valid(mailDeliveryMessageSchema,{from:envelope.from.address,to:envelope.to.map(a=>a.address),cc:envelope.cc.map(a=>a.address),bcc:envelope.bcc.map(a=>a.address),subject:value.subject,bodyText:html?htmlToText(value.body.content):value.body.content,...(html?{bodyHtml:value.body.content}:{}),attachments});
  // A final version read rejects content assembled across an external edit.
  const after=await readProviderDraft(request,account,draftId);
  if(after.fingerprint!==draft.fingerprint)invalid('This Outlook draft changed while opening it.');
  return {draft,message,envelope};
}
