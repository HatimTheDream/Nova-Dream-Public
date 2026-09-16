import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboxWriting } from '../apps/client/src/dreamclaw/inbox-host';
import { inboxActiveCompose, inboxComposeSources, inboxWritingKey } from '../apps/client/src/dreamclaw/inbox-writing';

function storageFixture() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const records = new Map<string, string>();
  let full = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key: string) { return records.get(key) ?? null; },
    setItem(key: string, value: string) { if (full) throw new Error('Quota exceeded'); records.set(key, value); },
  } });
  return { records, full(value: boolean) { full = value; }, restore() {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  } };
}

test('cloned Inbox writing survives reload before any edit, then both windows keep independent branches', () => {
  const storage = storageFixture();
  try {
    const original = createInboxWriting('device', 'first');
    original.getState().change('compose.body', 'Unsent original\nSecond line');
    original.getState().change('reply.thread-a', 'Reply for A');
    createInboxWriting('device', 'cloned', 'first');
    const reloaded = createInboxWriting('device', 'cloned');
    assert.deepEqual(reloaded.getState().fields, original.getState().fields);
    reloaded.getState().change('compose.body', 'Cloned branch');
    original.getState().change('compose.body', 'Original branch');
    assert.equal(createInboxWriting('device', 'cloned', 'first').getState().fields['compose.body'], 'Cloned branch');
    assert.equal(createInboxWriting('device', 'first').getState().fields['compose.body'], 'Original branch');
    assert.equal(reloaded.getState().fields['reply.thread-a'], 'Reply for A');
    assert.deepEqual(createInboxWriting('another-device', 'first').getState().fields, {});
  } finally { storage.restore(); }
});

test('new messages keep every original field and reload with independent recipients, body and signature choices', () => {
  const storage = storageFixture();
  try {
    const original = createInboxWriting('device', 'first');
    const change = (source:string, field:string, value:string|boolean) => original.getState().change(inboxWritingKey(source, field), value);
    change('compose', 'composeBody', 'Original writing'); change('compose', 'composeTo', 'first@example.test');
    change('compose', 'composeIncludeSignature', false); change('reply:A', 'body', 'Reply stays intact');
    const source = original.getState().newMessage('gmail:studio');
    assert.equal(inboxActiveCompose(original.getState().fields), source);
    assert.equal(original.getState().fields[inboxWritingKey(source, 'composeTo')], undefined);
    change(source, 'composeBody', 'Independent writing'); change(source, 'composeTo', 'second@example.test');
    change(source, 'composeIncludeSignature', true);
    original.getState().selectMessage('compose');
    assert.equal(original.getState().fields[inboxWritingKey('compose', 'composeBody')], 'Original writing');
    const reopened = createInboxWriting('device', 'first');
    assert.equal(inboxActiveCompose(reopened.getState().fields), 'compose');
    assert.deepEqual(inboxComposeSources(reopened.getState().fields), ['compose', source]);
    reopened.getState().selectMessage(source);
    assert.equal(reopened.getState().fields[inboxWritingKey(source, 'composeTo')], 'second@example.test');
    assert.equal(reopened.getState().fields[inboxWritingKey('compose', 'composeIncludeSignature')], false);
    assert.equal(reopened.getState().fields[inboxWritingKey('reply:A', 'body')], 'Reply stays intact');
    const cloned = createInboxWriting('device', 'second', 'first');
    assert.deepEqual(cloned.getState().fields, reopened.getState().fields);
    cloned.getState().selectMessage('compose');
    assert.equal(inboxActiveCompose(createInboxWriting('device', 'second').getState().fields), 'compose');
    assert.equal(inboxActiveCompose(createInboxWriting('device', 'first').getState().fields), source);
  } finally { storage.restore(); }
});

test('storage failure refuses switching or starting a writer and recovery retains unsaved text from all messages', () => {
  const storage = storageFixture();
  try {
    const original = createInboxWriting('device', 'first');
    const source = original.getState().newMessage('studio');
    storage.full(true);
    original.getState().change(inboxWritingKey(source, 'composeBody'), 'Keep my unsaved text');
    assert.throws(() => original.getState().selectMessage('compose'), /storage/);
    assert.throws(() => original.getState().newMessage('work'), /storage/);
    assert.equal(inboxActiveCompose(original.getState().fields), source);
    assert.deepEqual(inboxComposeSources(original.getState().fields), ['compose', source]);
    storage.full(false);
    original.getState().selectMessage('compose');
    const reloaded = createInboxWriting('device', 'first');
    assert.equal(reloaded.getState().fields[inboxWritingKey(source, 'composeBody')], 'Keep my unsaved text');
    assert.throws(() => reloaded.getState().selectMessage('reply:A'), /unavailable/);
    assert.equal(inboxActiveCompose(reloaded.getState().fields), 'compose');
  } finally { storage.restore(); }
});

test('storage failure keeps all new writing in memory, reports failed clone copying, and later saves the complete draft', () => {
  const storage = storageFixture();
  try {
    const original = createInboxWriting('device', 'first');
    original.getState().change('compose.subject', 'Kept subject');
    storage.full(true);
    const cloned = createInboxWriting('device', 'cloned', 'first');
    assert.equal(cloned.getState().storageError, true);
    cloned.getState().change('compose.body', 'Keep me through failed persistence');
    cloned.getState().change('reply.includeSignature', false);
    assert.equal(cloned.getState().fields['compose.body'], 'Keep me through failed persistence');
    assert.equal(cloned.getState().storageError, true);
    assert.equal(storage.records.has('e3:inbox-writing:device:cloned'), false);
    storage.full(false);
    cloned.getState().change('compose.to', 'recipient@example.test');
    assert.equal(cloned.getState().storageError, false);
    assert.deepEqual(createInboxWriting('device', 'cloned').getState().fields, cloned.getState().fields);
    assert.equal(original.getState().fields['compose.body'], undefined);
  } finally { storage.restore(); }
});

test('late provider draft hydration imports once into its own writer without changing the selected message',()=>{
  const storage=storageFixture();try {
    const writing=createInboxWriting('device','first');writing.getState().change(inboxWritingKey('compose','composeBody'),'Original kept writing');
    const source=writing.getState().newMessage('studio');writing.getState().selectMessage('compose');
    writing.getState().importDraft(source,'opened',{composeSubject:'Provider subject',composeBody:'Provider body',composeIncludeSignature:false});
    assert.equal(inboxActiveCompose(writing.getState().fields),'compose');
    assert.equal(writing.getState().fields[inboxWritingKey('compose','composeBody')],'Original kept writing');
    writing.getState().change(inboxWritingKey(source,'composeBody'),'My newer edit');
    writing.getState().importDraft(source,'older-response',{composeBody:'Late old content'});
    assert.equal(createInboxWriting('device','first').getState().fields[inboxWritingKey(source,'composeBody')],'My newer edit');
    assert.throws(()=>writing.getState().importDraft('compose','other',{composeBody:'Replacement'}),/already has writing/);
  }finally{storage.restore();}
});

test('quota during provider import keeps complete contents in memory and can recover from the persisted open request after reload',()=>{
  const storage=storageFixture();try {
    const writing=createInboxWriting('device','first'),source=writing.getState().newMessage('studio');storage.full(true);
    const fields={composeTo:'maya@example.test',composeSubject:'Kept subject',composeBody:'Every original word',composeKeepFormatting:true};
    writing.getState().importDraft(source,'operation',fields);assert.equal(writing.getState().storageError,true);
    assert.equal(writing.getState().fields[inboxWritingKey(source,'composeBody')],fields.composeBody);
    const reloaded=createInboxWriting('device','first');assert.equal(reloaded.getState().fields[inboxWritingKey(source,'composeImportedOperation')],undefined);
    storage.full(false);reloaded.getState().importDraft(source,'operation',fields);
    assert.equal(createInboxWriting('device','first').getState().fields[inboxWritingKey(source,'composeBody')],fields.composeBody);
  }finally{storage.restore();}
});
