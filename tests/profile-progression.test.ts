import { agentMayUse } from '../packages/domain/agent-capabilities';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store';
import { startServer } from '../apps/service/http';
import { buildProfileProgress, levelForXp, progressForXp, questPeriod, xpRequiredForLevel, type QuestDraft } from '../packages/domain/profile-progression';
import type { Entity, Task } from '../packages/domain/contracts';
import type { TaskEvent } from '../packages/domain/tasks';
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'e3-profile-')); let now = Date.parse('2026-09-14T18:00:00Z'); let store = new Store(dir, () => now);
  const envelope = () => ({ requestId: randomUUID(), epoch: store.epoch });
  const save = (quest: QuestDraft, expectedRevision = 0) => store.saveQuest('owner', { ...envelope(), action: 'save', quest, expectedRevision });
  const task = (title: string) => store.mutate('owner', { ...envelope(), kind: 'task', entityId: `task:${randomUUID()}`, expectedRevision: 0, payload: { title, notes: '', status: 'open', planned: '', due: '' } }) as Entity<Task>;
  const change = (id: string, patch: Partial<Task>) => { const old = store.readEntity('task', id)!; return store.mutate('owner', { ...envelope(), kind: 'task', entityId: id, expectedRevision: old.revision, payload: { ...old.value, ...patch } }) as Entity<Task>; };
  return { dir, get store() { return store; }, envelope, save, task, change, time(value: string) { now = Date.parse(value); }, restart() { store.close(); store = new Store(dir, () => now); }, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function draft(): QuestDraft { return { id: randomUUID(), title: 'Build a reading habit', description: 'One chapter at a time.', projectId: null, due: '2026-09-21', steps: [{ id: randomUUID(), taskId: null, title: 'Choose a book' }, { id: randomUUID(), taskId: null, title: 'Read a chapter' }] }; }
test('original level curve has exact boundaries and no loss or premature level-up', () => {
  for (const level of [1, 2, 3, 6, 7, 20, 1000]) { const threshold = xpRequiredForLevel(level); assert.equal(levelForXp(threshold), level); if (threshold) assert.equal(levelForXp(threshold - 1), level - 1); }
  assert.equal(progressForXp(0).progressPct, 0); assert.equal(progressForXp(140).currentLevelXp, 140); assert.equal(levelForXp(-5), 1);
});
test('daily and Monday weekly quests follow workspace civil dates across DST and year boundary', () => {
  assert.deepEqual(questPeriod('daily', 'America/Los_Angeles', Date.parse('2026-03-08T07:59:59Z')), { start: '2026-03-07', end: '2026-03-08' });
  assert.deepEqual(questPeriod('weekly', 'America/Los_Angeles', Date.parse('2026-03-09T07:01:00Z')), { start: '2026-03-09', end: '2026-03-16' });
  assert.deepEqual(questPeriod('weekly', 'Asia/Tokyo', Date.parse('2026-01-01T00:00:00Z')), { start: '2025-12-29', end: '2026-01-05' });
  assert.deepEqual(questPeriod('daily', 'America/Los_Angeles', Date.parse('2026-11-01T09:30:00Z')), { start: '2026-11-01', end: '2026-11-02' });
});
test('quest saves atomically create canonical Tasks; receipts, edits and restart never duplicate work or XP', () => {
  const f = setup(); try {
    const input = { ...f.envelope(), action: 'save', quest: draft(), expectedRevision: 0 };
    const q = f.store.saveQuest('owner', input); assert.deepEqual(f.store.saveQuest('owner', input), q);
    assert.equal(f.store.snapshot('owner').tasks.length, 2); assert.equal(f.store.profileProgress().earnedXp, 0);
    assert.equal(f.store.readEntity('task', q.steps[0].taskId)!.value.due, '');
    assert.throws(() => f.store.saveQuest('someone-else', input), /different work/);
    assert.throws(() => f.store.saveQuest('owner', { ...input, quest: { ...input.quest, title: 'Other' } }), /different work/);
    f.restart(); assert.deepEqual(f.store.saveQuest('owner', input), q); assert.equal(f.store.profileProgress().personalQuests[0].title, input.quest.title);
    const linked = { ...input.quest, steps: q.steps.map(s => ({ ...s, title: '' })) };
    f.save({ ...linked, title: 'New title' }, 1); assert.equal(f.store.snapshot('owner').tasks.length, 2);
    assert.throws(() => f.save(linked, 1), /another window/);
  } finally { f.close(); }
});
test('invalid later links roll back every earlier new step and reject duplicate links and forged step identities', () => {
  const f = setup(); try {
    const q = draft(); q.steps[1].taskId = 'task:missing'; assert.throws(() => f.save(q), /available Task/);
    assert.equal(f.store.snapshot('owner').tasks.length, 0); assert.equal(f.store.profileProgress().personalQuests.length, 0);
    const t = f.task('Existing'); const dup = draft(); dup.steps = dup.steps.map(s => ({ ...s, taskId: t.id })); assert.throws(() => f.save(dup), /only once/);
    const good = f.save(draft()); const proposal = { ...draft(), id: good.id, steps: good.steps.map(s => ({ ...s, title: '' })) }; proposal.steps[0].taskId = t.id;
    assert.throws(() => f.save(proposal, 1), /Remove the old step/);
    assert.throws(() => f.save({ ...draft(), projectId: 'project:missing' }), /available Project/);
  } finally { f.close(); }
});
test('task completion, checklist correction, Trash and quest archive retain one shared reward ledger', () => {
  const f = setup(); try {
    const q = f.save(draft()); f.change(q.steps[0].taskId, { status: 'done' });
    assert.equal(f.store.profileProgress().personalQuests[0].progress, 1); assert.equal(f.store.profileProgress().earnedXp, 10);
    f.change(q.steps[1].taskId, { checklist: [{ id: randomUUID(), text: 'Read', done: true }] });
    let p = f.store.profileProgress(); assert(p.personalQuests[0].complete); assert.equal(p.earnedXp, 20); assert(p.milestones.find(m => m.id === 'pathfinder')!.earned);
    f.change(q.steps[0].taskId, { status: 'open' }); p = f.store.profileProgress(); assert(!p.personalQuests[0].complete); assert.equal(p.earnedXp, 10); assert(!p.milestones.find(m => m.id === 'pathfinder')!.earned);
    f.change(q.steps[0].taskId, { status: 'done' }); f.change(q.steps[0].taskId, { trashed: true });
    p = f.store.profileProgress(); assert.equal(p.earnedXp, 20); assert(p.personalQuests[0].complete); assert(p.personalQuests[0].stepProgress[0].trashed);
    f.store.saveQuest('owner', { ...f.envelope(), action: 'archive', id: q.id, archived: true, expectedRevision: 1 });
    p = f.store.profileProgress(); assert(p.personalQuests[0].archived); assert.equal(p.earnedXp, 20); assert(p.milestones.find(m => m.id === 'pathfinder')!.earned);
    f.store.saveQuest('owner', { ...f.envelope(), action: 'archive', id: q.id, archived: false, expectedRevision: 2 }); assert(!f.store.profileProgress().personalQuests[0].archived);
  } finally { f.close(); }
});
test('old work cannot be recycled into another daily quest; actual new occurrences count independently', () => {
  const f = setup(); try {
    const t = f.task('First work'); f.change(t.id, { status: 'done' }); assert.equal(f.store.profileProgress().quests[0].progress, 1);
    f.time('2026-09-15T18:00:00Z'); assert.equal(f.store.profileProgress().quests[0].progress, 0);
    f.change(t.id, { status: 'open' }); f.change(t.id, { status: 'done' }); assert.equal(f.store.profileProgress().quests[0].progress, 0); assert.equal(f.store.profileProgress().earnedXp, 10);
    const second = f.task('New work'); f.change(second.id, { status: 'done' }); assert.equal(f.store.profileProgress().quests[0].progress, 1); assert.equal(f.store.profileProgress().activeDays, 2);
    f.time('2026-09-20T18:00:00Z'); assert.equal(f.store.profileProgress().earnedXp, 20);
  } finally { f.close(); }
});
test('linking and removing existing Tasks preserves their writing, planning and credit', () => {
  const f = setup(); try {
    const t = f.task('Keep me'); f.change(t.id, { notes: 'Original notes', planned: '2026-09-20', status: 'done' });
    const before = f.store.readEntity('task', t.id), d = draft(); d.steps[0].taskId = t.id; const q = f.save(d);
    assert.deepEqual(f.store.readEntity('task', t.id), before); assert.equal(f.store.profileProgress().earnedXp, 10);
    f.save({ ...d, steps: [{ ...q.steps[1], title: '' }] }, 1); assert.deepEqual(f.store.readEntity('task', t.id), before); assert.equal(f.store.profileProgress().earnedXp, 10);
  } finally { f.close(); }
});
test('full ledger and paginated history remain correct beyond the snapshot event window', () => {
  const f = setup(); try {
    const t = f.task('A long history');
    for (let i = 0; i < 540; i++) f.change(t.id, { status: i % 2 ? 'open' : 'done' });
    f.change(t.id, { status: 'done' });
    const p = f.store.profileProgress(); assert.equal(p.earnedXp, 10); assert.equal(p.completedTasks, 1); assert.equal(p.history.total, 541); assert.equal(p.history.entries.length, 50);
    const ids = new Set<string>(); let page = p.history;
    for (;;) { for (const e of page.entries) { assert(!ids.has(e.id)); ids.add(e.id); } if (!page.next) break; page = f.store.profileHistory(page.next); }
    assert.equal(ids.size, 541); assert.throws(() => f.store.profileHistory('missing'), /Reload earned history/);
    const event: TaskEvent = { id: 'dedup:1', taskId: t.id, at: '2026-09-14T18:00:00Z', from: 'open', to: 'done', xpDelta: 10 };
    assert.equal(buildProfileProgress([], [event, event], [], 'UTC', Date.now(), f.store.epoch).earnedXp, 10);
  } finally { f.close(); }
});
test('profile HTTP routes require a session and origin, persist receipts, and expose confirmed quest state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3-profile-http-')); const server = await startServer({ directory: dir, port: 0, version: 'test' });
  try {
    const origin = server.origin;
    assert.equal((await fetch(origin + '/api/profile/progress')).status, 401);
    const session = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const headers = { Cookie: session.headers.get('set-cookie')!.split(';')[0], Origin: origin, 'Content-Type': 'application/json', 'X-Edition3-Client': '1' };
    const snapshot = await (await fetch(origin + '/api/snapshot', { headers })).json();
    const input = { requestId: randomUUID(), epoch: snapshot.epoch, expectedRevision: 0, action: 'save', quest: draft() };
    assert.equal((await fetch(origin + '/api/profile/quests', { method: 'POST', headers: { ...headers, Origin: 'https://invalid.example' }, body: JSON.stringify(input) })).status, 403);
    const post = () => fetch(origin + '/api/profile/quests', { method: 'POST', headers, body: JSON.stringify(input) });
    const saved = await post(); assert.equal(saved.status, 200); assert.deepEqual(await (await post()).json(), await saved.json());
    const progress = await (await fetch(origin + '/api/profile/progress', { headers })).json(); assert.equal(progress.personalQuests.length, 1); assert.equal(progress.earnedXp, 0);
    assert.equal((await fetch(origin + '/api/profile/quests', { method: 'POST', headers, body: JSON.stringify({ ...input, requestId: randomUUID(), epoch: randomUUID() }) })).status, 409);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('agent quest access requires both the pinned and current Profile and Task grants', () => {
  assert(!agentMayUse({profile:'edit'},{profile:'edit'},'profile.quests.save',{},true));
  assert(!agentMayUse({profile:'edit',tasks:'read'},{profile:'edit',tasks:'edit'},'profile.quests.save',{},true));
  assert(!agentMayUse({profile:'edit',tasks:'edit'},{profile:'edit'},'profile.progress',{},false));
  assert(agentMayUse({profile:'read',tasks:'read'},{profile:'read',tasks:'read'},'profile.progress',{},false));
  assert(agentMayUse({profile:'edit',tasks:'edit'},{profile:'edit',tasks:'edit'},'profile.quests.save',{},true));
});
