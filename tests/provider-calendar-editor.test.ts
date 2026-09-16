import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCalendarEditor, formForDraft, providerDraftLocked } from '../apps/client/src/dreamclaw/calendar-editor';
import { createCalendarHost } from '../apps/client/src/dreamclaw/calendar-host';
import { calendarDraftKey, type EventDraft } from '../apps/client/src/calendar-edit';
import type { ProviderCalendarEditable, ProviderCalendarPrepare, ProviderCalendarReview, ProviderCalendarTarget } from '../packages/domain/calendar-write';
import type { CalendarSourceRef, LocalEventInput } from '../packages/domain/calendar';
import type { CalendarEvent } from '../apps/client/src/dreamclaw/pages/Calendar/calendarTypes';
import type { CalendarGroupPrepare, CalendarGroupReview } from '../packages/domain/calendar-groups';

const epoch = randomUUID(), deviceId = randomUUID(), windowId = randomUUID();
const source: CalendarSourceRef = { id: 'source', accountId: 'google-account', generation: randomUUID(), provider: 'google', calendarId: 'primary', name: 'Studio', accountLabel: 'studio@example.test', primary: true, providerCanWrite: true, accountCanWrite: true };
const value: LocalEventInput = { title: 'Original workshop', notes: 'Complete original notes', location: 'Studio', timezone: 'Asia/Tokyo', allDay: false, start: { date: '2026-09-10', time: '09:00' }, end: { date: '2026-09-10', time: '10:00' }, state: 'confirmed', projectId: null, taskId: null, category: 'other', reminderMinutes: 30, deliveryChannel: 'last' };
const target: ProviderCalendarTarget = { sourceId: source.id, generation: source.generation, eventId: 'original-event', scope: 'event' };
const editable: ProviderCalendarEditable = { epoch, source, target, value, version: 'v1', attendees: 2, onlineMeeting: true, formattedDescription: false, repeating: false, recurrenceEditable: true, warnings: [], event: { id: target.eventId, title: value.title, notes: value.notes, location: value.location, status: 'confirmed', interval: { kind: 'instant', start: '2026-09-10T00:00:00Z', end: '2026-09-10T01:00:00Z', timezone: 'Asia/Tokyo' } } };
const projected: CalendarEvent = { id: 'source:original-event', title: 'Cached title', notes: 'Short cached summary', date: '2026-09-09', startTime: '17:00', endTime: '18:00', allDay: false, category: 'other', source: 'google', status: 'scheduled', reminderMinutes: 0, reminderStatus: 'none', deliveryChannel: 'last', createdAt: '', updatedAt: '', writeToken: 'captured-provider-event' };
const wire = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const journalKey = (window = windowId) => `e3:calendar:${deviceId}:${window}`;
function setup(t: TestContext, draft?: EventDraft) {
  const records = new Map<string, string>(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let full = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => records.get(key) ?? null, setItem(key: string, value: string) { if (full) throw new Error('Storage full'); records.set(key, value); } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  if (draft) records.set(journalKey(), JSON.stringify({ draft, editorOpen: true, retainedRefresh: { requestId: 'retained-refresh' } }));
  const options = { epoch, deviceId, windowId, timezone: 'America/Los_Angeles', findLocal() { throw new Error('Not a local fixture'); }, findProvider() { return target; }, findSource(id: string) { assert.equal(id, source.id); return source; }, async changed() {} };
  return { records, options, full() { full = true; } };
}
function review(input: ProviderCalendarPrepare, patch: Partial<ProviderCalendarReview> = {}): ProviderCalendarReview {
  return { id: randomUUID(), epoch, writerId: input.writerId, source, action: input.action, target: input.target, value: input.value, before: input.target ? value : undefined,
    revision: 2, digest: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'review', attendees: 0, changes: ['Title'], warnings: [], ...patch };
}
function remoteDraft(): EventDraft { return { id: target.eventId, epoch, revision: 1, scope: 'event', value, provider: { writerId: randomUUID(), source, editable } }; }
function scheduleDraft(): EventDraft {
  const draft = remoteDraft(); draft.scope = 'series'; draft.provider!.editable = { ...editable, target: { ...target, eventId: 'a-pattern', seriesId: 'a-pattern', scope: 'series' } }; draft.originalForm = { ...formForDraft(draft), title: 'My retained schedule writing' }; return draft;
}
function scheduleReview(input: CalendarGroupPrepare, patch: Partial<CalendarGroupReview> = {}): CalendarGroupReview {
  return { id: randomUUID(), epoch, writerId: input.writerId, source, label: input.label, state: 'review', closed: false, round: 1, revision: 3, digest: 'b'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: 'Review selected patterns',
    items: input.seriesIds.map(seriesId => ({ seriesId, operation: { id: randomUUID(), epoch, writerId: randomUUID(), source, action: 'delete', target: { ...target, eventId: seriesId, seriesId, scope: 'series' }, before: value, revision: 2, state: 'review', digest: 'c'.repeat(64), attendees: 0, changes: ['Delete series'], warnings: [], createdAt: '', updatedAt: '', expiresAt: '' } })), ...patch };
}

test('opening the original provider event parks independent local writing and retains full clocks and description after reload', async t => {
  const local: EventDraft = { id: randomUUID(), epoch, revision: 0, value: { ...value, title: 'Unsent local event' } };
  const f = setup(t, local);
  t.mock.method(globalThis, 'fetch', async () => wire(editable));
  const editor = createCalendarEditor(f.options);
  await editor.getState().openProvider(projected, 'event');
  assert.equal(editor.getState().keptDrafts[0].id, local.id);
  const form = formForDraft(editor.getState().draft!);
  assert.equal(form.notes, value.notes); assert.equal(form.date, '2026-09-10'); assert.equal(form.startTime, '09:00'); assert.equal(form.destinationId, source.id);
  editor.getState().keepForm({ ...form, title: 'Kept provider title' }); editor.getState().close();
  const resumed = createCalendarEditor(f.options); assert.equal(resumed.getState().open, false);
  await resumed.getState().openProvider(projected, 'event');
  assert.equal(formForDraft(resumed.getState().draft!).title, 'Kept provider title');
  resumed.getState().resumeKept(calendarDraftKey(local));
  assert.equal(formForDraft(resumed.getState().draft!).title, local.value.title);
  assert.equal(formForDraft(resumed.getState().keptDrafts[0]).title, 'Kept provider title');
  assert.equal(JSON.parse(f.records.get(journalKey())!).retainedRefresh.requestId, 'retained-refresh');
});

test('closing a full provider read discards its late result without replacing a newly opened draft', async t => {
  const f = setup(t); let respond!: () => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = () => resolve(wire(editable)); }));
  const editor = createCalendarEditor(f.options), loading = editor.getState().openProvider(projected, 'event');
  assert.equal(editor.getState().busy, true); editor.getState().close(); editor.getState().begin();
  editor.getState().keepForm({ ...formForDraft(editor.getState().draft!), title: 'New independent writing' });
  const id = editor.getState().draft!.id; respond(); await loading;
  assert.equal(editor.getState().draft!.id, id); assert.equal(formForDraft(editor.getState().draft!).title, 'New independent writing');
  assert.equal(editor.getState().draft!.provider, undefined);
});

test('lost preparation and confirmation responses recover the exact admitted requests after reload', async t => {
  const f = setup(t, remoteDraft()), sent: { route: string; input: any }[] = []; let operation: ProviderCalendarReview | undefined;
  let losePrepare = true, loseConfirm = true, effects = 0;
  t.mock.method(globalThis, 'fetch', async (route: any, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); sent.push({ route, input });
    if (route.endsWith('/prepare')) { operation ??= review(input); if (losePrepare) { losePrepare = false; throw new Error('Lost prepare response'); } return wire(operation); }
    if (route.endsWith('/confirm')) { if (operation!.state === 'review') { effects++; operation = { ...operation!, revision: 4, state: 'confirmed', event: editable.event }; } if (loseConfirm) { loseConfirm = false; throw new Error('Lost confirmation response'); } return wire(operation); }
    assert.ok(route.endsWith('/read')); return wire(operation);
  });
  const first = createCalendarEditor(f.options); first.getState().keepForm({ ...formForDraft(first.getState().draft!), title: 'My provider proposal' });
  await first.getState().save(); assert.match(first.getState().draft!.error!, /Lost prepare/);
  const resumed = createCalendarEditor(f.options), before = resumed.getState().draft!;
  resumed.getState().keepForm({ ...formForDraft(before), title: 'Cannot change pending proposal' }); assert.equal(resumed.getState().draft, before);
  await resumed.getState().checkProvider();
  assert.deepEqual(sent[1].input, sent[0].input); assert.equal(effects, 0);
  await resumed.getState().confirmProvider('confirm'); assert.equal(effects, 1); assert.match(resumed.getState().draft!.error!, /Lost confirmation/);
  const afterLoss = createCalendarEditor(f.options); await afterLoss.getState().checkProvider();
  assert.equal(afterLoss.getState().draft!.provider!.operation!.state, 'confirmed'); assert.equal(effects, 1);
  assert.equal(sent.filter(item => item.route.endsWith('/confirm')).length, 1);
  afterLoss.getState().finishProvider(); assert.equal(afterLoss.getState().draft, undefined);
});

test('uncertain provider effects use read-only reconciliation and retain the proposal when still unconfirmed', async t => {
  const draft = remoteDraft(), prepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, action: 'update' as const, target, expectedVersion: 'v1', value, replaceDescription: false, replaceRecurrence: false, replaceReminder: false };
  const operation = review(prepare, { state: 'unknown' }); draft.provider = { ...draft.provider!, prepare, operation };
  const f = setup(t, draft), routes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (route: any) => { routes.push(route); return wire(operation); });
  const editor = createCalendarEditor(f.options); await editor.getState().checkProvider(); editor.getState().editProvider(); editor.getState().finishProvider();
  assert.deepEqual(routes, ['/api/calendar/write/reconcile']); assert.equal(providerDraftLocked(editor.getState().draft), true);
  assert.equal(editor.getState().draft!.id, target.eventId);
});

test('conflict review preserves edited fields while accepting unrelated newer provider changes', async t => {
  const draft = remoteDraft(), prepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, action: 'update' as const, target, expectedVersion: 'v1', value: { ...value, title: 'My title' }, replaceDescription: false, replaceRecurrence: false, replaceReminder: false };
  draft.originalForm = { ...formForDraft(draft), title: 'My title' }; draft.provider = { ...draft.provider!, prepare, operation: review(prepare, { state: 'conflict' }) };
  const f = setup(t, draft), current = { ...editable, version: 'v2', value: { ...value, notes: 'New provider notes', location: 'New room' } };
  t.mock.method(globalThis, 'fetch', async () => wire(current));
  const editor = createCalendarEditor(f.options); await editor.getState().reviewProvider();
  assert.equal(formForDraft(editor.getState().draft!).notes, value.notes);
  editor.getState().editProvider();
  assert.equal(formForDraft(editor.getState().draft!).title, 'My title'); assert.equal(formForDraft(editor.getState().draft!).notes, 'New provider notes');
  assert.equal(formForDraft(editor.getState().draft!).location, 'New room'); assert.equal(editor.getState().draft!.provider!.editable!.version, 'v2');
  assert.equal(providerDraftLocked(editor.getState().draft), false);
});

test('a cloned creation cannot discard different writing when its original writer already saved', async t => {
  const id = randomUUID(), draft: EventDraft = { id, epoch, revision: 0, value, provider: { writerId: id, source } };
  const f = setup(t, draft), cloneWindow = randomUUID(), clone = createCalendarEditor({ ...f.options, windowId: cloneWindow, previousWindowId: windowId });
  clone.getState().keepForm({ ...formForDraft(clone.getState().draft!), title: 'Different clone writing' });
  let saved: ProviderCalendarReview;
  t.mock.method(globalThis, 'fetch', async (route: any, init: RequestInit) => {
    if (route.endsWith('/prepare')) {
      const input = JSON.parse(String(init.body)); saved = review({ ...input, value }, { state: 'confirmed', event: { ...editable.event, id: 'saved-event' } });
      return wire({ code: 'calendar_writer_saved', message: 'Original draft already saved', current: { operationId: saved.id } }, 409);
    }
    assert.ok(route.endsWith('/read')); return wire(saved);
  });
  await clone.getState().save(); assert.equal(clone.getState().draft!.provider!.separateProposal, true);
  clone.getState().finishProvider();
  assert.equal(formForDraft(clone.getState().draft!).title, 'Different clone writing'); assert.notEqual(clone.getState().draft!.id, id);
  assert.equal(clone.getState().draft!.provider!.operation, undefined);
  assert.equal(formForDraft(createCalendarEditor(f.options).getState().draft!).title, value.title);
});

test('reopening after reconnect retains writing and explicit reminders while refreshing permissions and unrelated fields', async t => {
  const draft = remoteDraft();
  draft.provider!.source = { ...source, accountCanWrite: false };
  draft.originalForm = { ...formForDraft(draft), title: 'My kept title', reminder: 0 };
  const f = setup(t, draft), connected = { ...source, generation: randomUUID() };
  const current = { ...editable, source: connected, target: { ...target, generation: connected.generation }, version: 'v2', value: { ...value, notes: 'New provider notes' } };
  const sent: any[] = [];
  t.mock.method(globalThis, 'fetch', async (route: any, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); sent.push({ route, input });
    return wire(route.endsWith('/open') ? current : review(input));
  });
  const options = { ...f.options, findSource: () => connected, findProvider: () => current.target };
  const editor = createCalendarEditor(options); await editor.getState().openProvider(projected, 'event');
  const kept = editor.getState().draft!;
  assert.equal(kept.provider!.source.generation, connected.generation); assert.equal(kept.provider!.source.accountCanWrite, true);
  assert.equal(formForDraft(kept).title, 'My kept title'); assert.equal(formForDraft(kept).notes, 'New provider notes'); assert.equal(formForDraft(kept).reminder, 0);
  const resumed = createCalendarEditor(options); await resumed.getState().save();
  assert.equal(sent.at(-1).input.generation, connected.generation); assert.equal(sent.at(-1).input.expectedVersion, 'v2');
  assert.equal(sent.at(-1).input.value.title, 'My kept title'); assert.equal(sent.at(-1).input.replaceReminder, true);
  assert.equal(sent.filter(item => item.route.endsWith('/confirm')).length, 0);
});

test('failed review reconnects through a fresh read without changing the old operation until edits are explicitly resumed', async t => {
  const draft = remoteDraft(), prepare: ProviderCalendarPrepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, action: 'update', target, expectedVersion: 'v1', value, replaceDescription: false, replaceRecurrence: false, replaceReminder: false };
  draft.provider = { ...draft.provider!, prepare, operation: review(prepare, { state: 'failed' }) };
  const f = setup(t, draft), connected = { ...source, generation: randomUUID() };
  t.mock.method(globalThis, 'fetch', async (_route: any, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).target.generation, connected.generation);
    return wire({ ...editable, source: connected, target: { ...target, generation: connected.generation }, version: 'v2' });
  });
  const editor = createCalendarEditor({ ...f.options, findSource: () => connected });
  await editor.getState().reviewProvider(); assert.equal(editor.getState().draft!.provider!.source.generation, source.generation);
  assert.deepEqual(editor.getState().draft!.provider!.prepare, prepare);
  editor.getState().editProvider(); assert.equal(editor.getState().draft!.provider!.source.generation, connected.generation);
  assert.equal(editor.getState().draft!.provider!.editable!.version, 'v2'); assert.equal(providerDraftLocked(editor.getState().draft), false);
});

test('refresh never rebinds an admitted review or unknown operation', async t => {
  const draft = remoteDraft(), prepare: ProviderCalendarPrepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, action: 'update', target, expectedVersion: 'v1', value, replaceDescription: false, replaceRecurrence: false, replaceReminder: false };
  draft.provider = { ...draft.provider!, prepare, operation: review(prepare, { state: 'unknown' }) };
  const f = setup(t, draft); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected request'); });
  const editor = createCalendarEditor({ ...f.options, findSource: () => ({ ...source, generation: randomUUID() }) });
  const before = editor.getState().draft;
  await editor.getState().refreshProvider();
  assert.equal(editor.getState().draft, before); assert.equal(calls, 0);
});

test('a foreign source or late connection change cannot overwrite a kept draft during refresh', async t => {
  const f = setup(t, remoteDraft()); let connected = source, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; connected = { ...source, generation: randomUUID() }; return wire(editable); });
  const editor = createCalendarEditor({ ...f.options, findSource: () => connected });
  await editor.getState().refreshProvider();
  assert.match(editor.getState().draft!.error!, /connection changed/); assert.equal(editor.getState().draft!.provider!.editable!.version, 'v1');
  connected = { ...source, accountId: 'another-account' }; await editor.getState().refreshProvider();
  assert.match(editor.getState().draft!.error!, /original Calendar account/); assert.equal(calls, 1);
});

test('new provider event drafts use current connection authority before their first preparation', async t => {
  const id = randomUUID(), f = setup(t, { id, epoch, revision: 0, value, provider: { writerId: id, source } });
  const connected = { ...source, generation: randomUUID() };
  t.mock.method(globalThis, 'fetch', async (_route: any, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); assert.equal(input.generation, connected.generation); assert.equal(input.target, undefined); return wire(review(input));
  });
  const editor = createCalendarEditor({ ...f.options, findSource: () => connected }); await editor.getState().save();
  assert.equal(editor.getState().draft!.provider!.operation!.state, 'review');
});

test('an explicitly rejected stale-source preparation unlocks its kept writing without retrying a write', async t => {
  const f = setup(t, remoteDraft()); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return wire({ code: 'calendar_source_changed', message: 'Refresh Calendar sources.' }, 409); });
  const editor = createCalendarEditor(f.options); await editor.getState().save();
  assert.equal(providerDraftLocked(editor.getState().draft), false); assert.equal(formForDraft(editor.getState().draft!).notes, value.notes); assert.equal(calls, 1);
});

test('the original Calendar host permits read-only refresh of retained writing after account permission changes', async t => {
  const f = setup(t, remoteDraft()), connected = { ...source, generation: randomUUID(), accountCanWrite: false };
  t.mock.method(globalThis, 'fetch', async (route: any) => wire(route.startsWith('/api/calendar/state')
    ? { epoch, deviceId, range: { from: '2026-09-01', to: '2026-10-01', timezone: 'America/Los_Angeles' }, events: [], localEvents: [], sources: [{ ...connected, selected: true, state: 'ready' }], jobs: [], selection: { revision: 1, sourceIds: [source.id], showLocal: true, showTasks: true }, accountMessages: [], eventsLimited: false }
    : { ...editable, source: connected, target: { ...target, generation: connected.generation } }));
  const host = createCalendarHost({ snapshot: { epoch, deviceId, layout: { value: { timezone: 'America/Los_Angeles' } } } as any, windowId, navigate() {}, keepView() {}, async changed() {} });
  await host.read({ startDate: '2026-09-01' } as any, false, new AbortController().signal);
  await host.editor.getState().refreshProvider();
  assert.equal(host.editor.getState().draft!.error, undefined); assert.equal(host.editor.getState().draft!.provider!.source.accountCanWrite, false);
  assert.equal(host.editor.getState().draft!.provider!.source.generation, connected.generation);
  assert.ok(f.records.get(journalKey()));
});

test('group selection and lost action responses retain exact requests through reload without repeating deletion', async t => {
  const f = setup(t, scheduleDraft()); let operation: CalendarGroupReview | undefined, lostPrepare = true, lostAction = true, effects = 0;
  const sent: { route: string; input: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (route: any, init: RequestInit) => {
    const input = JSON.parse(String(init.body)); sent.push({ route, input });
    if (route.endsWith('/prepare')) {
      assert.deepEqual(JSON.parse(f.records.get(journalKey())!).draft.provider.group.prepare, input);
      operation ??= scheduleReview(input); if (lostPrepare) { lostPrepare = false; throw new Error('Lost group preparation'); } return wire(operation);
    }
    if (route.endsWith('/action')) {
      if (operation!.state === 'review') { effects += operation!.items.length; operation = { ...operation!, revision: 8, state: 'confirmed', closed: true, items: operation!.items.map(item => ({ ...item, operation: { ...item.operation!, state: 'confirmed' } })) }; }
      if (lostAction) { lostAction = false; throw new Error('Lost group result'); } return wire(operation);
    }
    assert.ok(route.endsWith('/read')); return wire(operation);
  });
  const editor = createCalendarEditor(f.options); await editor.getState().prepareGroup(['a-pattern', 'b-pattern'], 'Classes');
  assert.match(editor.getState().draft!.error!, /Lost group preparation/); assert.equal(providerDraftLocked(editor.getState().draft), true);
  const resumed = createCalendarEditor(f.options); await resumed.getState().checkGroup(); assert.deepEqual(sent[0].input, sent[1].input);
  await resumed.getState().groupAction('confirm'); assert.equal(effects, 2);
  const recovered = createCalendarEditor(f.options); await recovered.getState().checkGroup(); assert.equal(recovered.getState().draft!.provider!.group!.operation!.state, 'confirmed');
  assert.equal(formForDraft(recovered.getState().draft!).title, 'My retained schedule writing'); assert.equal(sent.filter(item => item.route.endsWith('/action')).length, 1);
  recovered.getState().finishGroup(); assert.equal(recovered.getState().draft, undefined); assert.equal(effects, 2);
});

test('an uncertain grouped result uses only reconciliation and cannot discard its selection', async t => {
  const draft = scheduleDraft(), input: CalendarGroupPrepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, seriesIds: ['a-pattern'], label: 'Classes' };
  const operation = scheduleReview(input, { state: 'partial' }); operation.items[0].operation!.state = 'unknown'; draft.provider!.group = { prepare: input, operation };
  const f = setup(t, draft), routes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (route: any) => { routes.push(route); return wire(operation); });
  const editor = createCalendarEditor(f.options); await editor.getState().checkGroup(); editor.getState().finishGroup(); await editor.getState().refreshProvider();
  assert.deepEqual(routes, ['/api/calendar/groups/reconcile']); assert.deepEqual(editor.getState().draft!.provider!.group!.prepare.seriesIds, ['a-pattern']); assert.equal(formForDraft(editor.getState().draft!).title, 'My retained schedule writing');
});

test('finishing a custom selection that excludes the original series keeps the original event writing', async t => {
  const draft = scheduleDraft(), input: CalendarGroupPrepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, seriesIds: ['b-pattern'], label: 'Classes' };
  const operation = scheduleReview(input, { state: 'confirmed', closed: true }); operation.items[0].operation!.state = 'confirmed'; draft.provider!.group = { prepare: input, operation };
  const f = setup(t, draft), editor = createCalendarEditor(f.options); editor.getState().finishGroup();
  assert.equal(editor.getState().draft!.provider!.group, undefined); assert.equal(formForDraft(editor.getState().draft!).title, 'My retained schedule writing'); assert.equal(editor.getState().open, true);
});

test('an explicit group action rejection permits a fresh decision while keeping the immutable selection', async t => {
  const draft = scheduleDraft(), input: CalendarGroupPrepare = { requestId: randomUUID(), epoch, writerId: draft.provider!.writerId, sourceId: source.id, generation: source.generation, seriesIds: ['a-pattern'], label: 'Classes' };
  draft.provider!.group = { prepare: input, operation: scheduleReview(input) }; const f = setup(t, draft);
  t.mock.method(globalThis, 'fetch', async () => wire({ code: 'calendar_group_changed', message: 'Check current results.' }, 409));
  const editor = createCalendarEditor(f.options); await editor.getState().groupAction('confirm');
  assert.equal(editor.getState().draft!.provider!.group!.command, undefined); assert.deepEqual(editor.getState().draft!.provider!.group!.prepare.seriesIds, ['a-pattern']);
});

test('browser-storage failure prevents preparation and preserves the exact current writing', async t => {
  const f = setup(t, remoteDraft()); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected dispatch'); });
  const editor = createCalendarEditor(f.options); f.full();
  await assert.rejects(editor.getState().save(), /Free browser storage/);
  assert.equal(requests, 0); assert.equal(editor.getState().draft!.provider!.prepare, undefined); assert.equal(formForDraft(editor.getState().draft!).notes, value.notes);
});

test('Tasks opens the captured provider occurrence from its original range and rejects a changed connection', async t => {
  setup(t); let generation=source.generation;
  const range={from:'2026-09-10',to:'2026-11-09',timezone:'America/Los_Angeles'};
  const event={...editable.event,sourceId:source.id,seriesId:'master',originalStart:editable.event.interval.start};
  t.mock.method(globalThis,'fetch',async(route:any)=>{
    assert.ok(route.startsWith('/api/calendar/state?'));assert.equal(new URL(route,'http://fixture').searchParams.get('from'),range.from);
    return wire({epoch,deviceId,range,events:[event],localEvents:[],sources:[{...source,generation,selected:true,state:'ready'}],jobs:[],selection:{revision:1,sourceIds:[source.id],showLocal:true,showTasks:true},accountMessages:[],eventsLimited:false});
  });
  const host=createCalendarHost({snapshot:{epoch,deviceId,layout:{value:{timezone:range.timezone}}} as any,windowId,navigate(){},keepView(){},async changed(){}});
  const link={epoch,sourceId:source.id,generation:source.generation,eventId:event.id,date:'2026-09-09',range};
  await host.openLinkedEvent!(link,new AbortController().signal);
  assert.equal(host.editor.getState().providerScope?.id,`${source.id}:${event.id}`);assert.equal(host.editor.getState().providerScope?.recurringEventId,'master');
  host.editor.getState().close();generation=randomUUID();
  await assert.rejects(host.openLinkedEvent!(link,new AbortController().signal),/connection changed/);assert.equal(host.editor.getState().providerScope,undefined);
});
