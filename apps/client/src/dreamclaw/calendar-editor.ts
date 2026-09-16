import { createStore } from 'zustand/vanilla';
import type { CalendarSourceRef, LocalCalendarDetail, LocalCalendarEvent, LocalCalendarOccurrence, LocalEventInput } from '../../../../packages/domain/calendar';
import type { ProviderCalendarEditable, ProviderCalendarPrepare, ProviderCalendarReview, ProviderCalendarTarget } from '../../../../packages/domain/calendar-write';
import { canonical } from '../../../../packages/domain/contracts';
import { ApiError, readLocal, request, saveLocal } from '../api';
import { calendarDraftKey, draftForCalendar, eventSaveCommand, reviewedEventDraft, type EventDraft, type OriginalCalendarForm } from '../calendar-edit';
import { calendarFormInput } from './calendar-projection';
import type { CalendarEvent } from './pages/Calendar/calendarTypes';
import { calendarGroupRemoved, calendarGroupUncertain, type CalendarGroupReview, type CalendarGroupAction } from '../../../../packages/domain/calendar-groups';

type Journal = { keptDrafts?: EventDraft[]; draft?: EventDraft; editorOpen?: boolean; [key: string]: unknown };
type Options = { epoch: string; deviceId: string; windowId: string; previousWindowId?: string; timezone: string; findLocal(event: CalendarEvent): LocalCalendarOccurrence; findProvider?(event: CalendarEvent): ProviderCalendarTarget; findSource?(id: string): CalendarSourceRef; changed(): Promise<void>; providerChanged?(source: CalendarSourceRef): Promise<void> };
export type CalendarEditorState = {
  keptDrafts: EventDraft[]; openSaved(detail: LocalCalendarDetail): void; resumeKept(id: string): void;
  draft?: EventDraft; open: boolean; source?: CalendarEvent; scopeEvent?: LocalCalendarOccurrence;
  providerScope?: CalendarEvent; openingProvider?: { event: CalendarEvent; scope: ProviderCalendarTarget['scope'] };
  busy: boolean; storageError: string; notice: string;
  begin(event?: CalendarEvent, date?: Date): void;
  choose(draft: EventDraft): void;
  close(): void;
  keepForm(form: OriginalCalendarForm): void;
  changeValue(patch: Partial<LocalEventInput>): void;
  chooseExceptions(policy: 'keep' | 'reset'): void;
  save(form?: OriginalCalendarForm, cancelled?: boolean): Promise<void>;
  review(): Promise<void>;
  keepAsNew(): void;
  openProvider(event: CalendarEvent, scope: ProviderCalendarTarget['scope']): Promise<void>;
  saveProvider(action: ProviderCalendarPrepare['action'], form?: OriginalCalendarForm): Promise<void>;
  checkProvider(): Promise<void>;
  confirmProvider(decision: 'confirm' | 'cancel', acknowledgeNotifications?: boolean): Promise<void>;
  reviewProvider(): Promise<void>;
  refreshProvider(): Promise<void>;
  editProvider(): void;
  finishProvider(): void;
  replaceProvider(field: 'replaceDescription' | 'replaceRecurrence', value: boolean): void;
  prepareGroup(seriesIds: string[], label: string): Promise<void>;
  checkGroup(): Promise<void>;
  groupAction(action: CalendarGroupAction['action'], acknowledgeNotifications?: boolean): Promise<void>;
  finishGroup(): void;
};

export const providerDraftLocked = (draft?: EventDraft) => Boolean(draft?.provider?.prepare || draft?.provider?.operation || draft?.provider?.confirmation || draft?.provider?.group);

export function formForDraft(draft: EventDraft): OriginalCalendarForm {
  const v = draft.value;
  return draft.originalForm ?? { title: v.title, date: v.start.date, startTime: v.allDay ? '' : v.start.time, endTime: v.allDay ? '' : v.end.time, allDay: v.allDay,
    location: v.location, notes: v.notes, category: v.category ?? 'other', reminder: draft.provider?.editable ? -1 : v.reminderMinutes ?? 0, allDayReminder: v.allDayReminder,
    recurrence: draft.scope === 'occurrence' ? '' : v.repeat?.cadence ?? '', deliveryChannel: v.deliveryChannel ?? 'last', destinationId: draft.provider?.source.id ?? 'local' };
}
export function eventForDraft(draft: EventDraft): CalendarEvent {
  const f = formForDraft(draft), v = draft.value;
  return { id: draft.id, title: f.title, date: f.date, startTime: f.startTime, endTime: f.endTime, allDay: f.allDay,
    source: draft.provider?.source.provider ?? 'local', notes: f.notes, location: f.location, category: f.category, reminderMinutes: f.reminder, allDayReminder: f.allDayReminder,
    ...(draft.provider ? { sourceAccount: draft.provider.source.accountId, calendarId: draft.provider.source.calendarId, calendarName: draft.provider.source.name,
      readOnly: !draft.provider.source.providerCanWrite || !draft.provider.source.accountCanWrite,
      externalId: draft.provider.editable?.target.eventId, recurringEventId: draft.provider.editable?.target.seriesId, recurrenceInstanceKey: draft.provider.editable?.target.originalStart } : {}),
    deliveryChannel: f.deliveryChannel, reminderStatus: f.reminder ? 'pending' : 'none',
    recurrence: f.recurrence ? { freq: f.recurrence, interval: v.repeat?.interval ?? 1 } : undefined,
    status: v.state === 'cancelled' ? 'cancelled' : 'scheduled', createdAt: '', updatedAt: '',
  };
}

export function valueForDraft(draft: EventDraft, fields = formForDraft(draft)): LocalEventInput {
  const base = draft.value;
  return calendarFormInput({ title: fields.title || ' ', date: fields.date, startTime: fields.startTime, endTime: fields.endTime,
    allDay: fields.allDay, location: fields.location, notes: fields.notes, category: fields.category,
    reminderMinutes: fields.reminder < 0 ? base.reminderMinutes : fields.allDay && !draft.provider && fields.destinationId === 'local' ? 0 : fields.reminder, allDayReminder: fields.allDay ? fields.allDayReminder : null, deliveryChannel: fields.deliveryChannel,
    recurrence: fields.recurrence ? { freq: fields.recurrence, interval: base.repeat?.interval ?? 1 } : undefined,
    status: base.state === 'cancelled' ? 'cancelled' : 'scheduled' }, base.timezone, base);
}

function rebaseProviderDraft(draft: EventDraft, current: ProviderCalendarEditable): EventDraft {
  const provider = draft.provider!, previous = provider.editable!.value, proposed = valueForDraft(draft);
  const equal = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
  const value = { ...current.value };
  for (const key of Object.keys(proposed) as (keyof LocalEventInput)[]) if (!equal(proposed[key], previous[key])) Object.assign(value, { [key]: proposed[key] });
  if (previous.repeat && !proposed.repeat) delete value.repeat;
  if ((['start', 'end', 'timezone', 'allDay'] as const).some(key => !equal(proposed[key], previous[key]))) Object.assign(value, { start: proposed.start, end: proposed.end, timezone: proposed.timezone, allDay: proposed.allDay });
  const next: EventDraft = { ...draft, value, originalForm: undefined, provider: { ...provider, source: current.source, editable: current, current: undefined, prepare: undefined, operation: undefined, confirmation: undefined }, error: undefined };
  next.originalForm = { ...formForDraft(next), reminder: formForDraft(draft).reminder };
  return next;
}

// Reuses the same E3 journal, payload-bound save commands and explicit revision
// review as LocalEventEditor. The original Dream Claw modal supplies its fields.
export function createCalendarEditor(options: Options) {
  const key = `e3:calendar:${options.deviceId}:${options.windowId}`;
  const previousKey = options.previousWindowId ? `e3:calendar:${options.deviceId}:${options.previousWindowId}` : undefined;
  const initial = readLocal<Journal>(key) ?? (previousKey ? readLocal<Journal>(previousKey) : undefined) ?? {};
  let generation = 0;
  return createStore<CalendarEditorState>((set, get) => {
    const persist = (draft: EventDraft | undefined, open = get().open, keptDrafts = get().keptDrafts, required = false) => {
      const journal = { ...(readLocal<Journal>(key) ?? initial), draft, editorOpen: open, keptDrafts };
      const ok = saveLocal(key, journal);
      if (!ok && required) { set({ storageError: 'Free browser storage before switching event drafts. Your current writing is kept.' }); return false; }
      set({ draft, open, keptDrafts, storageError: ok ? '' : 'Browser storage is full. Keep this window open until your writing is saved.' });
      return ok;
    };
    const keepRequired = (draft: EventDraft) => { if (!persist(draft, get().open, get().keptDrafts, true)) throw new Error(get().storageError); };
    const park = () => {
      const draft = get().draft;
      if (!draft) return true;
      const kept = get().keptDrafts.filter(item => calendarDraftKey(item) !== calendarDraftKey(draft));
      if (kept.length >= 20) { set({ notice: 'Finish a kept Calendar draft before opening another event.' }); return false; }
      return persist(undefined, false, [...kept, draft], true);
    };
    const receiveProvider = (draft: EventDraft, operation: ProviderCalendarReview) => {
      const provider = draft.provider!;
      if (operation.epoch !== draft.epoch || operation.writerId !== provider.writerId || operation.source.id !== provider.source.id
        || provider.operation && operation.id !== provider.operation.id) throw new Error('This result belongs to another Calendar operation. Your original proposal is kept.');
      const separateProposal = provider.separateProposal || Boolean(provider.prepare?.value && operation.value && canonical(provider.prepare.value) !== canonical(operation.value));
      keepRequired({ ...draft, provider: { ...provider, operation, separateProposal }, error: undefined });
    };
    const runProvider = async (run: (draft: EventDraft) => Promise<void>) => {
      const draft = get().draft;
      if (!draft?.provider || get().busy) return;
      set({ busy: true });
      try { await run(draft); }
      catch (error) { const current = get().draft; if (current && calendarDraftKey(current) === calendarDraftKey(draft)) persist({ ...current, error: error instanceof Error ? error.message : 'The result could not be checked. Your event writing is kept.' }); }
      finally { set({ busy: false }); }
    };
    const currentProviderSource = (source: CalendarSourceRef) => {
      const current = options.findSource?.(source.id);
      if (!current || current.id !== source.id || current.provider !== source.provider || current.accountId !== source.accountId || current.calendarId !== source.calendarId) throw new Error('Refresh the original Calendar account before resuming this draft. Your writing is kept.');
      return current;
    };
    const readCurrentProvider = async (draft: EventDraft) => {
      const provider = draft.provider!, source = currentProviderSource(provider.source);
      const target = { ...provider.editable!.target, generation: source.generation };
      const current = await request<ProviderCalendarEditable>('calendar/write/open', { epoch: draft.epoch, target });
      if (current.epoch !== draft.epoch || canonical(current.target) !== canonical(target)
        || current.source.id !== source.id || current.source.accountId !== source.accountId || current.source.provider !== source.provider || current.source.calendarId !== source.calendarId
        || current.source.generation !== source.generation || currentProviderSource(source).generation !== source.generation) throw new Error('The current event does not match this kept proposal or its connection changed. Your writing is kept.');
      return current;
    };
    const receiveGroup = (draft: EventDraft, operation: CalendarGroupReview) => {
      const provider = draft.provider!, group = provider.group!;
      if (operation.epoch !== draft.epoch || operation.writerId !== provider.writerId || operation.source.id !== provider.source.id || operation.source.provider !== provider.source.provider || operation.source.accountId !== provider.source.accountId || operation.source.calendarId !== provider.source.calendarId
        || group.operation && operation.id !== group.operation.id) throw new Error('This result does not belong to the original schedule review. Your selection is kept.');
      const otherSelection = canonical([...group.prepare.seriesIds].sort()) !== canonical(operation.items.map(item => item.seriesId).sort());
      keepRequired({ ...draft, provider: { ...provider, group: { ...group, operation, command: undefined, otherSelection } }, error: undefined });
    };
    return {
      keptDrafts: initial.keptDrafts ?? [], draft: initial.draft, open: Boolean(initial.editorOpen && initial.draft), busy: false, storageError: '', notice: '',
      openSaved(detail) {
        if (get().busy) throw new Error('Wait for the current Calendar save before opening another event.');
        const current=get().draft;
        const matches = (draft: EventDraft) => draft.id === detail.event.id && (detail.occurrence?.originalDate ? draft.scope === 'occurrence' && draft.originalDate === detail.occurrence.originalDate : draft.scope !== 'occurrence');
        if(current && matches(current)){persist(current,true);return;}
        const saved=get().keptDrafts.find(matches);
        const parked=get().keptDrafts.filter(draft=>!matches(draft)&&(!current||calendarDraftKey(draft)!==calendarDraftKey(current)));
        if(current)parked.push(current);
        if(parked.length>20)throw new Error('Finish a kept Calendar draft before opening another event.');
        if(saved){if(!persist(saved,true,parked,true))throw new Error(get().storageError);}
        else if(detail.event.isSeries||detail.event.value.repeat){
          if(!persist(undefined,false,parked,true))throw new Error(get().storageError);
          set({scopeEvent:detail.occurrence ?? {...detail.event,eventId:detail.event.id,overrideRevision:0},source:undefined,notice:''});return;
        }else if(!persist(draftForCalendar(detail,'event'),true,parked,true))throw new Error(get().storageError);
        set({source:undefined,scopeEvent:undefined,notice:''});
      },
      resumeKept(id) {
        const candidates=get().keptDrafts.filter(draft=>calendarDraftKey(draft)===id||draft.id===id);const draft=candidates.length===1?candidates[0]:undefined;if(!draft||get().busy)return;
        const current=get().draft,parked=get().keptDrafts.filter(kept=>calendarDraftKey(kept)!==calendarDraftKey(draft)&&(!current||calendarDraftKey(kept)!==calendarDraftKey(current)));if(current)parked.push(current);
        if(persist(draft,true,parked,true))set({source:undefined,scopeEvent:undefined,notice:''});
      },
      begin(event, date = new Date()) {
        if (get().busy) return;
        if (!event && get().draft) { persist(get().draft, true); return; }
        if (event && event.source !== 'local') {
          if (!park()) return;
          if (['google', 'microsoft'].includes(event.source)) {
            if (event.recurringEventId) set({ providerScope: event, scopeEvent: undefined, source: undefined, notice: '' });
            else void get().openProvider(event, 'event');
          } else set({ source: event, open: true });
          return;
        }
        if (event) {
          const local = options.findLocal(event);
          const matches = (draft: EventDraft) => !draft.provider && draft.id === local.eventId && draft.originalDate === local.originalDate;
          if (get().draft && matches(get().draft!)) { persist(get().draft, true); return; }
          if (!park()) return;
          const kept = get().keptDrafts.find(matches);
          if (kept) { get().resumeKept(calendarDraftKey(kept)); return; }
          if (local.originalDate) { set({ scopeEvent: local, source: undefined }); return; }
          persist({ id: local.eventId, epoch: options.epoch, revision: local.revision, value: local.value, scope: 'event' }, true);
        } else {
          const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          persist({ id: crypto.randomUUID(), epoch: options.epoch, revision: 0, value: { title: '', notes: '', location: '', timezone: options.timezone, allDay: false,
            start: { date: day, time: '09:00' }, end: { date: day, time: '10:00' }, state: 'confirmed', projectId: null, taskId: null,
            category: 'other', reminderMinutes: 30, deliveryChannel: 'last' } }, true);
        }
        set({ source: undefined, notice: '' });
      },
      choose(draft) { if (get().busy) return; const key=calendarDraftKey(draft), kept=get().keptDrafts.find(item=>calendarDraftKey(item)===key); if(kept){get().resumeKept(key);return;} if(persist(draft, true, get().keptDrafts, true))set({ scopeEvent: undefined, source: undefined, notice: '' }); },
      close() {
        if (get().openingProvider) { generation++; set({ busy: false }); }
        persist(get().draft, false); set({ source: undefined, scopeEvent: undefined, providerScope: undefined, openingProvider: undefined });
      },
      keepForm(form) {
        const draft = get().draft;
        if (!draft || get().busy || draft.pending || draft.review || providerDraftLocked(draft)) return;
        persist({ ...draft, originalForm: form, error: undefined });
      },
      changeValue(patch) {
        const draft = get().draft;
        if (!draft || get().busy || draft.pending || draft.review || providerDraftLocked(draft)) return;
        const value = { ...valueForDraft(draft), ...patch };
        const fields = formForDraft(draft);
        persist({ ...draft, value, originalForm: { ...fields,
          date: value.start.date, startTime: value.start.time, endTime: value.end.time,
          recurrence: draft.scope === 'occurrence' ? '' : value.repeat?.cadence ?? '',
        }, error: undefined });
      },
      chooseExceptions(exceptions) {
        const draft = get().draft;
        if (draft && !get().busy && !draft.pending && !draft.review) persist({ ...draft, exceptions, error: undefined });
      },
      async save(form, cancelled = false) {
        if (get().busy) return;
        let draft = get().draft;
        if (!draft) throw new Error('Open a local event before saving.');
        if (draft.provider && !draft.provider.editable && !providerDraftLocked(draft) && (form ?? formForDraft(draft)).destinationId === 'local') {
          draft = { ...draft, provider: undefined }; keepRequired(draft);
        }
        if (draft.provider || (form ?? formForDraft(draft)).destinationId !== 'local') {
          await get().saveProvider(cancelled ? 'delete' : draft.provider?.editable ? 'update' : 'create', form); return;
        }
        if (draft.review) throw new Error('Review the current event before submitting your kept changes.');
        if (!draft.pending) {
          const fields = form ?? formForDraft(draft);
          if (fields.destinationId !== 'local') throw new Error('Connected-calendar editing is not available yet. Your form is kept.');
          const value = valueForDraft(draft, fields);
          if (cancelled) value.state = 'cancelled';
          draft = { ...draft, value, originalForm: fields };
        }
        const command = eventSaveCommand(draft, crypto.randomUUID());
        if (!persist({ ...draft, pending: command, error: undefined })) throw new Error(get().storageError);
        const ownGeneration = ++generation; set({ busy: true });
        try {
          await request<LocalCalendarEvent>('calendar/local', command);
          if (ownGeneration !== generation) return;
          persist(undefined, false);
          set({ source: undefined, notice: command.value.reminderMinutes || command.value.allDayReminder ? 'Event saved. Review its reminder in the bell menu; device display is tracked separately.' : 'Event saved.' });
        } catch (error) {
          if (ownGeneration !== generation) return;
          const kept = get().draft ?? draft;
          const next = { ...kept, error: error instanceof Error ? error.message : 'The event save is unconfirmed. Reconcile the original request.' };
          if (error instanceof ApiError) {
            if (['calendar_event_changed', 'calendar_occurrence_changed', 'calendar_scope_required', 'calendar_series_cancelled', 'epoch_changed'].includes(error.code)) { next.review = true; next.current = error.current as unknown as LocalCalendarEvent; }
            else if (['validation', 'calendar_time', 'calendar_repeat', 'calendar_exception_policy', 'calendar_exception_limit', 'missing_project', 'calendar_task_changed'].includes(error.code)) next.pending = undefined;
          }
          persist(next); throw error;
        } finally { if (ownGeneration === generation) set({ busy: false }); }
        // A refresh failure cannot undo an acknowledged save or recreate its draft.
        try { await options.changed(); }
        catch { set({ notice: 'Event saved. Refresh the calendar to see its latest details.' }); }
      },
      async review() {
        const draft = get().draft;
        if (!draft || get().busy) return;
        set({ busy: true });
        try {
          const detail = await request<LocalCalendarDetail>(`calendar/local/${draft.id}${draft.originalDate ? '?' + new URLSearchParams({ originalDate: draft.originalDate }) : ''}`);
          persist(reviewedEventDraft(get().draft ?? draft, detail));
        } catch (error) { persist({ ...(get().draft ?? draft), error: error instanceof Error ? error.message : 'The current event could not be checked. Your writing is kept.' }); }
        finally { set({ busy: false }); }
      },
      keepAsNew() {
        const draft = get().draft; if (!draft || get().busy || draft.provider) return;
        const value = valueForDraft(draft);
        persist({ id: crypto.randomUUID(), epoch: options.epoch, revision: 0, value, originalForm: draft.originalForm, scope: value.repeat ? 'series' : 'event' });
      },
      async openProvider(event, scope) {
        if (get().busy || !options.findProvider) return;
        let target: ProviderCalendarTarget;
        try { target = { ...options.findProvider(event), scope }; }
        catch (error) { set({ notice: error instanceof Error ? error.message : 'Refresh Calendar before reopening this event.' }); return; }
        const matches = (draft: EventDraft) => draft.provider?.source.id === target.sourceId && draft.provider.editable?.target.scope === scope
          && (scope === 'series' ? draft.provider.editable.target.seriesId === target.seriesId : draft.provider.editable?.target.eventId === target.eventId);
        if (get().draft && matches(get().draft!)) { persist(get().draft, true); await get().refreshProvider(); return; }
        if (!park()) return;
        const kept = get().keptDrafts.find(matches);
        if (kept) { get().resumeKept(calendarDraftKey(kept)); set({ providerScope: undefined }); await get().refreshProvider(); return; }
        const ownGeneration = ++generation;
        set({ source: { ...event, readOnly: true }, open: true, busy: true, openingProvider: { event, scope }, providerScope: undefined, notice: '' });
        try {
          const editable = await request<ProviderCalendarEditable>('calendar/write/open', { epoch: options.epoch, target });
          if (generation !== ownGeneration) return;
          if (editable.epoch !== options.epoch || editable.source.id !== target.sourceId || editable.source.generation !== target.generation
            || editable.target.scope !== scope || editable.target.eventId !== (scope === 'series' ? target.seriesId ?? target.eventId : target.eventId)) throw new Error('The provider returned another event. Reopen the original Calendar entry.');
          const draft: EventDraft = { id: editable.event.id, epoch: editable.epoch, revision: 1, scope,
            subtaskTarget: { sourceId: target.sourceId, eventId: target.eventId, originalStart: target.originalStart },
            originalDate: scope === 'occurrence' ? target.originalStart : undefined, value: editable.value,
            provider: { writerId: crypto.randomUUID(), source: editable.source, editable } };
          keepRequired(draft);
          set({ source: undefined, openingProvider: undefined });
        } catch (error) { if (generation === ownGeneration) set({ notice: error instanceof Error ? error.message : 'The original event could not be read.' }); }
        finally { if (generation === ownGeneration) set({ busy: false }); }
      },
      async saveProvider(action, form) {
        let draft = get().draft;
        if (!draft || get().busy) return;
        const destination = (form ?? formForDraft(draft)).destinationId;
        if (draft.provider && !draft.provider.editable && !providerDraftLocked(draft)) {
          const source = options.findSource?.(destination);
          if (!source) throw new Error('Refresh the chosen Calendar before saving.');
          draft = { ...draft, provider: { ...draft.provider, source } }; keepRequired(draft);
        }
        if (!draft.provider) {
          const fields = form ?? formForDraft(draft), source = options.findSource?.(fields.destinationId);
          if (!source) throw new Error('Refresh the selected Calendar before saving. Your writing is kept.');
          draft = { ...draft, value: valueForDraft(draft, fields), originalForm: fields, provider: { writerId: draft.id, source } };
          keepRequired(draft);
        }
        if (providerDraftLocked(draft)) { await get().checkProvider(); return; }
        if (draft.provider?.editable && currentProviderSource(draft.provider.source).generation !== draft.provider.source.generation) {
          keepRequired({ ...draft, originalForm: form ?? formForDraft(draft) });
          await get().refreshProvider();
          draft = get().draft!;
          if (draft.error) return;
          form = formForDraft(draft);
        }
        const fields = form ?? formForDraft(draft), provider = draft.provider!;
        const input: ProviderCalendarPrepare = { requestId: crypto.randomUUID(), epoch: draft.epoch, writerId: provider.writerId,
          sourceId: provider.source.id, generation: provider.source.generation, action,
          ...(provider.editable ? { target: provider.editable.target, expectedVersion: provider.editable.version } : {}),
          ...(action !== 'delete' ? { value: valueForDraft(draft, fields) } : {}),
          replaceDescription: provider.replaceDescription ?? false, replaceRecurrence: provider.replaceRecurrence ?? false, replaceReminder: fields.reminder >= 0 };
        keepRequired({ ...draft, originalForm: fields, provider: { ...provider, prepare: input }, error: undefined });
        await get().checkProvider();
      },
      async checkProvider() {
        if (get().draft?.provider?.group) { await get().checkGroup(); return; }
        await runProvider(async draft => {
          const provider = draft.provider!, operation = provider.operation;
          let result: ProviderCalendarReview | undefined;
          try { result = operation
            ? await request<ProviderCalendarReview>(operation.state === 'unknown' ? 'calendar/write/reconcile' : 'calendar/write/read', { requestId: crypto.randomUUID(), epoch: draft.epoch, operationId: operation.id })
            : provider.prepare ? await request<ProviderCalendarReview>('calendar/write/prepare', provider.prepare) : undefined; }
          catch (error) {
            if (!operation && error instanceof ApiError && ['validation', 'calendar_source_changed'].includes(error.code)) keepRequired({ ...draft, provider: { ...provider, prepare: undefined } });
            const current = error instanceof ApiError ? error.current as unknown as { operationId?: unknown } | undefined : undefined;
            if (!operation && error instanceof ApiError && ['calendar_writer_saved', 'calendar_operation_pending'].includes(error.code) && typeof current?.operationId === 'string') {
              const saved = await request<ProviderCalendarReview>('calendar/write/read', { requestId: crypto.randomUUID(), epoch: draft.epoch, operationId: current.operationId });
              receiveProvider(draft, saved); return;
            }
            throw error;
          }
          if (result?.state === 'review' && provider.confirmation && result.revision === provider.confirmation.expectedRevision && result.digest === provider.confirmation.digest) {
            result = await request<ProviderCalendarReview>('calendar/write/confirm', provider.confirmation);
          }
          if (result) receiveProvider(draft, result);
        });
      },
      async confirmProvider(decision, acknowledgeNotifications = false) {
        await runProvider(async draft => {
          const provider = draft.provider!, operation = provider.operation;
          if (!operation || operation.state !== 'review' || !operation.digest) throw new Error('Check the current Calendar review before applying it.');
          // An unresolved confirmation retains its exact admission identity. Reading
          // the operation is sufficient to recover a lost affirmative response.
          if (provider.confirmation) throw new Error('Check the saved operation before making another decision.');
          const confirmation = { requestId: crypto.randomUUID(), epoch: draft.epoch, operationId: operation.id, expectedRevision: operation.revision,
            digest: operation.digest, decision, acknowledgeNotifications };
          keepRequired({ ...draft, provider: { ...provider, confirmation }, error: undefined });
          let result: ProviderCalendarReview;
          try { result = await request<ProviderCalendarReview>('calendar/write/confirm', confirmation); }
          catch (error) {
            if (error instanceof ApiError && ['calendar_guest_review', 'calendar_review_expired', 'calendar_review_changed'].includes(error.code)) keepRequired({ ...draft, provider: { ...provider, confirmation: undefined } });
            throw error;
          }
          receiveProvider(get().draft!, result);
        });
        if (decision === 'cancel' && get().draft?.provider?.operation?.state === 'cancelled') get().editProvider();
      },
      async reviewProvider() {
        await runProvider(async draft => {
          const provider = draft.provider!;
          if (!provider.editable || !['conflict', 'failed', 'cancelled'].includes(provider.operation?.state ?? '')) return;
          const current = await readCurrentProvider(draft);
          keepRequired({ ...draft, provider: { ...provider, current }, error: undefined });
        });
      },
      async refreshProvider() {
        await runProvider(async draft => {
          if (providerDraftLocked(draft)) return;
          if (draft.provider!.editable) keepRequired(rebaseProviderDraft(draft, await readCurrentProvider(draft)));
          else keepRequired({ ...draft, provider: { ...draft.provider!, source: currentProviderSource(draft.provider!.source) }, error: undefined });
          set({ notice: 'Current Calendar details refreshed. Your edits are kept.' });
        });
      },
      editProvider() {
        const draft = get().draft, provider = draft?.provider;
        if (!draft || !provider || get().busy || !['cancelled', 'failed', 'conflict'].includes(provider.operation?.state ?? '')) return;
        if (provider.editable && provider.operation?.state !== 'cancelled' && !provider.current) return;
        if (provider.current && provider.editable) { keepRequired(rebaseProviderDraft(draft, provider.current)); return; }
        const value = valueForDraft(draft);
        const next: EventDraft = { ...draft, value, originalForm: undefined, provider: { ...provider, editable: provider.current ?? provider.editable, current: undefined, prepare: undefined, operation: undefined, confirmation: undefined }, error: undefined };
        next.originalForm = { ...formForDraft(next), reminder: provider.prepare?.replaceReminder ? formForDraft(draft).reminder : next.provider?.editable ? -1 : value.reminderMinutes ?? 0 };
        keepRequired(next);
      },
      finishProvider() {
        const draft = get().draft;
        if (!draft?.provider || get().busy || !['confirmed', 'observed'].includes(draft.provider.operation?.state ?? '')) return;
        if (draft.provider.separateProposal) {
          const id = crypto.randomUUID();
          keepRequired({ id, epoch: options.epoch, revision: 0, value: valueForDraft(draft), originalForm: formForDraft(draft),
            provider: { writerId: id, source: draft.provider.source } });
          set({ notice: 'Your different proposal is kept as a separate new event. Review it before saving.' }); return;
        }
        if (!persist(undefined, false, get().keptDrafts, true)) return;
        set({ source: undefined, notice: draft.provider.operation?.detail ?? 'Calendar updated.' });
        void (options.providerChanged?.(draft.provider.source) ?? options.changed()).catch(() => set({ notice: 'The provider result is saved. Refresh Calendar to see its latest schedule.' }));
      },
      replaceProvider(field, value) {
        const draft = get().draft;
        if (!draft?.provider || get().busy || providerDraftLocked(draft)) return;
        keepRequired({ ...draft, provider: { ...draft.provider, [field]: value } });
      },
      async prepareGroup(seriesIds, label) {
        const draft = get().draft, provider = draft?.provider;
        if (!draft || !provider?.editable || get().busy) return;
        if (providerDraftLocked(draft)) throw new Error('Finish the retained Calendar review before choosing another schedule.');
        const source = currentProviderSource(provider.source);
        keepRequired({ ...draft, provider: { ...provider, group: { prepare: { requestId: crypto.randomUUID(), epoch: draft.epoch, writerId: provider.writerId, sourceId: source.id, generation: source.generation, seriesIds, label } } }, error: undefined });
        await get().checkGroup();
      },
      async checkGroup() {
        await runProvider(async draft => {
          const group = draft.provider!.group; if (!group) return;
          let result: CalendarGroupReview;
          try {
            result = group.operation
              ? await request<CalendarGroupReview>(group.operation.items.some(calendarGroupUncertain) ? 'calendar/groups/reconcile' : 'calendar/groups/read', { requestId: crypto.randomUUID(), epoch: draft.epoch, operationId: group.operation.id })
              : await request<CalendarGroupReview>('calendar/groups/prepare', group.prepare);
          } catch (error) {
            if (!group.operation && error instanceof ApiError && ['validation', 'calendar_source_changed'].includes(error.code)) keepRequired({ ...draft, provider: { ...draft.provider!, group: undefined } });
            const current = error instanceof ApiError ? error.current as unknown as { operationId?: unknown } | undefined : undefined;
            if (!group.operation && error instanceof ApiError && error.code === 'calendar_group_pending' && typeof current?.operationId === 'string') {
              result = await request<CalendarGroupReview>('calendar/groups/read', { requestId: crypto.randomUUID(), epoch: draft.epoch, operationId: current.operationId });
            } else throw error;
          }
          if (group.command && result.revision === group.command.expectedRevision && !result.closed) result = await request<CalendarGroupReview>('calendar/groups/action', group.command);
          receiveGroup(draft, result);
        });
      },
      async groupAction(action, acknowledgeNotifications = false) {
        await runProvider(async draft => {
          const group = draft.provider!.group, operation = group?.operation;
          if (!group || !operation || group.command) throw new Error('Check the original schedule request before making another decision.');
          const command: CalendarGroupAction = { requestId: crypto.randomUUID(), epoch: draft.epoch, operationId: operation.id, expectedRevision: operation.revision, action, digest: operation.digest, acknowledgeNotifications };
          keepRequired({ ...draft, provider: { ...draft.provider!, group: { ...group, command } }, error: undefined });
          try { receiveGroup(get().draft!, await request<CalendarGroupReview>('calendar/groups/action', command)); }
          catch (error) {
            if (error instanceof ApiError && ['calendar_group_changed', 'calendar_group_guests', 'calendar_group_uncertain'].includes(error.code)) keepRequired({ ...draft, provider: { ...draft.provider!, group: { ...group, command: undefined } } });
            throw error;
          }
        });
      },
      finishGroup() {
        const draft = get().draft, provider = draft?.provider, group = provider?.group, operation = group?.operation;
        if (!draft || !provider || !group || !operation?.closed || get().busy) return;
        const originalRemoved = operation.items.some(item => calendarGroupRemoved(item) && item.seriesId === provider.editable?.target.seriesId);
        if (group.otherSelection && originalRemoved) {
          const id = crypto.randomUUID(); keepRequired({ id, epoch: options.epoch, revision: 0, value: valueForDraft(draft), originalForm: formForDraft(draft), provider: { writerId: id, source: operation.source } });
          set({ notice: 'The original selection was completed in another window. Your different writing is kept as a separate new event.' });
        } else if (originalRemoved) {
          if (!persist(undefined, false, get().keptDrafts, true)) return;
          set({ source: undefined, notice: operation.detail });
        } else {
          keepRequired({ ...draft, provider: { ...provider, group: undefined }, error: undefined });
          set({ notice: operation.detail });
        }
        void (options.providerChanged?.(operation.source) ?? options.changed()).catch(() => set({ notice: 'Schedule results are saved. Refresh Calendar to see its latest dates.' }));
      },
    };
  });
}
