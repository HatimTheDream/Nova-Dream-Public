import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInboxDeliveryJournal, type InboxDeliveryInput } from '../apps/client/src/dreamclaw/inbox-delivery-journal';
import type { MailDeliveryReview } from '../packages/domain/mail-delivery';
import { ApiError } from '../apps/client/src/api';
import { createInboxWriting, inboxActiveCompose, inboxWritingKey } from '../apps/client/src/dreamclaw/inbox-writing';

function fixture() {
  const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID() };
  const input: InboxDeliveryInput = { epoch: scope.epoch, accountId: randomUUID(), generation: randomUUID(), mode: 'send', message: { from: 'studio@example.test', to: ['maya@example.test'], cc: [], bcc: [], subject: 'Kept message', bodyText: 'Every word stays here.', attachments: [] } };
  const records = new Map<string, unknown>(); let full = false;
  const disk = { read(key: string): any { return structuredClone(records.get(key)); }, write(key: string, value: unknown) { if (full) return false; records.set(key, structuredClone(value)); return true; } };
  const calls: { action: string; input: any }[] = [], reviews = new Map<string, MailDeliveryReview>(), receipts = new Map<string, MailDeliveryReview>();
  let drop: string | undefined, writes = 0;
  const send = async (action: 'prepare' | 'read' | 'confirm' | 'reconcile' | 'open', payload: any): Promise<MailDeliveryReview> => {
    calls.push({ action, input: structuredClone(payload) });
    let result: MailDeliveryReview;
    if (action === 'open') {
      result = receipts.get(payload.requestId) ?? { id: randomUUID(), epoch: payload.epoch, accountId: payload.accountId, generation: payload.generation, writerId: payload.writerId, provider: 'google', accountEmail: input.message.from, mode: 'draft', state: 'saved', revision: 2, digest: 'b'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+1800000).toISOString(), message: {...input.message, bodyHtml:'<p>Original <strong>formatting</strong></p>'}, openedDraft:payload.source, providerDraftId:'provider-draft', providerMessageId:payload.source.messageId };
      reviews.set(result.id, result); receipts.set(payload.requestId, result);
    } else if (action === 'prepare') {
      result = receipts.get(payload.requestId) ?? { id: randomUUID(), epoch: payload.epoch, accountId: payload.accountId, generation: payload.generation, writerId: payload.writerId, provider: 'google', accountEmail: payload.message.from, mode: payload.mode, state: 'prepared', revision: 2, digest: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+1800000).toISOString(), message: payload.message };
      reviews.set(result.id, result); receipts.set(payload.requestId, result);
    } else if (action === 'confirm') {
      const receipt = receipts.get(payload.requestId);
      const original = reviews.get(payload.operationId)!;
      result = receipt ?? { ...original, state: payload.decision === 'cancel' ? 'cancelled' : original.mode === 'send' ? 'accepted' : 'saved', revision: original.revision + 2 };
      if (!receipt && payload.decision === 'confirm') writes++;
      reviews.set(result.id, result); receipts.set(payload.requestId, result);
    } else result = reviews.get(payload.operationId)!;
    if (drop === action) { drop = undefined; throw Error('Lost response'); }
    return structuredClone(result);
  };
  return { scope, input, disk, calls, reviews, send, full(value: boolean) { full = value; }, drop(action: string) { drop = action; }, get writes() { return writes; }, open(override = scope) { return createInboxDeliveryJournal(override, send, disk); } };
}
const expected = (review: MailDeliveryReview) => ({ id: review.id, revision: review.revision, digest: review.digest! });

test('switching composer during a lost send keeps its exact request through independent writing and cloned-window recovery', async () => {
  const f = fixture(), writing = createInboxWriting(f.scope.deviceId, f.scope.windowId, undefined, f.disk), journal = f.open();
  writing.getState().change(inboxWritingKey('compose', 'composeBody'), 'First message');
  const prepared = await journal.prepare('compose', f.input);
  f.drop('confirm');
  await assert.rejects(journal.confirm('compose', expected(prepared.review!), 'confirm'), /Lost/);
  const originalRequest = structuredClone(journal.store.getState().records.compose.confirmation);
  const source = writing.getState().newMessage('work');
  writing.getState().change(inboxWritingKey(source, 'composeBody'), 'Second message');
  const second = await journal.prepare(source, {...f.input, message:{...f.input.message, bodyText:'Second message'}});
  assert.notEqual(second.prepare.writerId, prepared.prepare.writerId);
  assert.deepEqual(journal.store.getState().records.compose.confirmation, originalRequest);
  const cloneScope = {...f.scope, windowId:randomUUID(), previousWindowId:f.scope.windowId};
  const clone = f.open(cloneScope), cloneWriting = createInboxWriting(f.scope.deviceId, cloneScope.windowId, cloneScope.previousWindowId, f.disk);
  assert.equal(inboxActiveCompose(cloneWriting.getState().fields), source);
  assert.deepEqual(clone.store.getState().records.compose.confirmation, originalRequest);
  await clone.retry('compose');
  assert.equal(f.writes, 1);
  assert.equal(clone.store.getState().records[source].review?.state, 'prepared');
  assert.equal(cloneWriting.getState().fields[inboxWritingKey(source, 'composeBody')], 'Second message');
  cloneWriting.getState().selectMessage('compose');
  assert.equal(cloneWriting.getState().fields[inboxWritingKey('compose', 'composeBody')], 'First message');
});

test('late preparation completes under its own source while another composer has an independent review', async () => {
  const f = fixture(); let release!:()=>void;
  const held = new Promise<void>(resolve => {release=resolve;});
  const journal = createInboxDeliveryJournal(f.scope, async(action,input:any) => { if(action==='prepare' && input.message.subject==='Kept message') await held; return f.send(action,input); }, f.disk);
  const first = journal.prepare('compose', f.input);
  const source = `compose:${randomUUID()}`;
  const second = await journal.prepare(source, {...f.input, message:{...f.input.message,subject:'Independent message'}});
  assert.equal(journal.store.getState().busy.compose, true);
  assert.equal(journal.store.getState().busy[source], false);
  release(); const completed = await first;
  assert.equal(journal.store.getState().records[source].review?.id, second.review?.id);
  assert.notEqual(completed.review?.id, second.review?.id);
  assert.equal(f.writes, 0);
});

test('lost preparation recovers the original message and request after reload even if current writing changed', async () => {
  const f = fixture(); f.drop('prepare');
  await assert.rejects(f.open().prepare('compose', f.input), /Lost/);
  const reopened = f.open();
  const recovered = await reopened.prepare('compose', { ...f.input, message: { ...f.input.message, bodyText: 'New writing stays separate.' } });
  assert.equal(recovered.review?.message.bodyText, f.input.message.bodyText);
  assert.equal(f.calls[0].input.requestId, f.calls[1].input.requestId);
  assert.equal(f.calls[0].input.writerId, f.calls[1].input.writerId); assert.equal(f.writes, 0);
});

test('lost confirmation persists its exact request and retries only that request after reload', async () => {
  const f = fixture(), journal = f.open(), prepared = await journal.prepare('reply:A', f.input);
  f.drop('confirm'); await assert.rejects(journal.confirm('reply:A', expected(prepared.review!), 'confirm'), /Lost/);
  const reopened = f.open(); assert.equal(reopened.store.getState().records['reply:A'].pending, 'confirm');
  assert.throws(() => reopened.release('reply:A', prepared.review!.id), /settled/);
  const recovered = await reopened.retry('reply:A');
  assert.equal(recovered.review?.state, 'accepted'); assert.equal(recovered.pending, undefined);
  assert.equal(f.calls[1].input.requestId, f.calls[2].input.requestId); assert.equal(f.writes, 1);
});

test('reading Prepared after a dropped confirmation does not discard the unresolved confirmation identity', async () => {
  const f = fixture(); let fail = true;
  const journal = createInboxDeliveryJournal(f.scope, async (action, input) => { if (action === 'confirm' && fail) { fail = false; throw Error('Request connection lost'); } return f.send(action, input); }, f.disk);
  const prepared = await journal.prepare('compose', f.input);
  await assert.rejects(journal.confirm('compose', expected(prepared.review!), 'confirm'));
  const requestId = journal.store.getState().records.compose.confirmation!.requestId;
  const checked = await journal.check('compose'); assert.equal(checked.review?.state, 'prepared'); assert.equal(checked.pending, 'confirm');
  await assert.rejects(journal.confirm('compose', expected(checked.review!), 'cancel'), /original request/);
  assert.equal((await journal.retry('compose')).review?.state, 'accepted');
  assert.equal(f.calls.find(call => call.action === 'confirm')!.input.requestId, requestId); assert.equal(f.writes, 1);
});

test('full storage prevents a new request; a failed save of a confirmed result recovers the original receipt', async () => {
  const f = fixture(), journal = f.open(); f.full(true);
  await assert.rejects(journal.prepare('compose', f.input), /browser storage/); assert.equal(f.calls.length, 0);
  f.full(false); const prepared = await journal.retry('compose');
  const wrapped = createInboxDeliveryJournal(f.scope, async (action, input) => { const result = await f.send(action, input); if (action === 'confirm') f.full(true); return result; }, f.disk);
  assert.equal((await wrapped.confirm('compose', expected(prepared.review!), 'confirm')).review?.state, 'accepted');
  assert.equal(wrapped.store.getState().storageError, true); f.full(false);
  assert.equal((await f.open().retry('compose')).review?.state, 'accepted'); assert.equal(f.writes, 1);
});

test('cloned windows keep the original unresolved operation while other devices and epochs remain isolated', async () => {
  const f = fixture(), original = f.open(), prepared = await original.prepare('compose', f.input);
  f.drop('confirm'); await assert.rejects(original.confirm('compose', expected(prepared.review!), 'confirm'));
  const clonedScope = { ...f.scope, windowId: randomUUID(), previousWindowId: f.scope.windowId };
  const clone = f.open(clonedScope), kept = clone.store.getState().records.compose;
  assert.equal(kept.confirmation?.requestId, original.store.getState().records.compose.confirmation?.requestId);
  assert.equal((await clone.retry('compose')).review?.state, 'accepted'); assert.equal(f.writes, 1);
  assert.deepEqual(f.open({ ...f.scope, deviceId: randomUUID() }).store.getState().records, {});
  assert.deepEqual(f.open({ ...f.scope, epoch: randomUUID() }).store.getState().records, {});
});

test('source-bound completions never replace another message and older or foreign responses are rejected', async () => {
  const f = fixture(); let corrupt = false;
  const journal = createInboxDeliveryJournal(f.scope, async (action, input) => { const result = await f.send(action, input); return corrupt ? { ...result, generation: randomUUID() } : result; }, f.disk);
  await journal.prepare('reply:A', f.input);
  await journal.prepare('reply:B', { ...f.input, message: { ...f.input.message, subject: 'Independent B' } });
  corrupt = true; await assert.rejects(journal.check('reply:A'), /different message/);
  assert.equal(journal.store.getState().records['reply:A'].review?.generation, f.input.generation);
  assert.equal(journal.store.getState().records['reply:B'].review?.message.subject, 'Independent B');
  const id = journal.store.getState().records['reply:B'].review!.id;
  f.reviews.set(id, { ...f.reviews.get(id)!, revision: 1 }); corrupt = false;
  await assert.rejects(journal.check('reply:B'), /older/);
});

test('saved drafts cannot silently become new sends; only settled send/cancel/failure releases permit another operation', async () => {
  const f = fixture(), journal = f.open(), prepared = await journal.prepare('reply:A', { ...f.input, mode: 'draft' });
  const saved = await journal.confirm('reply:A', expected(prepared.review!), 'confirm');
  assert.throws(() => journal.release('reply:A', saved.review!.id), /provider draft/);
  assert.equal((await journal.prepare('reply:A', f.input)).review?.mode, 'draft'); assert.equal(f.writes, 1);
  const compose = await journal.prepare('compose', f.input);
  const cancelled = await journal.confirm('compose', expected(compose.review!), 'cancel');
  journal.release('compose', cancelled.review!.id);
  const fresh = await journal.prepare('compose', f.input); assert.notEqual(fresh.review!.writerId, compose.review!.writerId);
});

test('an unconfirmed preparation can be explicitly discarded without clearing message writing or dispatching mail', async () => {
  const f = fixture(), journal = f.open(); f.drop('prepare');
  await assert.rejects(journal.prepare('compose', f.input)); journal.discardPreparation('compose');
  assert.equal(journal.store.getState().records.compose, undefined); assert.equal(f.writes, 0);
  await journal.prepare('compose', f.input); assert.throws(() => journal.discardPreparation('compose'), /saved operation/);
});

test('editing a saved draft keeps its writer and previous receipt through cancellation, reload and another review',async()=>{
  const f=fixture(),journal=f.open(),prepared=await journal.prepare('compose',{...f.input,mode:'draft'});
  const saved=await journal.confirm('compose',expected(prepared.review!),'confirm');await journal.editSaved('compose');
  assert.equal(f.open().store.getState().records.compose.editing,true);
  const next=await journal.prepare('compose',{...f.input,mode:'draft',message:{...f.input.message,bodyText:'Edited draft'}});
  assert.equal(next.prepare.writerId,saved.prepare.writerId);assert.equal(next.prepare.previous?.operationId,saved.review!.id);
  const cancelled=await journal.confirm('compose',expected(next.review!),'cancel');journal.release('compose',cancelled.review!.id);
  const restored=f.open().store.getState().records.compose;assert.equal(restored.review!.id,saved.review!.id);assert.equal(restored.editing,true);
  const sending=await journal.prepare('compose',{...f.input,message:{...f.input.message,bodyText:'Final draft'}});
  assert.equal(sending.prepare.previous?.operationId,saved.review!.id);assert.equal(sending.prepare.writerId,saved.prepare.writerId);assert.equal(sending.prepare.mode,'send');
});

test('a lost saved-draft edit review retries the same parent and request after reload; discarding preparation restores that draft',async()=>{
  const f=fixture(),journal=f.open(),prepared=await journal.prepare('reply',{...f.input,mode:'draft'});
  const saved=await journal.confirm('reply',expected(prepared.review!),'confirm');await journal.editSaved('reply');f.drop('prepare');
  await assert.rejects(journal.prepare('reply',{...f.input,mode:'draft'}));
  const original=journal.store.getState().records.reply.prepare;const reloaded=f.open(),recovered=await reloaded.retry('reply');
  assert.deepEqual(recovered.prepare,original);assert.equal(recovered.prepare.previous!.operationId,saved.review!.id);assert.equal(f.writes,1);
  const cancelled=await reloaded.confirm('reply',expected(recovered.review!),'cancel');reloaded.release('reply',cancelled.review!.id);f.drop('prepare');
  await assert.rejects(reloaded.prepare('reply',f.input));reloaded.discardPreparation('reply');
  assert.equal(reloaded.store.getState().records.reply.review!.id,saved.review!.id);assert.equal(reloaded.store.getState().records.reply.editing,true);
});

test('a stale window opens the newer operation identified by the service without dispatching its changed message',async()=>{
  const f=fixture(),first=f.open(),prepared=await first.prepare('compose',{...f.input,mode:'draft'});
  await first.confirm('compose',expected(prepared.review!),'confirm');await first.editSaved('compose');
  let latest:MailDeliveryReview|undefined;
  const stale=createInboxDeliveryJournal(f.scope,async(action,input:any)=>{
    if(action==='prepare'&&latest)throw new ApiError('mail_delivery_pending','Review current operation',{operationId:latest.id} as any);
    return f.send(action,input);
  },f.disk);
  const updated=await first.prepare('compose',{...f.input,mode:'draft'});latest=(await first.confirm('compose',expected(updated.review!),'confirm')).review;
  const recovered=await stale.prepare('compose',{...f.input,message:{...f.input.message,bodyText:'Different stale proposal'}});
  assert.equal(recovered.review?.id,latest!.id);assert.equal(recovered.review?.state,'saved');assert.equal(recovered.pending,undefined);
  assert.match(recovered.error??'',/Another window/);assert.equal(f.writes,2);
  assert.equal(recovered.prepare.message.bodyText,'Different stale proposal');
});

test('a newer-operation hint cannot replace the original journal with a different account or writer',async()=>{
  const f=fixture(),first=f.open(),prepared=await first.prepare('compose',{...f.input,mode:'draft'});
  await first.confirm('compose',expected(prepared.review!),'confirm');await first.editSaved('compose');
  const foreign={...prepared.review!,id:randomUUID(),writerId:randomUUID()};
  const journal=createInboxDeliveryJournal(f.scope,async(action,input)=>{
    if(action==='prepare')throw new ApiError('mail_delivery_pending','Newer',{operationId:foreign.id} as any);
    if(action==='read')return foreign;return f.send(action,input);
  },f.disk);
  await assert.rejects(journal.prepare('compose',f.input),/different message or account/);
  assert.equal(journal.store.getState().records.compose.pending,'prepare');assert.equal(journal.store.getState().records.compose.base?.review.id,prepared.review!.id);assert.equal(f.writes,1);
});

test('lost provider-draft opening retries its exact identity after switching messages and reload, with no provider writes',async()=>{
  const f=fixture(),writing=createInboxWriting(f.scope.deviceId,f.scope.windowId,undefined,f.disk),journal=f.open();
  writing.getState().change(inboxWritingKey('compose','composeBody'),'My current writing');
  const source=writing.getState().newMessage('studio');f.drop('open');
  const input={epoch:f.scope.epoch,accountId:f.input.accountId,generation:f.input.generation,accountEmail:f.input.message.from,source:{messageId:'message',threadId:'thread'}};
  await assert.rejects(journal.openDraft(source,input),/Lost/);
  const identity=structuredClone(journal.store.getState().records[source].opening);
  writing.getState().selectMessage('compose');
  const reopened=f.open(),result=await reopened.retry(source);
  assert.deepEqual(result.opening,identity);assert.deepEqual(f.calls[0].input,f.calls[1].input);
  assert.equal(result.editing,true);assert.equal(result.pending,undefined);assert.equal(result.review?.providerDraftId,'provider-draft');
  assert.equal(inboxActiveCompose(writing.getState().fields),'compose');
  assert.equal(writing.getState().fields[inboxWritingKey('compose','composeBody')],'My current writing');assert.equal(f.writes,0);
});

test('draft opening rejects foreign message contents and preserves the original retry identity',async()=>{
  const f=fixture(),journal=createInboxDeliveryJournal(f.scope,async(action,input)=>{
    const result=await f.send(action,input);return {...result,openedDraft:{messageId:'foreign',threadId:'thread'}};
  },f.disk);
  await assert.rejects(journal.openDraft('compose',{epoch:f.scope.epoch,accountId:f.input.accountId,generation:f.input.generation,accountEmail:f.input.message.from,source:{messageId:'selected',threadId:'thread'}}),/different provider message/);
  assert.equal(journal.store.getState().records.compose.pending,'open');assert.equal(journal.store.getState().records.compose.review,undefined);
  assert.equal((await f.open().retry('compose')).review?.openedDraft?.messageId,'selected');assert.equal(f.writes,0);
});

test('storage failure prevents opening dispatch and a superseded provider draft cannot become editable',async()=>{
  const f=fixture(),journal=f.open();f.full(true);
  await assert.rejects(journal.openDraft('compose',{epoch:f.scope.epoch,accountId:f.input.accountId,generation:f.input.generation,accountEmail:f.input.message.from,source:{messageId:'selected',threadId:'thread'}}),/browser storage/);
  assert.equal(f.calls.length,0);f.full(false);const opened=await journal.retry('compose');
  f.reviews.set(opened.review!.id,{...opened.review!,superseded:true,canEditDraft:false});
  await assert.rejects(journal.editSaved('compose'),/Another message/);assert.equal(f.writes,0);
});
