import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store';
import { createLynxAppearance } from '../packages/domain/lynx-appearance';
import { blankRecord, type AgentDesign as Agent } from '../packages/domain/workspace-records';
import { createPortraitRecipe } from '../apps/client/src/nova/lynx-portrait/recipe';

test('one saved 3D appearance survives host restart, profile/agent projection and a replayed save', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-lynx-appearance-'));
  let store = new Store(directory);
  try {
    const legacy = { ...blankRecord('agent', 'UTC') as Agent, name: 'Original', position: 'Reviewer', appearance: { ...createPortraitRecipe('james-original') } };
    store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'agent', entityId: 'agent:original', expectedRevision: 0, payload: legacy });
    const originalSaved = store.readEntity('agent', 'agent:original')?.value;
    const appearance = { ...createLynxAppearance(), body: 'plush', furColor: '#647788', outerwear: 'field-jacket', ears: 'short' };
    const agent = { ...blankRecord('agent', 'UTC') as Agent, name: 'Lynx fixture', position: 'Artist', appearance };
    const command = { requestId: randomUUID(), epoch: store.epoch, kind: 'agent' as const, entityId: 'agent:lynx', expectedRevision: 0, payload: agent };
    const receipt = store.mutate('owner', command);
    store.mutate('owner', { requestId: randomUUID(), epoch: store.epoch, kind: 'profile', entityId: 'profile:owner', expectedRevision: 0, payload: { name: 'Owner fixture', position: 'Creator', about: '', appearance } });
    store.close(); store = new Store(directory);
    assert.deepEqual(store.mutate('owner', command), receipt);
    assert.deepEqual(store.readEntity('agent', 'agent:lynx')?.value.appearance, appearance);
    assert.deepEqual(store.readEntity('profile', 'profile:owner')?.value.appearance, appearance);
    assert.deepEqual(store.readEntity('agent', 'agent:original')?.value, originalSaved);
    assert.equal(store.recordHistory({ kind: 'agent', id: 'agent:lynx' }).versions.length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
