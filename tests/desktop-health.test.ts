import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/service/http';

test('the service publishes its paired build identity without exposing local workspace data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-desktop-health-'));
  const identity = { version: '0.69.0', buildVersion: '1.0.122', schemaVersion: 51, candidateId: 'a'.repeat(64) };
  const service = await startServer({ directory, port: 0, ...identity });
  try {
    const response = await fetch(service.origin + '/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { application: 'nova-dream-edition-3', apiVersion: 1, status: 'ready', ...identity });
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
