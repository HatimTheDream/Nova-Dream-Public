import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AddressBooks } from '../apps/service/address-books.js';
import { Accounts } from '../apps/service/accounts.js';
import { Providers, ProviderError, accountCapabilities, accountScopes } from '../apps/service/providers.js';
import { getProviderContact, providerContactsPage, updateProviderContact, parseProviderContact, providerContactFolders } from '../apps/service/provider-contacts.js';
import type { ConnectedAccount, Provider } from '../packages/domain/accounts.js';
import { blankRecord, type Contact } from '../packages/domain/workspace-records.js';
import type { MailRequest } from '../apps/service/provider-mail-delivery.js';
function fixture(t: TestContext, provider: Provider = 'google') {
  const directory = mkdtempSync(join(tmpdir(), 'e3-address-')), store = new Store(directory); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const scopes = accountScopes(provider, ['contactsWrite']), a: ConnectedAccount = { id: 'account:fixture', generation: randomUUID(), provider, subject: 'fixture', label: 'Fixture', email: 'fixture@example.test', revision: 1, state: 'connected', connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scopes, capabilities: accountCapabilities(provider, scopes) };
  let remote: any = provider === 'google' ? { resourceName: 'people/c123', metadata: { sources: [{ type: 'CONTACT', id: '123', etag: 'v1' }] }, names: [{ displayName: 'Mina Park' }], emailAddresses: [{ value: 'mina@example.test' }], phoneNumbers: [{ value: '12345', type: 'work' }, { value: 'extra', type: 'home' }], organizations: [{ name: 'Studio', title: 'Designer' }] } : { id: 'contact123', '@odata.etag': 'v1', displayName: 'Mina Park', emailAddresses: [{ address: 'mina@example.test' }], mobilePhone: '12345', businessPhones: ['extra'], companyName: 'Studio', jobTitle: 'Designer' };
  let lost = false, denied = false, deleted = false, hook: (() => void) | undefined; const writes: any[] = [];
  const request: MailRequest = async (path, init) => {
    if (!init?.method) {
      if (path.includes('contactFolders')) return { value: [] };
      if (path.includes('/connections?') || path.startsWith('/contacts?')) return provider === 'google' ? { connections: [structuredClone(remote)] } : { value: [structuredClone(remote)] };
      if (deleted) throw new ProviderError('not_found', 'Gone');
      return structuredClone(remote);
    }
    if (denied) throw new ProviderError('unavailable', 'Concurrent change', undefined, 412);
    const body = JSON.parse(String(init.body)); writes.push(body);
    if (provider === 'google') { const etag = remote.metadata.sources[0].etag; assert.equal(body.metadata.sources[0].etag, etag); remote = { ...remote, ...body, metadata: { sources: [{ type: 'CONTACT', id: '123', etag: etag + 'x' }] } }; if (body.names) remote.names = [{ displayName: body.names[0].unstructuredName }]; }
    else { assert.equal(new Headers(init.headers).get('If-Match'), remote['@odata.etag']); remote = { ...remote, ...body, '@odata.etag': remote['@odata.etag'] + 'x' }; }
    hook?.(); hook = undefined;
    if (lost) { lost = false; throw new ProviderError('unavailable', 'Lost response'); }
    return structuredClone(remote);
  };
  const accounts = { state: () => ({ accounts: [a], clients: [], attempts: [], probes: [] }), contactOperation: async (_id: string, generation: string, capabilities: string[], _signal: AbortSignal, run: any) => { const check = () => { if (a.generation !== generation || a.state !== 'connected') throw Error('Account changed'); if (capabilities.some(c => !(a.capabilities as any)[c])) throw Error('Missing permission'); }; check(); return run(a, request, check); } } as unknown as Pick<Accounts, 'state' | 'contactOperation'>;
  const books = new AddressBooks(store, accounts); t.after(() => books.close()); const input = () => ({ epoch: store.epoch, accountId: a.id, generation: a.generation });
  const save = (id: string, patch: Partial<Contact>) => { const current = store.readEntity('contact', id); return store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'contact', entityId: id, expectedRevision: current?.revision ?? 0, payload: { ...blankRecord('contact', 'UTC'), name: 'Person', ...current?.value, ...patch } }); };
  const importOne = async (target = 'new', mode = 'both') => { const review = await books.browse('owner', input()), command = { ...input(), requestId: randomUUID(), reviewId: review.id, entries: [{ remoteId: review.entries[0].remoteId, target, revision: store.readEntity('contact', target)?.revision ?? 0 }], mode }; const result = books.import('owner', command); return { command, id: result.imported[0] }; };
  return { store, books, a, input, save, importOne, request, writes, get remote() { return remote; }, set remote(value: any) { remote = value; }, lose() { lost = true; }, deny(v: boolean) { denied = v; }, remove() { deleted = true; }, hook(fn: () => void) { hook = fn; }, sync: () => books.sync('owner', { ...input(), requestId: randomUUID() }), links: () => books.state('owner', { epoch: store.epoch }).links };
}
for (const provider of ['google', 'microsoft'] as const) test(`${provider}: import replay and two-way shared-field sync preserve private CRM and provider-only fields`, async t => {
  const f = fixture(t, provider), { command, id } = await f.importOne(); assert.equal(f.store.listEntities('contact').length, 1); assert.deepEqual(f.books.import('owner', command).imported, [id]);
  f.save(id, { position: 'Director', notes: 'Private briefing', otherOrganizations: ['Private group'], pipelineStage: 'active' }); await f.sync(); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].notes, undefined); assert.equal(f.writes[0].personalNotes, undefined); assert.equal(f.writes[0].pipelineStage, undefined);
  if (provider === 'google') { assert.equal(f.remote.organizations[0].title, 'Director'); assert.equal(f.remote.phoneNumbers[1].value, 'extra'); f.remote.organizations[0].name = 'New studio'; f.remote.metadata.sources[0].etag += 'r'; }
  else { assert.equal(f.remote.jobTitle, 'Director'); assert.deepEqual(f.remote.businessPhones, ['extra']); f.remote.companyName = 'New studio'; f.remote['@odata.etag'] += 'r'; }
  await f.sync(); assert.equal(f.store.readEntity('contact', id)?.value.organization, 'New studio'); assert.equal(f.store.readEntity('contact', id)?.value.notes, 'Private briefing'); assert.deepEqual(f.store.readEntity('contact', id)?.value.otherOrganizations, ['Private group']); assert.equal(f.writes.length, 1);
  await f.sync(); assert.equal(f.writes.length, 1);
});
test('existing-contact differences are reviewed before any write; stale comparison cannot overwrite later edits', async t => {
  const f = fixture(t); f.save('contact:existing', { name: 'Mina', email: 'mina@example.test', organization: 'Local org' }); const { id } = await f.importOne('contact:existing');
  assert.equal(id, 'contact:existing'); assert.equal(f.links()[0].state, 'conflict'); await f.sync(); assert.equal(f.writes.length, 0);
  let link = f.links()[0]; const choices = Object.fromEntries(link.conflict!.fields.map(k => [k, 'local']));
  f.save(id, { name: 'Edited during review' }); assert.throws(() => f.books.changeLink('owner', { ...f.input(), requestId: randomUUID(), linkId: link.id, revision: link.revision, action: 'resolve', choices }), /changed during review/);
  await f.sync(); link = f.links()[0]; f.books.changeLink('owner', { ...f.input(), requestId: randomUUID(), linkId: link.id, revision: link.revision, action: 'resolve', choices: Object.fromEntries(link.conflict!.fields.map(k => [k, 'remote'])) }); await f.sync(); assert.equal(f.store.readEntity('contact', id)?.value.name, 'Mina Park'); assert.equal(f.writes.length, 0);
});
test('lost provider reply reconciles the exact contact without repeating a confirmed update', async t => {
  const f = fixture(t), { id } = await f.importOne(); f.save(id, { phone: 'changed' }); f.lose(); await f.sync(); assert.equal(f.links()[0].state, 'unknown'); assert.ok(f.links()[0].intent); assert.equal(f.writes.length, 1);
  await f.sync(); assert.equal(f.links()[0].state, 'synced'); assert.equal(f.links()[0].intent, undefined); assert.equal(f.writes.length, 1);
});
test('concurrent provider changes produce a conflict; a local edit during a provider write is kept for the next sync', async t => {
  const f = fixture(t), { id } = await f.importOne(); f.save(id, { phone: 'local phone' }); f.remote.phoneNumbers[0].value = 'remote phone'; f.remote.metadata.sources[0].etag += 'r'; await f.sync(); assert.equal(f.links()[0].state, 'conflict'); assert.equal(f.writes.length, 0);
  let link = f.links()[0]; f.books.changeLink('owner', { ...f.input(), requestId: randomUUID(), linkId: link.id, revision: link.revision, action: 'resolve', choices: { phone: 'local' } }); await f.sync();
  f.save(id, { position: 'First update' }); f.hook(() => f.save(id, { position: 'Later update' })); await f.sync(); assert.equal(f.store.readEntity('contact', id)?.value.position, 'Later update'); await f.sync(); assert.equal(f.remote.organizations[0].title, 'Later update');
});
test('pause, account-generation fencing and remote removal keep local history and prohibit further writes', async t => {
  const f = fixture(t), { id } = await f.importOne(); let link = f.links()[0]; const command = { ...f.input(), requestId: randomUUID(), linkId: link.id, revision: link.revision, action: 'pause' };
  f.books.changeLink('owner', command); f.books.changeLink('owner', command); f.save(id, { name: 'Local retained' }); await f.sync(); assert.equal(f.writes.length, 0);
  f.a.generation = randomUUID(); link = f.links()[0]; f.books.changeLink('owner', { ...f.input(), requestId: randomUUID(), linkId: link.id, revision: link.revision, action: 'resume' }); await f.sync(); assert.equal(f.links()[0].generation, f.a.generation);
  f.remove(); await f.sync(); assert.equal(f.links()[0].state, 'missing'); assert.equal(f.store.readEntity('contact', id)?.value.name, 'Local retained'); assert.ok(f.store.readEntityVersion('contact', id, 1));
});
test('read-only imports never send edits and revoked write permission blocks outgoing sync', async t => {
  const f = fixture(t), { id } = await f.importOne('new', 'read'); f.save(id, { phone: 'local phone' }); await f.sync(); assert.equal(f.writes.length, 0); assert.equal(f.links()[0].state, 'conflict');
  const g = fixture(t, 'microsoft'), imported = await g.importOne(); g.a.capabilities.contactsWrite = false; g.save(imported.id, { phone: 'not sent' }); await g.sync(); assert.equal(g.writes.length, 0); assert.equal(g.links()[0].state, 'error');
});
test('provider contact requests reject foreign pagination and preserve OAuth scopes when upgrading', async () => {
  let calls = 0; const p = new Providers(async () => { calls++; return new Response('{}'); }); const req = p.contactRequest('microsoft', 'private-fixture', new AbortController().signal);
  assert.throws(() => req('/contacts/../../other')); await assert.rejects(providerContactsPage('microsoft', req, 'https://evil.example/contacts')); assert.equal(calls, 0);
  assert.ok(accountScopes('google', ['contactsWrite'], ['https://www.googleapis.com/auth/gmail.modify']).includes('https://www.googleapis.com/auth/gmail.modify'));
  assert.equal(accountCapabilities('microsoft', ['Contacts.ReadWrite']).contactsRead, true); assert.equal(accountCapabilities('microsoft', ['Contacts.ReadWrite']).contactsWrite, true);
});
test('Google contact field updates preserve secondary organizations and phones; unsupported entries are counted', async () => {
  const raw = { resourceName: 'people/c1', metadata: { sources: [{ type: 'CONTACT', etag: 'a' }] }, names: [{ displayName: 'A' }], phoneNumbers: [{ value: 'first' }, { value: 'second' }], organizations: [{ name: 'Main', title: 'Role', department: 'Keep' }, { name: 'Other' }] };
  const current = parseProviderContact('google', raw); let body: any;
  const req: MailRequest = async (_path, init) => { body = JSON.parse(String(init?.body)); return { ...raw, ...body }; };
  await updateProviderContact('google', req, current, { ...current.value, phone: 'replacement', position: 'New role' }, ['phone', 'position']);
  assert.equal(body.phoneNumbers[1].value, 'second'); assert.equal(body.organizations[0].department, 'Keep'); assert.equal(body.organizations[1].name, 'Other'); assert.equal(body.names, undefined);
  const page = await providerContactsPage('google', async () => ({ connections: [raw, { resourceName: 'people/bad' }] })); assert.equal(page.entries.length, 1); assert.equal(page.skipped, 1);
});
