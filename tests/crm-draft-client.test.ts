import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CrmDraft, confirmedCrm, crmDraftId, readCrmJournal, readCrmLegacy, type CrmCommand, type CrmJournal, type CrmKind, type CrmRecord, type CrmScope, type CrmValues } from '../apps/client/src/crm-draft-client';

class Memory {
  rows = new Map<string, string>(); writes = 0; failRead = false; failWrite = false; failNextReadback = false;
  private afterWrite = false;
  getItem(key: string) {
    if (this.failRead || this.afterWrite && this.failNextReadback) { this.afterWrite = false; this.failNextReadback = false; throw Error('Synthetic read refusal'); }
    this.afterWrite = false; return this.rows.get(key) ?? null;
  }
  setItem(key: string, raw: string) {
    if (this.failWrite) throw Error('Synthetic storage full');
    this.writes++; this.rows.set(key, raw); this.afterWrite = true;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function values<K extends CrmKind>(kind: K): CrmValues[K] {
  return (kind === 'activity' ? { kind: 'note', at: '2026-10-19T12:00:00.000Z', text: 'Exact original activity writing', archived: false }
    : { name: 'Original Organization', website: '', phone: '', industry: '', notes: 'Exact original notes' }) as CrmValues[K];
}
function saved<K extends CrmKind>(kind: K, command: CrmCommand<K>): CrmRecord<K> {
  return { id: command.id, revision: command.expectedRevision + 1, deviceId: 'original-creator',
    updatedAt: '2026-10-20T08:00:00.000Z', value: structuredClone(command.value),
    ...(kind === 'activity' ? { contactId: command.contactId } : { memberIds: ['contact:original'] }) } as unknown as CrmRecord<K>;
}
function fixture<K extends CrmKind>(kind: K, revision = 0) {
  const memory = new Memory(), scope: CrmScope & { kind: K } = { kind, id: kind + ':' + randomUUID(), epoch: randomUUID(), deviceId: randomUUID(), ...(kind === 'activity' ? { contactId: 'contact:original' } : {}) };
  const key = `e3:crm-${kind}:${scope.deviceId}:${scope.id}:window`;
  const fallback: CrmJournal<K> = { format: 1, kind, id: scope.id, epoch: scope.epoch, revision, value: values(kind), dirty: false, ...(scope.contactId ? { contactId: scope.contactId } : {}) };
  const calls: CrmCommand<K>[] = []; let active = true, updates = 0;
  let send: (command: CrmCommand<K>) => Promise<unknown> = async command => saved(kind, command);
  const make = () => new CrmDraft(memory, key, scope, structuredClone(fallback), async command => { calls.push(structuredClone(command)); return send(command); }, () => updates++, () => active);
  const current = () => revision ? saved(kind, { ...scope, requestId: randomUUID(), expectedRevision: revision - 1, value: values(kind) }) : undefined;
  return { kind, memory, scope, key, fallback, calls, make, current, send: (fn: typeof send) => { send = fn; }, retireScope: () => { active = false; }, updates: () => updates };
}

test('failed input persistence retains incomplete writing in memory and refuses departure until the same bytes are kept', () => {
  const f = fixture('organization'), owner = f.make(), original = structuredClone(owner.journal.value);
  f.memory.failWrite = true;
  const proposal = { ...original, website: 'https://', notes: 'Every new word remains here.' };
  assert.equal(owner.change(proposal), false); assert.deepEqual(owner.journal.value, proposal); assert.equal(owner.journal.dirty, true);
  assert.equal(owner.retain(), false); assert.equal(f.memory.rows.has(f.key), false); assert.equal(f.calls.length, 0);
  f.memory.failWrite = false; assert(owner.retain());
  assert.deepEqual(f.make().journal.value, proposal); assert.equal(f.calls.length, 0);
});

test('malformed or unreadable storage refuses mutation and preserves the original raw record', async () => {
  for (const mode of ['malformed', 'unsupported', 'unreadable'] as const) {
    const f = fixture('activity'), raw = mode === 'unsupported' ? JSON.stringify({ ...f.fallback, format: 9 }) : '{original';
    f.memory.rows.set(f.key, raw); f.memory.failRead = mode === 'unreadable';
    const owner = f.make(); assert(owner.invalid); assert(owner.blocked);
    assert(!owner.change({ ...values('activity'), text: 'Must not replace' })); assert.equal(await owner.save(), undefined);
    assert(owner.retain()); assert.equal(f.memory.rows.get(f.key), raw); assert.equal(f.memory.writes, 0); assert.equal(f.calls.length, 0);
  }
});

test('foreign-epoch clean and dirty journals remain byte-exact and cannot be recycled as a new draft', async () => {
  for (const sameId of [true, false]) for (const dirty of [true, false]) {
    const f = fixture('organization'), old = { ...f.fallback, id: sameId ? f.scope.id : 'organization:older', epoch: randomUUID(), revision: 2, dirty };
    const raw = JSON.stringify(old, null, 2); f.memory.rows.set(f.key, raw);
    const owner = f.make(); assert(owner.blocked); assert(owner.retain());
    assert(!owner.change({ ...values('organization'), notes: 'New text' })); assert.equal(await owner.save(), undefined);
    assert.equal(f.memory.rows.get(f.key), raw); assert.equal(f.memory.writes, 0); assert.equal(f.calls.length, 0);
  }
});

test('legacy unknown-workspace writing stays blocked until explicit adoption and keeps its original raw bytes', async () => {
  const f = fixture('organization'), raw = JSON.stringify({ value: { ...values('organization'), website: 'unfinished://' }, revision: 0 }, null, 2);
  f.memory.rows.set(f.key, raw); const owner = f.make();
  assert(owner.legacy); assert(owner.blocked); assert.equal(await owner.save(), undefined); assert.equal(f.memory.rows.get(f.key), raw);
  assert(owner.adoptLegacy()); assert(!owner.legacy); assert.equal(owner.journal.legacyOriginal, raw);
  assert.equal(owner.journal.value.website, 'unfinished://'); assert.equal(f.make().journal.legacyOriginal, raw); assert.equal(f.calls.length, 0);
});

test('legacy pending identity is unchanged during adoption and a foreign pending epoch is never adopted', async () => {
  for (const foreign of [false, true]) {
    const f = fixture('activity'), command: CrmCommand<'activity'> = { requestId: randomUUID(), epoch: foreign ? randomUUID() : f.scope.epoch, id: f.scope.id, expectedRevision: 0, value: values('activity'), contactId: f.scope.contactId };
    const raw = JSON.stringify({ value: command.value, revision: 0, pending: command }); f.memory.rows.set(f.key, raw);
    assert.equal(crmDraftId(f.memory, f.key, 'activity'), command.id);
    const owner = f.make(); assert(owner.legacy); assert.deepEqual(owner.journal.pending, command);
    assert.equal(owner.adoptLegacy(), !foreign); assert.equal(f.calls.length, 0);
    if (foreign) { assert.equal(await owner.save(), undefined); assert.equal(f.memory.rows.get(f.key), raw); }
    else { await owner.save(); assert.deepEqual(f.calls, [command]); assert.equal(owner.journal.legacyOriginal, raw); assert.equal(owner.journal.revision, 1); }
  }
});

test('oversized legacy expansion and new writing cannot be persisted as an unreadable journal', () => {
  const f = fixture('organization'), raw = JSON.stringify({ value: { ...values('organization'), notes: '"'.repeat(110000) }, revision: 0 });
  assert(raw.length < 256000); assert(readCrmLegacy(raw, 'organization'));
  f.memory.rows.set(f.key, raw); const owner = f.make();
  assert(!owner.adoptLegacy()); assert(owner.legacy); assert.equal(f.memory.rows.get(f.key), raw); assert.equal(f.memory.writes, 0);
  const next = fixture('organization'), draft = next.make(), oversized = { ...values('organization'), notes: 'a'.repeat(520000) };
  assert(!draft.change(oversized)); assert.deepEqual(draft.journal.value, oversized); assert(!draft.retain()); assert.equal(next.memory.rows.has(next.key), false);
});

test('current record identity and activity parent must match even when revisions are equal', async () => {
  for (const kind of ['activity', 'organization'] as const) {
    const f = fixture(kind, 1), owner = f.make(), current = f.current()!;
    owner.change(values(kind));
    const wrong = { ...current, id: kind + ':different' };
    assert(owner.changed(wrong)); assert(!owner.review(wrong)); assert.equal(await owner.save(wrong), undefined); assert.equal(f.calls.length, 0);
    if (kind === 'activity') {
      const wrongContact = { ...current, contactId: 'contact:different' };
      assert(owner.changed(wrongContact)); assert(!owner.review(wrongContact)); assert.equal(await owner.save(wrongContact), undefined);
    }
    const newer = { ...current, revision: 3 }; assert(owner.changed(newer)); assert.equal(await owner.save(newer), undefined);
    const proposal = structuredClone(owner.journal.value); assert(owner.review(newer)); assert.deepEqual(owner.journal.value, proposal); assert.equal(owner.journal.revision, 3);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture('organization'), raw = JSON.stringify({ value: values('organization'), revision: 0 }); f.memory.rows.set(f.key, raw);
  const owner = f.make(), different = saved('organization', { ...f.scope, id: 'organization:other', expectedRevision: 0, requestId: randomUUID(), value: values('organization') });
  assert(!owner.adoptLegacy(different)); assert.equal(f.memory.rows.get(f.key), raw);
});

test('uncertain response survives reload and only the unchanged original command can reconcile', async () => {
  const f = fixture('activity'), first = f.make(); first.change(values('activity'));
  f.send(async () => { throw Error('Connection lost after admission'); });
  assert.equal(await first.save(), undefined); const original = structuredClone(f.calls[0]), raw = f.memory.rows.get(f.key)!;
  assert.deepEqual(readCrmJournal(raw, 'activity')!.pending, original); assert(!first.review()); first.retire();
  f.send(async command => saved('activity', command)); const reopened = f.make();
  const result = await reopened.save(); assert.equal(result?.id, original.id); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], original); assert.equal(reopened.journal.pending, undefined); assert.equal(reopened.journal.revision, 1);
});

test('a successful server response with failed local acknowledgement never posts a second request', async () => {
  const f = fixture('organization'), owner = f.make(); owner.change(values('organization'));
  f.send(async command => { f.memory.failWrite = true; return saved('organization', command); });
  assert.equal(await owner.save(), undefined); const original = structuredClone(f.calls[0]); assert.deepEqual(owner.journal.pending, original);
  assert.equal(owner.journal.dirty, true); assert(owner.retain(), 'The unchanged original pending command is already durable'); assert.equal(f.calls.length, 1);
  f.memory.failWrite = false; const result = await owner.save();
  assert.equal(result?.revision, 1); assert.equal(f.calls.length, 1); assert.equal(owner.journal.pending, undefined);
  assert.equal(owner.journal.dirty, false); assert.equal(f.make().journal.revision, 1);
});

test('successful write followed by failed readback accepts only its exact desired bytes on retry', async () => {
  const f = fixture('organization'), owner = f.make();
  f.memory.failNextReadback = true; assert(!owner.change({ ...values('organization'), notes: 'Unconfirmed local write' }));
  const desired = f.memory.rows.get(f.key), writes = f.memory.writes; assert(desired);
  assert(owner.retain()); assert.equal(f.memory.writes, writes); assert.equal(f.memory.rows.get(f.key), desired);
  f.send(async command => { f.memory.failNextReadback = true; return saved('organization', command); });
  assert.equal(await owner.save(), undefined); assert(owner.journal.pending);
  const acknowledged = f.memory.rows.get(f.key)!; assert.equal(readCrmJournal(acknowledged, 'organization')!.pending, undefined);
  assert.equal((await owner.save())?.revision, 1); assert.equal(f.calls.length, 1); assert.equal(f.memory.rows.get(f.key), acknowledged);
});

test('pending write readback failure sends nothing until the exact original command is durably confirmed', async () => {
  const f = fixture('activity'), owner = f.make(); owner.change(values('activity'));
  f.memory.failNextReadback = true; assert.equal(await owner.save(), undefined); assert.equal(f.calls.length, 0);
  const original = structuredClone(owner.journal.pending); assert(original);
  await owner.save(); assert.deepEqual(f.calls, [original]);
});

test('known rejection remains in memory after storage refusal and explicit review must persist before clearing it', async () => {
  const f = fixture('organization'), owner = f.make(); owner.change(values('organization'));
  f.send(async () => { f.memory.failWrite = true; throw Object.assign(Error('Known quota refusal'), { status: 507 }); });
  await owner.save(); const original = structuredClone(owner.journal.pending); assert(original); assert.equal(owner.journal.rejection?.status, 507);
  await owner.save(); assert.equal(f.calls.length, 1); assert(!owner.review()); assert.deepEqual(owner.journal.pending, original); assert.equal(owner.journal.rejection?.status, 507);
  f.memory.failWrite = false; assert(owner.review()); assert.equal(owner.journal.pending, undefined); assert.equal(owner.journal.rejection, undefined);
  assert.equal(owner.journal.dirty, true); assert.deepEqual(owner.journal.value, values('organization')); assert.equal(f.calls.length, 1);
});

test('another window changing the journal cannot be overwritten by input or late successful acknowledgement', async () => {
  const f = fixture('activity'), owner = f.make(); owner.change(values('activity'));
  const waiting = deferred<unknown>(); f.send(() => waiting.promise); const saving = owner.save(), original = f.calls[0];
  const other = { ...owner.journal, value: { ...values('activity'), text: 'Newer writing from another window' } };
  const raw = JSON.stringify(other); f.memory.rows.set(f.key, raw); waiting.resolve(saved('activity', original));
  assert.equal(await saving, undefined); assert.equal(f.memory.rows.get(f.key), raw); assert.deepEqual(owner.journal.pending, original);
  assert.equal(await owner.save(), undefined); assert.equal(f.calls.length, 1); assert.equal(f.memory.rows.get(f.key), raw); assert(!owner.retain());
  const input = fixture('organization'), editor = input.make(); editor.change(values('organization'));
  const remote = JSON.stringify({ ...editor.journal, value: { ...values('organization'), notes: 'Other original writing' } }); input.memory.rows.set(input.key, remote);
  const proposal = { ...values('organization'), notes: 'My unsaved writing' };
  assert(!editor.change(proposal)); assert.deepEqual(editor.journal.value, proposal); assert.equal(input.memory.rows.get(input.key), remote);
});

test('retired or changed-scope owners leave the original pending journal untouched after response', async () => {
  for (const retire of ['instance', 'scope'] as const) {
    const f = fixture('activity'), owner = f.make(); owner.change(values('activity'));
    const waiting = deferred<unknown>(); f.send(() => waiting.promise); const saving = owner.save(), original = f.calls[0], raw = f.memory.rows.get(f.key);
    if (retire === 'instance') owner.retire(); else f.retireScope();
    const updates = f.updates(); waiting.resolve(saved('activity', original));
    assert.equal(await saving, undefined); assert.equal(f.memory.rows.get(f.key), raw); assert.equal(f.updates(), updates); assert.equal(f.calls.length, 1);
  }
});

test('response confirmation binds original id, revision, parent and normalized payload while allowing its original creator', () => {
  const f = fixture('activity'), command: CrmCommand<'activity'> = { requestId: randomUUID(), epoch: f.scope.epoch, id: f.scope.id, expectedRevision: 4, value: values('activity'), contactId: f.scope.contactId };
  const response = saved('activity', command); assert.equal(confirmedCrm('activity', command, response).deviceId, 'original-creator');
  for (const wrong of [
    { ...response, id: 'activity:other' }, { ...response, revision: 7 }, { ...response, contactId: 'contact:other' },
    { ...response, value: { ...response.value, text: 'Different saved writing' } },
  ]) assert.throws(() => confirmedCrm('activity', command, wrong));
});
