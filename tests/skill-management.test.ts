import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import type { SkillCommand, SkillOperation } from '../packages/domain/skill-management.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { SkillManagement, type SkillManagementTransport } from '../apps/service/skill-management.js';
import { SkillWorkshop } from '../apps/service/skill-workshop.js';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import native from './fixtures/skill-workshop-native.json';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'e3-skill-management-')), store = new Store(directory), device = store.session().deviceId;
  const base: AssistantConnection = { state: 'ready', generation: randomUUID(), message: 'Fixture', methods: ['skills.status', 'skills.proposals.list', 'skills.proposals.inspect', 'skills.proposals.events.list'], grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: false };
  const managerState: AssistantConnection = { ...base, state: 'unconfigured', methods: ['create', 'update', 'revise', 'apply', 'reject'].map(action => 'skills.proposals.' + action), grantedScopes: ['operator.read', 'operator.admin'] };
  const listeners = new Set<(event: EventFrame) => void>(); let current: any = structuredClone(native['revised-inspect']), events: any = { events: [] }, starts = 0, stops = 0, created = 0;
  let inventory = [{ skillKey: native.inspected.record.target.skillKey, name: native.inspected.record.target.skillName, description: 'An installed test skill.', source: 'workspace', eligible: true, disabled: false }];
  const calls: { method: string; params: any; captured?: SkillOperation }[] = [];
  let readHook: ((method: string) => Promise<unknown>) | undefined, writeHook: ((method: string, params: any) => Promise<unknown>) | undefined;
  const gateway: AssistantTransport = { status: () => ({ ...base }), subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, models: async () => [], attachmentPolicy: () => ({}), request: async <T>(method: string) => {
    if (readHook) return await readHook(method) as T;
    if (method === 'skills.status') return { skills: structuredClone(inventory) } as T;
    if (method.endsWith('.list') && !method.includes('.events.')) return { schema: 'openclaw.skill-workshop.proposals-manifest.v1', proposals: [] } as T;
    return structuredClone(method.includes('.events.') ? events : current) as T;
  } };
  const manager: SkillManagementTransport = { ...gateway, status: () => ({ ...managerState }), start() { starts++; managerState.state = 'ready'; managerState.generation = base.generation; }, async stop() { stops++; managerState.state = 'unconfigured'; }, request: async <T>(method: string, params: any) => {
    calls.push({ method, params, captured: store.internalRead<SkillOperation>('skill-management:operation:' + params.correlationId) });
    if (writeHook) return await writeHook(method, params) as T;
    const result: any = structuredClone(native.revised);
    if (method.endsWith('.apply')) result.record.status = 'applied';
    if (method.endsWith('.reject')) return { ...result.record, status: 'rejected' } as T;
    if (method.endsWith('.update')) result.record.kind = 'update';
    return result as T;
  } };
  const factory = () => { created++; return manager; }, workshop = new SkillWorkshop(store, gateway), service = new SkillManagement(store, gateway, workshop, factory);
  const access = (enabled = true, as = device) => service.access(as, { requestId: randomUUID(), epoch: store.epoch, generation: base.generation!, enabled });
  const draft = { name: native.inspected.record.target.skillKey, description: 'Review a draft.', content: '# Review\n\nKeep the original files intact.\n', supportFiles: [] };
  const create = () => ({ requestId: randomUUID(), epoch: store.epoch, generation: base.generation!, action: 'create' as const, draft });
  const review = async () => { const view = await workshop.inspect(native.inspected.record.id); return workshop.keep(device, { requestId: randomUUID(), epoch: store.epoch, generation: base.generation!, proposalId: view.record.id, revisionHash: view.revisionHash, targetFingerprint: view.targetFingerprint }); };
  const decision = async (action: 'apply' | 'reject' = 'apply'): Promise<SkillCommand> => ({ requestId: randomUUID(), epoch: store.epoch, generation: base.generation!, action, reviewId: (await review()).savedId, reason: 'Reviewed this exact test proposal.' });
  const settle = async (id: string) => { for (let i = 0; i < 100 && ['preparing', 'dispatched'].includes(service.operation(id).state); i++) await new Promise(r => setTimeout(r, 2)); return service.operation(id); };
  return { directory, store, device, base, managerState, gateway, manager, factory, workshop, service, calls, access, draft, create, review, decision, settle, counts: () => ({ starts, stops, created }), setCurrent(v: unknown) { current = v; }, setInventory(v: typeof inventory) { inventory = v; }, setEvents(v: unknown) { events = v; }, onRead(hook?: typeof readHook) { readHook = hook; }, onWrite(hook?: typeof writeHook) { writeHook = hook; }, emit(name: string) { for (const fn of listeners) fn({ type: 'event', event: name }); }, async close() { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('management authority is explicit, per device and bound to the current host; old access receipts cannot re-enable it', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.state(f.device).enabled, false); assert.equal(f.counts().created, 0);
    assert.throws(() => f.service.submit(f.device, f.create()), /Enable or reconnect/);
    const enable = { requestId: randomUUID(), epoch: f.store.epoch, generation: f.base.generation, enabled: true };
    await f.service.access(f.device, enable); assert.equal(f.service.state(f.device).connection, 'ready');
    assert.throws(() => f.service.submit(f.store.session().deviceId, f.create()), /Enable or reconnect/);
    await f.access(false); await f.service.access(f.device, enable); assert.equal(f.service.state(f.device).enabled, false);
    await f.access(); f.base.state = 'disconnected'; f.emit('e3.disconnected'); assert.equal(f.managerState.state, 'unconfigured');
    assert.throws(() => f.service.submit(f.device, f.create()), /Enable or reconnect/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('one immutable intent precedes dispatch; duplicate HTTP retries read its current receipt without another native write', async () => {
  const f = fixture();
  try {
    await f.access(); const cmd = await f.decision();
    const op = f.service.submit(f.device, cmd); f.service.submit(f.device, cmd);
    const result = await f.settle(op.id); assert.equal(result.state, 'confirmed'); assert.equal(result.resultStatus, 'applied');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].captured?.state, 'dispatched'); assert.deepEqual(f.calls[0].captured?.intent, cmd);
    assert.equal(f.calls[0].params.agentId, 'main'); assert.equal(f.calls[0].params.expectedRevisionHash, native.revised.revisionHash); assert.equal(f.calls[0].params.correlationId, cmd.requestId);
    await f.access(false); assert.equal(f.service.submit(f.device, cmd).state, 'confirmed'); assert.equal(f.calls.length, 1);
    assert.throws(() => f.service.submit(f.device, { ...cmd, reason: 'Altered retry' }), /request|different|already/i);
    assert.throws(() => f.service.submit(randomUUID(), cmd), /request|device|different/i);
  } finally { await f.close(); }
});
test('revocation during preflight and destination preimage changes prevent dispatch', async () => {
  const f = fixture();
  try {
    await f.access(); const cmd = await f.decision(); let release!: (value: unknown) => void;
    f.onRead(() => new Promise(resolve => { release = resolve; })); const op = f.service.submit(f.device, cmd);
    assert.equal(op.state, 'preparing'); await f.access(false); release(native['revised-inspect']);
    assert.equal((await f.settle(op.id)).state, 'not-sent'); assert.equal(f.calls.length, 0);
    f.onRead(); await f.access(); const next = await f.decision();
    const changed: any = structuredClone(native['revised-inspect']); changed.record.supportFiles[0].targetExisted = true; changed.record.supportFiles[0].targetContentHash = 'f'.repeat(64); f.setCurrent(changed);
    const blocked = await f.settle(f.service.submit(f.device, next).id); assert.equal(blocked.state, 'not-sent'); assert.match(blocked.message, /destinations changed/); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('lost native apply replies reconcile through exact correlation events, including paged history, without admin access or replay', async () => {
  const f = fixture();
  try {
    await f.access(); const cmd = await f.decision(); f.onWrite(async () => { throw new Error('Disconnected after native commit: /private/credential'); });
    const op = await f.settle(f.service.submit(f.device, cmd).id); assert.equal(op.state, 'unknown'); assert.doesNotMatch(JSON.stringify(op), /private\/credential/);
    assert.throws(() => f.service.submit(f.device, { ...cmd, requestId: randomUUID() }), /existing uncertain operation/);
    await f.access(false);
    const event = { ...native.events.events.at(-1)!, correlationId: randomUUID(), sequence: 100, type: 'applied' };
    f.setEvents({ events: [event], nextSequence: 100 }); assert.equal((await f.service.check(op.id)).scanCursor, 100);
    f.setEvents({ events: [{ ...event, sequence: 101, eventId: randomUUID(), correlationId: op.id }] });
    const confirmed = await f.service.check(op.id); assert.equal(confirmed.state, 'confirmed'); assert.equal(confirmed.resultRevisionHash, cmd.action === 'apply' ? native.revised.revisionHash : ''); assert.equal(f.calls.length, 1);
    assert.equal(f.service.submit(f.device, cmd).state, 'confirmed'); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
test('native create uncertainty remains honest until explicitly reviewed; association does not invent execution proof', async () => {
  const f = fixture();
  try {
    await f.access(); const cmd = f.create(); f.onWrite(async () => { throw new Error('Lost creation reply'); });
    const op = await f.settle(f.service.submit(f.device, cmd).id); assert.equal(op.state, 'unknown');
    await f.service.check(op.id); assert.equal(f.calls.length, 1); assert.match(f.service.operation(op.id).message, /does not prove/);
    const review = await f.review();
    const input = { requestId: randomUUID(), epoch: f.store.epoch, operationId: op.id, acknowledgeUnconfirmed: true, reviewId: review.savedId, reason: 'I inspected the matching proposal on this host.' };
    const associated = f.service.resolve(f.device, input); assert.equal(associated.state, 'reviewed-unconfirmed'); assert.equal(associated.associatedReviewId, review.savedId); assert.equal(associated.resultStatus, undefined);
    assert.deepEqual(f.service.resolve(f.device, input), associated); assert.equal(f.calls.length, 1);
    f.onWrite(); assert.equal((await f.settle(f.service.submit(f.device, f.create()).id)).state, 'confirmed'); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});
test('restart distinguishes never-dispatched work from uncertain dispatched work and never starts a management connection', async () => {
  const f = fixture(); let replacement: SkillManagement | undefined;
  try {
    await f.access(); const op = await f.settle(f.service.submit(f.device, f.create()).id);
    await f.service.close();
    const saved = { ...op, state: 'dispatched' as const };
    f.store.internalWrite('skill-management:operation:' + op.id, saved); f.store.internalWrite('skill-management:index:' + op.id, { ...f.service.state(f.device).operations[0], state: 'dispatched' });
    const starts = f.counts().starts; replacement = new SkillManagement(f.store, f.gateway, f.workshop, f.factory);
    assert.equal(replacement.operation(op.id).state, 'unknown'); assert.equal(f.counts().starts, starts); assert.equal(replacement.submit(f.device, op.intent).state, 'unknown'); assert.equal(f.calls.length, 1);
    await replacement.close(); replacement = undefined;
    f.store.internalWrite('skill-management:operation:' + op.id, { ...saved, state: 'preparing' }); f.store.internalWrite('skill-management:index:' + op.id, { ...f.service.state(f.device).operations[0], state: 'preparing' });
    replacement = new SkillManagement(f.store, f.gateway, f.workshop, f.factory); assert.equal(replacement.operation(op.id).state, 'not-sent');
    await replacement.close(); replacement = undefined;
    f.store.internalWrite('skill-management:operation:' + op.id, { ...saved, epoch: randomUUID(), state: 'preparing' }); f.store.internalWrite('skill-management:index:' + op.id, { ...f.service.state(f.device).operations[0], state: 'preparing' });
    replacement = new SkillManagement(f.store, f.gateway, f.workshop, f.factory); assert.equal(replacement.operation(op.id).state, 'unknown', 'recovered pre-dispatch snapshots may predate an actual native effect');
  } finally { await replacement?.close(); await f.close(); }
});
test('revision and rejection use exact captured reviews; invalid support paths and full history fail before effects', async () => {
  const f = fixture();
  try {
    await f.access(); f.setCurrent(native.inspected); const review = await f.review();
    const cmd: SkillCommand = { ...f.create(), action: 'revise', reviewId: review.savedId, draft: f.draft }; assert.equal((await f.settle(f.service.submit(f.device, cmd).id)).state, 'confirmed');
    assert.equal(f.calls[0].params.expectedRevisionHash, native.inspected.revisionHash); assert.deepEqual(f.calls[0].params.supportFiles, []);
    f.setCurrent(native['revised-inspect']); const rejected = await f.settle(f.service.submit(f.device, await f.decision('reject')).id); assert.equal(rejected.resultStatus, 'rejected');
    const count = f.calls.length; const create = f.create();
    assert.throws(() => f.service.submit(f.device, { ...create, draft: { ...f.draft, supportFiles: [{ path: '../escape', content: 'data' }] } }));
    assert.throws(() => f.service.submit(f.device, { ...create, draft: { ...f.draft, supportFiles: [{ path: 'SKILL.md', content: 'data' }] } }));
    f.store.internalWrite('skill-management:quota', { count: 500, bytes: 0 }); assert.throws(() => f.service.submit(f.device, create), /storage is full/); assert.equal(f.calls.length, count);
    assert.throws(() => f.service.operation(create.requestId), /unavailable/);
  } finally { await f.close(); }
});
test('management HTTP does not create a privileged connection on read, and retains session/origin boundaries', async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'e3-skill-control-http-'));
  const server = await startServer({ directory, port: 0, gateway: f.gateway, skillManagementFactory: f.factory });
  try {
    const url = server.origin + '/api/agent-skills/management'; assert.equal((await fetch(url)).status, 401);
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0], headers = { cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1' };
    const state = await (await fetch(url, { headers })).json(); assert.equal(state.enabled, false); assert.equal(f.counts().created, 0);
    assert.equal((await fetch(url + '?agentId=foreign', { headers })).status, 400);
    const body = JSON.stringify({ requestId: randomUUID(), epoch: state.epoch, generation: state.generation, enabled: true });
    assert.equal((await fetch(url + '/access', { method: 'POST', headers: { ...headers, origin: 'https://foreign.example' }, body })).status, 403);
    assert.equal(f.counts().created, 0); assert.equal((await fetch(url + '/access', { method: 'POST', headers, body })).status, 200); assert.equal(f.counts().created, 1);
  } finally { await server.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an update resolves its exact installed key before native name-first lookup and retains that identity on reply replay', async () => {
  const f = fixture();
  try {
    await f.access(); const key = f.draft.name, name = 'original-readable-name';
    f.setInventory([{ skillKey: key, name, description: 'The selected skill.', source: 'workspace', eligible: true, disabled: false }, { skillKey: 'different-key', name: key, description: 'A different skill whose name collides with the selected key.', source: 'workspace', eligible: true, disabled: false }]);
    const inspected = structuredClone(native['revised-inspect']); inspected.record.target.skillName = name; f.setCurrent(inspected);
    const review = await f.review();
    f.onWrite(async (method, params) => { assert.equal(method, 'skills.proposals.update'); assert.equal(params.skillName, name); const ack = structuredClone(native.revised); ack.record.kind = 'update'; ack.record.target.skillName = name; return ack; });
    const cmd: SkillCommand = { ...f.create(), action: 'update', sourceReviewId: review.savedId };
    const op = await f.settle(f.service.submit(f.device, cmd).id);
    assert.equal(op.state, 'confirmed'); assert.equal(op.skillKey, key); assert.equal(op.skillName, name); assert.deepEqual(op.intent, cmd); assert.equal(f.calls.length, 1);
    f.setInventory([]); assert.equal(f.service.submit(f.device, cmd).state, 'confirmed'); assert.equal(f.calls.length, 1, 'Original replay must not resolve a new target or dispatch another update');
  } finally { await f.close(); }
});

test('missing keys, duplicate native names and changed reviewed names stop updates before dispatch', async () => {
  const f = fixture();
  try {
    await f.access(); const key = f.draft.name, name = 'readable-name';
    f.setInventory([{ skillKey: key, name, description: 'Selected skill.', source: 'workspace', eligible: true, disabled: false }]);
    const missing: SkillCommand = { ...f.create(), action: 'update', draft: { ...f.draft, name } };
    const absent = await f.settle(f.service.submit(f.device, missing).id); assert.equal(absent.state, 'not-sent'); assert.match(absent.message, /exact skill key/);
    f.setInventory([key, 'another-key'].map(skillKey => ({ skillKey, name, description: 'Duplicate name.', source: 'workspace', eligible: true, disabled: false })));
    const duplicate = await f.settle(f.service.submit(f.device, { ...f.create(), action: 'update' }).id); assert.equal(duplicate.state, 'not-sent'); assert.match(duplicate.message, /more than one/);
    const source = await f.review(); f.setInventory([{ skillKey: key, name, description: 'Renamed since review.', source: 'workspace', eligible: true, disabled: false }]);
    const renamed = await f.settle(f.service.submit(f.device, { ...f.create(), action: 'update', sourceReviewId: source.savedId }).id); assert.equal(renamed.state, 'not-sent'); assert.match(renamed.message, /name changed/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('a source-based update cannot silently retarget a different key or host', async () => {
  const f = fixture();
  try {
    await f.access(); const source = await f.review();
    const cmd: SkillCommand = { ...f.create(), action: 'update', sourceReviewId: source.savedId };
    assert.throws(() => f.service.submit(f.device, { ...cmd, draft: { ...f.draft, name: 'another-installed-key' } }), /reviewed skill and host/);
    f.base.generation = randomUUID(); f.managerState.generation = f.base.generation; await f.access();
    assert.throws(() => f.service.submit(f.device, { ...cmd, requestId: randomUUID(), generation: f.base.generation! }), /reviewed skill and host/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('target lookup rechecks authority and a mismatched acknowledgement stays uncertain under the original key', async () => {
  const f = fixture();
  try {
    await f.access(); let release!: (value: unknown) => void;
    f.onRead(method => { assert.equal(method, 'skills.status'); return new Promise(resolve => { release = resolve; }); });
    const cmd: SkillCommand = { ...f.create(), action: 'update' }, first = f.service.submit(f.device, cmd);
    await f.access(false); f.onRead(); release({ skills: [{ skillKey: f.draft.name, name: f.draft.name, description: 'Original target.', source: 'workspace', eligible: true, disabled: false }] });
    assert.equal((await f.settle(first.id)).state, 'not-sent'); assert.equal(f.calls.length, 0);
    await f.access(); f.onWrite(async () => { const ack = structuredClone(native.revised); ack.record.kind = 'update'; ack.record.target.skillName = 'changed-during-dispatch'; return ack; });
    const uncertain = await f.settle(f.service.submit(f.device, { ...cmd, requestId: randomUUID() }).id);
    assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.skillKey, f.draft.name);
    assert.throws(() => f.service.submit(f.device, { ...cmd, requestId: randomUUID() }), /existing uncertain operation/);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
