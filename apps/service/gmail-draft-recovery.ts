import { z } from 'zod';
import type { MailRequest, MailReconciliation } from './provider-mail-delivery.js';
import { gmailOperationContentMatches } from './gmail-operation-content.js';

const id=z.string().min(1).max(2000);
const message=z.object({id,threadId:id,labelIds:z.array(z.string()).max(1000),payload:z.object({headers:z.array(z.object({name:z.string().max(1000),value:z.string().max(10000)})).max(1000)})});
const unavailable:MailReconciliation={detail:'Gmail has not confirmed this exact draft. Your writing is kept; no draft was created again.'};

/** Gmail may replace Message-ID on saving a draft. Only an exact operation
 * marker and complete matching MIME content can resolve that lost response. */
export async function recoverGmailDraft(request:MailRequest,operation:{id:string;previousOperationId?:string;providerDraftId?:string;rawMime?:string;message?:{reply?:{threadId:string}}}):Promise<MailReconciliation> {
  if(!operation.rawMime)return unavailable;
  // A known container avoids a mailbox scan for an uncertain draft update.
  const page=operation.providerDraftId
    ? z.object({id,message:z.object({id})}).parse(await request(`/drafts/${encodeURIComponent(operation.providerDraftId)}?format=minimal`))
    : undefined;
  const inventory=page?{drafts:[page]}:z.object({drafts:z.array(z.object({id,message:z.object({id})})).max(50).default([]),nextPageToken:id.optional()}).parse(await request('/drafts?maxResults=50&includeSpamTrash=true'));
  if('nextPageToken' in inventory&&inventory.nextPageToken)return {...unavailable,detail:'Gmail has more drafts than this check can verify completely. The operation stays unconfirmed; no draft was created again.'};
  const containers=new Set<string>(),messages=new Set<string>();
  for(const draft of inventory.drafts){if(containers.has(draft.id)||messages.has(draft.message.id))return unavailable;containers.add(draft.id);messages.add(draft.message.id);}
  const matches:{draftId:string;messageId:string;threadId:string}[]=[];
  // Bound parallel metadata reads. Unrelated draft bodies are never fetched.
  for(let offset=0;offset<inventory.drafts.length;offset+=4){
    const results=await Promise.all(inventory.drafts.slice(offset,offset+4).map(async draft=>{
      const query=new URLSearchParams({format:'metadata',metadataHeaders:'X-Edition3-Operation'});
      const found=message.parse(await request(`/messages/${encodeURIComponent(draft.message.id)}?${query}`));
      const markers=found.payload.headers.filter(h=>h.name.toLowerCase()==='x-edition3-operation');
      if(found.id!==draft.message.id)throw new Error('Gmail draft identity changed during the check.');
      if(!markers.some(marker=>marker.value===operation.id))return undefined;
      if(markers.length!==1||!found.labelIds.includes('DRAFT')||found.labelIds.some(label=>['SENT','TRASH','SPAM'].includes(label)))return 'ambiguous' as const;
      return {draftId:draft.id,messageId:found.id,threadId:found.threadId};
    }));
    if(results.includes('ambiguous'))return unavailable;
    matches.push(...results.filter((value):value is {draftId:string;messageId:string;threadId:string}=>!!value&&value!=='ambiguous'));
  }
  if(matches.length!==1)return unavailable;
  const match=matches[0];
  if(operation.message?.reply&&operation.message.reply.threadId!==match.threadId)return unavailable;
  const found=z.object({id,message:z.object({id,threadId:id,labelIds:z.array(z.string()).max(1000),raw:z.string().max(54*1024*1024).regex(/^[A-Za-z0-9_-]*={0,2}$/)})}).parse(await request(`/drafts/${encodeURIComponent(match.draftId)}?format=raw`));
  if(found.id!==match.draftId||found.message.id!==match.messageId||found.message.threadId!==match.threadId||!found.message.labelIds.includes('DRAFT')||found.message.labelIds.some(label=>['SENT','TRASH','SPAM'].includes(label)))return unavailable;
  if(!await gmailOperationContentMatches(operation.id,operation.rawMime,found.message.raw,match.threadId))return unavailable;
  return {outcome:'saved',result:{draftId:match.draftId,messageId:match.messageId},completed:[operation.previousOperationId?'update-draft':'create'],detail:'Gmail confirms the operation marker and complete contents of this saved draft.'};
}
