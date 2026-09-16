import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { keepInboxTarget, inboxTargetKey, readInboxTarget, type InboxTarget } from '../apps/client/src/inbox-target';
import { createInboxSource, readLinkedEmail, type LinkedEmail } from '../apps/client/src/dreamclaw/inbox-source';
import { createInboxMailApi, installInboxMailApi } from '../apps/client/src/dreamclaw/inbox-transport';
import type { InboxAccount } from '../apps/client/src/dreamclaw/services/inbox/inboxSession';
import { originalMicrosoftThreadDigests } from '../apps/service/dreamclaw/microsoft-mail';
function storage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), records = new Map<string,string>(); let full=false;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{if(full)throw Error('quota');records.set(key,value);}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');});
  return {records,setFull(value:boolean){full=value;}};
}
const account = (provider: 'gmail'|'microsoft'='gmail'):InboxAccount => ({provider,key:provider+':account',accountId:'account',generation:randomUUID(),email:provider+'@example.test',label:'Original account',canRead:true,canSend:true,canDraft:true,canModify:true,supportsSignature:true});
const target = (epoch:string, provider:'google'|'microsoft'='google'):Omit<InboxTarget,'nonce'> => ({epoch,eventId:randomUUID(),source:{provider,accountId:'account',threadId:'exact-thread'}});
const loaded = (t:InboxTarget,a:InboxAccount):LinkedEmail => ({account:a,digest:{id:t.source.threadId,subject:'Original email',from:'sender@example.test',date:'2026-09-08',labels:['FLAGGED'],providerTags:['Studio'],messageCount:1,category:'other',summary:'Private body stays transient',latestBody:'Private body stays transient',latestSnippet:'Private body stays transient',attentionScore:0},reader:{loadKey:'linked-load',threadKey:'linked-thread',status:'ready',messages:[],sendAsAliases:[],selectedFrom:a.email,microsoftSignatureDraft:'',error:null}});

test('source navigation keeps only the exact event/account/thread and clone tombstones do not reopen closed links',async t=>{
 const s=storage(t),epoch=randomUUID(),a=account(),value=keepInboxTarget('device','window',target(epoch));
 const controller=createInboxSource({epoch,deviceId:'device',windowId:'window',read:async(t,a)=>loaded(t,a)});
 await controller.load([a],'scope');assert.equal(controller.store.getState().value?.digest.id,'exact-thread');assert.ok(!JSON.stringify([...s.records]).includes('Private body'));
 assert.deepEqual(readInboxTarget('device','clone','window'),value);
 const clone=createInboxSource({epoch,deviceId:'device',windowId:'clone',previousWindowId:'window'});assert.equal(clone.close(),true);assert.equal(readInboxTarget('device','clone','window'),undefined);assert.deepEqual(readInboxTarget('device','window'),value);
 controller.scroll(value.nonce,123);assert.equal(controller.scroll(value.nonce),123);assert.equal(controller.scroll(randomUUID()),0);
});
test('disconnected and wrong-provider accounts cannot substitute for the original, while reconnect revalidates generation',async t=>{
 storage(t);const epoch=randomUUID(),a=account(),calls:string[]=[];keepInboxTarget('d','w',target(epoch));
 const controller=createInboxSource({epoch,deviceId:'d',windowId:'w',read:async(t,a)=>{calls.push(a.generation);return loaded(t,a);}});
 await controller.load([],'initial');assert.equal(controller.store.getState().status,'error');
 await controller.load([account('microsoft')],'wrong-provider');assert.equal(calls.length,0);
 await controller.load([{...a,canRead:false}],'no-permission');assert.equal(calls.length,0);
 await controller.load([a],'connected');assert.equal(controller.store.getState().status,'ready');
 const reconnected={...a,generation:randomUUID()};await controller.load([reconnected],'reconnected');assert.deepEqual(calls,[a.generation,reconnected.generation]);
 const other=createInboxSource({epoch:randomUUID(),deviceId:'d',windowId:'w',read:async()=>{throw Error('Must not read');}});await other.load([a],'scope');assert.match(other.store.getState().error!,/earlier workspace/);
});
test('late reads cannot reopen a closed source or overwrite a newer link; failed refresh retains only matching readable data',async t=>{
 storage(t);const epoch=randomUUID(),a=account(),waiters:((v:LinkedEmail)=>void)[]=[];const first=keepInboxTarget('d','w',target(epoch));
 const controller=createInboxSource({epoch,deviceId:'d',windowId:'w',read:()=>new Promise(resolve=>waiters.push(resolve))});const read=controller.load([a],'scope');controller.close();waiters[0](loaded(first,a));await read;assert.equal(controller.store.getState().target,undefined);assert.equal(controller.store.getState().value,undefined);
 keepInboxTarget('d','w',target(epoch));controller.acceptStoredTarget();const older=controller.load([a],'scope');
 const newest=keepInboxTarget('d','w',{...target(epoch),source:{provider:'google',accountId:a.accountId,threadId:'new-thread'}});controller.acceptStoredTarget();const current=controller.load([a],'scope');waiters[2](loaded(newest,a));await current;waiters[1](loaded(first,a));await older;assert.equal(controller.store.getState().value?.digest.id,'new-thread');
 let fail=false;const refresh=createInboxSource({epoch,deviceId:'d',windowId:'w',read:async(t,a)=>{if(fail)throw Error('Offline');return loaded(t,a);}});await refresh.load([a],'scope');fail=true;await refresh.load([a],'scope',true);assert.equal(refresh.store.getState().status,'error');assert.equal(refresh.store.getState().value?.digest.id,'new-thread');await refresh.load([],'disconnected');assert.equal(refresh.store.getState().value,undefined);
});
test('storage failure prevents switching source identity or silently leaving an unresolved navigation',async t=>{
 const s=storage(t),epoch=randomUUID();const original=keepInboxTarget('d','w',target(epoch));const controller=createInboxSource({epoch,deviceId:'d',windowId:'w'});s.setFull(true);
 assert.throws(()=>keepInboxTarget('d','w',target(epoch)),/Free browser storage/);assert.equal(controller.close(),false);assert.deepEqual(controller.store.getState().target,original);assert.deepEqual(readInboxTarget('d','w'),original);
 s.setFull(false);assert.equal(controller.close(),true);
});
test('exact linked Gmail and Outlook reads reuse original message/digest views, flags, categories and generation fences',async t=>{
 storage(t);const epoch=randomUUID(),owners=[account(),account('microsoft')];owners[1].accountId='outlook';owners[1].key='microsoft:outlook';
 const context={epoch,deviceId:randomUUID(),accounts:{clients:[],attempts:[],probes:[],accounts:owners.map(a=>({id:a.accountId,generation:a.generation,provider:a.provider==='gmail'?'google':'microsoft',state:'connected',email:a.email,label:a.label,scopes:[],capabilities:{mailRead:true}}))}} as any;
 const graph={id:'immutable-source',conversationId:'exact-thread',subject:'Workshop planning',bodyPreview:'Bring the notes.',from:{emailAddress:{address:'sender@example.test'}},receivedDateTime:'2026-09-08T10:00:00Z',isRead:false,flag:{flagStatus:'flagged'},categories:['Studio']};
 const api=createInboxMailApi(context,async input=>({accountId:input.accountId,generation:input.generation,kind:input.selector.kind,coverage:'complete',readAt:new Date().toISOString(),value:input.selector.kind==='gmail.thread'?{thread:{id:'exact-thread',messages:[{id:'gmail-message',threadId:'exact-thread',labelIds:['STARRED'],internalDate:'1788861600000',payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Workshop planning'},{name:'From',value:'sender@example.test'}],body:{data:Buffer.from('Bring the notes.').toString('base64url')}}}]}}:input.selector.kind==='gmail.aliases'?{sendAs:[{sendAsEmail:owners[0].email,isDefault:true}]}:{messages:[{id:'immutable-source',idType:'immutable',conversationId:'exact-thread',subject:graph.subject,from:'sender@example.test',to:owners[1].email,cc:'',date:graph.receivedDateTime,bodyText:graph.bodyPreview,snippet:graph.bodyPreview,isRead:false}],threads:originalMicrosoftThreadDigests({value:[graph]}),attachmentMessageIds:[]}}));
 const dispose=installInboxMailApi(api);t.after(dispose);
 const google=await readLinkedEmail({...target(epoch),nonce:randomUUID()},owners[0]);assert.equal(google.digest.subject,'Workshop planning');assert.ok(google.digest.labels.includes('STARRED'));assert.equal(google.reader.messages[0].bodyText,'Bring the notes.');assert.equal(google.reader.selectedFrom,owners[0].email);
 const microsoft=await readLinkedEmail({...target(epoch,'microsoft'),source:{provider:'microsoft',accountId:'outlook',threadId:'exact-thread'},nonce:randomUUID()},owners[1]);assert.ok(microsoft.digest.labels.includes('FLAGGED'));assert.deepEqual(microsoft.digest.providerTags,['Studio']);assert.equal(microsoft.digest.sourceMessageId,'immutable-source');assert.equal(microsoft.reader.messages[0].id,'immutable-source');
 for (const [owner, provider, messageId] of [[owners[0],'google','gmail-message'],[owners[1],'microsoft','immutable-source']] as const) {
  const link={...target(epoch,provider), source:{provider,accountId:owner.accountId,threadId:'exact-thread'}, messageId, nonce:randomUUID()};
  assert.equal((await readLinkedEmail(link,owner)).reader.messages[0].id,messageId);
  await assert.rejects(readLinkedEmail({...link,messageId:'removed-message'},owner),/exact source email is no longer available/);
 }
});

test('an old connection cannot publish over its replacement, and mismatched returned identities never become readable',async t=>{
 storage(t);const epoch=randomUUID(),original=account(),newer={...original,generation:randomUUID()},link=keepInboxTarget('d','w',target(epoch));
 const waits:((value:LinkedEmail)=>void)[]=[];const source=createInboxSource({epoch,deviceId:'d',windowId:'w',read:()=>new Promise(resolve=>waits.push(resolve))});
 const oldRead=source.load([original],'old'),newRead=source.load([newer],'new');
 waits[1](loaded(link,newer));await newRead;waits[0](loaded(link,original));await oldRead;assert.equal(source.store.getState().value?.account.generation,newer.generation);assert.equal(source.store.getState().scope,'new');
 const wrong=createInboxSource({epoch,deviceId:'d',windowId:'w',read:async(t,a)=>{const value=loaded(t,a);value.digest.id='unrelated-thread';return value;}});await wrong.load([newer],'new');assert.equal(wrong.store.getState().status,'error');assert.equal(wrong.store.getState().value,undefined);assert.match(wrong.store.getState().error!,/does not match/);
});
