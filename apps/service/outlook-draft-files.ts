import type {ConnectedAccount} from '../../packages/domain/accounts.js';
import type {MailDeliveryMessage,MailDraftSnapshot} from '../../packages/domain/mail-delivery.js';
import {canonical} from '../../packages/domain/contracts.js';
import {readProviderDraft} from './provider-mail-drafts.js';
import type {MailRequest} from './provider-mail-delivery.js';
import {ProviderError} from './providers.js';

type File=MailDraftSnapshot['attachments'][number];
export type OutlookFileChange={kind:'remove';file:File}|{kind:'add';index:number};
export type OutlookFileProgress={cursor:number;draft:MailDraftSnapshot;pending?:boolean};
export const fileIdentity=(file:File)=>canonical({name:file.name,mimeType:file.mimeType,bytes:file.bytes,sha256:file.sha256,cid:file.cid,disposition:file.disposition??'attachment'});
export function outlookFilePlan(current:MailDraftSnapshot,desired:MailDeliveryMessage):OutlookFileChange[] {
  const remaining=[...current.attachments],added:OutlookFileChange[]=[];
  desired.attachments.forEach((file,index)=>{const match=remaining.findIndex(item=>fileIdentity(item)===fileIdentity(file));if(match>=0)remaining.splice(match,1);else added.push({kind:'add',index});});
  if(remaining.some(file=>!file.providerId))throw new ProviderError('invalid_response','The exact Outlook file identifiers are unavailable. Reopen this draft before changing its files.');
  if(added.some(change=>change.kind==='add'&&desired.attachments[change.index].bytes>=3*1024*1024))throw new ProviderError('permission','This Outlook file needs the large-file upload workflow. Your selected files and writing are kept.');
  // Add first, then remove the exact old ids. Partial completion never discards
  // the retained bytes and is reported until the reviewed body is also saved.
  return [...added,...remaining.map(file=>({kind:'remove' as const,file}))];
}
export function verifiedFileChange(before:MailDraftSnapshot,after:MailDraftSnapshot,change:OutlookFileChange,message:MailDeliveryMessage):boolean {
  if(before.id!==after.id||!before.contentFingerprint||before.contentFingerprint!==after.contentFingerprint)return false;
  const old=before.attachments,newFiles=[...after.attachments];
  for(const file of old){
    if(change.kind==='remove'&&file.providerId===change.file.providerId)continue;
    const index=newFiles.findIndex(candidate=>candidate.providerId===file.providerId&&fileIdentity(candidate)===fileIdentity(file));
    if(index<0)return false;newFiles.splice(index,1);
  }
  if(change.kind==='remove')return newFiles.length===0&&!after.attachments.some(file=>file.providerId===change.file.providerId);
  return newFiles.length===1&&!!newFiles[0].providerId&&fileIdentity(newFiles[0])===fileIdentity(message.attachments[change.index]);
}
export async function applyOutlookFileChange(request:MailRequest,account:ConnectedAccount,draft:MailDraftSnapshot,change:OutlookFileChange,message:MailDeliveryMessage,before:()=>void):Promise<MailDraftSnapshot> {
  const current=await readProviderDraft(request,account,draft.id);
  if(current.fingerprint!==draft.fingerprint)throw new ProviderError('permission','The Outlook draft changed between file steps. Your remaining selection is kept; check the saved operation.');
  if(!current.etag||!/^(?:W\/)?"[^"\r\n]+"$/.test(current.etag))throw new ProviderError('permission','Outlook did not provide its current draft version. Your files are kept.');
  const path=`/messages/${encodeURIComponent(draft.id)}/attachments`;
  before();
  if(change.kind==='remove'){
    const result=await request(path+'/'+encodeURIComponent(change.file.providerId!),{method:'DELETE',headers:{'If-Match':current.etag}},[204]);
    if(result!==null)throw new ProviderError('invalid_response','Outlook did not confirm the file removal. Check this operation.');
  }else{
    const file=message.attachments[change.index];
    const result=await request(path,{method:'POST',headers:{'If-Match':current.etag},body:JSON.stringify({'@odata.type':'#microsoft.graph.fileAttachment',name:file.name,contentType:file.mimeType,contentBytes:file.base64,...(file.cid?{contentId:file.cid}:{}),...(file.disposition==='inline'?{isInline:true}:{})})}) as {id?:unknown};
    if(!result||typeof result.id!=='string'||!result.id)throw new ProviderError('invalid_response','Outlook did not confirm the added file. Check this operation.');
  }
  let after:MailDraftSnapshot;
  try{after=await readProviderDraft(request,account,draft.id);}catch{throw new ProviderError('invalid_response','Outlook accepted a file change, but its complete result could not be read. Check this operation before continuing.');}
  if(!verifiedFileChange(current,after,change,message))throw new ProviderError('invalid_response','The complete Outlook file change could not be verified. Check this operation before continuing.');
  return after;
}
