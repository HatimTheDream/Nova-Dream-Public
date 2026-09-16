import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import type { ConnectedAccount } from '../../packages/domain/accounts.js';
import type { MailTriageAction, MailTriageTarget, TriageChange, TriageMessageState, TriageStep, TriageThreadState } from '../../packages/domain/mail-triage.js';
import type { MailRequest } from './provider-mail-delivery.js';
import { ProviderError } from './providers.js';

const id=z.string().min(1).max(2000), strings=z.array(id).max(1000);
const gmailMessage=z.object({id,threadId:id,labelIds:strings.optional(),internalDate:z.string().optional(),payload:z.object({headers:z.array(z.object({name:z.string(),value:z.string()})).max(1000).optional()}).optional()});
const graphMessage=z.object({id,conversationId:id,isDraft:z.boolean(),isRead:z.boolean(),flag:z.object({flagStatus:id}),categories:strings,parentFolderId:id,changeKey:id,'@odata.etag':z.string().max(4000).optional(),subject:z.string().max(10000).optional(),from:z.object({emailAddress:z.object({address:z.string()})}).optional(),receivedDateTime:z.string().optional()});
const graphSelect='id,conversationId,isDraft,isRead,flag,categories,parentFolderId,changeKey,subject,from,receivedDateTime';
function valid<T>(schema:z.ZodType<T>,raw:unknown):T { const result=schema.safeParse(raw);if(!result.success)throw new ProviderError('invalid_response','The provider did not return the complete mail state. Refresh this review.');return result.data; }
export const triageHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const unique=(values:string[])=>[...new Set(values)].sort();
export function messageFingerprint(message:TriageMessageState){return triageHash({...message,etag:undefined,changeKey:undefined});}
function normalize(provider:ConnectedAccount['provider'],raw:unknown):TriageMessageState {
  if(provider==='google') {
    const m=valid(gmailMessage,raw),labels=unique(m.labelIds??[]),header=(name:string)=>m.payload?.headers?.find(h=>h.name.toLowerCase()===name)?.value??'';
    return {id:m.id,threadId:m.threadId,draft:labels.includes('DRAFT'),labels,isRead:!labels.includes('UNREAD'),flagStatus:labels.includes('STARRED')?'flagged':'notFlagged',categories:[],subject:header('subject'),from:header('from'),date:m.internalDate&&Number.isFinite(Number(m.internalDate))?new Date(Number(m.internalDate)).toISOString():''};
  }
  const m=valid(graphMessage,raw);
  return {id:m.id,threadId:m.conversationId,draft:m.isDraft,labels:[],isRead:m.isRead,flagStatus:m.flag.flagStatus,categories:unique(m.categories),parentFolderId:m.parentFolderId,changeKey:m.changeKey,etag:m['@odata.etag'],subject:m.subject??'',from:m.from?.emailAddress.address??'',date:m.receivedDateTime??''};
}
export async function readTriageMessage(request:MailRequest,account:ConnectedAccount,messageId:string) {
  const message=normalize(account.provider,await request(`/messages/${encodeURIComponent(messageId)}${account.provider==='google'?'?format=metadata&metadataHeaders=Subject&metadataHeaders=From':`?$select=${graphSelect}`}`));
  if(message.id!==messageId)throw new ProviderError('invalid_response','The provider returned a different message. No further change was made.');
  return message;
}
export async function readTriageThread(request:MailRequest,account:ConnectedAccount,target:MailTriageTarget):Promise<TriageThreadState> {
  let messages:TriageMessageState[]=[];
  if(account.provider==='google') {
    const value=valid(z.object({id,messages:z.array(gmailMessage).min(1).max(2000)}),await request(`/threads/${encodeURIComponent(target.threadId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`));
    if(value.id!==target.threadId)throw new ProviderError('invalid_response','Gmail returned a different conversation.');
    messages=value.messages.map(m=>normalize(account.provider,m));
  } else {
    let path='/messages?'+new URLSearchParams({'$select':graphSelect,'$top':'100','$filter':`conversationId eq '${target.threadId.replaceAll("'","''")}'`});
    const seen=new Set<string>();
    while(path) {
      if(seen.has(path)||seen.size>=20)throw new ProviderError('invalid_response','This conversation could not be read completely. No mail was changed.');
      seen.add(path);
      const page=valid(z.object({value:z.array(graphMessage).max(1000),'@odata.nextLink':z.string().optional()}),await request(path));
      messages.push(...page.value.map(m=>normalize(account.provider,m)));
      if(messages.length>2000)throw new ProviderError('invalid_response','Select a smaller conversation before changing mail.');
      path='';
      if(page['@odata.nextLink']) {
        let next:URL;try{next=new URL(page['@odata.nextLink']);}catch{throw new ProviderError('invalid_response','Outlook returned an invalid continuation.');}
        if(next.origin!=='https://graph.microsoft.com'||next.pathname!=='/v1.0/me/messages'||next.username||next.password||next.hash)throw new ProviderError('invalid_response','Outlook returned an unexpected continuation.');
        path='/messages'+next.search;
      }
    }
  }
  if(!messages.length||messages.some(m=>m.threadId!==target.threadId)||new Set(messages.map(m=>m.id)).size!==messages.length)throw new ProviderError('invalid_response','The exact conversation membership could not be verified.');
  messages.sort((a,b)=>a.id.localeCompare(b.id));
  return {target,messages,fingerprint:triageHash(messages.map(messageFingerprint))};
}

/** Preserve Dream Claw's label/folder/category mappings (main.ts and
 * microsoftMail.ts), executing only the fixed reviewed message membership. */
export async function resolveTriageResource(request:MailRequest,account:ConnectedAccount,action:MailTriageAction,organization?:string):Promise<string|undefined> {
  if(account.provider==='google'&&['organize','remove-organization'].includes(action)) {
    const value=valid(z.object({labels:z.array(z.object({id,name:id,type:z.string().optional()})).max(10000)}),await request('/labels'));
    const matches=value.labels.filter(label=>label.type==='user'&&(label.name===organization||label.id===organization));
    if(matches.length!==1)throw new ProviderError('permission','Choose an existing Gmail label. Creating a new label uses a separate review.');
    return matches[0].id;
  }
  if(account.provider==='microsoft'&&['archive','delete'].includes(action))return valid(z.object({id}),await request(`/mailFolders/${action==='archive'?'archive':'deleteditems'}?$select=id`)).id;
  return organization;
}
export function triageChange(provider:ConnectedAccount['provider'],action:MailTriageAction,resource?:string):TriageChange {
  if(provider==='google') {
    const mapping:Partial<Record<MailTriageAction,Record<string,boolean>>>={'mark-read':{UNREAD:false},'mark-unread':{UNREAD:true},flag:{STARRED:true},unflag:{STARRED:false},archive:{INBOX:false},delete:{TRASH:true,INBOX:false,SPAM:false}};
    if(mapping[action])return {labels:mapping[action]};
    if(!resource)throw new ProviderError('invalid_response','The reviewed label is unavailable.');
    return {labels:{[resource]:action==='organize'}};
  }
  if(action==='mark-read'||action==='mark-unread')return {isRead:action==='mark-read'};
  if(action==='flag'||action==='unflag')return {flagStatus:action==='flag'?'flagged':'notFlagged'};
  if(action==='archive'||action==='delete')return {parentFolderId:resource};
  return {category:{name:resource!,present:action==='organize'}};
}
export function touchedState(message:TriageMessageState,change:TriageChange):TriageChange {
  return {...(change.labels?{labels:Object.fromEntries(Object.keys(change.labels).map(label=>[label,message.labels.includes(label)]))}:{}),...(change.isRead!==undefined?{isRead:message.isRead}:{}),...(change.flagStatus!==undefined?{flagStatus:message.flagStatus}:{}),...(change.category?{category:{name:change.category.name,present:message.categories.includes(change.category.name)}}:{}),...(change.parentFolderId?{parentFolderId:message.parentFolderId}:{})};
}
export const matchesChange=(message:TriageMessageState,change:TriageChange)=>canonical(touchedState(message,change))===canonical(change);
export function triageSteps(account:ConnectedAccount,current:TriageMessageState,change:TriageChange):TriageStep[] {
  const path=`/messages/${encodeURIComponent(current.id)}`;
  if(account.provider==='google') {
    if(change.labels?.TRASH===true&&!current.labels.includes('TRASH'))return [{method:'POST',path:path+'/trash',expected:change}];
    const steps:TriageStep[]=[];
    if(change.labels?.TRASH===false&&current.labels.includes('TRASH'))steps.push({method:'POST',path:path+'/untrash',expected:{labels:{TRASH:false}}});
    const labels=Object.entries(change.labels??{}).filter(([label])=>label!=='TRASH');
    if(labels.length)steps.push({method:'POST',path:path+'/modify',body:{addLabelIds:labels.filter(([,present])=>present).map(([label])=>label),removeLabelIds:labels.filter(([,present])=>!present).map(([label])=>label)},expected:change});
    return steps;
  }
  if(change.parentFolderId)return [{method:'POST',path:path+'/move',body:{destinationId:change.parentFolderId},expected:change}];
  const categories=new Set(current.categories);
  if(change.category){if(change.category.present)categories.add(change.category.name);else categories.delete(change.category.name);}
  return [{method:'PATCH',path,body:{...(change.isRead!==undefined?{isRead:change.isRead}:{}),...(change.flagStatus?{flag:{flagStatus:change.flagStatus}}:{}),...(change.category?{categories:[...categories]}:{})},expected:change}];
}
export async function applyTriageStep(request:MailRequest,account:ConnectedAccount,current:TriageMessageState,step:TriageStep,before:()=>void):Promise<TriageMessageState> {
  const headers:Record<string,string>={};
  if(account.provider==='microsoft') {
    if(current.etag&&/^(?:W\/)?"[^"\r\n]+"$/.test(current.etag))headers['If-Match']=current.etag;
    else if(step.body&&typeof step.body==='object'&&'categories' in step.body)throw new ProviderError('permission','Outlook did not provide a conditional category version. Refresh before changing categories.');
  }
  before();
  const raw=await request(step.path,{method:step.method,headers,...(step.body!==undefined?{body:JSON.stringify(step.body)}:{})});
  // A response to this exact request is affirmative evidence. A later GET is
  // only observed state and cannot establish who performed an uncertain write.
  const result=valid(z.object({id,threadId:id.optional(),conversationId:id.optional(),labelIds:strings.optional(),isRead:z.boolean().optional(),flag:z.object({flagStatus:id}).optional(),categories:strings.optional(),parentFolderId:id.optional()}),raw);
  if(account.provider==='google'&&step.expected.labels&&!result.labelIds)throw new ProviderError('invalid_response','Gmail did not confirm the updated labels. Check the saved result.');
  if(result.id!==current.id||(result.threadId&&result.threadId!==current.threadId)||(result.conversationId&&result.conversationId!==current.threadId))throw new ProviderError('invalid_response','The provider did not confirm the same message. Check the saved review.');
  const state={...current,...(account.provider==='google'?{labels:result.labelIds??[]}:{isRead:result.isRead??current.isRead,flagStatus:result.flag?.flagStatus??current.flagStatus,categories:result.categories??current.categories,parentFolderId:result.parentFolderId??current.parentFolderId})};
  if((step.expected.isRead!==undefined&&result.isRead===undefined)||(step.expected.flagStatus&&result.flag===undefined)||(step.expected.category&&result.categories===undefined)||(step.expected.parentFolderId&&result.parentFolderId===undefined)||!matchesChange(state,step.expected))throw new ProviderError('invalid_response','The provider response did not confirm the reviewed state. Check this saved review.');
  return state;
}
