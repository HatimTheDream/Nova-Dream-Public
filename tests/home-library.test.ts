import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { HomeFeed } from '../apps/service/home-feed.js';
import { homeIdeaScope, type HomeCollection, type HomeItem, type HomeLibraryCommand, type LibraryReceipt, type HomeReference } from '../packages/domain/home-library.js';
import { isHomeLibraryReceipt } from '../packages/domain/home-library-view.js';
import type { AssistantOutput } from '../packages/domain/assistant.js';
import type { AssignmentAttempt } from '../packages/domain/assignments.js';
import type { AgentRoutine, RoutineOccurrence } from '../packages/domain/agent-routines.js';
import type { ContentReview } from '../packages/domain/content-workspace.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
function setup() { const directory = mkdtempSync(join(tmpdir(), 'nova-home-library-')), store = new Store(directory), device = store.session().deviceId, library = new HomeLibrary(store);return { directory, store, device, library, envelope: () => ({ requestId: randomUUID(), epoch: store.epoch }) }; }
function fixture(run: (f: ReturnType<typeof setup>) => void) { const f = setup();try { run(f); } finally { f.store.close();rmSync(f.directory, { recursive: true, force: true }); } }
test('mixed Library references and kept widgets survive restart; replay applies once', () => fixture(f => {
 const originalLayout = f.store.snapshot(f.device).layout;
 const noteInput = { ...f.envelope(), type: 'item-save', id: 'library:note', expectedRevision: 0, value: { kind: 'note', title: 'Priorities', body: 'Keep Thursday clear.', archived: false } } satisfies HomeLibraryCommand;
 const note = f.library.command(f.device, noteInput) as HomeItem;assert.deepEqual(f.library.command(f.device, noteInput), note);
 const project = f.store.mutate(f.device, { ...f.envelope(), kind: 'project', entityId: 'project:personal', expectedRevision: 0, payload: { name: 'Personal', purpose: 'Daily life' } });
 const command = { ...f.envelope(), type: 'collection-save', id: 'collection:week', expectedRevision: 0, value: { title: 'My Week', subtitle: 'Priorities and references', icon: 'book', pinned: true, archived: false, references: [{ kind: 'note', id: note.id, revision: 1 }, { kind: 'project', id: project.id, revision: project.revision }] } } satisfies HomeLibraryCommand;
 const saved = f.library.command(f.device, command) as HomeCollection;assert.deepEqual(f.library.command(f.device, command), saved);
 assert.equal(f.library.state(f.device).items.length, 1);assert.equal(f.library.state(f.device).collections.length, 1);
 assert.deepEqual(f.store.snapshot(f.device).layout, originalLayout);
 f.store.close();f.store = new Store(f.directory);const state = new HomeLibrary(f.store).state(f.device);assert.equal(state.collections[0].references.length, 2);assert.equal(state.items[0].body, 'Keep Thursday clear.');assert.deepEqual(f.store.snapshot(f.device).layout, originalLayout);
}));
test('source changes refuse new capture but reconcile an immutable earlier receipt', () => fixture(f => {
 const base = { ...f.envelope(), type: 'item-save', id: 'library:note', expectedRevision: 0, value: { kind: 'note', title: 'Notes', body: 'Original words', archived: false } } satisfies HomeLibraryCommand;
 f.library.command(f.device, base);const reference = { kind: 'note' as const, id: base.id, revision: 1 };
 const request = { ...f.envelope(), references: [reference] }, capture = f.library.capture(f.device, request);
 f.library.command(f.device, { ...base, ...f.envelope(), expectedRevision: 1, value: { ...base.value, body: 'New words' } });
 assert.deepEqual(f.library.capture(f.device, request), capture);assert.equal(capture.sources[0].text, 'Original words');
 assert.throws(() => f.library.capture(f.device, { ...f.envelope(), references: [reference] }), /changed/);
 assert.throws(() => f.library.command(f.device, { ...base, ...f.envelope(), value: { ...base.value, body: 'Overwrite' } }), /changed/);
 assert.equal(f.library.state(f.device).items[0].body, 'New words');
}));
test('stale collection references are kept during edits; new forged references are refused', () => fixture(f => {
 f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: 'library:note', expectedRevision: 0, value: { kind: 'note', title: 'One', body: 'Text', archived: false } });
 const value = { title: 'Sources', subtitle: '', icon: 'folder' as const, pinned: false, archived: false, references: [{ kind: 'note' as const, id: 'library:note', revision: 1 }] };
 f.library.command(f.device, { ...f.envelope(), type: 'collection-save', id: 'collection:one', expectedRevision: 0, value });
 f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: 'library:note', expectedRevision: 1, value: { kind: 'note', title: 'Two', body: 'Changed', archived: false } });
 f.library.command(f.device, { ...f.envelope(), type: 'collection-save', id: 'collection:one', expectedRevision: 1, value: { ...value, title: 'Renamed' } });
 assert.equal(f.library.state(f.device).collections[0].references[0].revision, 1);assert.equal(f.library.resolve(f.device, value.references[0]).availability, 'changed');
 assert.throws(() => f.library.command(f.device, { ...f.envelope(), type: 'collection-save', id: 'collection:fake', expectedRevision: 0, value: { ...value, references: [{ kind: 'note', id: 'missing', revision: 1 }] } }), /changed or disappeared/);
 assert.throws(() => f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: 'library:url', expectedRevision: 0, value: { kind: 'link', title: 'Unsafe', url: 'javascript:alert(1)', body: '', archived: false } }));
}));
test('Idea preferences are revisioned and shared through retained storage', () => fixture(f => {
 const input = { ...f.envelope(), type: 'preferences-save', expectedRevision: 0, value: { saved: ['plan-week'], hidden: ['draft-notes'] } } satisfies HomeLibraryCommand;
 const saved = f.library.command(f.device, input);assert.deepEqual(f.library.command(f.device, input), saved);assert.deepEqual(new HomeLibrary(f.store).state(f.device).ideaPreferences, { revision: 1, ...input.value });
 assert.throws(() => f.library.command(f.device, { ...input, ...f.envelope() }), /preferences changed/);
}));
test('Feed uses actual retained results and truthful uncertain states without dispatch', () => fixture(f => {
 const file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'result.md', Buffer.from('Complete result').toString('base64'));
 const output: AssistantOutput = { id: randomUUID(), version: 1, conversationId: randomUUID(), projectId: null, createdAt: new Date().toISOString(), nativeId: randomUUID(), messageId: 'message:one', messageHash: 'a'.repeat(64), text: 'Complete result', name: 'Saved Research', uploadRequestId: randomUUID(), file, state: 'ready' };
 f.store.internalWrite('assistant:output:' + output.id, output);
 const attempt: AssignmentAttempt = { id: randomUUID(), epoch: f.store.epoch, deviceId: f.device, assignmentId: 'assignment:one', assignmentRevision: 2, title: 'Unconfirmed Work', agentId: 'agent:one', agentRevision: 1, agentName: 'Researcher', projectId: null, createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + 60000, state: 'unknown', message: 'Connection lost; reconcile the same attempt.' };
 f.store.internalWrite('assignments:summary:' + attempt.id, attempt);
 const before = f.store.internalList('assignments:summary:'), feed = new HomeFeed(f.store).state(f.device);
 assert.equal(feed.cards.length, 2);assert.equal(feed.cards.find(c => c.id === 'assignment:' + attempt.id)?.status, 'Needs Checking');assert.equal(feed.cards.find(c => c.id.startsWith('output:'))?.references[0].sha256, file.sha256);assert.deepEqual(f.store.internalList('assignments:summary:'), before);
 const capture = f.library.capture(f.device, { ...f.envelope(), references: feed.cards.find(c => c.id.startsWith('output:'))!.references });assert.equal(capture.sources[0].text, 'Complete result');
}));
test('Home destinations reopen exact output and reviewed Content versions without writes', () => fixture(f => {
 const feed = new HomeFeed(f.store), epoch = f.store.epoch;
 const file = f.store.upload(f.device, randomUUID(), epoch, 'saved.md', Buffer.from('Exact saved output').toString('base64'));
 const output: AssistantOutput = { id: randomUUID(), version: 2, conversationId: randomUUID(), projectId: null, createdAt: new Date().toISOString(), nativeId: randomUUID(), messageId: 'message:two', messageHash: 'b'.repeat(64), text: '', name: 'Output Two', uploadRequestId: randomUUID(), file, state: 'ready' };
 f.store.internalWrite('assistant:output:' + output.id, output);
 const value = { ...blankRecord('content', 'America/Los_Angeles'), title: 'Original Draft', body: 'Reviewed words' };
 const original = f.store.mutate(f.device, { ...f.envelope(), kind: 'content', entityId: 'content:reviewed', expectedRevision: 0, payload: value });
 const review: ContentReview = { id: randomUUID(), revision: 1, contentId: original.id, sourceRevision: original.revision, reviewerId: null, reviewerName: 'You', state: 'changes', createdAt: Date.now(), updatedAt: Date.now(), comments: [{ id: randomUUID(), text: 'Clarify the conclusion.', quote: 'Reviewed words', author: 'You', at: Date.now(), resolved: false }] };
 f.store.internalWrite('content:review:' + review.id, review);
 f.store.mutate(f.device, { ...f.envelope(), kind: 'content', entityId: original.id, expectedRevision: 1, payload: { ...value, title: 'Current Draft', body: 'Current words' } });
 const before = f.store.internalList(''), cursor = f.store.entityCursor;
 const exact = feed.destination(f.device, { epoch, target: { kind: 'conversation', id: output.conversationId, outputId: output.id, outputVersion: 2, sha256: file.sha256 } });assert.match(exact.text, /Exact saved output/);assert.ok(exact.sourceDetails?.includes(output.id));assert.ok(!exact.text.includes(output.id));
 assert.equal(feed.destination(f.device, { epoch, reference: { kind: 'output', id: output.id, revision: 1, sha256: file.sha256 } }).status, 'Unavailable');
 const target = { kind: 'content', id: original.id, reviewId: review.id, reviewRevision: 1, sourceRevision: 1 };
 const old = feed.destination(f.device, { epoch, target });assert.equal(old.title, 'Original Draft');assert.equal(old.status, 'Earlier Content Version');assert.match(old.text, /Reviewed words/);assert.doesNotMatch(old.text, /Current words/);assert.match(old.text, /Clarify the conclusion/);assert.deepEqual(old.target, target);
 assert.deepEqual(f.store.internalList(''), before);assert.equal(f.store.entityCursor, cursor);
 f.store.internalWrite('content:review:' + review.id, { ...review, revision: 2, comments: [] });
 const updated = feed.destination(f.device, { epoch, target });assert.equal(updated.status, 'Review Updated');assert.match(updated.text, /Earlier review comments are unavailable/);
 assert.throws(() => feed.destination(f.device, { epoch: randomUUID(), target }), /workspace changed/);
 assert.throws(() => feed.destination(f.device, { epoch, target: { kind: 'content', id: '../private' } }));
}));
test('Home resolves retained routine occurrences beyond loaded pages and original note versions', () => fixture(f => {
 const feed = new HomeFeed(f.store), epoch = f.store.epoch, at = Date.now();
 const routine: AgentRoutine = { id: randomUUID(), revision: 2, epoch, deviceId: f.device, updatedAt: at, agentId: 'agent:one', nextAt: null, attention: null, value: { name: 'Current Routine', assignmentId: 'assignment:one', assignmentRevision: 1, projectRevision: null, schedule: { kind: 'every', minutes: 60, anchor: new Date(at).toISOString() }, timezone: 'America/Los_Angeles', missed: 'review', enabled: false, archived: false } };
 f.store.internalWrite('agent-routines:item:' + routine.id, routine);f.store.internalWrite(`agent-routines:revision:${routine.id}:00000001`, { ...routine, revision: 1, value: { ...routine.value, name: 'Original Routine' } });
 const occurrence: RoutineOccurrence = { id: randomUUID(), routineId: routine.id, routineRevision: 1, scheduledAt: at - 86400000, recordedAt: at - 86400000, state: 'review', message: 'The host missed this run. No work started.' };
 const suffix = 'old-page:' + occurrence.id;f.store.internalWrite('agent-routines:history:all:' + suffix, occurrence);f.store.internalWrite('agent-routines:cursor:' + occurrence.id, { suffix, routineId: routine.id });
 const result = feed.destination(f.device, { epoch, target: { kind: 'routine', id: routine.id, occurrenceId: occurrence.id } });assert.equal(result.title, 'Original Routine');assert.equal(result.status, 'Needs Review');assert.match(result.text, /No work started/);assert.equal(result.links[0].occurrenceId, occurrence.id);
 const note = { type: 'item-save', id: 'library:history', expectedRevision: 0, value: { kind: 'note', title: 'Old Note', body: 'Old text', archived: false } } as const;
 f.library.command(f.device, { ...f.envelope(), ...note });f.library.command(f.device, { ...f.envelope(), ...note, expectedRevision: 1, value: { ...note.value, title: 'New Note', body: 'New text' } });
 const old = feed.destination(f.device, { epoch, reference: { kind: 'note', id: note.id, revision: 1 } });assert.equal(old.title, 'Old Note');assert.equal(old.status, 'Earlier Saved Version');assert.match(old.text, /Old text/);assert.doesNotMatch(old.text, /New text/);
}));
test('Ideas keep Project space and reject a selected Task moved out of scope', () => fixture(f => {
 const chat = f.store.mutate(f.device, { ...f.envelope(), kind: 'project', entityId: 'project:chat', expectedRevision: 0, payload: { name: 'Personal Planning', purpose: '', space: 'chat' } });
 const work = f.store.mutate(f.device, { ...f.envelope(), kind: 'project', entityId: 'project:work', expectedRevision: 0, payload: { name: 'Work Research', purpose: '', space: 'work' } });
 const task = f.store.mutate(f.device, { ...f.envelope(), kind: 'task', entityId: 'task:planning', expectedRevision: 0, payload: { title: 'Choose A Focus', notes: '', status: 'open', planned: '', due: '', projectId: chat.id } });
 const planning = homeIdeaScope(f.store.snapshot(f.device), chat.id, [task.id], 'plan');assert.equal(planning.space, 'chat');assert.equal(planning.projectId, chat.id);assert.equal(planning.workMode, 'plan');
 const research = homeIdeaScope(f.store.snapshot(f.device), work.id, [], 'research');assert.equal(research.space, 'work');assert.equal(research.projectId, work.id);assert.equal(research.workMode, 'research');
 f.store.mutate(f.device, { ...f.envelope(), kind: 'task', entityId: task.id, expectedRevision: task.revision, payload: { ...f.store.readEntity('task', task.id)!.value, projectId: work.id } });
 assert.throws(() => homeIdeaScope(f.store.snapshot(f.device), chat.id, [task.id], 'plan'), /moved to another Project/);
 assert.throws(() => homeIdeaScope(f.store.snapshot(f.device), 'project:missing', [], 'research'), /Project is unavailable/);
}));

type Fixture = ReturnType<typeof setup>;
const collection = (f: Fixture, id: string, references: HomeReference[] = []) => f.library.command(f.device, {
 ...f.envelope(), type: 'collection-save', id, expectedRevision: 0,
 value: { title: id, subtitle: '', icon: 'folder', pinned: false, archived: false, references },
}) as HomeCollection;
const note = (f: Fixture, id: string, body = 'Kept writing') => f.library.command(f.device, {
 ...f.envelope(), type: 'item-save', id, expectedRevision: 0, value: { kind: 'note', title: id, body, archived: false },
}) as HomeItem;
const ref = (item: HomeItem): HomeReference => ({ kind: item.kind, id: item.id, revision: item.revision });
const guard = (row: HomeCollection) => ({ id: row.id, expectedRevision: row.revision });
const receipt = (f: Fixture, input: HomeLibraryCommand, device = f.device) => {
 const result = f.library.command(device, input) as LibraryReceipt;
 assert.equal(isHomeLibraryReceipt(result), true, 'actual service response satisfies the client acknowledgement contract');
 return result;
};
const currentCollection = (f: Fixture, id: string) => f.library.state(f.device).collections.find(c => c.id === id)!;
const undo = (f: Fixture, result: LibraryReceipt) => ({ ...f.envelope(), type: 'library-undo' as const, ...result.undo! });

test('legacy order reads do not migrate; first successful old-client mutation seeds stable order', () => fixture(f => {
 const at = '2026-01-01T00:00:00.000Z';
 for (const id of ['collection:b', 'collection:a']) f.store.internalWrite('home:library:collection:' + id, { id, revision: 1, updatedAt: at, title: id, subtitle: '', icon: 'book', pinned: false, archived: false, references: [] });
 const before = f.store.internalList('home:library:');
 assert.deepEqual(f.library.state(f.device).organization, { revision: 0, collectionIds: ['collection:a', 'collection:b'] });
 assert.deepEqual(f.store.internalList('home:library:'), before, 'GET does not create organization state');
 const a = currentCollection(f, 'collection:a');
 const input = { ...f.envelope(), type: 'collection-save', id: a.id, expectedRevision: 99, value: { title: 'Renamed', subtitle: '', icon: a.icon, pinned: true, archived: true, references: [] } } satisfies HomeLibraryCommand;
 assert.throws(() => f.library.command(f.device, input), /changed/);
 assert.equal(f.store.internalRead('home:library:organization'), undefined);
 f.library.command(f.device, { ...input, ...f.envelope(), expectedRevision: 1 });
 assert.deepEqual(f.library.state(f.device).organization, { revision: 1, collectionIds: ['collection:a', 'collection:b'] });
 collection(f, 'collection:c');
 assert.deepEqual(f.library.state(f.device).organization, { revision: 2, collectionIds: ['collection:a', 'collection:b', 'collection:c'] });
}));

test('atomic capture deduplicates exact saved URLs, preserves URL semantics and replays once', () => fixture(f => {
 const target = collection(f, 'collection:links');
 const row = (id: string, url: string) => ({ rowId: id, id, value: { kind: 'link' as const, title: id, url, body: 'Annotation', archived: false } });
 const input = { ...f.envelope(), type: 'items-capture', destination: guard(target), rows: [row('link:one', 'https://EXAMPLE.com/a?q=1&x=2#keep'), row('link:two', 'https://example.com/a?q=1&x=2#keep'), row('link:three', 'http://example.com/a?q=1&x=2#keep')] } satisfies HomeLibraryCommand;
 const saved = receipt(f, input);
 assert.deepEqual(saved.outcomes.map(o => o.disposition), ['created-and-added', 'duplicate-in-batch', 'created-and-added']);
 assert.equal(saved.createdItems.length, 2); assert.equal(saved.collections[0].references.length, 2);
 assert.equal(saved.createdItems[0].kind === 'link' && saved.createdItems[0].url, 'https://example.com/a?q=1&x=2#keep');
 assert.deepEqual(receipt(f, input), saved);
 const link = saved.createdItems[0];
 f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: link.id, expectedRevision: 1, value: { kind: 'link', title: 'New address', url: 'https://example.com/new', body: '', archived: false } });
 assert.equal(f.library.resolve(f.device, ref(link)).url, 'https://example.com/a?q=1&x=2#keep');
 assert.equal(f.library.resolve(f.device, ref(link)).availability, 'changed');
 const duplicates = receipt(f, { ...f.envelope(), type: 'items-capture', destination: guard(saved.collections[0]), rows: [row('link:four', 'https://example.com/a?q=1&x=2#keep')] });
 assert.equal(duplicates.changed, false); assert.equal(duplicates.undo, null); assert.deepEqual(duplicates.collections, []);
 assert.equal(duplicates.outcomes[0].disposition, 'already-in-destination'); assert.equal(f.library.state(f.device).items.length, 2);
 assert.deepEqual(receipt(f, input), saved, 'a late replay stays the original historical result');
 assert.throws(() => receipt(f, { ...input, rows: [row('link:changed', 'https://example.com')] }), /already used/);
}));

test('capture rollback covers all writes, item IDs, current quotas and stale destination', () => fixture(f => {
 const target = collection(f, 'collection:atomic');
 const rows = ['note:first', 'note:second'].map(id => ({ rowId: id, id, value: { kind: 'note' as const, title: id, body: 'Exact text', archived: false } }));
 const input = { ...f.envelope(), type: 'items-capture', destination: guard(target), rows } satisfies HomeLibraryCommand;
 const before = f.store.internalList('home:library:');
 const write = f.store.internalWrite.bind(f.store); let writes = 0;
 f.store.internalWrite = ((id: string, value: unknown) => { if (++writes === 3) throw Error('Injected failed persistence'); return write(id, value); }) as typeof f.store.internalWrite;
 try { assert.throws(() => receipt(f, input), /failed persistence/); } finally { f.store.internalWrite = write; }
 assert.deepEqual(f.store.internalList('home:library:'), before, 'even earlier history/item writes roll back');
 const saved = receipt(f, input); assert.equal(saved.createdItems.length, 2, 'failed transaction did not consume request');
 assert.throws(() => receipt(f, { ...input, ...f.envelope() }), /changed/);
 assert.throws(() => receipt(f, { ...input, ...f.envelope(), destination: guard(saved.collections[0]) }), /identity already exists/);
 const beforeQuota = f.store.internalList('home:library:');
 for (let index = 0; index < 20; index++) f.store.internalWrite('home:library:item:large:' + index, { id: 'large:' + index, kind: 'note', revision: 1, updatedAt: '', title: 'Capacity', body: 'x'.repeat(100000), archived: false });
 const atLimit = f.store.internalList('home:library:');
 assert.throws(() => receipt(f, { ...input, ...f.envelope(), destination: guard(saved.collections[0]), rows: [{ ...rows[0], id: 'new:over', rowId: 'over' }] }), /capacity/);
 assert.deepEqual(f.store.internalList('home:library:'), atLimit); assert.ok(atLimit.length > beforeQuota.length);
}));

test('missing historical links refuse dedupe without opening the newer address', () => fixture(f => {
 const current: HomeItem = { id: 'link:old', revision: 2, kind: 'link', title: 'Current', url: 'https://example.com/current', body: '', archived: false, updatedAt: '' };
 f.store.internalWrite('home:library:item:' + current.id, current);
 const old: HomeReference = { kind: 'link', id: current.id, revision: 1 };
 const target = collection(f, 'collection:empty');
 f.store.internalWrite('home:library:collection:' + target.id, { ...target, references: [old] });
 const resource = f.library.resolve(f.device, old); assert.equal(resource.availability, 'missing'); assert.equal(resource.url, undefined);
 const before = f.store.internalList('home:library:');
 assert.throws(() => receipt(f, { ...f.envelope(), type: 'items-capture', destination: guard(target), rows: [{ rowId: 'new', id: 'link:new', value: { kind: 'link', title: 'New', url: 'https://example.com/current', body: '', archived: false } }] }), /version is unavailable/);
 assert.deepEqual(f.store.internalList('home:library:'), before);
}));

test('move/copy retain stale identities; exact duplicates stay in source and version collisions are atomic', () => fixture(f => {
 const one = note(f, 'note:one'), two = note(f, 'note:two'), three = note(f, 'note:three');
 const source = collection(f, 'collection:source', [ref(one), ref(two)]), destination = collection(f, 'collection:destination', [ref(two), ref(three)]);
 f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: one.id, expectedRevision: 1, value: { kind: 'note', title: 'Updated', body: 'New text', archived: false } });
 const input = { ...f.envelope(), type: 'references-transfer', mode: 'move', source: guard(source), destination: guard(destination), references: [ref(one), ref(two)], before: ref(three) } satisfies HomeLibraryCommand;
 const moved = receipt(f, input);
 assert.deepEqual(currentCollection(f, source.id).references, [ref(two)]);
 assert.deepEqual(currentCollection(f, destination.id).references, [ref(two), ref(one), ref(three)]);
 assert.deepEqual(moved.outcomes.map(o => o.disposition), ['moved', 'already-in-destination']);
 assert.equal(f.store.internalRead<HomeItem>('home:library:item:' + one.id)!.body, 'New text');
 assert.deepEqual(receipt(f, input), moved);
 const collisionSource = collection(f, 'collection:collision', [{ ...ref(one), revision: 2 }]);
 const before = f.store.internalList('home:library:');
 assert.throws(() => receipt(f, { ...input, ...f.envelope(), source: guard(collisionSource), destination: guard(currentCollection(f, destination.id)), references: [{ ...ref(one), revision: 2 }] }), /another version/);
 assert.deepEqual(f.store.internalList('home:library:'), before);
 const copied = receipt(f, { ...f.envelope(), type: 'references-transfer', mode: 'copy', source: guard(currentCollection(f, destination.id)), destination: guard(currentCollection(f, source.id)), references: [ref(one)], before: null });
 assert.equal(copied.collections.length, 1); assert.equal(f.library.state(f.device).items.length, 3);
}));

test('transfer validates exact source, anchor, destination capacity and both revisions before writing', () => fixture(f => {
 const item = note(f, 'note:selected'), source = collection(f, 'collection:source', [ref(item)]), destination = collection(f, 'collection:destination');
 const input = { ...f.envelope(), type: 'references-transfer', mode: 'move', source: guard(source), destination: guard(destination), references: [ref(item)], before: null } satisfies HomeLibraryCommand;
 for (const change of [{ source: { ...guard(source), expectedRevision: 0 } }, { destination: { ...guard(destination), expectedRevision: 0 } }, { references: [{ ...ref(item), revision: 99 }] }, { before: ref(item) }]) {
  const before = f.store.internalList('home:library:'); assert.throws(() => receipt(f, { ...input, ...change, ...f.envelope() })); assert.deepEqual(f.store.internalList('home:library:'), before);
 }
 const held: HomeReference[] = Array.from({ length: 200 }, (_, index) => ({ kind: 'note', id: 'missing:' + index, revision: 1 }));
 f.store.internalWrite('home:library:collection:' + destination.id, { ...destination, references: held });
 const before = f.store.internalList('home:library:'); assert.throws(() => receipt(f, input), /full/); assert.deepEqual(f.store.internalList('home:library:'), before);
}));

test('reference order is an exact permutation; no-op receipts have no inverse or revision bump', () => fixture(f => {
 const a = note(f, 'note:a'), b = note(f, 'note:b'), target = collection(f, 'collection:order', [ref(a), ref(b)]);
 const unchanged = receipt(f, { ...f.envelope(), type: 'references-order', collection: guard(target), references: target.references });
 assert.equal(unchanged.changed, false); assert.equal(unchanged.undo, null); assert.equal(currentCollection(f, target.id).revision, 1);
 for (const refs of [[ref(a)], [ref(a), { ...ref(b), revision: 2 }]]) assert.throws(() => receipt(f, { ...f.envelope(), type: 'references-order', collection: guard(target), references: refs }), /every exact/);
 const changed = receipt(f, { ...f.envelope(), type: 'references-order', collection: guard(target), references: [ref(b), ref(a)] });
 assert.equal(changed.collections[0].revision, 2); assert.deepEqual(changed.collections[0].references, [ref(b), ref(a)]);
}));

test('collection ordering refuses stale memberships and Undo preserves unrelated records and revisions', () => fixture(f => {
 const a = collection(f, 'collection:a'), b = collection(f, 'collection:b'), old = f.library.state(f.device).organization;
 const ordered = receipt(f, { ...f.envelope(), type: 'collections-order', expectedRevision: old.revision, collectionIds: [b.id, a.id] });
 assert.equal(ordered.collections.length, 0); assert.deepEqual(ordered.organization?.collectionIds, [b.id, a.id]);
 note(f, 'note:unrelated');
 const undone = receipt(f, undo(f, ordered)); assert.deepEqual(undone.organization?.collectionIds, [a.id, b.id]); assert.equal(undone.organization?.revision, old.revision + 2);
 const current = f.library.state(f.device).organization; collection(f, 'collection:concurrent');
 assert.throws(() => receipt(f, { ...f.envelope(), type: 'collections-order', expectedRevision: current.revision, collectionIds: current.collectionIds }), /order or membership changed/);
}));

test('capture Undo removes only memberships, retains writing, and reconciles lost Undo responses', () => fixture(f => {
 const target = collection(f, 'collection:undo'), other = collection(f, 'collection:other');
 const capture = receipt(f, { ...f.envelope(), type: 'items-capture', destination: guard(target), rows: [{ rowId: 'n', id: 'note:captured', value: { kind: 'note', title: 'Original', body: 'Original body', archived: false } }] });
 f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: 'note:captured', expectedRevision: 1, value: { kind: 'note', title: 'Edited', body: 'Keep later writing', archived: false } });
 f.library.command(f.device, { ...f.envelope(), type: 'collection-save', id: other.id, expectedRevision: 1, value: { title: 'Unrelated edit', subtitle: '', icon: 'folder', pinned: true, archived: false, references: [] } });
 const request = undo(f, capture), undone = receipt(f, request);
 assert.equal(currentCollection(f, target.id).references.length, 0); assert.equal(currentCollection(f, target.id).revision, 3);
 assert.equal(f.library.state(f.device).items[0].body, 'Keep later writing'); assert.equal(currentCollection(f, other.id).title, 'Unrelated edit');
 assert.deepEqual(receipt(f, request), undone); assert.throws(() => receipt(f, undo(f, capture)), /already undone/);
 assert.ok(f.store.internalRead('home:library:version:item-save:note:captured:1'));
}));

test('Undo refuses another device, fabricated guards and affected intervening writes without reverting anything', () => fixture(f => {
 const a = note(f, 'note:a'), b = note(f, 'note:b'), target = collection(f, 'collection:undo', [ref(a), ref(b)]);
 const changed = receipt(f, { ...f.envelope(), type: 'references-order', collection: guard(target), references: [ref(b), ref(a)] });
 const second = f.store.session().deviceId;
 assert.throws(() => receipt(f, undo(f, changed), second), /your confirmed original/);
 assert.throws(() => receipt(f, { ...undo(f, changed), expected: { collections: [], organizationRevision: null } }), /exact affected/);
 const now = currentCollection(f, target.id);
 f.library.command(f.device, { ...f.envelope(), type: 'collection-save', id: now.id, expectedRevision: now.revision, value: { title: 'Later writing', subtitle: '', icon: now.icon, pinned: false, archived: false, references: now.references } });
 const before = f.store.internalList('home:library:'); assert.throws(() => receipt(f, undo(f, changed)), /changed after/); assert.deepEqual(f.store.internalList('home:library:'), before);
}));

test('legacy pin/archive inverse is field-scoped; title edits never receive an inverse', () => fixture(f => {
 const row = collection(f, 'collection:legacy');
 const { id, revision, updatedAt: _at, ...value } = row;
 const command = { ...f.envelope(), type: 'collection-save', id, expectedRevision: revision, value: { ...value, pinned: true, archived: true } } satisfies HomeLibraryCommand;
 const saved = f.library.command(f.device, command) as HomeCollection;
 const undone = receipt(f, { ...f.envelope(), type: 'library-undo', operationId: command.requestId, expected: { collections: [guard(saved)], organizationRevision: null } });
 assert.equal(undone.collections[0].pinned, false); assert.equal(undone.collections[0].archived, false); assert.equal(undone.collections[0].revision, 3);
 const title = { ...command, ...f.envelope(), expectedRevision: 3, value: { ...value, title: 'Writing' } };
 f.library.command(f.device, title); assert.equal(f.store.internalRead('home:library:operation:' + title.requestId), undefined);
}));

test('the final allowed collection and authored item save without increasing existing limits', () => fixture(f => {
 for (let index = 0; index < 99; index++) f.store.internalWrite('home:library:collection:old:' + index, { id: 'old:' + index, revision: 1, updatedAt: '', title: 'Retained', subtitle: '', icon: 'book', pinned: false, archived: false, references: [] });
 const last = collection(f, 'collection:last'); assert.equal(f.library.state(f.device).collections.length, 100);
 assert.throws(() => collection(f, 'collection:over'), /limit/);
 for (let index = 0; index < 299; index++) f.store.internalWrite('home:library:item:old:' + index, { id: 'old:' + index, revision: 1, updatedAt: '', kind: 'note', title: 'Retained', body: '', archived: index % 2 === 0 });
 const capture = (id: string, revision: number) => ({ ...f.envelope(), type: 'items-capture' as const, destination: { id: last.id, expectedRevision: revision }, rows: [{ rowId: id, id, value: { kind: 'note' as const, title: 'Boundary', body: '', archived: false } }] });
 const saved = receipt(f, capture('note:last', 1)); assert.equal(f.library.state(f.device).items.length, 300);
 const before = f.store.internalList('home:library:'); assert.throws(() => receipt(f, capture('note:over', saved.collections[0].revision)), /capacity/);
 assert.deepEqual(f.store.internalList('home:library:'), before);
}));

test('capture accepts member 200 then refuses 201 atomically, including the proposed item', () => fixture(f => {
 const target = collection(f, 'collection:full');
 const references: HomeReference[] = Array.from({ length: 199 }, (_, index) => ({ kind: 'note', id: 'historical:' + index, revision: 1 }));
 f.store.internalWrite('home:library:collection:' + target.id, { ...target, references });
 const capture = (id: string, revision: number) => ({ ...f.envelope(), type: 'items-capture' as const, destination: { id: target.id, expectedRevision: revision }, rows: [{ rowId: id, id, value: { kind: 'note' as const, title: id, body: '', archived: false } }] });
 const saved = receipt(f, capture('note:200', 1)); assert.equal(saved.collections[0].references.length, 200);
 assert.throws(() => receipt(f, capture('note:201', 2)), /capacity/);
 assert.equal(f.store.internalRead('home:library:item:note:201'), undefined);
 assert.equal(currentCollection(f, target.id).revision, 2);
}));

test('a failed second collection persistence rolls the entire move back', () => fixture(f => {
 const item = note(f, 'note:move'), source = collection(f, 'collection:source', [ref(item)]), destination = collection(f, 'collection:destination');
 const input = { ...f.envelope(), type: 'references-transfer', mode: 'move', source: guard(source), destination: guard(destination), references: [ref(item)], before: null } satisfies HomeLibraryCommand;
 const before = f.store.internalList('home:library:'), write = f.store.internalWrite.bind(f.store);
 f.store.internalWrite = ((id: string, value: unknown) => { if (id === 'home:library:collection:' + source.id) throw Error('Second collection persistence failed'); return write(id, value); }) as typeof f.store.internalWrite;
 try { assert.throws(() => receipt(f, input), /Second collection/); } finally { f.store.internalWrite = write; }
 assert.deepEqual(f.store.internalList('home:library:'), before); assert.equal(receipt(f, input).changed, true);
}));

test('new capture refuses normalized URL overflow; old item-save keeps its accepted exact URL bytes', () => fixture(f => {
 const target = collection(f, 'collection:urls');
 const original = 'https://EXAMPLE.com/a?q=1#kept';
 const saved = f.library.command(f.device, { ...f.envelope(), type: 'item-save', id: 'link:legacy', expectedRevision: 0, value: { kind: 'link', title: 'Exact legacy', url: original, body: '', archived: false } }) as HomeItem;
 assert.equal(saved.kind === 'link' && saved.url, original);
 const url = 'https://example.com/' + '🦊'.repeat(200);
 assert.ok(url.length < 2048 && new URL(url).href.length > 2048);
 const before = f.store.internalList('home:library:');
 assert.throws(() => receipt(f, { ...f.envelope(), type: 'items-capture', destination: guard(target), rows: [{ rowId: 'overflow', id: 'link:overflow', value: { kind: 'link', title: 'Too long', url, body: '', archived: false } }] }), /normalized link/);
 assert.deepEqual(f.store.internalList('home:library:'), before);
}));

test('legacy first capture seed and later unrelated collection creation do not broaden membership Undo', () => fixture(f => {
 const target: HomeCollection = { id: 'collection:legacy', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z', title: 'Legacy', subtitle: '', icon: 'book', pinned: false, archived: false, references: [] };
 f.store.internalWrite('home:library:collection:' + target.id, target);
 const captured = receipt(f, { ...f.envelope(), type: 'items-capture', destination: guard(target), rows: [{ rowId: 'one', id: 'note:one', value: { kind: 'note', title: 'Retained', body: 'Private writing', archived: false } }] });
 assert.equal(captured.organization?.revision, 1); assert.equal(captured.undo?.expected.organizationRevision, null);
 const inverse = f.store.internalRead('home:library:operation:' + captured.operationId); assert.doesNotMatch(JSON.stringify(inverse), /Private writing/);
 collection(f, 'collection:unrelated');
 receipt(f, undo(f, captured));
 assert.deepEqual(f.library.state(f.device).organization.collectionIds, [target.id, 'collection:unrelated']);
 assert.equal(currentCollection(f, target.id).references.length, 0);
}));

test('new captured identities reject invented hashes and inverse records retain their command provenance', () => fixture(f => {
 const project = f.store.mutate(f.device, { ...f.envelope(), kind: 'project', entityId: 'project:exact', expectedRevision: 0, payload: { name: 'Exact', purpose: '' } });
 assert.throws(() => collection(f, 'collection:forged', [{ kind: 'project', id: project.id, revision: project.revision, sha256: 'a'.repeat(64) }]), /changed or disappeared/);
 const a = note(f, 'note:a'), b = note(f, 'note:b'), target = collection(f, 'collection:exact', [ref(a), ref(b)]);
 const result = receipt(f, { ...f.envelope(), type: 'references-order', collection: guard(target), references: [ref(b), ref(a)] });
 const inverse = f.store.internalRead<{ type: string; epoch: string; device: string }>('home:library:operation:' + result.operationId)!;
 assert.equal(inverse.type, 'references-order'); assert.equal(inverse.epoch, f.store.epoch); assert.equal(inverse.device, f.device);
 receipt(f, undo(f, result));
}));
