import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectVoiceCatalog, VoiceSetup } from '../apps/service/voice.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';

const provider = { id: 'openai', label: 'OpenAI fixture', configured: true, models: ['fixture-model'], voices: ['fixture-voice'], modes: ['realtime'], transports: ['webrtc'], brains: ['agent-consult'], supportsBrowserSession: true };
const catalog = { realtime: { ready: true, providers: [provider] } };

test('voice readiness requires explicit host confirmation and a supported browser route', () => {
  assert.equal(projectVoiceCatalog(catalog).state, 'available');
  assert.equal(projectVoiceCatalog({ realtime: { providers: [provider] } }).state, 'unverified');
  assert.equal(projectVoiceCatalog({ realtime: { ready: false, providers: [provider] } }).state, 'unconfigured');
  assert.equal(projectVoiceCatalog({ realtime: { ready: true, providers: [{ ...provider, transports: ['gateway-relay'] }] } }).state, 'unverified');
  const projected = projectVoiceCatalog({ realtime: { ...catalog.realtime, privateToken: 'FIXTURE_SECRET', providers: [{ ...provider, credential: 'FIXTURE_SECRET' }] } });
  assert.equal(JSON.stringify(projected).includes('FIXTURE_SECRET'), false);
  assert.equal(projectVoiceCatalog({ realtime: { providers: [{}] } }).state, 'unverified');
});

test('voice discovery shares concurrent reads and cannot apply another host’s result', async () => {
  let connection: AssistantConnection = { state: 'ready', message: '', generation: 'host-a', modelAuthReady: true, methods: ['talk.catalog'], grantedScopes: ['operator.read'] };
  let reads = 0, resolve!: (value: unknown) => void;
  const gateway: AssistantTransport = { status: () => connection, request: <T>() => { reads++; return new Promise<T>(accept => { resolve = value => accept(value as T); }); }, subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}) };
  const service = new VoiceSetup(gateway);
  const first = service.read(), second = service.read();
  assert.equal(reads, 1);
  connection = { ...connection, generation: 'host-b' };
  resolve(catalog);
  assert.equal((await first).state, 'disconnected');
  assert.equal((await second).state, 'disconnected');
  const current = service.read(); resolve(catalog);
  assert.equal((await current).state, 'available');
  await service.read(); assert.equal(reads, 2);
  connection = { ...connection, state: 'disconnected' };
  assert.equal((await service.read()).state, 'disconnected'); assert.equal(reads, 2);
});
