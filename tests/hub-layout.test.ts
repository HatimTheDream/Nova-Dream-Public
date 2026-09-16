import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AgentHub } from '../apps/service/agent-hub.js';
import type { AssignmentService } from '../apps/service/assignments.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { hubLayoutKey, roomTemplates, type HubLayout } from '../packages/domain/hub-layout.js';

function fixture(run: (f: ReturnType<typeof setup>) => void) { const f = setup(); try { run(f); } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); } }
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'e3-expandable-hub-')), store = new Store(directory), device = store.session().deviceId;
  const hub = new AgentHub(store, {} as AssignmentService);
  const layout = () => store.internalRead<HubLayout>(hubLayoutKey)!;
  const createCommand = (name = 'Helper') => ({ requestId: randomUUID(), epoch: store.epoch, kind: 'agent' as const, entityId: `agent:${randomUUID()}`, expectedRevision: 0, payload: { ...blankRecord('agent', 'UTC'), name, position: 'Planner' } });
  const add = (name?: string) => store.mutate(device, createCommand(name));
  const change = (action: unknown, expectedRevision = layout().revision, requestId = randomUUID()) => hub.changeLayout(device, { requestId, epoch: store.epoch, expectedRevision, action });
  return { directory, store, device, hub, layout, add, change, createCommand };
}
test('adding agents balances the office grid while preserving identities, furnishings and desks', () => fixture(f => {
  const first = f.add('First'), second = f.add('Second'), before = f.layout();
  assert.equal(before.rooms.length, 4);
  const third = f.add('Third'), after = f.layout();
  assert.equal(after.rooms.length, 5);
  assert.deepEqual(after.rooms.slice(0,4).map(({x,y,entry,...r})=>r),before.rooms.map(({x,y,entry,...r})=>r));
  assert.deepEqual(after.placements[first.id], before.placements[first.id]);
  assert.deepEqual(after.placements[second.id], before.placements[second.id]);
  assert.notEqual(after.placements[third.id].roomId, before.placements[first.id].roomId);
  for (let i = 0; i < 47; i++) f.add(`Member ${i}`);
  const final = f.layout();
  assert.equal(Object.keys(final.placements).length, 50);
  assert.equal(new Set(Object.values(final.placements).map(p => `${p.roomId}/${p.desk}`)).size, 50);
  assert.deepEqual(final.rooms.slice(0,5).map(({x,y,entry,...r})=>r),after.rooms.map(({x,y,entry,...r})=>r));
  for (const a of final.rooms) for (const b of final.rooms) if (a.id !== b.id) {
    const t = roomTemplates[a.template], u = roomTemplates[b.template];
    assert.ok(a.x + t.width <= b.x || b.x + u.width <= a.x || a.y + t.height <= b.y || b.y + u.height <= a.y);
  }
}));
test('agent save receipt replays without adding rooms and saved placement survives restart', () => fixture(f => {
  const cmd = f.createCommand('Retained');
  const saved = f.store.mutate(f.device, cmd), before = f.layout();
  assert.deepEqual(f.store.mutate(f.device, cmd), saved);
  assert.deepEqual(f.layout(), before);
  const reopened = new Store(f.directory);
  try { assert.deepEqual(reopened.internalRead(hubLayoutKey), before); }
  finally { reopened.close(); }
}));
test('archiving frees a desk without deleting the room; restoring does not displace its new occupant', () => fixture(f => {
  const first = f.add('First'), second = f.add('Second'), original = f.layout();
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: first.id, expectedRevision: 1, payload: { ...(first.value as object), archived: true } });
  assert.deepEqual(f.layout().rooms, original.rooms);
  assert.equal(f.layout().placements[first.id], undefined);
  const replacement = f.add('Replacement');
  assert.deepEqual(f.layout().placements[replacement.id], original.placements[first.id]);
  f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'agent', entityId: first.id, expectedRevision: 2, payload: first.value });
  assert.deepEqual(f.layout().placements[replacement.id], original.placements[first.id]);
  assert.deepEqual(f.layout().placements[second.id], original.placements[second.id]);
  assert.notDeepEqual(f.layout().placements[first.id], original.placements[first.id]);
}));
test('room commands replay the original receipt, reject stale revisions and prevent occupied-desk assignment', () => fixture(f => {
  const a = f.add('A'), b = f.add('B'), initial = f.layout();
  const command = { requestId: randomUUID(), epoch: f.store.epoch, expectedRevision: initial.revision, action: { type: 'add-room', template: 'private', name: 'Writing studio' } };
  const added = f.hub.changeLayout(f.device, command);
  assert.deepEqual(f.hub.changeLayout(f.device, command), added);
  assert.equal(f.layout().rooms.length, initial.rooms.length + 1);
  assert.throws(() => f.change({ type: 'rename-room', roomId: added.rooms.at(-1)!.id, name: 'Changed' }, initial.revision), /another window/);
  assert.throws(() => f.change({ type: 'place-agent', agentId: b.id, ...initial.placements[a.id] }), /occupied/);
  const room = added.rooms.at(-1)!;
  const moved = f.change({ type: 'place-agent', agentId: a.id, roomId: room.id, desk: 0 });
  assert.deepEqual(moved.placements[a.id], { roomId: room.id, desk: 0 });
  assert.throws(() => f.change({ type: 'place-agent', agentId: b.id, roomId: room.id, desk: 1 }), /unavailable/);
  assert.deepEqual(f.layout(), moved);
}));
test('failed agent writes cannot change the room layout', () => fixture(f => {
  const a = f.add(), before = f.layout();
  assert.throws(() => f.store.mutate(f.device, { ...f.createCommand(), entityId: a.id, expectedRevision: 0 }), /newer version/);
  assert.deepEqual(f.layout(), before);
}));
test('furnishings persist independently, reject incompatible slots and replay without moving any identity', () => fixture(f => {
  const agent=f.add('Furnished'), before=f.layout(), room=before.rooms.find(r=>r.id===before.placements[agent.id].roomId)!;
  const id=randomUUID(), changed=f.change({type:'furnish-room',roomId:room.id,slot:'desk-0',furniture:'birch-desk'},before.revision,id);
  assert.equal(changed.rooms.find(r=>r.id===room.id)?.furniture?.['desk-0'],'birch-desk');
  assert.deepEqual(changed.placements,before.placements);
  assert.deepEqual(f.change({type:'furnish-room',roomId:room.id,slot:'desk-0',furniture:'birch-desk'},before.revision,id),changed);
  assert.throws(()=>f.change({type:'furnish-room',roomId:room.id,slot:'desk-0',furniture:'sage-sofa'}),/fits this location/);
  assert.throws(()=>f.change({type:'furnish-room',roomId:room.id,slot:'missing',furniture:'plant'}),/fits this location/);
  const reopened=new Store(f.directory);try{assert.deepEqual(reopened.internalRead(hubLayoutKey),changed);}finally{reopened.close();}
}));
