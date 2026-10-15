import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { HomeFeed } from '../apps/service/home-feed.js';
import { homeIdeaScope, type HomeCollection, type HomeItem, type HomeLibraryCommand } from '../packages/domain/home-library.js';
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
