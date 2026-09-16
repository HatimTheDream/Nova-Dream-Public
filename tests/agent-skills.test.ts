import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkills } from '../apps/service/agent-skills.js';
import { skillAvailability } from '../packages/domain/agent-skills.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import { startServer } from '../apps/service/http.js';

const skill = { name: 'Writing review', description: 'Review structure and clarity.', source: 'openclaw-workshop', skillKey: 'writing-review', disabled: false, eligible: true, modelVisible: true };
function fixture() {
  const state: AssistantConnection = { state: 'ready', generation: randomUUID(), methods: ['skills.status'], grantedScopes: ['operator.read'], modelAuthReady: true, message: 'Fixture' };
  const calls: unknown[] = [];
  const transport: AssistantTransport = { status: () => ({ ...state }), subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}), request: async <T>(method: string, params: unknown) => { calls.push({ method, params }); return { skills: [skill] } as T; } };
  return { state, transport, calls, service: new AgentSkills(transport, () => 1234) };
}
test('installed inventory uses the real worker identity and omits paths, install commands and extra host fields', async () => {
  const f = fixture();
  f.transport.request = async <T>(method: string, params: unknown) => { f.calls.push({ method, params }); return { workspaceDir: '/private/host', token: 'secret', skills: [{ ...skill, filePath: '/private/host/SKILL.md', baseDir: '/private/host', apiKey: 'secret', install: [{ args: ['secret'] }], missing: { bins: ['rg'], env: ['REVIEW_TOKEN'], secret: 'hidden' } }] } as T; };
  const result = await f.service.installed();
  assert.deepEqual(f.calls, [{ method: 'skills.status', params: { agentId: 'main' } }]);
  assert.equal(result.nativeAgentId, 'main'); assert.equal(result.observedAt, 1234);
  assert.deepEqual(result.skills[0].missing, { bins: ['rg'], env: ['REVIEW_TOKEN'] });
  assert.doesNotMatch(JSON.stringify(result), /private\/host|secret|hidden|filePath|install/);
});
test('missing runtime exposure is not presented as confirmed availability', () => {
  assert.equal(skillAvailability(skill).state, 'available');
  assert.equal(skillAvailability({ ...skill, modelVisible: undefined }).state, 'ready');
  assert.equal(skillAvailability({ ...skill, modelVisible: false, commandVisible: true }).label, 'Command only');
  assert.equal(skillAvailability({ ...skill, eligible: false }).state, 'setup');
  assert.equal(skillAvailability({ ...skill, disabled: true }).state, 'disabled');
  assert.equal(skillAvailability({ ...skill, blockedByAllowlist: true }).state, 'restricted');
  assert.equal(skillAvailability({ ...skill, blockedByAgentFilter: true }).state, 'restricted');
});
test('disconnection, unavailable capabilities and missing read permission do not masquerade as an empty inventory', async () => {
  const f = fixture(); f.state.state = 'disconnected'; await assert.rejects(f.service.installed(), /Connect the Assistant/);
  f.state.state = 'ready'; f.state.methods = []; await assert.rejects(f.service.installed(), /does not expose/);
  f.state.methods = ['skills.status']; f.state.grantedScopes = []; await assert.rejects(f.service.installed(), /does not allow reading/);
  assert.equal(f.calls.length, 0);
});
test('late foreign-host and malformed inventory responses cannot replace current availability', async () => {
  const f = fixture(); let finish!: (value: any) => void;
  f.transport.request = () => new Promise(resolve => { finish = resolve; });
  const read = f.service.installed(); f.state.generation = randomUUID(); finish({ skills: [skill] }); await assert.rejects(read, /host changed/);
  f.transport.request = async <T>() => ({ skills: [skill, skill] }) as T; await assert.rejects(f.service.installed(), /unsupported skill inventory/);
  f.transport.request = async <T>() => ({ skills: [{ ...skill, eligible: undefined }] }) as T; await assert.rejects(f.service.installed(), /unsupported skill inventory/);
  f.transport.request = async () => { throw new Error('/private/token secret'); }; await assert.rejects(f.service.installed(), e => e instanceof Error && !e.message.includes('secret'));
});
test('installed-skill HTTP reads use session/origin authority and reject arbitrary native agent selection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-skills-http-')), f = fixture(), server = await startServer({ directory, port: 0, gateway: f.transport });
  try {
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0], url = server.origin + '/api/agent-skills/installed';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { cookie, origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(url + '?agentId=foreign', { headers: { cookie } })).status, 400);
    const response = await fetch(url, { headers: { cookie } }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).skills[0].skillKey, skill.skillKey);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
