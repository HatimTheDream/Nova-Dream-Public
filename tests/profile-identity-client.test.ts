import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonical, type Command, type Entity } from '../packages/domain/contracts';
import { type PersonalProfile } from '../packages/domain/workspace-records';
import { createMascotAppearance } from '../packages/domain/mascot-appearance';
import { ProfileIdentityDraft, confirmedProfileIdentity, profileIdentityKey } from '../apps/client/src/profile-identity-client';
import { readRecordJournal } from '../apps/client/src/record-draft-recovery';

const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID() };
const value: PersonalProfile = { name: 'Saved identity', position: 'A position', about: 'Original biography', appearance: createMascotAppearance() };
const saved = (revision = 7, profile = value): Entity<PersonalProfile> => ({
  id: 'profile:owner', revision, value: structuredClone(profile), deviceId: scope.deviceId, updatedAt: '2026-10-20T10:00:00.000Z',
});
const nextLook = { ...createMascotAppearance(), face: 'adventurous' };
class Memory {
  values = new Map<string, string>(); writes = 0; failRead = false; failWrite = false; failReadback = false; nextRead = false;
  getItem(key: string) { if (this.failRead || this.nextRead) { this.nextRead = false; throw Error('Read refused'); } return this.values.get(key) ?? null; }
  setItem(key: string, raw: string) { if (this.failWrite) throw Error('Storage full'); this.values.set(key, raw); this.writes++; if (this.failReadback) { this.failReadback = false; this.nextRead = true; } }
}
const result = (command: Command) => saved(command.expectedRevision + 1, command.payload as PersonalProfile);
function fixture(entity: Entity<PersonalProfile> | undefined = saved(), post?: (command: Command) => Promise<unknown>, raw?: string) {
  const storage = new Memory(), key = profileIdentityKey(scope.deviceId, scope.windowId), calls: Command[] = [];
  if (raw !== undefined) storage.values.set(key, raw);
  let owns = true;
  const send = async (command: Command) => { calls.push(structuredClone(command)); return post ? post(command) : result(command); };
  const draft = new ProfileIdentityDraft(storage, scope, entity, send, () => {}, () => owns);
  return { storage, key, calls, draft, send, retireOwner() { owns = false; } };
}
test('one exact legacy journal retains incomplete writing and opening sends or converts nothing', () => {
  const legacy = { name: '', position: 'An unfinished position', about: 'Keep these words', appearance: { mascot: 'original-legacy-recipe' } };
  const raw = JSON.stringify({ value: legacy, revision: 7, epoch: scope.epoch, dirty: true });
  const f = fixture(saved(), undefined, raw);
  assert.deepEqual(f.draft.journal.value, legacy); assert.equal(f.storage.writes, 0); assert.equal(f.calls.length, 0);
  assert(readRecordJournal(raw, 'profile', 'profile:owner')); assert.equal(f.draft.key, `e3:journal:${scope.deviceId}:profile:owner:${scope.windowId}`);
});
test('full save uses the original target and does not repeat a clean saved profile', async () => {
  const f = fixture(); f.draft.change({ ...value, name: '  My identity  ', about: 'Keep exactly\n  this biography' });
  const reply = await f.draft.saveProfile(); assert(reply);
  assert.equal(f.calls[0].entityId, 'profile:owner'); assert.equal(f.calls[0].kind, 'profile'); assert.equal(f.calls[0].epoch, scope.epoch);
  assert.equal((f.calls[0].payload as PersonalProfile).name, 'My identity'); assert.equal(reply.value.about, 'Keep exactly\n  this biography');
  assert.equal(f.draft.journal.dirty, false); assert.equal(f.draft.canCloseSaved, true); await f.draft.saveProfile(); assert.equal(f.calls.length, 1);
});
test('Save Look changes only saved appearance while unrelated writing survives acknowledgement and reload', async () => {
  const f = fixture(); f.draft.change({ ...value, name: 'Unsent name', about: 'Unsent biography', appearance: nextLook });
  const reply = await f.draft.saveLook(nextLook); assert(reply);
  assert.deepEqual(f.calls[0].payload, { ...value, appearance: nextLook }); assert.equal(f.calls[0].expectedRevision, 7);
  assert.equal(f.draft.journal.value.name, 'Unsent name'); assert.equal(f.draft.journal.dirty, true); assert.equal(f.draft.saved?.revision, 8);
  const reopened = new ProfileIdentityDraft(f.storage, scope, reply, f.send);
  assert.equal(reopened.journal.value.about, 'Unsent biography'); await reopened.saveProfile();
  assert.equal(f.calls[1].expectedRevision, 8); assert.equal((f.calls[1].payload as PersonalProfile).name, 'Unsent name');
});
test('new identity Use Look stages only and first Save still needs a valid full profile', async () => {
  const storage = new Memory(), calls: Command[] = [];
  const draft = new ProfileIdentityDraft(storage, scope, undefined, async command => { calls.push(command); return result(command); });
  await draft.saveLook(nextLook); assert.equal(calls.length, 0); assert.deepEqual(draft.journal.value.appearance, nextLook);
  await draft.saveProfile(); assert.equal(calls.length, 0); assert.match(draft.error, /name/);
  draft.change({ ...draft.journal.value, name: 'First profile' }); await draft.saveProfile();
  assert.equal(calls.length, 1); assert.equal(calls[0].entityId, 'profile:owner'); assert.equal(calls[0].expectedRevision, 0);
});
test('Cancel Look preserves other writing and failed keeping is never successful retention', () => {
  const f = fixture(); f.draft.change({ ...value, about: 'Unfinished biography', appearance: nextLook });
  f.storage.failWrite = true; assert.equal(f.draft.cancelLook(), false);
  assert.equal(f.draft.journal.value.about, 'Unfinished biography'); assert.deepEqual(f.draft.journal.value.appearance, value.appearance);
  assert.equal(f.draft.retain(), false); assert.match(f.draft.error, /Storage full/); assert.equal(f.calls.length, 0);
  f.storage.failWrite = false; assert.equal(f.draft.retain(), true); assert.equal(f.draft.kept, true);
});
test('a lost partial save resumes the exact original envelope after reload', async () => {
  const f = fixture(saved(), async () => { throw Error('Original response lost'); });
  f.draft.change({ ...value, name: 'Kept unsent identity' }); await f.draft.saveLook(nextLook);
  const original = structuredClone(f.draft.pending); assert(original);
  assert.equal(f.draft.change({ ...value, name: 'Forbidden pending edit' }), false);
  const calls: Command[] = [], reopened = new ProfileIdentityDraft(f.storage, scope, saved(8, original.payload as PersonalProfile),
    async command => { calls.push(command); return result(command); });
  assert.equal(calls.length, 0); await reopened.checkOriginal(original.requestId);
  assert.deepEqual(calls, [original]); assert.equal(reopened.journal.value.name, 'Kept unsent identity'); assert(reopened.journal.dirty);
  await reopened.checkOriginal(original.requestId); assert.equal(calls.length, 1, 'retired check callback cannot become a new full save');
});
test('known response plus failed acknowledgement retries storage only and retains exact pending authority', async () => {
  const f = fixture(saved(), async command => { f.storage.failWrite = true; return result(command); });
  f.draft.change({ ...value, about: 'Saved once' }); assert.equal(await f.draft.saveProfile(), undefined);
  const original = f.draft.pending!; assert(f.draft.hasConfirmedResult); assert.equal(f.calls.length, 1); assert(f.draft.journal.dirty);
  f.storage.failWrite = false; assert(await f.draft.checkOriginal(original.requestId));
  assert.equal(f.calls.length, 1); assert.equal(f.draft.pending, undefined); assert.equal(f.draft.hasConfirmedResult, false);
});
test('successful acknowledgement write with failed readback acknowledges the exact desired bytes without POST', async () => {
  const f = fixture(saved(), async command => { f.storage.failReadback = true; return result(command); });
  f.draft.change({ ...value, position: 'New position' }); await f.draft.saveProfile();
  assert(f.draft.hasConfirmedResult); const original = f.draft.pending!; const writes = f.storage.writes;
  assert(await f.draft.checkOriginal(original.requestId)); assert.equal(f.storage.writes, writes); assert.equal(f.calls.length, 1);
});
test('failed initial persistence sends nothing and retains the first pending request for its explicit check', async () => {
  const f = fixture(); f.draft.change({ ...value, about: 'Keep in memory' }); f.storage.failWrite = true;
  await f.draft.saveProfile(); assert.equal(f.calls.length, 0); assert.equal(f.draft.journal.value.about, 'Keep in memory');
  const original = structuredClone(f.draft.pending); assert(original);
  f.storage.failWrite = false; await f.draft.saveProfile(); assert.equal(f.calls.length, 0, 'a fresh Save cannot replace the original pending request');
  await f.draft.checkOriginal(original.requestId); assert.deepEqual(f.calls, [original]);
});
test('auth, maintenance, recovery and epoch failures never erase original uncertainty', async () => {
  for (const code of ['unauthorized', 'update_in_progress', 'recovery_held', 'epoch_changed', 'request_reused']) {
    const f = fixture(saved(), async () => { throw Object.assign(Error(code), { code, status: 409 }); });
    f.draft.change({ ...value, name: 'An original proposal' }); await f.draft.saveProfile();
    assert(f.draft.pending); assert.equal(f.draft.journal.conflict, undefined); assert.equal(f.draft.canReview, false);
    assert.equal(f.draft.review(saved(8), scope.epoch, false), false); assert.equal(f.calls.length, 1);
  }
});
test('known revision conflict admits only explicit monotonic review and never automatically sends again', async () => {
  const current = saved(9, { ...value, about: 'Newer saved writing' });
  const f = fixture(saved(), async () => { throw Object.assign(Error('Changed'), { code: 'revision_conflict', current }); });
  f.draft.change({ ...value, about: 'My retained writing' }); await f.draft.saveProfile();
  assert(f.draft.canReview); assert.equal(f.draft.journal.value.about, 'My retained writing');
  f.storage.failWrite = true; const original = f.draft.pending; assert.equal(f.draft.review(current, scope.epoch, true), false); assert.equal(f.draft.pending, original);
  f.storage.failWrite = false; assert.equal(f.draft.observe(current, scope.epoch), true);
  assert.equal(f.draft.review(saved(8), scope.epoch, false), false); assert.equal(f.draft.review(saved(9), scope.epoch, false), false);
  assert.equal(f.draft.review(current, scope.epoch, true), true); assert.equal(f.calls.length, 1);
  assert.equal(f.draft.journal.value.about, 'My retained writing'); assert.equal(f.draft.journal.revision, 9); assert.equal(f.draft.pending, undefined);
});
test('malformed, foreign epoch, wrong-target pending and unreadable journals cannot be overwritten', async () => {
  const base = { value, revision: 7, epoch: scope.epoch, dirty: true };
  const wrong = { ...base, pending: { requestId: randomUUID(), epoch: scope.epoch, expectedRevision: 7, entityId: 'profile:other', kind: 'profile', payload: value } };
  for (const raw of ['{original', JSON.stringify({ ...base, epoch: randomUUID() }), JSON.stringify(wrong)]) {
    const f = fixture(saved(), undefined, raw); assert(f.draft.blocked);
    assert.equal(f.draft.change({ ...value, name: 'Cannot overwrite' }), false); await f.draft.saveProfile();
    assert.equal(f.storage.values.get(f.key), raw); assert.equal(f.calls.length, 0); assert.equal(f.draft.retain(), true);
  }
  const storage = new Memory(); storage.failRead = true;
  const draft = new ProfileIdentityDraft(storage, scope, saved(), async () => { throw Error('No POST'); });
  assert(draft.blocked); assert.equal(storage.writes, 0);
});
test('raw CAS preserves newer durable writing and current memory without blind overwrite', () => {
  const f = fixture(); f.draft.change({ ...value, about: 'First memory' });
  const concurrent = JSON.stringify({ value: { ...value, about: 'Another original writer' }, revision: 7, epoch: scope.epoch, dirty: true });
  f.storage.values.set(f.key, concurrent); assert.equal(f.draft.change({ ...value, about: 'Current unsaved memory' }), false);
  assert.equal(f.draft.journal.value.about, 'Current unsaved memory'); assert.equal(f.storage.values.get(f.key), concurrent); assert.equal(f.draft.retain(), false);
});
test('returning exactly to saved writing still requires durable acknowledgement before closing', () => {
  const f = fixture(); f.draft.change({ ...value, about: 'An earlier kept draft' }); const older = f.storage.getItem(f.key);
  f.storage.failWrite = true; assert.equal(f.draft.change(value), false); assert.equal(f.draft.journal.dirty, false);
  assert.equal(f.draft.canCloseSaved, false); assert.equal(f.draft.retain(), false); assert.equal(f.storage.getItem(f.key), older);
  f.storage.failWrite = false; assert.equal(f.draft.retain(), true); assert.equal(f.draft.canCloseSaved, true);
  const reopened = new ProfileIdentityDraft(f.storage, scope, saved(), f.send); assert.deepEqual(reopened.journal.value, value); assert.equal(reopened.journal.dirty, false);
  assert.equal(f.calls.length, 0);
});
test('reply identity, device, revision and schema-parsed original payload must all match', () => {
  const command: Command = { requestId: randomUUID(), epoch: scope.epoch, kind: 'profile', entityId: 'profile:owner', expectedRevision: 7, payload: value };
  for (const bad of [{ ...result(command), id: 'profile:other' }, { ...result(command), revision: 9 }, { ...result(command), deviceId: randomUUID() },
    { ...result(command), value: { ...value, about: 'Different content' } }, { ...result(command), value: { ...value, name: ' Saved identity ' } }]) {
    assert.throws(() => confirmedProfileIdentity(command, bad, scope.deviceId));
  }
  assert.deepEqual(confirmedProfileIdentity(command, result(command), scope.deviceId), result(command));
});
test('retired or changed owners cannot acknowledge, mutate storage or send from stale callbacks', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(saved(), () => new Promise(yes => { resolve = yes; }));
  f.draft.change({ ...value, about: 'An original pending proposal' }); const work = f.draft.saveProfile(); const raw = f.storage.getItem(f.key);
  f.retireOwner(); resolve(result(f.calls[0])); await work;
  assert.equal(f.storage.getItem(f.key), raw); assert.equal(f.draft.hasConfirmedResult, false); assert(f.draft.pending);
  await f.draft.checkOriginal(f.draft.pending!.requestId); assert.equal(f.calls.length, 1);
});
test('delayed snapshots and old receipts cannot displace newer saved identity or close newer writing', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(saved(), () => new Promise(yes => { resolve = yes; }));
  f.draft.change({ ...value, about: 'Original saved proposal' }); const work = f.draft.saveProfile();
  const newer = saved(9, { ...value, about: 'Newer saved identity' }); assert(f.draft.observe(newer, scope.epoch));
  resolve(result(f.calls[0])); await work;
  assert.deepEqual(f.draft.saved, newer); assert.equal(f.draft.journal.revision, 8); assert.equal(f.draft.canCloseSaved, false);
  assert.equal(f.draft.observe(saved(), scope.epoch), false); assert.deepEqual(f.draft.saved, newer);
  assert.equal(f.draft.review(newer, randomUUID(), false), false);
  assert.equal(f.draft.review(newer, scope.epoch, false), true); assert.equal(canonical(f.draft.journal.value), canonical(newer.value));
});
