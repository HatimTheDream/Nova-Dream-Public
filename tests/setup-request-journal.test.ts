import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SetupRequestJournal } from '../apps/client/src/setup-request-journal';
import type { SetupRequestReference, SetupRequestView } from '../packages/domain/setup-request';
const epoch = randomUUID(), ref: SetupRequestReference = { requestId: randomUUID(), epoch, kind: 'gateway-connect', sha256: 'a'.repeat(64) };
const view = (state: SetupRequestView['state'], revision: number): SetupRequestView => ({ ...ref, state, revision, message: 'Original Setup' });
function fixture() {
  const values = new Map<string, string>(); let fail = false, readback = false, writes = 0;
  const storage = { getItem: (key: string) => { if (readback && writes) throw Error(); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (fail) throw Error(); values.set(key, value); writes++; } };
  return { values, storage, journal: new SetupRequestJournal(storage, 'fixture', epoch), fail: (v: boolean) => { fail = v; }, readback: (v: boolean) => { readback = v; } };
}
test('setup retains only exact identity before dispatch and reload preserves the original unknown operation', () => {
  const f = fixture(); assert.equal(f.journal.begin(ref), true); assert.equal(f.journal.dispatch(), true);
  const restored = new SetupRequestJournal(f.storage, 'fixture', epoch);
  assert.deepEqual(restored.pending?.reference, ref); assert.equal(restored.dispatch(), false);
  assert.equal(restored.begin({ ...ref, requestId: randomUUID() }), false);
  assert.doesNotMatch(f.values.get('fixture')!, /token|url|credential/);
  assert.equal(restored.accept(view('working', 1)), true); assert.equal(restored.accept(view('applied', 2)), true);
  assert.equal(restored.pending, undefined); assert.equal(restored.accept(view('working', 1)), false);
});
test('changed response identity and older observations cannot clear pending setup', () => {
  const f = fixture(); f.journal.begin(ref); f.journal.dispatch(); f.journal.accept(view('unknown', 2));
  for (const wrong of [{ ...view('applied', 3), requestId: randomUUID() }, { ...view('applied', 3), sha256: 'b'.repeat(64) }, view('not-found', 0)])
    assert.equal(f.journal.accept(wrong), false);
  assert.equal(f.journal.pending?.result?.state, 'unknown');
});
test('unreadable original metadata is preserved and failed readback never authorizes dispatch', () => {
  const f = fixture(); f.readback(true); assert.equal(f.journal.begin(ref), false); assert.equal(f.journal.dispatch(), false);
  f.readback(false); assert.equal(f.journal.begin(ref), true);
  f.values.set('fixture', '{broken'); const bad = new SetupRequestJournal(f.storage, 'fixture', epoch);
  assert.equal(bad.begin(ref), false); assert.equal(f.values.get('fixture'), '{broken');
});
test('another window cannot overwrite pending bytes or late results from an earlier request', () => {
  const f = fixture(); f.journal.begin(ref); const other = new SetupRequestJournal(f.storage, 'fixture', epoch);
  f.journal.dispatch(); assert.equal(other.accept(view('closed', 1)), false); assert.ok(other.error);
  assert.equal(f.journal.accept(view('applied', 2)), true);
  assert.equal(f.journal.begin({ ...ref, requestId: randomUUID() }), true); assert.equal(f.journal.accept(view('applied', 2)), false);
});
test('closing has its own retained identity and does not unlock an unknown request before receipt', () => {
  const f = fixture(); f.journal.begin(ref); f.journal.dispatch();
  assert.equal(f.journal.prepareClose(randomUUID()), undefined);
  f.journal.accept(view('unknown', 1));
  const close = f.journal.prepareClose(randomUUID()); assert.ok(close);
  assert.deepEqual(new SetupRequestJournal(f.storage, 'fixture', epoch).prepareClose(randomUUID()), close);
  assert.ok(f.journal.pending); assert.equal(f.journal.accept(view('closed', 2)), true); assert.equal(f.journal.pending, undefined);
});
