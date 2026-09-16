import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../apps/client/src/api.js';
const tag = '"e3-' + 'a'.repeat(64) + '"';
test('browser reads handle actual conditional HTTP responses, clear on reconnect and never serve saved data after denial', async () => {
  const original = globalThis.fetch; let mode: 'first' | 'unchanged' | 'denied' = 'first', sent: Headers[] = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(new Headers(init?.headers));
    if (init?.method === 'POST') return new Response('{}');
    if (mode === 'denied') return new Response('{"code":"web_owner_required","message":"Sign in"}', { status: 403 });
    return mode === 'first' ? new Response('{"value":"retained"}', { headers: { ETag: tag } }) : new Response(null, { status: 304, headers: { ETag: tag } });
  };
  try {
    await request('session', {});
    assert.deepEqual(await request('snapshot'), { value: 'retained' });
    mode = 'unchanged'; assert.deepEqual(await request('snapshot'), { value: 'retained' });
    assert.equal(sent.at(-1)?.get('if-none-match'), tag);
    mode = 'denied'; await assert.rejects(request('snapshot'), /Sign in/);
    mode = 'first'; await request('snapshot'); assert.equal(sent.at(-1)?.has('if-none-match'), false);
    await request('session', {}); await request('snapshot'); assert.equal(sent.at(-1)?.has('if-none-match'), false);
  } finally { globalThis.fetch = original; }
});
