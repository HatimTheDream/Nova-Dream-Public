import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { buildMailMime } from '../apps/service/mail-mime';
import { reconcileDelivery } from '../apps/service/provider-mail-delivery';
import { recoverGmailDraft } from '../apps/service/gmail-draft-recovery';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailDeliveryMessage } from '../packages/domain/mail-delivery';

async function fixture() {
  const operationId=randomUUID(), attachment=Buffer.from('Exact reviewed file');
  const message:MailDeliveryMessage={from:'me@example.test',to:['me@example.test'],cc:[],bcc:['private@example.test'],subject:'Draft — café',bodyText:'Line one\nLine two\n',bodyHtml:'<p>Line one<br>Line two</p>',attachments:[{name:'notes.txt',mimeType:'text/plain',bytes:attachment.length,base64:attachment.toString('base64'),sha256:createHash('sha256').update(attachment).digest('hex')}]};
  const rawMime=(await buildMailMime(message,operationId,'2026-09-15T05:00:00.000Z')).toString('base64url');
  const rewritten=(raw:string)=>Buffer.from(Buffer.from(raw,'base64url').toString().replace(`<${operationId}@edition3.invalid>`,'<replacement@mail.gmail.com>')).toString('base64url');
  const state={raw:rewritten(rawMime),duplicates:false,truncated:false,labels:['DRAFT'],marker:operationId,duplicateHeaders:false,threadId:'thread',rawMessageId:'message',reads:[] as string[]};
  const request=async(path:string,init?:RequestInit):Promise<unknown>=>{
    assert(!init?.method||init.method==='GET','Reconciliation must not write');state.reads.push(path);
    const url=new URL(path,'https://fixture.test');
    if(url.pathname==='/drafts'&&url.searchParams.has('q'))return {drafts:[]};
    if(url.pathname==='/drafts')return {drafts:[{id:'unrelated-draft',message:{id:'unrelated'}},{id:'draft',message:{id:'message'}},...(state.duplicates?[{id:'second-draft',message:{id:'second'}}]:[])],...(state.truncated?{nextPageToken:'more'}:{})};
    if(url.pathname==='/drafts/draft'&&url.searchParams.get('format')==='minimal')return {id:'draft',message:{id:'message'}};
    if(url.pathname.startsWith('/messages/')) {const id=url.pathname.split('/').at(-1)!;return {id,threadId:state.threadId,labelIds:state.labels,payload:{headers:[{name:'X-Edition3-Operation',value:id==='unrelated'?randomUUID():state.marker},...(state.duplicateHeaders?[{name:'x-edition3-operation',value:state.marker}]:[])]}};}
    if(url.pathname==='/drafts/draft'&&url.searchParams.get('format')==='raw')return {id:'draft',message:{id:state.rawMessageId,threadId:state.threadId,labelIds:state.labels,raw:state.raw}};
    throw Error('Unexpected draft request: '+path);
  };
  const operation={id:operationId,mode:'draft' as const,message,attempted:'create' as const,completed:[],rawMime};
  return {operation,message,state,request,rewritten};
}

test('Gmail can rewrite Message-ID: a bounded marker search and exact MIME contents recover the saved draft',async()=>{
  const f=await fixture();
  const result=await reconcileDelivery(f.request,{provider:'google'} as ConnectedAccount,f.operation);
  assert.equal(result.outcome,'saved');assert.deepEqual(result.result,{draftId:'draft',messageId:'message'});assert.deepEqual(result.completed,['create']);
  assert.equal(f.state.reads.filter(path=>path.includes('format=raw')).length,1);
  assert(!f.state.reads.some(path=>path.startsWith('/drafts/unrelated')));
});

test('a known Gmail draft update checks only its original container after an empty Message-ID search',async()=>{
  const f=await fixture();
  const result=await reconcileDelivery(f.request,{provider:'google'} as ConnectedAccount,{...f.operation,providerDraftId:'draft',previousOperationId:randomUUID(),attempted:'update-draft'});
  assert.equal(result.outcome,'saved');assert.deepEqual(result.completed,['update-draft']);
  assert(!f.state.reads.some(path=>path==='/drafts?maxResults=50&includeSpamTrash=true'));
});

test('an exact marker never confirms edited recipients, body, attachments, reply headers or another thread',async()=>{
  for(const change of ['recipient','body','file','reply','thread']){
    const f=await fixture();
    const changed={...f.message,...(change==='recipient'?{bcc:['someone-else@example.test']} : change==='body'?{bodyText:'Different writing'}:change==='file'?{attachments:[]}: {})};
    const raw=await buildMailMime(changed,f.operation.id,'2026-09-15T05:00:00.000Z');
    f.state.raw=f.rewritten(change==='reply'?Buffer.from(raw.toString().replace('MIME-Version:', 'Reply-To: elsewhere@example.test\r\nMIME-Version:')).toString('base64url'):raw.toString('base64url'));
    const operation=change==='thread'?{...f.operation,message:{...f.message,reply:{threadId:'another-thread',messageId:'original',quote:false}}}:f.operation;
    assert.equal((await recoverGmailDraft(f.request,operation)).outcome,undefined,change);
  }
});

test('ambiguous, incomplete, moved and changed drafts stay unconfirmed without reading unrelated bodies',async()=>{
  for(const change of ['duplicates','truncated','trash','duplicateHeaders','messageChanged','markerChanged']){
    const f=await fixture();
    if(change==='duplicates')f.state.duplicates=true;if(change==='truncated')f.state.truncated=true;
    if(change==='trash')f.state.labels=['DRAFT','TRASH'];if(change==='duplicateHeaders')f.state.duplicateHeaders=true;
    if(change==='messageChanged')f.state.rawMessageId='changed';if(change==='markerChanged')f.state.marker=randomUUID();
    assert.equal((await recoverGmailDraft(f.request,f.operation)).outcome,undefined,change);
    assert(!f.state.reads.some(path=>path.startsWith('/drafts/unrelated')));
  }
});
