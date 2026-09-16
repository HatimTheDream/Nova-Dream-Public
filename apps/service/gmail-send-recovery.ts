import { z } from 'zod';
import type { MailRequest, MailReconciliation } from './provider-mail-delivery.js';
import { gmailOperationContentMatches } from './gmail-operation-content.js';

const id=z.string().min(1).max(2000);
const identity=z.object({id,threadId:id,labelIds:z.array(z.string()).max(1000),internalDate:z.string().regex(/^\d{1,16}$/)});
const metadata=identity.extend({payload:z.object({headers:z.array(z.object({name:z.string().max(1000),value:z.string().max(10000)})).max(1000)})});
const unavailable:MailReconciliation={detail:'Gmail has not confirmed this exact send. Your writing is kept; no message was sent again.'};

/** A successful Gmail send can replace Message-ID. Check a complete bounded
 * Sent inventory, then the unique marker and complete content; never resend. */
export async function recoverGmailSend(request:MailRequest,operation:{id:string;createdAt?:string;previousOperationId?:string;rawMime?:string;message?:{reply?:{threadId:string}}}):Promise<MailReconciliation> {
  const createdAt=Date.parse(operation.createdAt??'');
  if(!operation.rawMime||!Number.isFinite(createdAt)||createdAt<0)return unavailable;
  // The immutable review predates dispatch. A small clock margin is only a
  // search bound: matching still requires the unique marker and exact bytes.
  const after=Math.max(0,Math.floor(createdAt/1000)-300);
  const query=new URLSearchParams({labelIds:'SENT',includeSpamTrash:'true',q:`after:${after}`,maxResults:'50'});
  const page=z.object({messages:z.array(z.object({id,threadId:id})).max(50).default([]),nextPageToken:id.optional()}).parse(await request('/messages?'+query));
  if(page.nextPageToken)return {...unavailable,detail:'Gmail has more sent messages than this check can verify completely. The operation stays unconfirmed; no message was sent again.'};
  if(new Set(page.messages.map(m=>m.id)).size!==page.messages.length)return unavailable;
  const matches:z.infer<typeof identity>[]=[];
  for(let offset=0;offset<page.messages.length;offset+=4){
    const results=await Promise.all(page.messages.slice(offset,offset+4).map(async candidate=>{
      const parameters=new URLSearchParams({format:'metadata',metadataHeaders:'X-Edition3-Operation'});
      const found=metadata.parse(await request(`/messages/${encodeURIComponent(candidate.id)}?${parameters}`));
      if(found.id!==candidate.id||found.threadId!==candidate.threadId)throw Error('Gmail message identity changed during the check.');
      const markers=found.payload.headers.filter(h=>h.name.toLowerCase()==='x-edition3-operation');
      if(!markers.some(h=>h.value===operation.id))return undefined;
      if(markers.length!==1||!found.labelIds.includes('SENT')||found.labelIds.includes('DRAFT')||Number(found.internalDate)<after*1000)return 'ambiguous' as const;
      return found;
    }));
    if(results.includes('ambiguous'))return unavailable;
    matches.push(...results.filter((value):value is z.infer<typeof metadata>=>!!value&&value!=='ambiguous'));
  }
  if(matches.length!==1)return unavailable;
  const match=matches[0];
  if(operation.message?.reply&&operation.message.reply.threadId!==match.threadId)return unavailable;
  const found=identity.extend({raw:z.string().max(54*1024*1024).regex(/^[A-Za-z0-9_-]*={0,2}$/)}).parse(await request(`/messages/${encodeURIComponent(match.id)}?format=raw`));
  if(found.id!==match.id||found.threadId!==match.threadId||found.internalDate!==match.internalDate||!found.labelIds.includes('SENT')||found.labelIds.includes('DRAFT'))return unavailable;
  if(!await gmailOperationContentMatches(operation.id,operation.rawMime,found.raw,match.threadId))return unavailable;
  return {outcome:'accepted',result:{messageId:match.id},completed:[operation.previousOperationId?'send-draft':'send'],detail:'Gmail confirms the operation marker and complete message in Sent. Recipient delivery is not confirmed.'};
}
