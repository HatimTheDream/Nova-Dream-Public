import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import type { Command } from '../packages/domain/contracts.js';
import { blankRecord, type AgentDesign, type PersonalProfile } from '../packages/domain/workspace-records.js';
import { createSquareLynxAppearance } from '../packages/domain/square-lynx.js';
import {
  createMascotAppearance, defaultMascotAppearance, editableMascotAppearance, resolveMascotAppearance,
} from '../packages/domain/mascot-appearance.js';

test('saved mascot recipes survive Store restart and old portraits change only after an explicit appearance save', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-mascot-'));
  let store = new Store(directory);
  const save = (kind: 'agent' | 'profile', entityId: string, payload: AgentDesign | PersonalProfile, expectedRevision = 0) => {
    const command: Command = { kind, entityId, payload, expectedRevision, requestId: randomUUID(), epoch: store.epoch };
    return store.mutate('owner', command);
  };
  const restart = () => { store.close(); store = new Store(directory); };
  try {
    const newAppearance = createMascotAppearance({
      ...defaultMascotAppearance, face: 'curious', pattern: 'rosettes', outfit: 'cardigan', glasses: 'browline',
      fur: '#aabbcc', markings: '#123456', eyes: '#fedcba', clothing: '#445566', accent: '#aaccff',
    });
    const newAgent = { ...blankRecord('agent', 'UTC'), name: 'New mascot', position: 'Designer', appearance: newAppearance } as AgentDesign;
    const oldAppearance = { schemaVersion: 1, catalogRevision: 'nova-square-lynx-1', avatarId: 'spots-teal-collar' };
    const oldAgent = { ...blankRecord('agent', 'UTC'), name: 'Original mascot', position: 'Researcher', appearance: oldAppearance } as AgentDesign;
    const profile: PersonalProfile = { name: 'Owner', position: 'Designer', about: '', appearance: createSquareLynxAppearance('blaze-purple-soft-collar') };
    save('agent', 'agent:new-mascot', newAgent);
    save('agent', 'agent:original-mascot', oldAgent);
    save('profile', 'profile:owner', profile);

    // Opening the creator produces editable data without a migration write.
    editableMascotAppearance(store.readEntity('agent', 'agent:original-mascot')?.value.appearance);
    editableMascotAppearance(store.readEntity('profile', 'profile:owner')?.value.appearance);
    save('profile', 'profile:owner', { ...profile, name: 'Renamed owner' }, 1);
    restart();
    assert.deepEqual(store.readEntity('agent', 'agent:new-mascot')?.value, newAgent);
    assert.equal(resolveMascotAppearance(store.readEntity('agent', 'agent:new-mascot')?.value.appearance).status, 'ready');
    assert.deepEqual(store.readEntity('agent', 'agent:original-mascot')?.value, oldAgent);
    assert.deepEqual(store.readEntity('profile', 'profile:owner')?.value.appearance, profile.appearance);
    assert.equal(store.recordHistory({ kind: 'agent', id: 'agent:original-mascot' }).versions.length, 1);

    const chosen = createMascotAppearance({ ...editableMascotAppearance(profile.appearance), glasses: 'round', fur: '#ffddbb' });
    const updatedProfile = { ...profile, name: 'Renamed owner', appearance: chosen };
    save('profile', 'profile:owner', updatedProfile, 2);
    restart();
    assert.deepEqual(store.readEntity('profile', 'profile:owner')?.value, updatedProfile);
    assert.equal(resolveMascotAppearance(store.readEntity('profile', 'profile:owner')?.value.appearance).status, 'ready');
    assert.deepEqual(store.readEntity('agent', 'agent:original-mascot')?.value.appearance, oldAppearance);
    assert.deepEqual(store.readEntity('agent', 'agent:new-mascot')?.value.appearance, newAppearance);
    const history = store.recordHistory({ kind: 'profile', id: 'profile:owner' }).versions;
    const originalRevision = history.find(version => version.revision === 1);
    const newRevision = history.find(version => version.revision === 3);
    assert.ok(originalRevision && 'appearance' in originalRevision.value);
    assert.ok(newRevision && 'appearance' in newRevision.value);
    assert.deepEqual(originalRevision.value.appearance, profile.appearance);
    assert.deepEqual(newRevision.value.appearance, chosen);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
