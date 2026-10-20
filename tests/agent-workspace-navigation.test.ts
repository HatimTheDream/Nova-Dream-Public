import test from 'node:test';
import assert from 'node:assert/strict';
import { agentDestination, keepAgentSelection, nextAgentSelection, readAgentSelection, registerAgentDraftNavigation, mayLeaveAgentDrafts, agentLocalSlot } from '../apps/client/src/agent-workspace-navigation';

function storage(raw: string | null = null) {
  const data = { raw, readsFail: false, writesFail: false, writes: 0,
    getItem(_key: string) { if (data.readsFail) throw Error('Unreadable'); return data.raw; },
    setItem(_key: string, value: string) { if (data.writesFail) throw Error('Full'); data.writes++; data.raw = value; },
  };
  return data;
}
test('legacy view identities open without a write and retain Headquarters through other destinations', () => {
  for (const view of ['agent', 'hub', 'assignment', 'routines', 'skills'] as const) {
    const s = storage(JSON.stringify({ view, target: 'original-nonce' })), state = readAgentSelection(s, 'view');
    assert.ok(state.ok); assert.equal(state.value.view, view); assert.equal(s.writes, 0);
    assert.equal(agentDestination(view), view === 'assignment' ? 'work' : ['agent', 'hub'].includes(view) ? 'team' : view);
  }
  const s = storage('{"view":"hub"}'), state = readAgentSelection(s, 'view'); assert.ok(state.ok);
  const work = keepAgentSelection(s, 'view', state, nextAgentSelection(state.value, 'work'), () => true); assert.ok(work.ok);
  const back = keepAgentSelection(s, 'view', work, nextAgentSelection(work.value, 'team'), () => true); assert.ok(back.ok);
  assert.equal(back.value.view, 'hub'); assert.equal(s.writes, 2);
});
test('absent, malformed and read-refused metadata remain distinct and malformed bytes are never replaced', () => {
  const absent = storage(); assert.deepEqual(readAgentSelection(absent, 'view'), { ok: true, raw: null, value: { view: 'agent' } });
  for (const raw of ['{', 'null', '{"view":"other"}', '{"view":"agent","target":12}', '{"view":"skills","teamPresentation":"other"}']) {
    const s = storage(raw), result = readAgentSelection(s, 'view'); assert.equal(result.ok, false);
    assert.equal(keepAgentSelection(s, 'view', result, { view: 'assignment' }, () => true).ok, false);
    assert.equal(s.raw, raw); assert.equal(s.writes, 0);
  }
  absent.readsFail = true; assert.equal(readAgentSelection(absent, 'view').ok, false); assert.equal(absent.writes, 0);
});
test('retention and exact previous view are checked before writing; successful same-event changes compose', () => {
  const s = storage(), initial = readAgentSelection(s, 'view'); assert.ok(initial.ok);
  assert.equal(keepAgentSelection(s, 'view', initial, { view: 'skills' }, () => false).ok, false);
  s.writesFail = true; assert.equal(keepAgentSelection(s, 'view', initial, { view: 'skills' }, () => true).ok, false);
  assert.equal(s.raw, null); s.writesFail = false;
  const first = keepAgentSelection(s, 'view', initial, { view: 'routines' }, () => true); assert.ok(first.ok);
  assert.equal(keepAgentSelection(s, 'view', initial, { view: 'hub' }, () => true).ok, false);
  const next = keepAgentSelection(s, 'view', first, nextAgentSelection(first.value, 'team'), () => true); assert.ok(next.ok);
  assert.equal(next.value.view, 'agent'); assert.equal(s.writes, 2);
});
test('a successful synchronous write stays acknowledged without a verification read or replay', () => {
  const s = storage(), initial = readAgentSelection(s, 'view');
  const originalWrite = s.setItem;
  s.setItem = (key, value) => { originalWrite(key, value); s.readsFail = true; };
  const result = keepAgentSelection(s, 'view', initial, { view: 'hub' }, () => true);
  assert.ok(result.ok); assert.equal(result.raw, '{"view":"hub"}'); assert.equal(s.writes, 1);
  assert.equal(keepAgentSelection(s, 'view', result, { view: 'agent' }, () => true).ok, false);
  assert.equal(s.writes, 1);
});
test('each mounted owner retains its own scope; refusal and exceptions do not skip other owners, cleanup retires callbacks', () => {
  const calls: string[] = [];
  const a = registerAgentDraftNavigation('old', () => { calls.push('old'); return false; });
  const b = registerAgentDraftNavigation('current', () => { calls.push('current'); return true; });
  const c = registerAgentDraftNavigation('current', () => { calls.push('throws'); throw Error('Storage'); });
  assert.equal(mayLeaveAgentDrafts('current'), false); assert.deepEqual(calls, ['current', 'throws']);
  c(); calls.length = 0; assert.equal(mayLeaveAgentDrafts('current'), true); assert.deepEqual(calls, ['current']);
  a(); b(); calls.length = 0; assert.equal(mayLeaveAgentDrafts(), true); assert.deepEqual(calls, []);
});
test('an original owner retries failed writing without replacing malformed or independently changed retained bytes', () => {
  const valid = (value: unknown): value is string => typeof value === 'string';
  const s = storage('"Original"'), slot = agentLocalSlot(s, 'room', valid, '');
  assert.equal(slot.initial, 'Original'); assert.equal(slot.keep('Original'), true); assert.equal(s.writes, 0);
  s.writesFail = true; assert.equal(slot.keep('Unfinished 雪'), false); assert.equal(s.raw, '"Original"');
  s.writesFail = false; assert.equal(slot.keep('Unfinished 雪'), true);
  s.raw = '"Another owner"'; assert.equal(slot.keep('Newer writing'), false); assert.equal(s.raw, '"Another owner"');
  const malformed = storage('{'), kept = agentLocalSlot(malformed, 'room', valid, '');
  assert.ok(kept.error); assert.equal(kept.keep(''), true); assert.equal(malformed.writes, 0);
  assert.equal(kept.keep('Local writing'), false); assert.equal(malformed.raw, '{');
  const unreadable = storage('"Retained"'); unreadable.readsFail = true;
  const lost = agentLocalSlot(unreadable, 'room', valid, '');
  unreadable.readsFail = false; assert.equal(lost.keep('Changed'), false); assert.equal(unreadable.raw, '"Retained"');
});
