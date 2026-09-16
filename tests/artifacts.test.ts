import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { ArtifactReader, artifactByteLimit, type ArtifactSource } from '../apps/service/artifacts.js';

const source: ArtifactSource = { nativeKey: 'agent:main:e3:fixture', nativeId: 'native-fixture', connectionGeneration: 'host-fixture', artifactId: 'artifact_managed_media_fixture' };
function fixture(exchange?: typeof fetch) {
  const requests: any[] = [], listeners = new Set<(event: EventFrame) => void>();
  let replies: any[] = [];
  const gateway: AssistantTransport = {
    status: () => ({ state: 'ready', url: 'ws://127.0.0.1:18999', generation: source.connectionGeneration, methods: ['artifacts.download'], grantedScopes: ['operator.read'], modelAuthReady: true, message: 'Fixture' }),
    request: async (_method, input) => { requests.push(input); return replies.shift(); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    models: async () => [], attachmentPolicy: () => ({}),
  };
  const reader = new ArtifactReader(gateway, exchange);
  return { reader, requests, setReplies: (...values: any[]) => { replies = values; }, reconnect: () => listeners.forEach(listener => listener({ type: 'event', event: 'e3.connected', payload: {} })) };
}
const bytesGrant = (bytes = Buffer.from('Generated file bytes')) => ({ artifact: { id: source.artifactId, sessionKey: source.nativeKey, title: 'example.txt', type: 'file', mimeType: 'text/plain', sizeBytes: bytes.length, download: { mode: 'bytes' } }, encoding: 'base64', data: bytes.toString('base64') });
const urlGrant = (extra = '') => ({ ...bytesGrant(), artifact: { ...bytesGrant().artifact, download: { mode: 'url' } }, data: undefined, encoding: undefined, url: `/api/chat/media/outgoing/${encodeURIComponent(source.nativeKey)}/fixture/full?mediaTicket=temporary${extra}`, expiresAt: new Date(Date.now() + 60000).toISOString() });

test('artifact bytes are bound to the original transcript reference before and after download', async () => {
  const f = fixture(); f.setReplies(bytesGrant()); let checks = 0;
  try {
    const result = await f.reader.read(source, async () => { checks++; });
    assert.equal(result.bytes.toString(), 'Generated file bytes');
    assert.equal(result.sha256, createHash('sha256').update(result.bytes).digest('hex'));
    assert.equal(result.mimeType, 'text/plain'); assert.equal(checks, 2);
    assert.deepEqual(f.requests, [{ sessionKey: source.nativeKey, artifactId: source.artifactId }]);
    assert.equal('url' in result, false);
  } finally { f.reader.close(); }
});

test('a private expiring grant refreshes once without forwarding owner credentials or accepting redirects', async () => {
  const fetches: RequestInit[] = [];
  const f = fixture(async (_url, options) => { fetches.push(options!); return fetches.length === 1 ? new Response('', { status: 410 }) : new Response('Generated file bytes'); });
  f.setReplies(urlGrant(), urlGrant());
  try {
    const result = await f.reader.read(source, async () => undefined);
    assert.equal(result.bytes.toString(), 'Generated file bytes'); assert.equal(f.requests.length, 2);
    for (const options of fetches) { assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined); }
  } finally { f.reader.close(); }
});

test('foreign URLs, wrong artifact paths, and extra query credentials are rejected before fetch', async () => {
  let fetches = 0;
  const f = fixture(async () => { fetches++; return new Response('Generated file bytes'); });
  try {
    for (const url of ['https://foreign.invalid/output?mediaTicket=temporary', '/api/chat/media/outgoing/other/fixture/full?mediaTicket=temporary', urlGrant('&token=owner').url]) {
      f.setReplies({ ...urlGrant(), url });
      await assert.rejects(f.reader.read(source, async () => undefined), /supported private download/);
    }
    assert.equal(fetches, 0);
  } finally { f.reader.close(); }
});

test('returned identity and byte length must match the exact requested artifact', async () => {
  const f = fixture();
  try {
    f.setReplies({ ...bytesGrant(), artifact: { ...bytesGrant().artifact, sessionKey: 'another-conversation' } });
    await assert.rejects(f.reader.read(source, async () => undefined), /connection changed/);
    f.setReplies({ ...bytesGrant(), artifact: { ...bytesGrant().artifact, sizeBytes: 1 } });
    await assert.rejects(f.reader.read(source, async () => undefined), /source size/);
    f.setReplies({ ...bytesGrant(), data: 'not base64' });
    await assert.rejects(f.reader.read(source, async () => undefined), /valid output bytes/);
  } finally { f.reader.close(); }
});

test('oversized streamed content is stopped before any bytes are returned to the client', async () => {
  let cancelled = false;
  const f = fixture(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(artifactByteLimit + 1)); }, cancel() { cancelled = true; } })));
  f.setReplies({ ...urlGrant(), artifact: { ...urlGrant().artifact, sizeBytes: undefined } });
  try { await assert.rejects(f.reader.read(source, async () => undefined), /8 MB/); assert.equal(cancelled, true); }
  finally { f.reader.close(); }
});

test('same-host reconnect aborts an in-flight download and never returns its late bytes', async () => {
  let release!: (response: Response) => void, signal: AbortSignal | undefined;
  const f = fixture(async (_url, options) => { signal = options!.signal as AbortSignal; return new Promise<Response>(resolve => { release = resolve; }); });
  f.setReplies(urlGrant());
  try {
    const pending = f.reader.read(source, async () => undefined);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.reconnect(); assert.equal(signal?.aborted, true);
    release(new Response('Generated file bytes'));
    await assert.rejects(pending, /connection changed/);
  } finally { f.reader.close(); }
});

test('an incarnation change after bytes arrive prevents delivery and provider error details stay private', async () => {
  const f = fixture(); f.setReplies(bytesGrant()); let checks = 0;
  try { await assert.rejects(f.reader.read(source, async () => { if (++checks === 2) throw new Error('Changed native incarnation'); }), /could not be verified/); }
  finally { f.reader.close(); }
  const errorFixture = fixture(async () => { throw new Error('https://private.invalid/?mediaTicket=secret-ticket'); });
  errorFixture.setReplies(urlGrant());
  try { await assert.rejects(errorFixture.reader.read(source, async () => undefined), error => error instanceof Error && error.message.includes('could not be verified') && !error.message.includes('secret-ticket')); }
  finally { errorFixture.reader.close(); }
});

test('a large valid native artifact downloads without overflowing encoding validation', async () => {
  const f = fixture(), bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 173); f.setReplies(bytesGrant(bytes));
  try { const result = await f.reader.read(source, async () => undefined); assert.equal(result.bytes.length, bytes.length); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex')); }
  finally { f.reader.close(); }
});
