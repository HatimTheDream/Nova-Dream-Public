import assert from 'node:assert/strict';
import test from 'node:test';

test('browser requests keep the loaded document identity and notify on update rejection without changing the proposal', async () => {
  const meta = { content: 'a'.repeat(64) }, events: string[] = [], calls: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => meta } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => events.push(event.type) } });
  globalThis.fetch = async (_url, options) => { calls.push(options!); return new Response(JSON.stringify({ code: 'client_update', message: 'Reload this window.' }), { status: 409 }); };
  try {
    const { request, ApiError, apiFailure } = await import('../apps/client/src/api');
    meta.content = 'b'.repeat(64);
    const proposal = { requestId: 'original', payload: { title: 'My retained writing' } };
    await assert.rejects(request('commands', proposal), e => e instanceof ApiError && e.code === 'client_update');
    assert.equal(calls.length, 1); assert.equal(calls[0].body, JSON.stringify(proposal));
    assert.equal((calls[0].headers as Record<string, string>)['X-Edition3-Candidate'], 'a'.repeat(64));
    await assert.rejects(request('snapshot'), /Reload/);
    assert.equal((calls[1].headers as Record<string, string>)['X-Edition3-Candidate'], 'a'.repeat(64));
    // Stop/End still reach the service after detecting the update.
    globalThis.fetch = async (_url, options) => { calls.push(options!); return new Response('{"state":"ended"}'); };
    assert.deepEqual(await request('assistant/voice/end', { requestId: 'end-original' }), { state: 'ended' });
    apiFailure({ code: 'phone_pair_required', message: 'Pair again' }, 401);
    assert.deepEqual(events, ['e3:update-required', 'e3:update-required', 'e3:pair-required']);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'document'); Reflect.deleteProperty(globalThis, 'window');
  }
});
