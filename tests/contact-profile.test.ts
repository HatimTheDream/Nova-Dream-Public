import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from '../apps/service/store.js';
import { uploadContactPhoto } from '../apps/service/contact-photo.js';
import { startServer } from '../apps/service/http.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { blankRecord, contactSchema, type Contact } from '../packages/domain/workspace-records.js';
import { contactMatches, contactOrganizations, mergedContactValue, sortContacts } from '../packages/domain/contacts.js';
import type { Entity } from '../packages/domain/contracts.js';

test('photos normalize orientation, strip metadata, replay and retain verified bytes through edit, merge, restart and removal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contact-photo-')); let store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#785aa6' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const command = { requestId: randomUUID(), epoch: store.epoch, name: 'private-photo.jpg', base64: input.toString('base64') };
  const photo = await uploadContactPhoto(store, 'owner', command), bytes = store.download(photo.id).bytes, info = await sharp(bytes).metadata();
  assert.equal(info.width, 341); assert.equal(info.height, 512); assert.equal(info.exif, undefined); assert.equal(info.orientation, undefined); assert.equal(info.format, 'webp');
  assert.deepEqual(await uploadContactPhoto(store, 'owner', command), photo);
  const save = (id: string, payload: Partial<Contact>, revision = 0) => store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'contact', entityId: id, expectedRevision: revision, payload: { ...blankRecord('contact', 'UTC'), name: 'Mina Park', ...payload } }) as Entity<Contact>;
  const original = save('contact:a', { photo, organization: 'Alpha', otherOrganizations: ['Beta'] });
  assert.equal(save('contact:a', { name: 'Mina P.' }, 1).value.photo?.id, photo.id); // older editor omits new fields
  assert.deepEqual(store.readEntity('contact', original.id)?.value.otherOrganizations, ['Beta']);
  const second = await uploadContactPhoto(store, 'owner', { ...command, requestId: randomUUID(), base64: (await sharp(input).negate().png().toBuffer()).toString('base64') });
  save('contact:b', { photo: second, organization: 'Gamma', otherOrganizations: ['Beta'] });
  const merged = store.mergeContacts('owner', { requestId: randomUUID(), epoch: store.epoch, keep: { id: 'contact:a', revision: 2 }, other: { id: 'contact:b', revision: 1 }, fields: { photo: 'other' }, notes: 'both' });
  assert.equal(merged.value.photo?.id, second.id); assert.deepEqual(contactOrganizations(merged.value), ['Gamma', 'Beta']);
  assert.equal(store.readEntityVersion('contact', original.id, 1)?.value.photo?.id, photo.id);
  store.close(); store = new Store(directory);
  assert.deepEqual(store.download(photo.id).bytes, bytes); assert.equal(store.readEntity('contact', 'contact:a')?.value.photo?.id, second.id);
  save('contact:a', { ...merged.value, photo: null, otherOrganizations: [] }, 3);
  assert.equal(store.readEntity('contact', 'contact:a')?.value.photo, null); assert.deepEqual(store.readEntity('contact', 'contact:a')?.value.otherOrganizations, []);
  assert.deepEqual(store.download(second.id).metadata, second); // retained history can still resolve its portrait
  assert.throws(() => save('contact:forged', { photo: { ...photo, name: 'forged' } }), /verified/);
  const fake = store.upload('owner', randomUUID(), store.epoch, 'photo.png', Buffer.from('<script>alert(1)</script>').toString('base64'));
  assert.throws(() => save('contact:script', { photo: fake }), /verified/);
  assert.equal(store.readEntity('contact', 'contact:script'), undefined);
});

test('photo admission rejects malformed, oversized, animated and stale-epoch input without accepting arbitrary URLs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contact-photo-invalid-')), store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = { requestId: randomUUID(), epoch: store.epoch, name: 'photo', base64: '' };
  for (const base64 of ['https://example.test/private.jpg', Buffer.from('<svg/>').toString('base64'), Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')]) await assert.rejects(uploadContactPhoto(store, 'owner', { ...command, base64 }));
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(uploadContactPhoto(store, 'owner', { ...command, epoch: randomUUID(), base64: image.toString('base64') }), /recovery/);
  await assert.rejects(uploadContactPhoto(store, 'owner', { ...command, base64: image.subarray(0, 40).toString('base64') }), /photo/);
  const animatedHeader = Buffer.alloc(30); animatedHeader.write('RIFF'); animatedHeader.write('WEBP', 8); animatedHeader.write('VP8X', 12); animatedHeader[20] = 2;
  await assert.rejects(uploadContactPhoto(store, 'owner', { ...command, base64: animatedHeader.toString('base64') }), /still/);
});

test('all organizations stay searchable and merge without losing the non-primary membership; sort groups are stable', () => {
  const value = { ...blankRecord('contact', 'UTC'), name: 'Mina', organization: 'Northstar', otherOrganizations: ['Harbor', 'Café Collective'] } as Contact;
  assert.equal(contactMatches(value, 'cafe mina'), true);
  const merged = mergedContactValue(value, { ...value, organization: 'Oak', otherOrganizations: ['harbor', 'Studio'] }, { fields: { organization: 'other' }, notes: 'both' });
  assert.deepEqual(contactOrganizations(merged), ['Oak', 'Northstar', 'Harbor', 'Café Collective', 'Studio']);
  assert.equal(contactSchema.safeParse({ ...value, otherOrganizations: ['Harbor', 'harbor'] }).success, false);
  const row = (id: string, name: string, organization: string, favorite = false, updatedAt = '2026-09-12T10:00:00Z'): Entity<Contact> => ({ id, deviceId: 'fixture', revision: 1, updatedAt, value: { ...value, name, organization, favorite } });
  const rows = [row('none', 'Aaron', '', true), row('z', 'Zoe', 'Alpha'), row('b', 'Beth', 'alpha'), row('new', 'Carl', 'Beta', false, '2026-09-12T11:00:00Z')];
  assert.deepEqual(sortContacts(rows, 'organization').map(r => r.id), ['b', 'z', 'new', 'none']);
  assert.deepEqual(sortContacts(rows, 'name').map(r => r.id), ['none', 'b', 'new', 'z']);
  assert.equal(sortContacts(rows, 'recent')[0].id, 'new'); assert.equal(rows[0].id, 'none');
});

test('photo HTTP route uses existing session and mutation guards; previews serve only bounded raster bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'contact-photo-http-')), host = await startServer({ directory, port: 0 });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(phoneRouteAllowed('/api/contacts/photo', 'POST'), true);
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'gold' } }).png().toBuffer();
  const body = JSON.stringify({ requestId: randomUUID(), epoch: host.store.epoch, name: 'image.png', base64: image.toString('base64') });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(host.origin + '/api/contacts/photo', { method: 'POST', headers, body })).status, 403);
  headers['X-Edition3-Client'] = '1'; assert.equal((await fetch(host.origin + '/api/contacts/photo', { method: 'POST', headers, body })).status, 401);
  const session = await fetch(host.origin + '/api/session', { method: 'POST', headers, body: '{}' });
  headers.Cookie = session.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(host.origin + '/api/contacts/photo', { method: 'POST', headers, body }); assert.equal(response.status, 200);
  const photo = await response.json() as { id: string };
  const preview = await fetch(host.origin + '/api/attachments/' + photo.id + '?preview=1', { headers: { Cookie: headers.Cookie } });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('Content-Type'), 'image/webp'); assert.equal(preview.headers.get('Cache-Control'), 'no-store');
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width, 64);
});
