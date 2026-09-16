import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { AssistantQuestions } from '../apps/service/questions.js';
import { Store } from '../apps/service/store.js';
import type { AccessTransport } from '../apps/service/full-access.js';
import type { Conversation } from '../packages/domain/assistant.js';
import { canonicalQuestionAnswers, nativeQuestionSchema, safeQuestionSnapshot } from '../packages/domain/questions.js';

const prompts = [{ questionId: 'format', header: 'Format', question: 'Choose an output format.', options: [{ label: 'Brief' }, { label: 'Detailed' }], isOther: true }, { questionId: 'targets', header: 'Targets', question: 'Which surfaces?', multiSelect: true, options: [{ label: 'Desktop' }, { label: 'Phone' }] }, { questionId: 'note', header: 'Notes', question: 'What should it include?', options: [] }];
const answer = { format: ['Brief'], targets: ['Desktop', 'Phone'], note: ['Keep my details.'] };
async function fixture(run: (f: any) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-questions-')), store = new Store(directory), device = store.session().deviceId;
  const conversation: Conversation = { id: randomUUID(), revision: 1, title: 'Question fixture', projectId: null, archived: false, model: null, thinking: null, createdAt: '', updatedAt: '', connectionGeneration: 'host-one', nativeKey: 'agent:main:e3:fixture', nativeId: randomUUID(), state: 'ready' };
  const listeners = new Set<(event: EventFrame) => void>();
  const f: any = { store, device, conversation, generation: 'host-one', calls: [], lose: false, failGet: false, missing: false, hold: undefined, verify: 0 };
  f.native = { id: randomUUID(), questions: structuredClone(prompts), sessionKey: conversation.nativeKey, status: 'pending', createdAtMs: 100, expiresAtMs: Date.now() + 60000 };
  const control: AccessTransport = {
    status: () => ({ state: 'ready', generation: f.generation, url: 'ws://127.0.0.1:50000', message: 'Fixture', methods: ['question.get', 'question.list', 'question.resolve', 'sessions.messages.subscribe'], grantedScopes: ['operator.read', 'operator.questions'], modelAuthReady: true }),
    start() {}, async stop() {}, models: async () => [], attachmentPolicy: () => ({}), subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async request<T>(method: string, params: any): Promise<T> {
      f.calls.push({ method, params });
      if (method === 'sessions.messages.subscribe') return { subscribed: true, key: conversation.nativeKey } as T;
      if (method === 'question.list') return { questions: f.missing || f.native.status !== 'pending' ? [] : [structuredClone(f.native)] } as T;
      if (method === 'question.get') { if (f.failGet) throw Error('Disconnected'); if (f.missing) throw new GatewayClientRequestError({ code: 'INVALID_REQUEST', message: 'gone', details: { reason: 'QUESTION_NOT_FOUND' } }); return { question: structuredClone(f.native) } as T; }
      if (method === 'question.resolve') { await f.hold; f.native = { ...f.native, status: params.cancel ? 'cancelled' : 'answered', ...(params.cancel ? {} : { answers: f.native.questions[0].isSecret ? { answers: { token: ['stored'] } } : params.answers }) }; if (f.lose) throw Error('Response lost'); return { status: f.native.status, ...(f.native.answers ? { answers: f.native.answers } : {}) } as T; }
      throw Error(method);
    },
  };
  f.control = control;
  f.make = () => new AssistantQuestions(store, control, () => [conversation], async () => { f.verify++; if (f.replaced) { conversation.nativeId = randomUUID(); throw Error('Replaced'); } }, () => control);
  f.service = f.make();
  f.event = (native: any) => { for (const fn of listeners) fn({ type: 'event', event: 'question.requested', payload: native }); };
  f.item = () => f.service.state().items[0];
  f.input = (answers = answer) => ({ requestId: randomUUID(), epoch: store.epoch, id: f.item().id, expectedRevision: f.item().revision, answers });
  f.check = (id = f.item().id) => f.service.check({ requestId: randomUUID(), epoch: store.epoch, id });
  try { await f.service.sync(); await run(f); }
  finally { await f.service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
test('questions preserve canonical choices, multi-select and custom answers; malformed outcomes fail closed', () => {
  assert.deepEqual(canonicalQuestionAnswers(prompts, { ...answer, format: [' Brief '], note: ['  exact words  '] }), { ...answer, note: ['exact words'] });
  assert.deepEqual(canonicalQuestionAnswers([prompts[0]], { format: ['Custom'] }), { format: ['Custom'] });
  for (const invalid of [{}, { ...answer, format: ['Brief', 'Detailed'] }, { ...answer, targets: ['Other'] }, { ...answer, note: [' '] }, { ...answer, foreign: ['value'] }]) assert.throws(() => canonicalQuestionAnswers(prompts, invalid));
  const base = { id: 'one', questions: prompts, sessionKey: 'session', createdAtMs: 1, expiresAtMs: 2 };
  assert.equal(nativeQuestionSchema.safeParse({ ...base, status: 'answered' }).success, false);
  assert.equal(nativeQuestionSchema.safeParse({ ...base, status: 'pending', answers: { answers: answer } }).success, false);
  assert.equal(nativeQuestionSchema.safeParse({ ...base, status: 'pending', questions: [{ ...prompts[0], options: [{ label: ' One ' }, { label: 'one' }] }] }).success, false);
});
test('native questions subscribe before execution, submit once and retain exact terminal answers through restart', () => fixture(async f => {
  await f.service.prepare(f.conversation.id); assert.equal(f.service.state().state, 'ready');
  f.event({ ...f.native, sessionKey: 'unregistered' }); assert.equal(f.service.state().items.length, 1);
  const input = f.input(), result = await f.service.resolve(f.device, input);
  assert.equal(result.snapshot.status, 'answered'); assert.deepEqual(result.snapshot.answers.answers, answer); assert.equal(result.action.message, 'Answer confirmed.'); assert.equal(f.verify, 1);
  await f.service.resolve(f.device, input); assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 1);
  f.event({ ...f.native, status: 'pending', answers: undefined }); assert.equal(f.item().snapshot.status, 'answered');
  await f.service.close(); f.service = f.make(); assert.deepEqual(f.item().snapshot.answers.answers, answer);
}));
test('lost answers reconcile native truth without replay; a competing native answer wins', () => fixture(async f => {
  f.lose = true; const input = f.input(); assert.equal((await f.service.resolve(f.device, input)).action.state, 'unknown');
  await f.service.resolve(f.device, input); assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 1);
  f.native.answers.answers.format = ['Detailed']; const result = await f.check(); assert.equal(result.snapshot.status, 'answered'); assert.match(result.action.message, /different response/);
}));
test('two windows cannot dispatch competing answers; stale drafts do not change the first accepted intent', () => fixture(async f => {
  let release!: () => void; f.hold = new Promise<void>(r => { release = r; }); const original = f.input(), pending = f.service.resolve(f.device, original);
  await assert.rejects(f.service.resolve(f.device, { ...original, requestId: randomUUID(), answers: { ...answer, format: ['Detailed'] } }), { code: 'question_changed' });
  release(); await pending; assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 1);
  await assert.rejects(f.service.resolve(f.device, { ...original, answers: { ...answer, format: ['Detailed'] } }), /request/i);
}));
test('native cancellation, expiry and missing records remain distinct; missing requests can be dismissed without guessing success', () => fixture(async f => {
  f.missing = true; await f.service.sync(); assert.equal(f.item().availability, 'missing'); assert.equal(f.item().snapshot.status, 'pending');
  await assert.rejects(f.service.resolve(f.device, f.input()), { code: 'question_changed' });
  f.service.dismiss(f.device, { requestId: randomUUID(), epoch: f.store.epoch, id: f.item().id, expectedRevision: f.item().revision }); assert.equal(f.item().dismissed, true);
  f.missing = false; await f.check(); assert.equal(f.item().availability, 'live'); assert.equal(f.item().dismissed, undefined);
  const { answers, ...input } = f.input(); const result = await f.service.resolve(f.device, { ...input, cancel: true }); assert.equal(result.snapshot.status, 'cancelled'); assert.equal(result.action.message, 'Question cancelled.');
}));
test('a lost connection does not mean expiry; explicit fresh check is needed before another answer', () => fixture(async f => {
  f.failGet = true; const result = await f.service.resolve(f.device, f.input()); assert.equal(result.action.state, 'unknown'); assert.equal(result.availability, 'live');
  await assert.rejects(f.check(), /Disconnected/); assert.equal(f.item().snapshot.status, 'pending');
  f.failGet = false; await f.check(); assert.equal(f.item().action, undefined); await f.service.resolve(f.device, f.input()); assert.equal(f.item().snapshot.status, 'answered');
  assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 1);
}));
test('changed prompt, reused native id, changed host, archived chat and replaced native conversation never receive an old answer', () => fixture(async f => {
  const hostInput = f.input(); f.generation = 'host-two'; await assert.rejects(f.service.resolve(f.device, hostInput), { code: 'question_host_changed' }); f.generation = 'host-one';
  f.conversation.archived = true; await assert.rejects(f.service.resolve(f.device, f.input()), { code: 'question_read_only' }); f.conversation.archived = false;
  await assert.rejects(f.service.resolve(f.device, f.input({ ...answer, targets: ['invalid'] })), { code: 'question_answer' });
  const original = structuredClone(f.native); f.native.questions[0].question = 'Changed question'; assert.equal((await f.service.resolve(f.device, f.input())).action.state, 'unknown'); assert.equal((await f.check()).availability, 'missing');
  f.native = structuredClone(original); await f.check(); f.native.createdAtMs++; assert.equal((await f.service.resolve(f.device, f.input())).action.state, 'unknown'); assert.equal((await f.check()).availability, 'missing');
  f.native = structuredClone(original); await f.check(); f.replaced = true; await f.service.resolve(f.device, f.input()); assert.equal(f.service.state().items.length, 0);
  assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 0);
}));
test('secret bytes are exact on the native request and absent from app snapshots, records and replay receipts', () => fixture(async f => {
  f.native = { ...f.native, id: randomUUID(), createdAtMs: 200, questions: [{ questionId: 'token', header: 'Token', question: 'Save this token?', options: [], isSecret: true, secretStore: { kind: 'secret', name: 'QA_TOKEN', allowedHosts: ['example.invalid'] } }] }; await f.service.sync();
  const value = '  fixture-secret-DO-NOT-RETAIN  ', input = f.input({ token: [value] });
  const result = await f.service.resolve(f.device, input); assert.equal(result.snapshot.answers.answers.token[0], 'stored');
  assert.equal(f.calls.find((c: any) => c.method === 'question.resolve').params.answers.answers.token[0], value);
  assert.equal(JSON.stringify(f.store.internalList('')).includes(value), false); assert.equal(JSON.stringify(f.service.state()).includes('fixture-secret-DO-NOT-RETAIN'), false);
  await f.service.resolve(f.device, input); assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 1);
  await assert.rejects(f.service.resolve(f.device, { ...input, answers: { token: ['another-value'] } }), /request/i);
  assert.equal(safeQuestionSnapshot({ ...f.native, status: 'answered', answers: { answers: { token: [value] } } }).answers!.answers.token[0], 'stored');
}));
test('missing preflight is never left confirming and a missing uncertain outcome is never retried', () => fixture(async f => {
  f.missing = true; const result = await f.service.resolve(f.device, f.input()); assert.equal(result.availability, 'missing'); assert.equal(result.action.state, 'unknown');
  await f.check(); assert.equal(f.item().action.state, 'unknown'); assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 0);
}));
test('expired native requests retain the actual outcome without dispatch', () => fixture(async f => {
  f.native.status = 'expired'; const result = await f.service.resolve(f.device, f.input()); assert.equal(result.snapshot.status, 'expired'); assert.equal(result.action.message, 'Question expired.'); assert.equal(f.calls.filter((c: any) => c.method === 'question.resolve').length, 0);
}));
