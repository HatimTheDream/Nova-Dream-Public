import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/service/http.js';
import { canonical } from '../packages/domain/contracts.js';

test('authenticated setup receipt and close routes fence a delayed runtime POST without starting native work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-setup-http-'));
  const service = await startServer({ directory, port: 0 });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = await fetch(`${service.origin}/api/session`, { method: 'POST', headers: { 'X-Edition3-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  const input = { requestId: randomUUID(), epoch: service.store.epoch };
  const original = { ...input, kind: 'runtime-start', sha256: createHash('sha256').update(canonical(input)).digest('hex') };
  const path = `${service.origin}/api/assistant/setup-request?${new URLSearchParams(original)}`;
  assert.equal((await fetch(path)).status, 401);
  const before = await fetch(path, { headers: { Cookie: cookie } }); assert.equal(before.status, 200);
  assert.equal((await before.json()).state, 'not-found');
  const command = { requestId: randomUUID(), epoch: input.epoch, original, revision: 0 };
  const closed = await fetch(`${service.origin}/api/assistant/setup-request/close`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  });
  assert.equal(closed.status, 200); assert.equal((await closed.json()).state, 'closed');
  const start = t.mock.method(service.runtime!, 'start', async () => assert.fail('A fenced original cannot start a runtime'));
  const late = await fetch(`${service.origin}/api/assistant/runtime/start`, {
    method: 'POST', headers: { Cookie: cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(late.status, 202); assert.equal((await late.json()).setupRequest.state, 'closed');
  assert.equal(start.mock.callCount(), 0);
  const result = await (await fetch(path, { headers: { Cookie: cookie } })).json();
  assert.equal(result.closedFrom, 'not-found'); assert.equal(result.requestId, input.requestId);
});
