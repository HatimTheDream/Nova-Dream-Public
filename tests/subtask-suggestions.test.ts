import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { SubtaskSuggestions } from '../apps/service/subtask-suggestions';
import { WorkerTransport } from './fixtures/assignment-worker';
import { readSuggestedSteps, type SubtaskSuggestion } from '../packages/domain/subtask-suggestions';
async function fixture(run: (f: { store: Store; service: SubtaskSuggestions; gateway: WorkerTransport; input: any; restart(): Promise<SubtaskSuggestions>; advance(ms: number): void }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-subtask-ai-')), store = new Store(directory), gateway = new WorkerTransport(directory, store.epoch);
  let now = Date.now(), service = new SubtaskSuggestions(store, gateway, () => now);
  const input = { requestId: randomUUID(), epoch: store.epoch, owner: `task:${randomUUID()}`, title: 'Plan a workshop', notes: 'Keep the session welcoming and accessible.', existing: ['Pick a date'] };
  try { await run({ store, service, gateway, input, restart: async () => { await service.close(); service = new SubtaskSuggestions(store, gateway, () => now); return service; }, advance(ms) { now += ms; } }); }
  finally { await service.close(); gateway.stopJournal?.(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
async function until(service: SubtaskSuggestions, id: string, state: SubtaskSuggestion['state']) {
  let latest; for (let i = 0; i < 100; i++) { latest = await service.check(id); if (latest.state === state) return latest; await new Promise(r => setTimeout(r, 3)); }
  assert.fail(`Expected ${state}, got ${JSON.stringify(latest)}`);
}
test('generation reuses the tool-free worker once and returns editable suggestions without creating a Task', () => fixture(async f => {
  const started = f.service.start('a', f.input); assert.equal(f.service.start('a', f.input).id, started.id);
  await until(f.service, started.id, 'running'); assert.equal(f.gateway.nativeCalls.length, 1);
  assert.equal(f.gateway.nativeCalls[0].disableTools, true); assert.equal(f.gateway.nativeCalls[0].deliver, false);
  assert.match(f.gateway.nativeCalls[0].message, /welcoming and accessible/); assert.match(f.gateway.nativeCalls[0].message, /Pick a date/);
  f.gateway.finish('["Choose the audience","Draft a simple agenda","Prepare materials"]');
  const result = await until(f.service, started.id, 'completed'); assert.equal(result.steps?.length, 3); assert.equal(f.store.snapshot('a').tasks.length, 0);
  const restarted = await f.restart(); assert.deepEqual(await restarted.check(started.id), result);
  assert.equal(restarted.start('a', f.input).id, started.id); assert.equal(f.gateway.nativeCalls.length, 1);
  assert.throws(() => restarted.start('a', { ...f.input, title: 'Different item' }), /different work/);
}));
test('lost admission and reconnect check the original worker instead of sending another prompt', () => fixture(async f => {
  f.gateway.loseAck = true; const started = f.service.start('a', f.input); await until(f.service, started.id, 'running'); // Polling recovers the lost acknowledgment from the exact worker journal.
  assert.throws(() => f.service.start('a', { ...f.input, requestId: randomUUID() }), /already being generated/);
  f.gateway.available = false; const restarted = await f.restart(); assert.equal((await restarted.check(started.id)).state, 'unknown');
  f.gateway.available = true; f.gateway.finish('["One small next step"]');
  assert.equal((await until(restarted, started.id, 'completed')).steps?.[0], 'One small next step'); assert.equal(f.gateway.nativeCalls.length, 1);
}));
test('foreign session and invalid output never become accepted subtasks', () => fixture(async f => {
  const started = f.service.start('a', f.input); await until(f.service, started.id, 'running'); f.gateway.finish('["Step"]'); f.gateway.foreignSession = true;
  assert.equal((await f.service.check(started.id)).state, 'unknown'); assert.equal(f.store.snapshot('a').tasks.length, 0);
  f.gateway.foreignSession = false; await until(f.service, started.id, 'completed');
  const second = f.service.start('a', { ...f.input, requestId: randomUUID() }); await until(f.service, second.id, 'running'); f.gateway.finish('Here is a malformed reply');
  assert.equal((await until(f.service, second.id, 'failed')).steps, undefined);
}));
test('cancel before dispatch starts no worker and deadline cancellation targets the exact run', () => fixture(async f => {
  let release!: () => void; f.gateway.holdCapabilities = new Promise<void>(r => { release = r; });
  const started = f.service.start('a', f.input); const stop = { requestId: randomUUID(), epoch: f.store.epoch, id: started.id };
  assert.equal((await f.service.stop('a', stop)).state, 'cancelled'); release(); await new Promise(r => setTimeout(r, 5)); assert.equal(f.gateway.nativeCalls.length, 0);
  const second = f.service.start('a', { ...f.input, requestId: randomUUID() }); await until(f.service, second.id, 'running'); f.advance(180001); await f.service.check(second.id);
  const abort = f.gateway.calls.find(c => c.method === 'chat.abort'); assert.equal(abort?.params.runId, f.gateway.nativeCalls[0].idempotencyKey);
  f.gateway.finish('', 'error'); assert.equal((await until(f.service, second.id, 'cancelled')).state, 'cancelled');
}));
test('suggested steps are bounded, trimmed and deduplicated', () => {
  assert.deepEqual(readSuggestedSteps('```json\n[" Start small ","start small","Next"]\n```'), ['start small', 'Next']);
  assert.throws(() => readSuggestedSteps('{}')); assert.throws(() => readSuggestedSteps('[""]')); assert.throws(() => readSuggestedSteps(JSON.stringify(['x'.repeat(301)])));
});
