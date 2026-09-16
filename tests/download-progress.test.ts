import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadPercent, readDownload, type DownloadProgress } from '../apps/client/src/download-progress';
import { request } from '../apps/client/src/api';
import { inboxStartupView, prepareRecentMessages, type InboxStartupProgress } from '../apps/client/src/inbox-startup-progress';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

test('download progress counts decoded UTF-8 bytes across chunks, even when a proxy compresses the body', async () => {
  const text = JSON.stringify({ text: '猫🙂 café' }), bytes = new TextEncoder().encode(text), seen: DownloadProgress[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'X-Nova-Body-Bytes': String(bytes.length), 'Content-Encoding': 'gzip', 'Content-Length': '10' } });
  const reading = readDownload(response, value => seen.push(value));
  controller.enqueue(bytes.slice(0, 11)); await settle();
  assert.equal(seen.at(-1)?.loadedBytes, 11); assert.equal(seen.at(-1)?.totalBytes, bytes.length);
  controller.enqueue(bytes.slice(11, 15)); await settle(); assert.equal(seen.at(-1)?.loadedBytes, 15);
  controller.enqueue(bytes.slice(15)); controller.close();
  assert.deepEqual(await reading, { text, loadedBytes: bytes.length });
  assert.equal(downloadPercent(seen.at(-1)), 99); // Validation, not byte receipt alone, completes the request.
  assert(seen.every(value => !value.complete));
});

test('missing, malformed, compressed-only and undersized totals never invent a download percentage', async () => {
  for (const headers of [{}, { 'Content-Length': '2', 'Content-Encoding': 'gzip' }, { 'X-Nova-Body-Bytes': '-1' }, { 'X-Nova-Body-Bytes': '2' }]) {
    const seen: DownloadProgress[] = [];
    const received = await readDownload(new Response('four', { headers: headers as HeadersInit }), progress => seen.push(progress));
    assert.equal(received.loadedBytes, 4); assert.equal(downloadPercent(seen.at(-1)), undefined);
  }
  const seen: DownloadProgress[] = [];
  await readDownload(new Response('four', { headers: { 'Content-Length': '4' } }), progress => seen.push(progress));
  assert.equal(seen.at(-1)?.totalBytes, 4);
});

test('failed streams retain received-byte evidence without claiming completion', async () => {
  const seen: DownloadProgress[] = []; let controller!: ReadableStreamDefaultController<Uint8Array>;
  const reading = readDownload(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'X-Nova-Body-Bytes': '10' } }), progress => seen.push(progress));
  controller.enqueue(new Uint8Array(3)); await settle(); controller.error(Error('Disconnected'));
  await assert.rejects(reading, /Disconnected/); assert.equal(seen.at(-1)?.loadedBytes, 3); assert.equal(downloadPercent(seen.at(-1)), 30);
});

test('the real API marks 100% only after valid JSON and marks a conditional reuse as cached', async () => {
  const original = globalThis.fetch, seen: DownloadProgress[] = [], tag = '"e3-' + 'a'.repeat(64) + '"';
  try {
    globalThis.fetch = async () => new Response('{"text":"🙂"}', { headers: { ETag: tag, 'X-Nova-Body-Bytes': '15' } });
    assert.deepEqual(await request('snapshot', undefined, undefined, 12000, p => seen.push(p)), { text: '🙂' });
    assert.equal(seen.at(-1)?.complete, true); assert.equal(downloadPercent(seen.at(-1)), 100);
    globalThis.fetch = async () => new Response(null, { status: 304, headers: { ETag: tag } });
    await request('snapshot', undefined, undefined, 12000, p => seen.push(p));
    assert.deepEqual(seen.at(-1), { loadedBytes: 0, totalBytes: 0, complete: true, cached: true });
    const malformed: DownloadProgress[] = [];
    globalThis.fetch = async () => new Response('{bad', { headers: { 'X-Nova-Body-Bytes': '4' } });
    await assert.rejects(request('invalid-progress-fixture', undefined, undefined, 12000, p => malformed.push(p)));
    assert(malformed.every(p => !p.complete));
  } finally { globalThis.fetch = original; }
});

test('Inbox percentage counts completed work while two real message preparations run concurrently', async () => {
  const pending = [deferred<void>(), deferred<void>(), deferred<void>()], started: number[] = [], seen: InboxStartupProgress[] = [];
  const work = prepareRecentMessages([0, 1, 2], async index => { started.push(index); await pending[index].promise; }, progress => seen.push(progress));
  assert.deepEqual(started, [0, 1]); assert.equal(seen.at(-1)?.completed, 0);
  pending[1].resolve(); await settle(); assert.deepEqual(started, [0, 1, 2]); assert.equal(seen.at(-1)?.completed, 1);
  assert.equal(inboxStartupView(seen.at(-1)!).percent, 33);
  pending[0].resolve(); await settle(); assert.equal(seen.at(-1)?.completed, 2);
  pending[2].resolve(); await work; assert.equal(seen.at(-1)?.completed, 3);
  assert.equal(inboxStartupView(seen.at(-1)!).percent, 100);
});

test('an invalidated Inbox scope rejects preparation without inventing completed messages', async () => {
  const seen: InboxStartupProgress[] = [];
  await assert.rejects(prepareRecentMessages([0], async () => { throw Error('Scope changed'); }, progress => seen.push(progress)), /Scope changed/);
  assert.equal(seen.at(-1)?.completed, 0);
  assert.equal(inboxStartupView({ phase: 'accounts', completed: 0 }).percent, undefined);
});
