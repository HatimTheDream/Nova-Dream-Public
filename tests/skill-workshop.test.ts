import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import native from './fixtures/skill-workshop-native.json';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import { Store } from '../apps/service/store.js';
import { SkillWorkshop } from '../apps/service/skill-workshop.js';
import { startServer } from '../apps/service/http.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'e3-workshop-')), store = new Store(directory), device = store.session().deviceId;
  const state: AssistantConnection = { state: 'ready', generation: randomUUID(), methods: ['skills.proposals.list', 'skills.proposals.inspect', 'skills.proposals.events.list'], grantedScopes: ['operator.read'], modelAuthReady: false, message: 'Fixture' };
  const calls: { method: string; params: unknown }[] = []; let reply: unknown = native['revised-inspect'];
  const gateway: AssistantTransport = { status: () => ({ ...state }), subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}), request: async <T>(method: string, params: unknown) => { calls.push({ method, params }); return structuredClone(reply) as T; } };
  const service = new SkillWorkshop(store, gateway, () => 123456789);
  const command = async () => { const v = await service.inspect(native.inspected.record.id); return { requestId: randomUUID(), epoch: store.epoch, generation: v.generation, proposalId: v.record.id, revisionHash: v.revisionHash, targetFingerprint: v.targetFingerprint }; };
  return { directory, store, device, state, calls, gateway, service, command, setReply(value: unknown) { reply = value; }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('proposal lists preserve native status and reject duplicate or incomplete identities', async () => {
  const f = fixture();
  try {
    const r = native['revised-inspect'].record;
    const entry = { id: r.id, kind: r.kind, status: r.status, title: r.title, description: r.description, createdAt: r.createdAt, updatedAt: r.updatedAt, skillName: r.target.skillName, skillKey: r.target.skillKey, scanState: r.scan.state, skillFile: '/private/fixture/secret' };
    const manifest = { schema: 'openclaw.skill-workshop.proposals-manifest.v1', proposals: [entry] };
    f.setReply(manifest); const result = await f.service.list(); assert.equal(result.proposals[0].status, 'pending'); assert.doesNotMatch(JSON.stringify(result), /private\/fixture/);
    f.setReply({ ...manifest, proposals: [entry, entry] }); await assert.rejects(f.service.list(), /incomplete or unsupported/);
    f.setReply({ ...manifest, proposals: [{ ...entry, status: undefined }] }); await assert.rejects(f.service.list(), /incomplete or unsupported/);
  } finally { f.close(); }
});
test('native full-bundle inspection verifies all bytes and projects review metadata without private target paths', async () => {
  const f = fixture();
  try {
    const view = await f.service.inspect(native.inspected.record.id);
    assert.equal(view.revisionHash, native['revised-inspect'].revisionHash);
    assert.equal(view.content, native['revised-inspect'].content);
    assert.equal(view.supportFiles[0].content, native['revised-inspect'].supportFiles[0].content);
    assert.equal(view.nativeAgentId, 'main'); assert.equal(view.observedAt, 123456789);
    assert.doesNotMatch(JSON.stringify(view), /private\/fixture|skillDir|skillFile/);
    assert.deepEqual(f.calls[0].params, { agentId: 'main', proposalId: native.inspected.record.id });
    f.setReply(native.revised); await assert.rejects(f.service.inspect(view.record.id), /incomplete or unsupported/, 'a native mutation acknowledgement is not a full inspection');
    for (const change of [(v: any) => v.supportFiles[0].content += 'altered', (v: any) => v.content += 'altered', (v: any) => v.record.id = 'foreign', (v: any) => v.supportFiles.push(v.supportFiles[0]), (v: any) => v.revisionHash = '0'.repeat(64), (v: any) => v.supportFiles[0].path = '../escape']) {
      const v = structuredClone(native['revised-inspect']); change(v); f.setReply(v); await assert.rejects(f.service.inspect(view.record.id), /incomplete or unsupported/);
    }
  } finally { f.close(); }
});
test('saving review copies binds epoch, host, native revision and the target omitted from native revision hashing', async () => {
  const f = fixture();
  try {
    const cmd = await f.command(), moved = structuredClone(native['revised-inspect']); moved.record.target.skillFile = '/private/fixture/different/SKILL.md';
    f.setReply(moved);
    assert.equal((await f.service.inspect(cmd.proposalId)).revisionHash, cmd.revisionHash, 'native revision excludes target');
    await assert.rejects(f.service.keep(f.device, cmd), /proposal or its target changed/);
    assert.equal(f.service.savedList().length, 0);
    f.setReply(native.inspected); await assert.rejects(f.service.keep(f.device, cmd), /proposal or its target changed/);
    f.setReply(native['revised-inspect']); f.state.generation = randomUUID(); await assert.rejects(f.service.keep(f.device, cmd), /proposal or its target changed/);
    await assert.rejects(f.service.keep(f.device, { ...cmd, epoch: randomUUID() }), /workspace changed/);
    assert.equal(f.service.savedList().length, 0);
  } finally { f.close(); }
});
test('a lost saved-copy response recovers the original request after restart, without rereading changed or offline native state', async () => {
  const f = fixture(); let reopened: Store | undefined;
  try {
    const cmd = await f.command(), saved = await f.service.keep(f.device, cmd);
    const again = await f.service.keep(f.device, { ...cmd, requestId: randomUUID() }); assert.equal(saved.savedId, again.savedId);
    assert.equal(f.service.savedList().length, 1);
    const current = structuredClone(native['revised-inspect']); current.content += 'later content'; f.setReply(current); f.state.state = 'disconnected';
    const count = f.calls.length; f.store.close(); reopened = new Store(f.directory); const service = new SkillWorkshop(reopened, f.gateway);
    assert.deepEqual(await service.keep(f.device, cmd), saved); assert.equal(f.calls.length, count);
    assert.deepEqual(service.saved(saved.savedId), saved); assert.equal(service.savedList()[0].savedId, saved.savedId);
    assert.equal(service.savedList()[0].status, 'pending', 'a retained observation is not rewritten as current native status');
    await assert.rejects(service.keep(randomUUID(), cmd), /another review/);
    await assert.rejects(service.keep(f.device, { ...cmd, revisionHash: '0'.repeat(64) }), /another review/);
  } finally { if (reopened) { reopened.close(); rmSync(f.directory, { recursive: true, force: true }); } else f.close(); }
});
test('late host changes and unavailable native read authority cannot produce retained review copies', async () => {
  const f = fixture();
  try {
    const cmd = await f.command(); let resolve!: (value: unknown) => void;
    f.gateway.request = <T>() => new Promise<T>(r => { resolve = v => r(v as T); });
    const pending = f.service.keep(f.device, cmd); f.state.generation = randomUUID(); resolve(native['revised-inspect']);
    await assert.rejects(pending, /workspace or Assistant host changed/); assert.equal(f.service.savedList().length, 0);
    f.state.state = 'disconnected'; await assert.rejects(f.service.list(), /Connect the original/);
    f.state.state = 'ready'; f.state.grantedScopes = []; await assert.rejects(f.service.list(), /does not allow reading/);
    f.state.grantedScopes = ['operator.read']; f.state.methods = []; await assert.rejects(f.service.list(), /does not expose/);
  } finally { f.close(); }
});
test('review quota failure leaves no copy or receipt and can retry once storage is available', async () => {
  const f = fixture();
  try {
    const cmd = await f.command(); f.store.internalWrite('skill-workshop:quota', { bytes: 0, count: 500 });
    await assert.rejects(f.service.keep(f.device, cmd), /storage is full/); assert.equal(f.service.savedList().length, 0);
    f.store.internalWrite('skill-workshop:quota', { bytes: 0, count: 0 }); const copy = await f.service.keep(f.device, cmd); assert.ok(copy.savedId);
    assert.equal(f.store.internalRead<{ count: number }>('skill-workshop:quota')?.count, 1);
  } finally { f.close(); }
});
test('native event pages preserve revision and correlation evidence while excluding arbitrary private payloads', async () => {
  const f = fixture();
  try {
    f.setReply(native.events); const page = await f.service.events(native.inspected.record.id);
    assert.equal(page.events.length, 4); assert.equal(page.events.at(-1)?.correlationId, native.events.events.at(-1)?.correlationId);
    assert.doesNotMatch(JSON.stringify(page), /targetSkillFile|private\/fixture|payload/);
    const next = native.events.events[1].sequence;
    f.setReply({ events: native.events.events.slice(0, 2), nextSequence: next }); assert.equal((await f.service.events(native.inspected.record.id)).nextSequence, next);
    await assert.rejects(f.service.events(native.inspected.record.id, next), /incomplete or unsupported/);
    f.setReply({ events: [], nextSequence: 10 }); await assert.rejects(f.service.events(native.inspected.record.id), /incomplete or unsupported/);
  } finally { f.close(); }
});
test('workshop HTTP requires authenticated same-origin access and accepts no arbitrary native host or agent selectors', async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'e3-workshop-http-')), server = await startServer({ directory, port: 0, gateway: f.gateway });
  try {
    const url = server.origin + '/api/agent-skills/proposal?proposalId=' + encodeURIComponent(native.inspected.record.id);
    assert.equal((await fetch(url)).status, 401);
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(url, { headers: { cookie, origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(url + '&agentId=foreign', { headers: { cookie } })).status, 400);
    const response = await fetch(url, { headers: { cookie } }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const view = await response.json(); const cmd = { requestId: randomUUID(), epoch: view.epoch, generation: view.generation, proposalId: view.record.id, revisionHash: view.revisionHash, targetFingerprint: view.targetFingerprint };
    const kept = await fetch(server.origin + '/api/agent-skills/keep-review', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: JSON.stringify(cmd) });
    assert.equal(kept.status, 200); const copy = await kept.json();
    assert.equal((await (await fetch(server.origin + '/api/agent-skills/reviews', { headers: { cookie } })).json()).length, 1);
    f.state.state = 'disconnected'; assert.equal((await fetch(server.origin + '/api/agent-skills/reviews?savedId=' + copy.savedId, { headers: { cookie } })).status, 200);
  } finally { await server.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
