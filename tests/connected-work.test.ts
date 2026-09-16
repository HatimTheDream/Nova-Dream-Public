import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { MailContacts, mailContactSender } from '../apps/service/mail-contacts.js';
import type { Accounts } from '../apps/service/accounts.js';
import { blankRecord, contentSchema, type Contact, type Content } from '../packages/domain/workspace-records.js';
import { contentCalendarEvents, contentPlanningCommand } from '../packages/domain/content-planning.js';
import type { MailContactPrepare } from '../packages/domain/mail-contact.js';
import type { Entity } from '../packages/domain/contracts.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'e3-connected-')); let store = new Store(directory), now = Date.now();
  const generation = randomUUID(); let connected = true; let afterRead = () => {};
  const account = { id: 'account-a', provider: 'google', generation, state: 'connected', capabilities: { mailRead: true } };
  const authority = { state: () => ({ accounts: connected ? [account] : [] }), mailRead: async (_id: string, _generation: string, selector: any) => { afterRead(); return { value: account.provider === 'google' ? gmail(selector.threadId) : outlook(selector.conversationId) }; } } as unknown as Accounts;
  let contacts = new MailContacts(store, authority, () => now);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get contacts() { return contacts; }, account, directory,
    input: (): MailContactPrepare => ({ epoch: store.epoch, generation, source: { provider: account.provider as 'google' | 'microsoft', accountId: account.id, threadId: 'thread-a' }, messageId: 'message-a' }),
    disconnect() { connected = false; }, setAfterRead(fn: () => void) { afterRead = fn; }, later() { now += 3600000; },
    restart() { store.close(); store = new Store(directory); contacts = new MailContacts(store, authority, () => now); },
    save(id: string, value: Contact, revision = 0) { return store.mutate('owner', { kind: 'contact', entityId: id, expectedRevision: revision, epoch: store.epoch, requestId: randomUUID(), payload: value }); },
  };
}
function gmail(threadId: string) { return { thread: { id: threadId, messages: [{ id: 'message-a', threadId, payload: { headers: [{ name: 'From', value: 'Maya Chen <maya@example.test>' }, { name: 'Subject', value: 'The launch brief' }] } }, { id: 'message-b', threadId, payload: { headers: [{ name: 'From', value: 'Another Sender <another@example.test>' }] } }] } }; }
function outlook(conversationId: string) { return { messages: [{ id: 'message-a', conversationId, from: 'Maya Chen <maya@example.test>', subject: 'The launch brief', isDraft: false }] }; }
const contact = (email = 'maya@example.test'): Contact => ({ ...blankRecord('contact', 'UTC'), name: 'Saved Maya', email, notes: 'Private retained notes' } as Contact);
const newCommand = (epoch: string, reviewId: string) => ({ requestId: randomUUID(), epoch, reviewId, target: { kind: 'new', name: 'Maya Chen' } });

for (const provider of ['google', 'microsoft']) test(`${provider}: exact sender → Contact → Task preserves canonical source across restart`, async t => {
  const f = fixture(t); f.account.provider = provider;
  const proposal = await f.contacts.prepare('owner', f.input()); assert.equal(proposal.review.source.sender, 'maya@example.test'); assert.equal(proposal.matches.length, 0);
  const command = newCommand(f.store.epoch, proposal.review.id), saved = f.contacts.link('owner', command);
  assert.equal(saved.value.mailSources?.[0].messageId, 'message-a'); assert.equal(saved.value.mailSources?.[0].provider, provider);
  const task = f.store.createRecordTask('owner', { requestId: randomUUID(), epoch: f.store.epoch, origin: { kind: 'contact', id: saved.id, revision: saved.revision }, title: 'Review the launch brief' });
  assert.equal(task.value.origin?.id, saved.id);
  f.restart(); f.disconnect(); f.later();
  assert.deepEqual(f.contacts.link('owner', command), saved); assert.equal(f.store.listEntities('contact').length, 1); assert.equal(f.store.listEntities('task').length, 1);
  assert.throws(() => f.contacts.link('other', command), /different work/);
  assert.throws(() => f.contacts.link('owner', { ...command, target: { kind: 'new', name: 'Altered name' } }), /different work/);
});
test('sender matching reviews all exact email matches, preserves private fields and never silently merges aliases', async t => {
  const f = fixture(t); f.save('contact:first', contact('MAYA@example.test')); f.save('contact:second', { ...contact(), name: 'Second Maya' }); f.save('contact:alias', contact('maya+work@example.test'));
  const proposal = await f.contacts.prepare('owner', f.input()); assert.equal(proposal.matches.length, 2);
  assert.throws(() => f.contacts.link('owner', newCommand(f.store.epoch, proposal.review.id)), /already exists/);
  const command = { ...newCommand(f.store.epoch, proposal.review.id), target: { kind: 'existing', id: 'contact:first', revision: 1 } };
  const saved = f.contacts.link('owner', command); assert.equal(saved.value.name, 'Saved Maya'); assert.equal(saved.value.notes, 'Private retained notes'); assert.equal(saved.revision, 2);
  const again = f.contacts.link('owner', { ...command, requestId: randomUUID(), target: { ...command.target, revision: 2 } }); assert.equal(again.revision, 2); assert.equal(again.value.mailSources?.length, 1);
  assert.equal(f.store.readEntity('contact', 'contact:second')?.revision, 1);
});
test('competing new Contact, changed revision, archive and revoked read access fence link creation', async t => {
  const f = fixture(t); const proposal = await f.contacts.prepare('owner', f.input());
  f.save('contact:race', contact()); assert.throws(() => f.contacts.link('owner', newCommand(f.store.epoch, proposal.review.id)), /already exists/);
  f.save('contact:race', { ...contact(), notes: 'Newer notes' }, 1);
  assert.throws(() => f.contacts.link('owner', { ...newCommand(f.store.epoch, proposal.review.id), target: { kind: 'existing', id: 'contact:race', revision: 1 } }), /changed/);
  f.save('contact:race', { ...contact(), archived: true }, 2);
  assert.throws(() => f.contacts.link('owner', { ...newCommand(f.store.epoch, proposal.review.id), target: { kind: 'existing', id: 'contact:race', revision: 3 } }), /changed/);
  f.disconnect(); assert.throws(() => f.contacts.link('owner', newCommand(f.store.epoch, proposal.review.id)), /Refresh/);
  assert.equal(f.store.listEntities('contact').length, 1);
});
test('a reconnect during sender read and another device cannot admit a captured Contact', async t => {
  const f = fixture(t); f.setAfterRead(() => f.account.generation = randomUUID());
  await assert.rejects(f.contacts.prepare('owner', f.input()), /Refresh/); assert.equal(f.store.internalList('mail:contact-review:').length, 0);
  f.setAfterRead(() => {}); const input = { ...f.input(), generation: f.account.generation }; const proposal = await f.contacts.prepare('owner', input);
  assert.throws(() => f.contacts.link('other', newCommand(f.store.epoch, proposal.review.id)), /Review/);
  f.later(); assert.throws(() => f.contacts.link('owner', newCommand(f.store.epoch, proposal.review.id)), /Review/);
});
test('source links cannot be fabricated, removed by ordinary edit or leaked into another sender', async t => {
  const f = fixture(t), proposal = await f.contacts.prepare('owner', f.input()), saved = f.contacts.link('owner', newCommand(f.store.epoch, proposal.review.id));
  assert.throws(() => f.save(saved.id, { ...saved.value, mailSources: [] }, saved.revision), /original email links/);
  assert.throws(() => f.save('contact:forged', { ...contact(), mailSources: [proposal.review.source] }), /original email links/);
  const changed = f.save(saved.id, { ...saved.value, notes: 'Legitimate edit' }, saved.revision); assert.equal(changed.revision, 2);
});
test('sender parsing rejects different message/thread, drafts, multiple senders and header injection', async t => {
  const f = fixture(t), input = f.input();
  for (const raw of [gmail('other-thread'), { thread: { id: 'thread-a', messages: [] } }, { thread: { id: 'thread-a', messages: [{ ...gmail('thread-a').thread.messages[0], labelIds: ['DRAFT'] }] } }]) await assert.rejects(mailContactSender(input, raw), /verified/);
  for (const from of ['Maya <maya@example.test>, Other <other@example.test>', 'Maya\r\nBcc: secret@example.test', 'not an email']) {
    const raw = gmail('thread-a'); raw.thread.messages[0].payload.headers[0].value = from; await assert.rejects(mailContactSender(input, raw), /verified/);
  }
});
test('timed Content is one canonical Calendar projection in the viewer timezone, with explicit DST occurrence', () => {
  const base = { ...blankRecord('content', 'UTC'), title: 'Launch', plannedDate: '2026-09-11', plannedTime: '00:15', plannedTimezone: 'Asia/Tokyo', plannedMinutes: 45 } as Content;
  const entity: Entity<Content> = { id: 'content:launch', revision: 1, deviceId: 'owner', updatedAt: '', value: contentSchema.parse(base) };
  const events = contentCalendarEvents([entity], { from: '2026-09-10', to: '2026-09-11', timezone: 'America/Los_Angeles' });
  assert.equal(events.length, 1); assert.equal(events[0].contentId, entity.id); assert.deepEqual(events[0].interval, { kind: 'instant', start: '2026-09-10T15:15:00.000Z', end: '2026-09-10T16:00:00.000Z', timezone: 'Asia/Tokyo' });
  assert.equal(contentCalendarEvents([entity], { from: '2026-09-11', to: '2026-09-12', timezone: 'America/Los_Angeles' }).length, 0);
  const overlap = { ...base, plannedDate: '2026-11-01', plannedTime: '01:30', plannedTimezone: 'America/Los_Angeles' };
  assert.equal(contentSchema.safeParse(overlap).success, false);
  for (const [plannedOverlap, hour] of [['earlier', '08'], ['later', '09']] as const) {
    const value = contentSchema.parse({ ...overlap, plannedOverlap }); const [event] = contentCalendarEvents([{ ...entity, value }], { from: '2026-11-01', to: '2026-11-02', timezone: 'UTC' }); assert.equal(event.interval.start, `2026-11-01T${hour}:30:00.000Z`);
  }
  assert.equal(contentSchema.safeParse({ ...base, plannedDate: '2026-03-08', plannedTime: '02:30', plannedTimezone: 'America/Los_Angeles' }).success, false);
  assert.throws(() => contentPlanningCommand({ ...entity, value: { ...base, plannedTime: '02:30', plannedTimezone: 'America/Los_Angeles' } }, { plannedDate: '2026-03-08' }, randomUUID(), randomUUID()), /skipped/);
  const published = contentSchema.parse({ ...base, stage: 'published', publication: { kind: 'manual', date: '2026-09-12', note: 'Recorded by owner' } });
  assert.equal(contentCalendarEvents([{ ...entity, value: published }], { from: '2026-09-12', to: '2026-09-13', timezone: 'UTC' })[0].interval.kind, 'date');
});
