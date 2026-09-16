import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectedAccount } from '../../packages/domain/accounts.js';
import type { MailDraftSnapshot, MailDeliveryMessage } from '../../packages/domain/mail-delivery.js';
import { canonical } from '../../packages/domain/contracts.js';
import { htmlToText } from './dreamclaw/microsoft-mail.js';
import { ProviderError } from './providers.js';
import type { MailRequest } from './provider-mail-delivery.js';

const id=z.string().min(1).max(2000), text=z.string().max(2000000);
const address=z.object({emailAddress:z.object({address:id})});
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const valid=<T>(schema:z.ZodType<T>,value:unknown):T=>{
  const result=schema.safeParse(value);if(!result.success)throw new ProviderError('invalid_response','The saved provider draft could not be read completely. Your writing is kept.');return result.data;
};
function parts(payload:any):{bodyText:string;attachments:MailDraftSnapshot['attachments']} {
  let bodyText='',html='',count=0;const attachments:MailDraftSnapshot['attachments']=[];
  function visit(part:any,depth=0) {
    if(depth>20||++count>1000)throw new ProviderError('invalid_response','This draft has too many nested message parts.');
    if(['multipart/signed','multipart/encrypted','application/pkcs7-mime','application/x-pkcs7-mime'].includes(part.mimeType))throw new ProviderError('invalid_response','This draft requires its signed or encrypted mail workflow. The original message is unchanged.');
    if(part.filename)attachments.push({name:String(part.filename),mimeType:String(part.mimeType||'application/octet-stream'),bytes:Number(part.body?.size??0)});
    else if(['text/plain','text/html'].includes(part.mimeType)&&typeof part.body?.data==='string') {
      const contentType=part.headers?.find((h:any)=>String(h.name).toLowerCase()==='content-type')?.value??'';
      const charset=String(contentType).match(/charset\s*=\s*"?([^\s;"]+)/i)?.[1]??'utf-8';
      let value:string;try{value=new TextDecoder(charset,{fatal:true}).decode(Buffer.from(part.body.data,'base64url'));}catch{throw new ProviderError('invalid_response','The saved draft text encoding could not be verified.');}
      if(part.mimeType==='text/plain')bodyText+=value;else html+=value;
    }
    for(const child of part.parts??[])visit(child,depth+1);
  }
  visit(payload);return {bodyText:bodyText||htmlToText(html),attachments};
}
/** A current provider-owned version, kept separately from the proposed writing. */
export async function readProviderDraft(request:MailRequest,account:ConnectedAccount,draftId:string):Promise<MailDraftSnapshot> {
  if(account.provider==='google') {
    const value=valid(z.object({id,message:z.object({id,threadId:id,labelIds:z.array(z.string()).optional(),payload:z.object({headers:z.array(z.object({name:z.string(),value:z.string()})).max(1000)}).passthrough()})}),await request(`/drafts/${encodeURIComponent(draftId)}?format=full`));
    if(value.id!==draftId||value.message.labelIds&&!value.message.labelIds.includes('DRAFT'))throw new ProviderError('invalid_response','This item is no longer the saved Gmail draft.');
    const get=(name:string)=>value.message.payload.headers.filter(h=>h.name.toLowerCase()===name).map(h=>h.value).join(', ');
    const content=parts(value.message.payload);
    const snapshot={id:value.id,messageId:value.message.id,subject:get('subject'),from:get('from'),to:[get('to')].filter(Boolean),cc:[get('cc')].filter(Boolean),bcc:[get('bcc')].filter(Boolean),...content};
    return {...snapshot,fingerprint:hash({id:value.id,message:value.message})};
  }
  const value=valid(z.object({id,isDraft:z.boolean(),changeKey:id,'@odata.etag':z.string().max(4000).optional(),subject:text,from:address.nullish(),toRecipients:z.array(address),ccRecipients:z.array(address),bccRecipients:z.array(address),body:z.object({contentType:z.string(),content:text}),hasAttachments:z.boolean()}),await request(`/messages/${encodeURIComponent(draftId)}?$select=id,isDraft,changeKey,subject,from,toRecipients,ccRecipients,bccRecipients,body,hasAttachments`));
  if(value.id!==draftId||!value.isDraft)throw new ProviderError('invalid_response','This item is no longer the saved Outlook draft.');
  const attachments:MailDraftSnapshot['attachments']=[];
  { // hasAttachments excludes inline files; always inspect the attachment list.
    const page=valid(z.object({value:z.array(z.object({id,name:id,contentType:id,size:z.number().int().nonnegative(),contentBytes:z.string().optional(),isInline:z.boolean().optional(),contentId:z.string().optional(),'@odata.type':z.string()})).max(100),'@odata.nextLink':z.string().optional()}),await request(`/messages/${encodeURIComponent(draftId)}/attachments`));
    if(page['@odata.nextLink'])throw new ProviderError('invalid_response','The complete saved-draft attachment list could not be verified.');
    for(const file of page.value) {
      if(file['@odata.type']!=='#microsoft.graph.fileAttachment'||typeof file.contentBytes!=='string'||file.size>=3*1024*1024)throw new ProviderError('invalid_response','This saved draft has an attachment that needs the large-file or linked-file workflow. Your writing is kept.');
      const bytes=Buffer.from(file.contentBytes,'base64');
      if(bytes.length!==file.size)throw new ProviderError('invalid_response','The provider draft attachment changed while reading.');
      attachments.push({providerId:file.id,name:file.name,mimeType:file.contentType,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(file.contentId?{cid:file.contentId.replace(/^<|>$/g,'')}:{}),...(file.isInline?{disposition:'inline' as const}:{})});
    }
  }
  // Graph can omit From on an unsent draft in this authenticated /me mailbox.
  // Keep an explicit provider sender; only absence uses the connected account.
  const snapshot={id:value.id,messageId:value.id,changeKey:value.changeKey,etag:value['@odata.etag'],subject:value.subject,from:value.from?.emailAddress.address??account.email,to:value.toRecipients.map(r=>r.emailAddress.address),cc:value.ccRecipients.map(r=>r.emailAddress.address),bcc:value.bccRecipients.map(r=>r.emailAddress.address),bodyText:value.body.contentType.toLowerCase()==='html'?htmlToText(value.body.content):value.body.content,attachments};
  return {...snapshot,contentFingerprint:hash({id:value.id,isDraft:value.isDraft,subject:value.subject,from:value.from,to:value.toRecipients,cc:value.ccRecipients,bcc:value.bccRecipients,body:value.body}),fingerprint:hash({snapshot,body:value.body})};
}
export function verifyDraftAttachments(draft:MailDraftSnapshot,message:MailDeliveryMessage) {
  const normalize=(files:MailDraftSnapshot['attachments'])=>files.map(({name,mimeType,bytes,sha256,cid,disposition})=>({name,mimeType,bytes,sha256,cid,disposition:disposition??'attachment'})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  if(canonical(normalize(draft.attachments))!==canonical(normalize(message.attachments)))throw new ProviderError('permission','The saved Outlook attachments differ from this message. Review those files before changing or sending this draft.');
}
