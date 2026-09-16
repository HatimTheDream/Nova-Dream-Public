import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { buildMailMime } from '../apps/service/mail-mime';
import { reconcileDelivery } from '../apps/service/provider-mail-delivery';
import { recoverGmailSend } from '../apps/service/gmail-send-recovery';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailDeliveryMessage } from '../packages/domain/mail-delivery';

async function fixture(){
  const id=randomUUID(),createdAt='2026-09-15T05:00:00.000Z',bytes=Buffer.from('Reviewed attachment');
  const message:MailDeliveryMessage={from:'me@example.test',to:['you@example.test'],cc:[],bcc:['private@example.test'],subject:'Sent — café',bodyText:'Line one\nLine two\n',bodyHtml:'<p>Line one<br>Line two</p>',attachments:[{name:'notes.txt',mimeType:'text/plain',bytes:bytes.length,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}]};
  const rawMime=(await buildMailMime(message,id,createdAt)).toString('base64url');
  const rewrite=(raw:string)=>Buffer.from(Buffer.from(raw,'base64url').toString().replace(`<${id}@edition3.invalid>`,'<rewritten@mail.gmail.com>')).toString('base64url');
  const state={raw:rewrite(rawMime),labels:['SENT'],internalDate:String(Date.parse(createdAt)+1000),rawId:'sent',rawThread:'thread',rawDate:undefined as string|undefined,marker:id,duplicateHeaders:false,duplicates:false,truncated:false,reads:[] as string[]};
  const request=async(path:string,init?:RequestInit):Promise<unknown>=>{
    assert(!init?.method||init.method==='GET','Lost-response recovery must never dispatch a write');state.reads.push(path);
    const url=new URL(path,'https://fixture.test');
    if(url.pathname==='/messages'){
      if(url.searchParams.get('q')?.startsWith('rfc822msgid:'))return {messages:[]};
      assert.equal(url.searchParams.get('labelIds'),'SENT');assert.equal(url.searchParams.get('includeSpamTrash'),'true');assert.equal(url.searchParams.get('maxResults'),'50');assert.equal(url.searchParams.get('q'),`after:${Date.parse(createdAt)/1000-300}`);
      return {messages:[{id:'unrelated',threadId:'other'},{id:'sent',threadId:'thread'},...(state.duplicates?[{id:'duplicate',threadId:'thread'}]:[])],...(state.truncated?{nextPageToken:'more'}:{})};
    }
    const messageId=url.pathname.split('/').at(-1)!;
    if(url.searchParams.get('format')==='metadata')return {id:messageId,threadId:messageId==='unrelated'?'other':'thread',labelIds:state.labels,internalDate:state.internalDate,payload:{headers:[{name:'X-Edition3-Operation',value:messageId==='unrelated'?randomUUID():state.marker},...(state.duplicateHeaders?[{name:'x-edition3-operation',value:state.marker}]:[])]}};
    assert.equal(messageId,'sent','Never read unrelated message bodies');assert.equal(url.searchParams.get('format'),'raw');
    return {id:state.rawId,threadId:state.rawThread,labelIds:state.labels,internalDate:state.rawDate??state.internalDate,raw:state.raw};
  };
  const operation={id,createdAt,mode:'send' as const,message,rawMime,attempted:'send' as const,completed:[]};
  return {operation,state,request,rewrite};
}

test('Gmail rewritten send ID resolves only through the unique marker and complete reviewed MIME, without resending',async()=>{
  const f=await fixture();const result=await reconcileDelivery(f.request,{provider:'google'} as ConnectedAccount,f.operation);
  assert.equal(result.outcome,'accepted');assert.deepEqual(result.result,{messageId:'sent'});assert.deepEqual(result.completed,['send']);assert.match(result.detail,/Recipient delivery is not confirmed/);assert.equal(f.state.reads.filter(p=>p.includes('format=raw')).length,1);
});

test('Gmail saved-draft send can be reconciled after recoverable Trash without claiming recipient delivery',async()=>{
  const f=await fixture();f.state.labels=['SENT','TRASH'];const result=await recoverGmailSend(f.request,{...f.operation,previousOperationId:randomUUID()});
  assert.equal(result.outcome,'accepted');assert.deepEqual(result.completed,['send-draft']);
});

test('same marker with altered recipients, body, files or reply envelope cannot confirm a send',async()=>{
  for(const change of ['sender','to','bcc','body','file','reply','thread','rawMarker']){
    const f=await fixture(),message={...f.operation.message,...(change==='sender'?{from:'else@example.test'}:change==='to'?{to:['else@example.test']}:change==='bcc'?{bcc:[]}:change==='body'?{bodyText:'Changed'}:change==='file'?{attachments:[]}: {})};
    const raw=await buildMailMime(message,change==='rawMarker'?randomUUID():f.operation.id,f.operation.createdAt);
    f.state.raw=f.rewrite(change==='reply'?Buffer.from(raw.toString().replace('MIME-Version:','Reply-To: else@example.test\r\nMIME-Version:')).toString('base64url'):raw.toString('base64url'));
    const operation=change==='thread'?{...f.operation,message:{...message,reply:{messageId:'source',threadId:'different',quote:false}}}:f.operation;
    assert.equal((await recoverGmailSend(f.request,operation)).outcome,undefined,change);
  }
});

test('duplicate, truncated, draft, old, changed or missing-identity evidence remains uncertain',async()=>{
  for(const change of ['duplicates','truncated','duplicateHeaders','draft','notSent','old','rawId','rawThread','rawDate','marker','noDate','noMime']){
    const f=await fixture();if(change==='duplicates')f.state.duplicates=true;if(change==='truncated')f.state.truncated=true;if(change==='duplicateHeaders')f.state.duplicateHeaders=true;
    if(change==='draft')f.state.labels=['SENT','DRAFT'];if(change==='notSent')f.state.labels=['INBOX'];if(change==='old')f.state.internalDate='1';if(change==='rawId')f.state.rawId='changed';if(change==='rawThread')f.state.rawThread='changed';if(change==='rawDate')f.state.rawDate='2';if(change==='marker')f.state.marker=randomUUID();
    const operation={...f.operation,...(change==='noDate'?{createdAt:undefined}:change==='noMime'?{rawMime:undefined}:{})};
    assert.equal((await recoverGmailSend(f.request,operation)).outcome,undefined,change);
    if(['noDate','noMime'].includes(change))assert.equal(f.state.reads.length,0);
  }
});
