import type { Entity } from '../packages/domain/contracts.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { ContactDirectory } from '../apps/service/contact-directory.js';
import { contactDestination, contactDuplicateReason, contactEmails, contactMatches } from '../packages/domain/contacts.js';
import { blankRecord, type Contact } from '../packages/domain/workspace-records.js';
import { accountCapabilities } from '../apps/service/providers.js';
import { createMailIndexSnapshot, sanitizeIndexedMailThread } from '../packages/domain/dreamclaw/mail-index.js';
import type { ConnectedAccount } from '../packages/domain/accounts.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { startServer } from '../apps/service/http.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-contacts-')); let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const save = (id: string, patch: Partial<Contact> = {}, revision = 0) => store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'contact', entityId: id, expectedRevision: revision, payload: { ...blankRecord('contact', 'UTC'), name: 'Mina Park', ...patch } }) as Entity<Contact>;
  return { directory, get store() { return store; }, save, restart() { store.close(); store = new Store(directory); } };
}
test('combine preserves both histories, alternate emails, notes, favorites and unchanged task origins; replay and restore survive restart', t => {
  const f = fixture(t), a = f.save('contact:a', { email: 'mina@example.test', notes: 'Design notes', favorite: true, tags: ['design'] }), b = f.save('contact:b', { email: 'work@example.test', organization: 'Studio', notes: 'Meeting notes', tags: ['team'] });
  const task = f.store.createRecordTask('owner', { requestId: randomUUID(), epoch: f.store.epoch, title: 'Review the brief', origin: { kind: 'contact', id: b.id, revision: b.revision } });
  const command = { requestId: randomUUID(), epoch: f.store.epoch, keep: { id: a.id, revision: 1 }, other: { id: b.id, revision: 1 }, fields: { email: 'other' }, notes: 'both' };
  const merged = f.store.mergeContacts('owner', command);
  assert.equal(merged.value.email, 'work@example.test'); assert.deepEqual(merged.value.otherEmails, ['mina@example.test']); assert.equal(merged.value.notes, 'Design notes\n\nMeeting notes'); assert.deepEqual(merged.value.tags, ['design', 'team']); assert.equal(merged.value.favorite, true);
  assert.deepEqual(f.store.readEntity('task', task.id), task); assert.equal(f.store.readEntityVersion('contact', b.id, 1)?.value.notes, 'Meeting notes');
  assert.equal(contactDestination(b.id, f.store.listEntities('contact')), a.id); assert.equal(f.store.readEntity('contact', b.id)?.value.archived, true);
  f.restart(); assert.deepEqual(f.store.mergeContacts('owner', command), merged); assert.equal(f.store.readEntity('contact', a.id)?.revision, 2);
  assert.throws(() => f.store.mergeContacts('other-device', command), /different work/);
  assert.throws(() => f.store.mergeContacts('owner', { ...command, notes: 'keep' }), /different work/);
  const restore = { requestId: randomUUID(), epoch: f.store.epoch, contact: { id: b.id, revision: 2 } }, restored = f.store.restoreContact('owner', restore);
  assert.equal(restored.value.archived, false); assert.equal(restored.value.mergedInto, undefined); assert.equal(restored.value.notes, 'Meeting notes'); assert.equal(contactDestination(b.id, f.store.listEntities('contact')), b.id);
  assert.deepEqual(f.store.readEntity('contact', a.id), merged); f.restart(); assert.deepEqual(f.store.restoreContact('owner', restore), restored);
});
test('merge is atomic on conflicting revisions and oversized combinations; archived originals cannot be overwritten by stale editors', t => {
  const f = fixture(t), a = f.save('contact:a', { notes: 'x'.repeat(12000) }), b = f.save('contact:b', { notes: 'y'.repeat(12000) });
  const command = { requestId: randomUUID(), epoch: f.store.epoch, keep: { id: a.id, revision: 1 }, other: { id: b.id, revision: 1 }, fields: {}, notes: 'both' };
  assert.throws(() => f.store.mergeContacts('owner', command)); assert.deepEqual(f.store.readEntity('contact', a.id), a); assert.deepEqual(f.store.readEntity('contact', b.id), b);
  assert.throws(() => f.store.mergeContacts('owner', { ...command, other: { id: b.id, revision: 2 }, notes: 'keep' }), /changed/);
  f.store.mergeContacts('owner', { ...command, notes: 'keep' });
  assert.throws(() => f.save('contact:b', { notes: 'Overwrite original' }, 2), /combined contact/);
  assert.throws(() => f.save('contact:c', { mergedInto: a.id }), /combined contact/);
  assert.throws(() => f.store.mergeContacts('owner', { ...command, requestId: randomUUID(), epoch: randomUUID() }), /workspace changed/);
});
test('duplicate detection and search preserve email identity and resolve multi-stage combinations', t => {
  const f = fixture(t), a = f.save('contact:a', { name: 'Mína Park', email: 'mi.na+work@example.test', notes: 'Workshop in Montréal', otherEmails: ['mina@example.test'] }), b = f.save('contact:b', { name: 'Different name', email: 'MINA@example.test' }), c = f.save('contact:c', { name: 'Mina', email: 'mina+work@example.test' });
  assert.equal(contactDuplicateReason(a.value, b.value), 'Same email address'); assert.equal(contactDuplicateReason(a.value, c.value), null); assert.equal(contactMatches(a.value, 'mina montreal'), true); assert.deepEqual(contactEmails(a.value), ['mi.na+work@example.test', 'mina@example.test']);
  f.store.mergeContacts('owner', { requestId: randomUUID(), epoch: f.store.epoch, keep: { id: a.id, revision: 1 }, other: { id: b.id, revision: 1 }, fields: {}, notes: 'both' });
  f.store.mergeContacts('owner', { requestId: randomUUID(), epoch: f.store.epoch, keep: { id: c.id, revision: 1 }, other: { id: a.id, revision: 2 }, fields: {}, notes: 'both' });
  assert.equal(contactDestination(b.id, f.store.listEntities('contact')), c.id);
});
function account(provider: 'google' | 'microsoft'): ConnectedAccount { const scopes = provider === 'google' ? ['https://www.googleapis.com/auth/gmail.readonly'] : ['Mail.Read']; return { id: randomUUID(), generation: randomUUID(), provider, subject: 'fixture', email: 'owner@example.test', label: 'Fixture', revision: 1, state: 'connected', scopes, capabilities: accountCapabilities(provider, scopes), connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
const row = (id: string, from: string, date = '2026-09-12T10:00:00Z') => sanitizeIndexedMailThread({ id, sourceMessageId: id + '-message', from, date, subject: 'Private brief ' + id, labels: ['INBOX'], messageCount: 1 })!;
test('Inbox discovery is read-only, bounded, address-exact and source-specific across Google and Microsoft', async t => {
  const f = fixture(t), google = account('google'), microsoft = account('microsoft'); f.save('contact:mina', { email: 'mina@example.test' });
  const rows = [row('a', 'Mina <mina@example.test>'), row('b', 'Mina <mina@example.test>'), row('alias', 'Mina <mi.na@example.test>'), row('ambiguous', 'A <a@example.test>, B <b@example.test>'), row('inject', 'A <a@example.test>\r\nBcc: x@example.test'), { ...row('missing', 'No message <no@example.test>'), sourceMessageId: undefined }, ...Array.from({ length: 42 }, (_, i) => row('extra' + i, `Person ${i} <person${i}@example.test>`))];
  const directory = new ContactDirectory(f.store, { state: () => ({ accounts: [google, microsoft], clients: [], attempts: [], probes: [] }) }, { read: async (_device, raw) => { const input = raw as { accountId: string }; const a = input.accountId === google.id ? google : microsoft; return { accountId: a.id, generation: a.generation, revision: '1', snapshot: { ...createMailIndexSnapshot(a.provider === 'google' ? 'gmail' : 'microsoft', a.id, new Date().toISOString()), exhausted: a === google, threads: a === google ? rows : [row('ms', 'Mina <mina@example.test>', '2026-09-12T12:00:00Z')] } }; } });
  const result = await directory.read('owner', { epoch: f.store.epoch }); assert.equal(result.senders.length, 40); assert.equal(result.total, 44); assert.equal(result.next, 40); assert.equal(result.partial, true); assert.equal(f.store.listEntities('contact').length, 1);
  const mina = (await directory.read('owner', { epoch: f.store.epoch, query: 'mina@' })).senders[0]; assert.equal(mina.conversations, 3); assert.equal(mina.contactId, 'contact:mina'); assert.equal(mina.input.source.provider, 'microsoft'); assert.equal(mina.input.messageId, 'ms-message');
  const activity = await directory.read('owner', { epoch: f.store.epoch, contactId: 'contact:mina' }); assert.equal(activity.correspondence.length, 3); assert.equal(activity.correspondence[0].source.messageId, 'ms-message'); assert.equal((await directory.read('owner', { epoch: f.store.epoch, offset: 40 })).senders.length, 4);
});
test('discovery discards account contributions revoked during later reads, and rejects changed workspace epochs', async t => {
  const f = fixture(t), first = account('google'), second = account('microsoft'); let count = 0;
  const directory = new ContactDirectory(f.store, { state: () => ({ accounts: [first, second], clients: [], attempts: [], probes: [] }) }, { read: async () => { const a = count++ === 0 ? first : second; if (a === second) first.state = 'disconnected'; return { accountId: a.id, generation: a.generation, revision: '1', snapshot: { ...createMailIndexSnapshot('gmail', a.id, new Date().toISOString()), threads: [row(a.id, 'Mina <mina@example.test>')] } }; } });
  const result = await directory.read('owner', { epoch: f.store.epoch }); assert.equal(result.senders[0].conversations, 1); assert.equal(result.senders[0].input.source.accountId, second.id);
  await assert.rejects(directory.read('owner', { epoch: randomUUID() }), /recovery/); await assert.rejects(directory.read('owner', { epoch: f.store.epoch, contactId: 'contact:missing' }), /unavailable/);
});
test('Contacts HTTP routes require the existing session and client guard; phone access is explicitly scoped', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-contacts-http-')); const host = await startServer({ directory, port: 0 }); t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const route of ['contacts/read', 'contacts/merge', 'contacts/restore', 'contacts/crm', 'contacts/activity', 'contacts/organization', 'contacts/address-books', 'contacts/address-browse', 'contacts/address-import', 'contacts/address-sync', 'contacts/address-link']) {
    assert.equal(phoneRouteAllowed('/api/' + route, 'POST'), true); assert.equal(phoneRouteAllowed('/api/' + route, 'GET'), false);
    assert.equal((await fetch(host.origin + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(host.origin + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' })).status, 401);
  }
});

test('combining verified email links preserves exact origins and permits future links through the retained alternate address', t => {
  const f = fixture(t); f.save('contact:a', { email: 'first@example.test' }); f.save('contact:b', { email: 'second@example.test' });
  const link = (id: string, sender: string, threadId: string, revision: number) => { const reviewId = randomUUID(), source = { provider: 'google', accountId: 'fixture-account', threadId, messageId: threadId + '-message', sender, subject: 'Exact source ' + threadId }; f.store.internalWrite('mail:contact-review:' + reviewId, { id: reviewId, epoch: f.store.epoch, device: 'owner', generation: randomUUID(), name: 'Mina', createdAt: Date.now(), source }); return f.store.linkMailContact('owner', { requestId: randomUUID(), epoch: f.store.epoch, reviewId, target: { kind: 'existing', id, revision } }, () => {}); };
  link('contact:a', 'first@example.test', 'first', 1); link('contact:b', 'second@example.test', 'second', 1);
  const merged = f.store.mergeContacts('owner', { requestId: randomUUID(), epoch: f.store.epoch, keep: { id: 'contact:a', revision: 2 }, other: { id: 'contact:b', revision: 2 }, fields: {}, notes: 'both' });
  assert.equal(merged.value.mailSources?.length, 2); assert.deepEqual(merged.value.mailSources?.map(source => source.threadId), ['first', 'second']);
  const updated = link('contact:a', 'second@example.test', 'third', 3); assert.equal(updated.value.mailSources?.length, 3); assert.equal(updated.value.mailSources?.[2].messageId, 'third-message');
});

test('contact calendar links use exact saved mail sources and include only upcoming matching local events', async t => {
  const { CalendarService } = await import('../apps/service/calendar.js'); const { dayInZone, nextDay } = await import('../packages/domain/tasks.js');
  const f = fixture(t); f.save('contact:a', { email: 'mina@example.test' });
  const source = { provider: 'google', accountId: 'account-one', threadId: 'thread-one', messageId: 'message-one', sender: 'mina@example.test', subject: 'Planning' }, reviewId = randomUUID();
  f.store.internalWrite('mail:contact-review:' + reviewId, { id: reviewId, epoch: f.store.epoch, device: 'owner', generation: randomUUID(), name: 'Mina', createdAt: Date.now(), source });
  f.store.linkMailContact('owner', { requestId: randomUUID(), epoch: f.store.epoch, reviewId, target: { kind: 'existing', id: 'contact:a', revision: 1 } }, () => {});
  const accounts = { state: () => ({ accounts: [], clients: [], attempts: [], probes: [] }), calendarSources: async () => ({ items: [], limited: false }), calendarEvents: async () => ({ events: [], coverage: 'complete' as const, pages: 1, skipped: 0 }) };
  const calendar = new CalendarService(f.store, accounts); const date = nextDay(dayInZone('UTC'));
  try {
    for (const accountId of ['account-one', 'different-account']) { const eventId = randomUUID(); calendar.saveLocal('owner', { requestId: randomUUID(), epoch: f.store.epoch, eventId, expectedRevision: 0, scope: 'event', value: { title: 'Planning meeting', notes: '', location: '', timezone: 'UTC', allDay: false, start: { date, time: '10:00' }, end: { date, time: '11:00' }, state: 'confirmed', projectId: null, taskId: null } }); f.store.internalWrite('calendar:mail-source:' + eventId, { source: { ...source, accountId } }); }
    const directory = new ContactDirectory(f.store, accounts, { read: async () => { throw Error('No connected mail account'); } }, calendar);
    const result = await directory.read('owner', { epoch: f.store.epoch, contactId: 'contact:a' }); assert.equal(result.calendar?.length, 1); assert.equal(result.calendar?.[0].title, 'Planning meeting'); assert.equal(result.calendar?.[0].date, date);
  } finally { await calendar.close(); }
});
