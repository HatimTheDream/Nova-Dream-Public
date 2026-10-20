import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarEditor, formForDraft } from '../apps/client/src/dreamclaw/calendar-editor';
import { calendarDraftKey, draftForCalendar, type EventDraft } from '../apps/client/src/calendar-edit';
import type { LocalCalendarDetail, LocalEventInput } from '../packages/domain/calendar';

const value: LocalEventInput = { title: 'Kept appointment', notes: 'Keep these notes', location: 'Studio', timezone: 'Asia/Tokyo', allDay: false,
  start: { date: '2026-09-09', time: '09:00' }, end: { date: '2026-09-09', time: '10:00' }, state: 'confirmed', projectId: null, taskId: null };
const options = { epoch: 'epoch', deviceId: 'device', windowId: 'window', timezone: 'America/Los_Angeles', findLocal() { throw new Error('Not needed in this fixture'); }, async changed() {} };
const key = 'e3:calendar:device:window';
function setup(t: TestContext, draft?: EventDraft) {
  const records = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  if (draft) records.set(key, JSON.stringify({ draft, editorOpen: true, day: '2026-09-09', retainedRefresh: { requestId: 'old-refresh' } }));
  return records;
}
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('Reminders return retains the exact pending Calendar draft and unrelated journal fields', t => {
  const pending = { requestId: 'original-save', epoch: 'epoch', eventId: 'series', expectedRevision: 2, scope: 'occurrence' as const, originalDate: '2026-09-09', expectedOverrideRevision: 1, value };
  const draft: EventDraft = { id: 'series', epoch: 'epoch', revision: 2, scope: 'occurrence', originalDate: '2026-09-09', overrideRevision: 1, value, pending };
  const records = setup(t, draft), editor = createCalendarEditor(options);
  assert.equal(editor.getState().closeRetained(), true); assert.equal(editor.getState().open, false);
  const stored = JSON.parse(records.get(key)!); assert.deepEqual(stored.draft, draft); assert.deepEqual(stored.retainedRefresh, { requestId: 'old-refresh' });
  const reopened = createCalendarEditor(options); assert.deepEqual(reopened.getState().draft?.pending, pending);
});
test('Reminders return refuses busy or full storage without changing editor identity, scope or provider state', t => {
  setup(t, { id: 'event', epoch: 'epoch', revision: 1, value }); const editor = createCalendarEditor(options);
  const original = editor.getState().draft;
  editor.setState({ busy: true }); assert.equal(editor.getState().closeRetained(), false); assert.equal(editor.getState().open, true);
  const source = { id: 'original-provider-event' } as NonNullable<ReturnType<typeof editor.getState>['source']>;
  const scopeEvent = { eventId: 'original-series', originalDate: '2026-09-09' } as NonNullable<ReturnType<typeof editor.getState>['scopeEvent']>;
  const openingProvider = { event: source, scope: 'event' as const };
  editor.setState({ busy: false, source, scopeEvent, providerScope: source, openingProvider });
  assert.equal(editor.getState().closeRetained(), false); assert.equal(editor.getState().openingProvider, openingProvider);
  editor.setState({ openingProvider: undefined }); t.mock.method(localStorage, 'setItem', () => { throw Error('Full'); });
  assert.equal(editor.getState().closeRetained(), false); assert.equal(editor.getState().open, true); assert.equal(editor.getState().draft, original);
  assert.equal(editor.getState().source, source); assert.equal(editor.getState().scopeEvent, scopeEvent); assert.equal(editor.getState().providerScope, source);
  assert.match(editor.getState().storageError, /storage/);
});

test('the Calendar add entry creates a new draft only when empty and otherwise resumes the saved event identity', t => {
  setup(t, { id: 'saved-event', epoch: 'epoch', revision: 7, value });
  const retained = createCalendarEditor(options);
  retained.getState().close();
  retained.getState().begin(undefined, new Date(2099, 10, 2, 12));
  assert.equal(retained.getState().open, true);
  assert.equal(retained.getState().draft!.id, 'saved-event');
  assert.equal(retained.getState().draft!.revision, 7);
  assert.deepEqual(retained.getState().draft!.value, value);
  const fresh = createCalendarEditor({ ...options, windowId: 'empty-window' });
  fresh.getState().begin(undefined, new Date(2099, 10, 2, 12));
  assert.equal(fresh.getState().open, true);
  assert.equal(fresh.getState().draft!.revision, 0);
  assert.equal(formForDraft(fresh.getState().draft!).date, '2099-11-02');
  assert.notEqual(fresh.getState().draft!.id, 'saved-event');
});

test('original modal resumes legacy writing, keeps raw fields and preserves the rest of the calendar journal', t => {
  const records = setup(t, { id: 'event', epoch: 'epoch', revision: 0, value });
  const first = createCalendarEditor(options);
  first.getState().keepForm({ ...formForDraft(first.getState().draft!), title: '  Unsent original modal writing  ', category: 'education', reminder: 15 });
  first.getState().close();
  const resumed = createCalendarEditor(options);
  assert.equal(resumed.getState().open, false);
  resumed.getState().begin(undefined, new Date('2026-12-01T12:00:00'));
  assert.equal(formForDraft(resumed.getState().draft!).date, '2026-09-09');
  assert.equal(formForDraft(resumed.getState().draft!).title, '  Unsent original modal writing  ');
  assert.equal(formForDraft(resumed.getState().draft!).category, 'education');
  assert.equal(formForDraft(resumed.getState().draft!).reminder, 15);
  assert.equal(JSON.parse(records.get(key)!).retainedRefresh.requestId, 'old-refresh');
  const cloned = createCalendarEditor({ ...options, windowId: 'clone', previousWindowId: 'window' });
  cloned.getState().keepForm({ ...formForDraft(cloned.getState().draft!), title: 'Separate clone writing' });
  assert.equal(formForDraft(createCalendarEditor(options).getState().draft!).title, '  Unsent original modal writing  ');
});

test('a lost original-modal save replays the identical payload after reload and locks changes until acknowledged', async t => {
  setup(t, { id: 'event', epoch: 'epoch', revision: 0, value });
  const sent: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    if (sent.length === 1) throw new Error('Response deliberately lost after saving');
    return answer({ id: 'event', revision: 1, value });
  });
  const first = createCalendarEditor(options);
  first.getState().keepForm({ ...formForDraft(first.getState().draft!), category: 'work', reminder: 15, deliveryChannel: 'telegram' });
  await assert.rejects(first.getState().save(), /deliberately lost/);
  const resumed = createCalendarEditor(options), kept = resumed.getState().draft!;
  resumed.getState().keepForm({ ...formForDraft(kept), title: 'Cannot replace an unconfirmed payload' });
  assert.equal(resumed.getState().draft, kept);
  await resumed.getState().save();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal((sent[0] as any).value.category, 'work');
  assert.equal((sent[0] as any).value.reminderMinutes, 15);
  assert.equal((sent[0] as any).value.timezone, 'Asia/Tokyo');
  assert.equal(resumed.getState().draft, undefined);
  assert.match(resumed.getState().notice, /device display is tracked separately/);
});

test('series conflict review keeps original form writing and refreshes exception authority before an explicit save', async t => {
  const repeated = { ...value, repeat: { cadence: 'weekly' as const, interval: 2, weekdays: [3], count: 8 } };
  const detail: LocalCalendarDetail = { epoch: 'epoch', event: { id: 'event', deviceId: 'device', revision: 2, value: repeated, updatedAt: '', exceptionsRevision: 4, isSeries: true }, exceptionCount: 1, exceptions: [] };
  setup(t, draftForCalendar(detail, 'series'));
  const sent: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_: unknown, init: RequestInit) => {
    if (init.method === 'GET') return answer({ ...detail, event: { ...detail.event, revision: 3, exceptionsRevision: 5 }, exceptionCount: 2 });
    sent.push(JSON.parse(init.body as string));
    return sent.length === 1 ? answer({ code: 'calendar_event_changed', message: 'Another window changed this series', current: detail.event }, 409) : answer(detail.event);
  });
  const first = createCalendarEditor(options);
  first.getState().keepForm({ ...formForDraft(first.getState().draft!), title: 'My whole-series proposal' });
  first.getState().chooseExceptions('reset');
  await assert.rejects(first.getState().save(), /Another window/);
  const resumed = createCalendarEditor(options);
  await assert.rejects(resumed.getState().save(), /Review the current event/);
  assert.equal(sent.length, 1);
  await resumed.getState().review();
  assert.equal(formForDraft(resumed.getState().draft!).title, 'My whole-series proposal');
  assert.equal(resumed.getState().draft!.detail!.exceptionCount, 2);
  await resumed.getState().save();
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.equal(sent[1].expectedRevision, 3); assert.equal(sent[1].expectedExceptionsRevision, 5);
  assert.equal(sent[1].exceptions, 'reset'); assert.equal(sent[1].value.repeat.interval, 2); assert.equal(sent[1].value.repeat.count, 8);
});

test('a calendar refresh failure cannot resurrect an acknowledged draft or overwrite later writing', async t => {
  setup(t, { id: 'event', epoch: 'epoch', revision: 0, value });
  t.mock.method(globalThis, 'fetch', async () => answer({ id: 'event', revision: 1, value }));
  const editor = createCalendarEditor({ ...options, async changed() {
    editor.getState().begin(undefined, new Date('2026-10-10T12:00:00'));
    editor.getState().keepForm({ ...formForDraft(editor.getState().draft!), title: 'A different unsent event' });
    throw new Error('Refresh offline');
  } });
  await editor.getState().save();
  assert.notEqual(editor.getState().draft!.id, 'event');
  assert.equal(editor.getState().open, true);
  assert.equal(formForDraft(editor.getState().draft!).title, 'A different unsent event');
  assert.equal(editor.getState().draft!.pending, undefined);
});


test('reminder targets keep separate occurrence and series writing, including pending saves, across reload', t => {
  const master = { id: 'series', deviceId: 'device', revision: 1, updatedAt: '', isSeries: true, value: { ...value, repeat: { cadence: 'daily' as const, interval: 1, weekdays: [] } } };
  const detail = (date: string): LocalCalendarDetail => ({ epoch: 'epoch', event: master, exceptionCount: 0, exceptions: [], occurrence: { ...master, id: 'series@'+date, eventId: master.id, originalDate: date, overrideRevision: 0, series: master, value: { ...value, start: { ...value.start, date } } } });
  const first = draftForCalendar(detail('2026-09-09'), 'occurrence');
  const pending = { requestId: 'kept-exact-request', epoch: 'epoch', eventId: 'series', expectedRevision: 1, value: first.value, scope: 'occurrence' as const, originalDate: first.originalDate, expectedOverrideRevision: 0 };
  setup(t, { ...first, pending }); const editor = createCalendarEditor(options);
  editor.getState().openSaved(detail('2026-09-10')); assert.equal(editor.getState().scopeEvent?.originalDate, '2026-09-10'); assert.equal(editor.getState().keptDrafts.length, 1);
  editor.getState().choose(draftForCalendar(detail('2026-09-10'), 'occurrence'));
  editor.getState().keepForm({ ...formForDraft(editor.getState().draft!), title: 'Second date writing' });
  editor.getState().openSaved(detail('2026-09-09')); assert.deepEqual(editor.getState().draft?.pending, pending); assert.equal(editor.getState().keptDrafts[0].originalDate, '2026-09-10');
  const resumed=createCalendarEditor(options); resumed.getState().resumeKept(calendarDraftKey(resumed.getState().keptDrafts[0])); assert.equal(formForDraft(resumed.getState().draft!).title, 'Second date writing'); assert.deepEqual(resumed.getState().keptDrafts[0].pending, pending);
  resumed.getState().openSaved({ ...detail('2026-09-09'), occurrence: undefined }); resumed.getState().choose(draftForCalendar(detail('2026-09-09'), 'series'));
  resumed.getState().keepForm({ ...formForDraft(resumed.getState().draft!), title: 'Entire series writing' });
  resumed.getState().openSaved(detail('2026-09-11')); resumed.getState().choose(draftForCalendar(detail('2026-09-11'), 'series'));
  assert.equal(formForDraft(resumed.getState().draft!).title, 'Entire series writing'); assert.equal(resumed.getState().keptDrafts.length, 2);
});
