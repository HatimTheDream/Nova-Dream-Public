import { CalendarMailSource } from '../../../CalendarMailSource';
// ═══════════════════════════════════════════════════════════
// EventModal — Add / Edit / Delete event with full i18n
// State machine: 'form' | 'confirmDelete'
// ═══════════════════════════════════════════════════════════

import { useState, useEffect, useMemo, useRef, useId, Children, cloneElement, isValidElement } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useCalendarHost, useCalendarEditor } from '@dreamclaw/stores/calendarStore';
import { formForDraft, providerDraftLocked } from '@dreamclaw/calendar-editor';
import type { OriginalCalendarForm } from '../../../calendar-edit';
import { CalendarDraftDetails } from './CalendarDraftDetails';
import { ProviderCalendarReview } from './ProviderCalendarReview';
import { ProviderCalendarGroupReview } from './ProviderCalendarGroupReview';
import { CalendarDays, X, Trash2, ArrowRight, Globe, HardDrive, CheckCircle } from '@dreamclaw/components/icons';
import { useCalendarStore } from '@dreamclaw/stores/calendarStore';
import { toDateStr } from './calendarUtils';
import { ALL_CATEGORIES, REMINDER_PRESETS, SOURCE_META } from './calendarTypes';
import type { CalendarEvent, EventCategory, RecurrenceFreq, DeliveryChannel } from './calendarTypes';
import { fetchDeliveryChannels, getFallbackDeliveryChannels, type DeliveryChannelOption } from './deliveryChannels';
import {
  calendarScheduleLabel,
  calendarSeriesId,
  relatedCalendarSeries,
  type CalendarDeleteScope,
} from '@dreamclaw/services/calendar/seriesDeletion';

interface EventModalProps {
  onClose: () => void;
  initialDate?: Date;
  editEvent?: CalendarEvent | null;
}

type ModalMode = 'form' | 'confirmDelete';
type DeleteChoice = CalendarDeleteScope | 'custom';
type CalendarDestination = {
  id: string;
  provider: 'local' | 'google' | 'microsoft';
  accountId?: string;
  accountEmail?: string;
  calendarId?: string;
  calendarName: string;
  isDefault: boolean;
  canWrite: boolean;
  needsPermission?: boolean;
  unavailableReason?: string;
};

const LAST_CALENDAR_DESTINATION_KEY = 'e3:calendar:last-destination';

function calendarDestinationLabel(destination: CalendarDestination): string {
  if (destination.provider === 'local') return 'Nova Dream only';
  const provider = destination.provider === 'google' ? 'Google' : 'Outlook';
  const calendar = destination.calendarName === destination.accountEmail ? 'Primary calendar' : destination.calendarName;
  return `${provider} · ${calendar}${destination.accountEmail ? ` · ${destination.accountEmail}` : ''}`;
}

// Reminder preset key mapping
const REMINDER_KEYS: Record<number, string> = {
  0: 'calendar.reminder.none',
  5: 'calendar.reminder.5min',
  15: 'calendar.reminder.15min',
  30: 'calendar.reminder.30min',
  60: 'calendar.reminder.1hour',
  120: 'calendar.reminder.2hours',
  1440: 'calendar.reminder.1day',
  10080: 'calendar.reminder.1week',
};

// Recurrence key mapping
const RECURRENCE_KEYS: Record<string, string> = {
  '': 'calendar.recurrence.none',
  daily: 'calendar.recurrence.daily',
  weekly: 'calendar.recurrence.weekly',
  monthly: 'calendar.recurrence.monthly',
  yearly: 'calendar.recurrence.yearly',
};

export function EventModal({ onClose, initialDate, editEvent }: EventModalProps) {
  const { t } = useTranslation();
  const host = useCalendarHost();
  const editor = useCalendarEditor();
  const navigate = host.navigate;
  const { addEvent, updateEvent, deleteEvent, events, settings } = useCalendarStore();

  const isEdit = !!editEvent;
  const isReadOnlyEvent = Boolean(editEvent?.readOnly);
  const sourceLabel = editEvent ? SOURCE_META[editEvent.source].label : '';
  const [mode, setMode] = useState<ModalMode>('form');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<DeleteChoice>('event');
  const [selectedSeriesIds, setSelectedSeriesIds] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<CalendarDestination[]>([
    { id: 'local', provider: 'local', calendarName: 'Nova Dream only', isDefault: true, canWrite: true },
  ]);
  const [destinationsLoading, setDestinationsLoading] = useState(!isEdit);
  const permissionDestinations = destinations.filter((destination) => destination.needsPermission);

  // Keep display timezone conversion separate from the original event’s editable wall times.
  const formEvent = editEvent ? host.editingValues(editEvent) : undefined;
  // The original fields write directly to E3's retained journal. Read-only source
  // events use a separate local form, so opening them cannot overwrite a draft.
  const [sourceForm, setSourceForm] = useState<OriginalCalendarForm>(() => ({
    title: formEvent?.title || '', date: formEvent?.date || toDateStr(initialDate ?? new Date()),
    startTime: formEvent?.startTime || '', endTime: formEvent?.endTime || '', allDay: formEvent?.allDay ?? false,
    location: formEvent?.location || '', notes: formEvent?.notes || '', category: formEvent?.category || 'other',
    reminder: formEvent?.reminderMinutes ?? settings.defaultReminder, allDayReminder: formEvent?.allDayReminder, recurrence: formEvent?.recurrence?.freq || '',
    deliveryChannel: formEvent?.deliveryChannel || settings.defaultDeliveryChannel, destinationId: 'local',
  }));
  const form = editor.draft ? formForDraft(editor.draft) : sourceForm;
  const { title, date, startTime, endTime, allDay, location, notes, category, reminder, recurrence, deliveryChannel, destinationId } = form;
  const setField = <K extends keyof OriginalCalendarForm>(key: K, value: OriginalCalendarForm[K]) => {
    const next = { ...form, [key]: value };
    setSaveError(null);
    if (editor.draft) editor.keepForm(next); else setSourceForm(next);
  };
  const setTitle = (v: string) => setField('title', v), setDate = (v: string) => setField('date', v);
  const setStartTime = (v: string) => setField('startTime', v), setEndTime = (v: string) => setField('endTime', v);
  const setAllDay = (v: boolean) => setField('allDay', v), setLocation = (v: string) => setField('location', v);
  const setNotes = (v: string) => setField('notes', v), setCategory = (v: EventCategory) => setField('category', v);
  const setReminder = (v: number) => setField('reminder', v), setRecurrence = (v: RecurrenceFreq | '') => setField('recurrence', v);
  const setDeliveryChannel = (v: DeliveryChannel) => setField('deliveryChannel', v), setDestinationId = (v: string) => setField('destinationId', v);
  const providerEvent = Boolean(editor.draft?.provider || destinationId !== 'local');
  const providerLocked = providerDraftLocked(editor.draft);
  const locked = isReadOnlyEvent || saving || editor.busy || Boolean(editor.draft?.pending || editor.draft?.review) || providerLocked;
  const endsNextDay = !allDay && Boolean(startTime && endTime && endTime <= startTime);
  const [deliveryOptions, setDeliveryOptions] = useState<DeliveryChannelOption[]>(
    () => getFallbackDeliveryChannels(formEvent?.deliveryChannel || settings.defaultDeliveryChannel)
  );
  const currentSeriesId = editEvent ? calendarSeriesId(editEvent) : undefined;
  const relatedSeries = useMemo(
    () => editEvent ? relatedCalendarSeries(events, { ...editEvent, title: editor.draft?.provider?.editable?.value.title ?? editEvent.title }) : [],
    [editEvent, events, editor.draft?.provider?.editable?.value.title],
  );
  const currentSeries = relatedSeries.find((choice) => choice.seriesId === currentSeriesId);
  const scheduleLabel = editEvent ? calendarScheduleLabel(editor.draft?.provider?.editable?.value.title ?? editEvent.title) : '';

  useEffect(() => {
    setDeleteChoice(editor.draft?.provider?.editable?.target.scope === 'series' ? 'series' : 'event');
    setSelectedSeriesIds(currentSeriesId ? [currentSeriesId] : []);
  }, [currentSeriesId, editor.draft?.provider?.editable?.target.scope]);

  useEffect(() => {
    let cancelled = false;

    fetchDeliveryChannels(host, deliveryChannel)
      .then((options) => {
        if (!cancelled) setDeliveryOptions(options);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [deliveryChannel]);

  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    const api = host;
    if (!api?.listDestinations) {
      setDestinationsLoading(false);
      return;
    }
    api.listDestinations()
      .then((result) => {
        if (cancelled) return;
        const options = result?.success && Array.isArray(result.destinations) && result.destinations.length > 0
          ? result.destinations.filter((destination) => destination?.id && (destination.canWrite || destination.needsPermission || destination.unavailableReason))
          : destinations;
        setDestinations(options);
        // Never replace a retained destination when an asynchronous read finishes.
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDestinationsLoading(false); });
    return () => { cancelled = true; };
  // The fallback destination is intentionally stable for the lifetime of the modal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit]);

  const handleSave = async () => {
    if ((!title.trim() && !editor.draft?.pending) || isReadOnlyEvent || saving || editor.busy || editor.draft?.review || providerLocked) return;
    setSaving(true);
    setSaveError(null);

    const destination = destinations.find((option) => option.id === destinationId) || destinations[0];

    const eventData = {
      title: title.trim(),
      date,
      startTime: allDay ? undefined : (startTime || undefined),
      endTime: allDay ? undefined : (endTime || undefined),
      allDay,
      location: location.trim() || undefined,
      notes: notes || undefined,
      category,
      reminderMinutes: allDay && !providerEvent ? 0 : reminder, allDayReminder: allDay ? form.allDayReminder : null,
      deliveryChannel,
      recurrence: recurrence ? { freq: recurrence, interval: 1 } : undefined,
      status: 'scheduled' as const,
      ...(!isEdit ? {
        destinationProvider: destination?.provider || 'local',
        sourceAccount: destination?.accountId,
        calendarId: destination?.calendarId,
        calendarName: destination?.calendarName,
      } : {}),
    };

    try {
      if (isEdit && editEvent) {
        await updateEvent(editEvent.id, eventData, editEvent);
      } else {
        await addEvent(eventData as any);
        if (destination?.id) { try { window.localStorage.setItem(LAST_CALENDAR_DESTINATION_KEY, destination.id); } catch { /* The host already acknowledged this save. */ } }
      }
      // The retained local editor closes only its own acknowledged draft. A later
      // refresh must not close a different editor the user has opened meanwhile.
      if (!editor.draft) onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The event could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const state = host.editor.getState();
    if (state.draft?.pending && !state.draft.review) void state.save().catch(() => {});
  }, [host]);

  // Keep a stable ref to handleSave so keyboard shortcut always uses latest form values
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // Keyboard: Escape to close, Ctrl+Enter to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'confirmDelete') setMode('form');
        else onClose();
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && mode === 'form') {
        e.preventDefault();
        handleSaveRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, onClose]);

  const handleDelete = async () => {
    if (!editEvent || locked) return;
    const scope: CalendarDeleteScope = deleteChoice === 'custom' ? 'schedule' : deleteChoice;
    const seriesIds = scope === 'schedule'
      ? deleteChoice === 'custom' ? selectedSeriesIds : relatedSeries.map((choice) => choice.seriesId)
      : undefined;
    if (scope === 'schedule' && (!seriesIds || seriesIds.length === 0)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await deleteEvent(editEvent.id, scope, seriesIds, editEvent);
      setMode('form');
      if (!editor.draft) onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The event could not be deleted. Try again.');
      setMode('form');
    } finally {
      setSaving(false);
    }
  };

  // ── Confirm Delete View ──
  if (mode === 'confirmDelete') {
    const recurring = Boolean(currentSeriesId && (editEvent?.source === 'google' || editEvent?.source === 'microsoft'));
    const customSelectionEmpty = deleteChoice === 'custom' && selectedSeriesIds.length === 0;
    const deleteButtonLabel = saving
      ? 'Deleting…'
      : deleteChoice === 'series'
        ? `Delete every ${currentSeries?.weekday || 'recurring date'}`
        : deleteChoice === 'schedule'
          ? `Delete all ${relatedSeries.length} recurring days`
          : deleteChoice === 'custom'
            ? `Delete ${selectedSeriesIds.length} selected recurring day${selectedSeriesIds.length === 1 ? '' : 's'}`
            : t('calendar.actions.delete');
    return (
      <Overlay onClose={onClose}>
        <div className="text-center py-4">
          <Trash2 size={42} emphasis="duotone" tone="danger" decorative className="mx-auto mb-3" />
          <h2 className="text-[16px] font-bold text-aegis-text mb-2">{t('calendar.deleteConfirm')}</h2>
          <p className="text-[13px] text-aegis-text-dim mb-1">{editEvent?.title}</p>
          {editor.draft && !editor.draft.provider && <p className="mt-3 text-[13px] text-aegis-text-secondary">{editor.draft.scope === 'series' ? 'The entire series will be cancelled, including its adjusted dates.' : editor.draft.scope === 'occurrence' ? `Only the occurrence originally scheduled for ${editor.draft.originalDate} will be cancelled.` : 'This event will be cancelled.'} Its saved history is retained.</p>}
          {editor.draft?.provider && !recurring && <p className="mt-3 text-[13px] text-aegis-text-secondary">{editor.draft.scope === 'series' ? 'The entire provider series will be deleted.' : editor.draft.scope === 'occurrence' ? 'Only this provider occurrence will be deleted.' : 'This event will be deleted from its provider.'} You will review the exact change and any guest notifications next.</p>}
          {recurring && (
            <fieldset className="mx-auto mt-4 max-w-sm text-left">
              <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-aegis-text-dim">What should be deleted?</legend>
              {editor.draft?.provider?.editable?.target.scope !== 'series' && <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2.5">
                <input type="radio" name="delete-scope" value="event" checked={deleteChoice === 'event'} onChange={() => setDeleteChoice('event')} className="mt-0.5" disabled={saving} />
                <span><strong className="block text-[12px] text-aegis-text">Only this date</strong><small className="text-[11px] text-aegis-text-dim">Every other recurring date stays on the calendar.</small></span>
              </label>}
              <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2.5">
                <input type="radio" name="delete-scope" value="series" checked={deleteChoice === 'series'} onChange={() => setDeleteChoice('series')} className="mt-0.5" disabled={saving} />
                <span><strong className="block text-[12px] text-aegis-text">Every {currentSeries?.weekday || 'matching day'} in this series</strong><small className="text-[11px] text-aegis-text-dim">Removes this provider series only. Other weekdays in the plan remain.</small></span>
              </label>
              {relatedSeries.length > 1 && (
                <>
                  <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-xl border border-red-400/25 bg-red-400/5 px-3 py-2.5">
                    <input type="radio" name="delete-scope" value="schedule" checked={deleteChoice === 'schedule'} onChange={() => setDeleteChoice('schedule')} className="mt-0.5" disabled={saving} />
                    <span><strong className="block text-[12px] text-aegis-text">All “{scheduleLabel}” patterns shown</strong><small className="text-[11px] text-aegis-text-dim">Removes all {relatedSeries.length} related recurring patterns found in the current Calendar view. Other dates may contain additional patterns.</small></span>
                  </label>
                  <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-xl border border-aegis-border bg-aegis-elevated px-3 py-2.5">
                    <input type="radio" name="delete-scope" value="custom" checked={deleteChoice === 'custom'} onChange={() => setDeleteChoice('custom')} className="mt-0.5" disabled={saving} />
                    <span><strong className="block text-[12px] text-aegis-text">Choose recurring days</strong><small className="text-[11px] text-aegis-text-dim">Select exactly which weekday series should be removed.</small></span>
                  </label>
                  {deleteChoice === 'custom' && (
                    <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-aegis-border bg-aegis-panel p-2" aria-label="Recurring days to delete">
                      {relatedSeries.map((choice) => (
                        <label key={choice.seriesId} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[rgb(var(--aegis-overlay)/0.05)]">
                          <input
                            type="checkbox"
                            checked={selectedSeriesIds.includes(choice.seriesId)}
                            onChange={(event) => setSelectedSeriesIds((current) => event.target.checked
                              ? Array.from(new Set([...current, choice.seriesId]))
                              : current.filter((seriesId) => seriesId !== choice.seriesId))}
                            disabled={saving}
                          />
                          <span><strong className="block text-[11px] text-aegis-text">{choice.weekday} · {choice.time}</strong><small className="block text-[11px] text-aegis-text-dim">{choice.title}</small></span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </fieldset>
          )}
          {editEvent?.reminderCronJobId && (
            <p className="text-[12px] text-aegis-warning">{t('calendar.deleteConfirmHint')}</p>
          )}
        </div>
        <div className="flex gap-2 justify-center mt-4">
          <button autoFocus onClick={() => setMode('form')} className="btn-secondary">
            {t('calendar.actions.back')}
          </button>
          <button onClick={handleDelete} disabled={locked || customSelectionEmpty}
            className="px-5 py-2 rounded-xl text-[13px] font-semibold bg-aegis-danger text-white hover:brightness-110 transition-colors disabled:opacity-50">
            {deleteButtonLabel}
          </button>
        </div>
      </Overlay>
    );
  }

  // Reuse the original modal's mode switch. The retained form stays in its
  // journal while a provider review is shown, without repeating every field
  // above the same proposed values in a long disabled form.
  if (providerLocked) return <Overlay onClose={onClose}>
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-[18px] font-bold text-aegis-text flex items-center gap-2"><CalendarDays size={22} emphasis="duotone" tone="gold" decorative/>Calendar change</h2>
      <button className="btn-secondary min-h-11 min-w-11" aria-label="Close event dialog" onClick={onClose}><X size={16}/></button>
    </div>
    <>{editor.draft?.provider?.group ? <ProviderCalendarGroupReview editor={editor}/> : <ProviderCalendarReview editor={editor}/>}</>
    {(editor.storageError || editor.draft?.error || saveError) && <p role="alert" className="mt-4 rounded-xl border border-red-400/25 px-3 py-2 text-[12px] text-aegis-danger">{editor.storageError || editor.draft?.error || saveError}</p>}
    <div className="flex justify-end mt-4"><button className="btn-secondary min-h-11" onClick={onClose}>Keep for later</button></div>
  </Overlay>;

  // ── Form View ──
  return (
    <Overlay onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-[18px] font-bold text-aegis-text flex items-center gap-2">
          <CalendarDays size={22} emphasis="duotone" tone="gold" decorative /> {editEvent?.source === 'content' ? 'Content plan' : isEdit ? t('calendar.editEvent') : t('calendar.newEvent')}
        </h2>
        <div className="flex items-center gap-1">
          {isEdit && !isReadOnlyEvent && (
            <button onClick={() => setMode('confirmDelete')} disabled={locked} title={t('calendar.actions.delete')} aria-label={t('calendar.actions.delete')}
              className="p-1.5 rounded-lg hover:bg-[rgb(var(--color-red-400)/0.1)] text-aegis-text-dim hover:text-[rgb(var(--color-red-400))] transition-colors">
              <Trash2 size={16} />
            </button>
          )}
          <button onClick={onClose} aria-label="Close event dialog"
            className="p-1.5 rounded-lg hover:bg-[rgb(var(--aegis-overlay)/0.06)] text-aegis-text-dim hover:text-aegis-text transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {editor.draft?.scope === 'occurrence' && <p className="mb-4 text-[12px] text-aegis-text-secondary">Editing only the occurrence originally scheduled for {editor.draft.originalDate}.</p>}
      {editor.draft?.scope === 'series' && <p className="mb-4 text-[12px] text-aegis-text-secondary">Editing the entire series.</p>}

      {editor.openingProvider && <div role="status" className="mb-4 space-y-2 text-[12px]"><p>{editor.busy ? 'Reading the complete original event…' : editor.notice}</p>{!editor.busy && <button className="btn-secondary" onClick={() => void editor.openProvider(editor.openingProvider!.event, editor.openingProvider!.scope)}>Retry original event</button>}</div>}
      {editor.draft?.provider && <div className="mb-4 space-y-2 text-[12px]">
        <p>{sourceLabel} · {editor.draft.provider.source.name} · {editor.draft.provider.source.accountLabel}</p>
        {editor.draft.provider.editable?.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {isReadOnlyEvent && <button className="btn-secondary" onClick={() => { onClose(); navigate('/settings'); }}>Review Calendar access</button>}
        <button className="btn-secondary" disabled={editor.busy} onClick={() => void editor.refreshProvider()}>Refresh account and event</button>
      </div>}
      {editEvent && host.openSubtasks && ['local', 'google', 'microsoft', 'task'].includes(editEvent.source ?? '') && <div className="mb-4"><button type="button" className="btn-secondary" onClick={() => { try { host.openSubtasks!(editEvent); onClose(); } catch (error) { setSaveError(error instanceof Error ? error.message : 'Reopen this event to see its subtasks.'); } }}><CheckCircle size={16}/>Subtasks</button></div>}
      {/* Fields */}
      <fieldset disabled={locked} className="space-y-3.5 min-w-0">
        {isReadOnlyEvent && (
          <div className="rounded-xl border border-[rgb(var(--color-amber-400)/0.2)] bg-[rgb(var(--color-amber-400)/0.08)] px-3 py-2 text-[12px] text-aegis-text-secondary">
            {editEvent?.source === 'content' ? 'This plan follows its Content record. Open Content plans to change its draft or date.' : editEvent?.source === 'task' ? 'This date follows its Task. Open Tasks to change its schedule, details or completion.' : `This ${sourceLabel} event is available to read. Review the original account’s Calendar permission to edit it.`}
          </div>
        )}

        {!isEdit && (
          <Field label="Save to calendar">
            <div className="relative">
              <select
                value={destinationId}
                onChange={(event) => setDestinationId(event.target.value)}
                className="field-input pl-10"
                disabled={destinationsLoading || saving}
                aria-describedby={destinationsLoading ? 'calendar-destination-help' : undefined}
              >
                {destinations.map((destination) => (
                  <option key={destination.id} value={destination.id} disabled={!destination.canWrite}>
                    {destination.needsPermission
                      ? `${destination.provider === 'google' ? 'Google' : 'Outlook'} · Enable Calendar editing · ${destination.accountEmail || 'Connected account'}`
                      : `${calendarDestinationLabel(destination)}${destination.unavailableReason ? ' · Editing unavailable' : ''}`}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-aegis-text-dim">
                {destinations.find((destination) => destination.id === destinationId)?.provider === 'local'
                  ? <HardDrive size={15} decorative />
                  : <Globe size={15} decorative />}
              </span>
            </div>
            {destinationsLoading && <p id="calendar-destination-help" className="mt-1.5 text-[12px] text-aegis-text-dim">Finding your connected calendars…</p>}
            {permissionDestinations.map((destination) => (
              <div key={`${destination.id}-permission`} role="status" className="mt-2 flex items-center justify-between gap-3 rounded-[8px] border border-aegis-primary/20 bg-aegis-primary/5 px-3 py-2">
                <span className="min-w-0 text-[11px] leading-4 text-aegis-text-muted">
                  <strong className="block truncate text-aegis-text">{destination.accountEmail}</strong>
                  Enable Calendar editing for this account to save events here.
                </span>
                <button type="button" className="executive-button shrink-0" onClick={() => { onClose(); navigate('/settings'); }}>
                  Enable calendar
                </button>
              </div>
            ))}
          </Field>
        )}

        {editor.draft && !editor.draft.provider && editor.draft.revision > 0 && <CalendarMailSource eventId={editor.draft.id} epoch={editor.draft.epoch} navigate={navigate} close={onClose}/>}

        <Field label={t('calendar.field.title')}>
          <input autoFocus data-autofocus type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={t('calendar.field.titlePlaceholder')}
            className="field-input" disabled={isReadOnlyEvent} />
        </Field>

        <Field label={t('calendar.field.date')}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field-input" disabled={isReadOnlyEvent} />
        </Field>

        {/* All-day toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} disabled={isReadOnlyEvent}
            className="w-4 h-4 rounded border-aegis-border bg-aegis-elevated accent-[rgb(var(--aegis-primary))]" />
          <span className="text-[13px] text-aegis-text">{t('calendar.allDay')}</span>
        </label>

        {/* Time fields (hidden when all-day) */}
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('calendar.field.startTime')}>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="field-input" disabled={isReadOnlyEvent} />
            </Field>
            <Field label={t('calendar.field.endTime')}>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="field-input" disabled={isReadOnlyEvent} aria-describedby={endsNextDay ? 'calendar-end-next-day' : undefined} />
              {endsNextDay && <p id="calendar-end-next-day" role="status" className="mt-1.5 text-[10px] font-medium text-aegis-primary">Ends the next day</p>}
            </Field>
          </div>
        )}

        <details className="dc-calendar-optional">
          <summary>Location & Notes</summary>
          <div className="space-y-3.5">
        <Field label={t('calendar.field.location')}>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)}
            placeholder={t('calendar.field.locationPlaceholder')} className="field-input" disabled={isReadOnlyEvent} />
        </Field>

        <Field label={t('calendar.field.notes')}>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={t('calendar.field.notesPlaceholder')} rows={2}
            className="field-input resize-none" disabled={isReadOnlyEvent} />
        </Field>
        <Field label={providerEvent ? 'Category in Nova Dream' : t('calendar.field.category')}>
          <select value={category} onChange={(e) => setCategory(e.target.value as EventCategory)} className="field-input" disabled={isReadOnlyEvent}>
            {ALL_CATEGORIES.map(cat => <option key={cat} value={cat}>{t(`calendar.category.${cat}`)}</option>)}
          </select>
        </Field>
        {editor.draft?.provider?.editable?.formattedDescription && <label className="flex min-h-11 items-start gap-2 text-[12px]"><input type="checkbox" checked={!!editor.draft.provider.replaceDescription} onChange={event => editor.replaceProvider('replaceDescription', event.target.checked)}/>Review replacing the formatted description with my plain-text notes.</label>}
          </div>
        </details>

        <details className="dc-calendar-optional">
          <summary>Reminders & Repeat</summary>
          <div className="space-y-3.5">
        {(!allDay || providerEvent) && <div className="space-y-3.5">
          <Field label={t('calendar.field.reminder')}>
            <select value={reminder} onChange={(e) => setReminder(Number(e.target.value))} className="field-input" disabled={allDay && !providerEvent || isReadOnlyEvent}>
              {editor.draft?.provider?.editable && <option value={-1}>Keep original provider reminders</option>}
              {REMINDER_PRESETS.map((m) => (
                <option key={m} value={m}>{t(REMINDER_KEYS[m])}</option>
              ))}
            </select>
          </Field>
          <Field label={t('calendar.delivery.label')}>
            <select value={deliveryChannel} onChange={(e) => setDeliveryChannel(e.target.value as DeliveryChannel)}
              className="field-input" disabled={providerEvent || allDay || reminder === 0 || isReadOnlyEvent}>
              {(providerEvent ? deliveryOptions.filter(channel => channel.id === 'last') : deliveryOptions).map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {providerEvent ? 'Connected Calendar' : t(`calendar.delivery.${channel.id}`, channel.label)}
                  {channel.id !== 'last' && channel.running ? ' • live' : channel.id !== 'last' && channel.configured ? ' • configured' : ''}
                </option>
              ))}
            </select>
            {reminder > 0 && !allDay && <div className="mt-1.5 text-[10px] text-aegis-text-dim">
              {providerEvent ? 'Reminders are managed by the connected Calendar. Existing default or custom reminders are preserved unless you change this field.' : 'Reminders are kept in this app. Enable device notifications in the bell menu. External channel delivery is not connected.'}
            </div>}
          </Field>
        </div>}

        {allDay && !providerEvent && <div className="space-y-3">
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={!!form.allDayReminder} disabled={isReadOnlyEvent} onChange={e => setField('allDayReminder', e.target.checked ? { daysBefore: 0, time: '09:00' } : null)}/>Remind me about this all-day event</label>
          {form.allDayReminder && <div className="grid grid-cols-2 gap-3">
            <Field label="Days before"><input className="field-input" type="number" min="0" max="28" value={form.allDayReminder.daysBefore} disabled={isReadOnlyEvent} onChange={e => setField('allDayReminder', { ...form.allDayReminder!, daysBefore: Number(e.target.value) })}/></Field>
            <Field label="Reminder time"><input className="field-input" type="time" value={form.allDayReminder.time} disabled={isReadOnlyEvent} onChange={e => setField('allDayReminder', { ...form.allDayReminder!, time: e.target.value })}/></Field>
            <Field label="When clocks repeat"><select className="field-input" value={form.allDayReminder.overlap ?? ''} disabled={isReadOnlyEvent} onChange={e => setField('allDayReminder', { ...form.allDayReminder!, overlap: e.target.value === '' ? undefined : e.target.value as 'earlier' | 'later' })}><option value="">Keep for review</option><option value="earlier">Earlier time</option><option value="later">Later time</option></select></Field>
            <p className="text-xs text-aegis-text-dim">Uses the event timezone: {editor.draft?.value.timezone ?? 'saved event timezone'}. Reminders whose clock time does not exist stay available for review.</p>
          </div>}
        </div>}

        {editor.draft?.scope !== 'occurrence' && editor.draft?.provider?.editable?.repeating && !editor.draft.provider.editable.recurrenceEditable && <label className="flex min-h-11 items-start gap-2 text-[12px]"><input type="checkbox" checked={!!editor.draft.provider.replaceRecurrence} onChange={event => editor.replaceProvider('replaceRecurrence', event.target.checked)}/>Replace the original provider repeat pattern with the pattern below.</label>}
        {editor.draft?.scope !== 'occurrence' && <Field label={t('calendar.field.recurrence')}>
          <select value={editor.draft?.provider?.editable?.repeating && !editor.draft.provider.editable.recurrenceEditable && !editor.draft.provider.replaceRecurrence ? 'provider' : recurrence} onChange={(e) => setRecurrence(e.target.value as RecurrenceFreq | '')} className="field-input" disabled={isReadOnlyEvent || Boolean(editor.draft?.provider?.editable?.repeating && !editor.draft.provider.editable.recurrenceEditable && !editor.draft.provider.replaceRecurrence)}>
            {editor.draft?.provider?.editable?.repeating && !editor.draft.provider.editable.recurrenceEditable && !editor.draft.provider.replaceRecurrence && <option value="provider">Keep original provider pattern</option>}
            {Object.entries(RECURRENCE_KEYS).map(([val, key]) => (
              <option key={val} value={val}>{t(key)}</option>
            ))}
          </select>
        </Field>}
          </div>
        </details>
        {editor.draft && <CalendarDraftDetails draft={editor.draft} change={editor.changeValue} chooseExceptions={editor.chooseExceptions}/>}
      </fieldset>

      {editor.draft?.review && <div className="calendar-draft-review mt-4" role="status">
        <strong>Your event needs review</strong>
        <p>Your writing is kept. Check the current event before saving these changes.</p>
        {editor.draft.current && <details><summary>View current event</summary><p>{editor.draft.current.value.title} · {editor.draft.current.value.start.date} · {editor.draft.current.value.start.time}</p></details>}
        <button type="button" disabled={editor.busy} onClick={() => { setSaveError(null); void editor.review(); }} className="btn-secondary">Review my kept event</button>
        <button type="button" disabled={editor.busy} onClick={() => { setSaveError(null); editor.keepAsNew(); }} className="btn-secondary">Keep as a separate new event</button>
      </div>}

      {/* Actions */}
      <div className="dc-calendar-actions flex gap-2 justify-end mt-6">
        <button onClick={onClose} className="btn-secondary">{editor.draft ? 'Keep for later' : t('calendar.actions.cancel')}</button>
        {isReadOnlyEvent ? editEvent?.sourceRoute && (
          <button
            onClick={() => { navigate(editEvent.sourceRoute!); onClose(); }}
            className="inline-flex items-center gap-2 rounded-xl bg-aegis-primary px-5 py-2 text-[13px] font-semibold text-aegis-btn-primary-text transition-colors hover:bg-aegis-primary-hover"
          >
            Open {sourceLabel} <ArrowRight size={14} />
          </button>
        ) : !providerLocked && (
          <button onClick={handleSave} disabled={(!title.trim() && !editor.draft?.pending) || saving || editor.busy || editor.draft?.review}
            className="px-5 py-2 rounded-xl text-[13px] font-semibold bg-aegis-primary text-aegis-btn-primary-text hover:bg-aegis-primary-hover transition-colors disabled:opacity-50 shadow-md shadow-aegis-primary/20">
            {saving || editor.busy ? t('calendar.actions.saving') : providerEvent ? 'Review Calendar save' : editor.draft?.pending ? 'Reconcile save' : editor.draft?.scope === 'occurrence' ? 'Save occurrence' : editor.draft?.scope === 'series' || recurrence ? 'Save series' : t('calendar.actions.save')}
          </button>
        )}
      </div>

      {(editor.storageError || editor.draft?.error || saveError) && <p role="alert" className="mt-4 rounded-xl border border-red-400/25 bg-red-400/8 px-3 py-2 text-[12px] text-aegis-danger">{editor.storageError || editor.draft?.error || saveError}</p>}
    </Overlay>
  );
}

// ── Shared sub-components ──

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef(document.activeElement);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      (dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')
        ?? dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)')
        ?? dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], summary') || []).filter(control => control.getClientRects().length > 0 && !control.matches(':disabled'));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', trapFocus);
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus();
    };
  }, []);

  return createPortal(
    <div className="dreamclaw-module dc-calendar-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Calendar event" className="dc-calendar-dialog w-[560px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-2xl bg-aegis-menu-bg border border-aegis-border p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>, document.body
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  // Preserve the original field layout while associating its label with its control,
  // including the destination select nested alongside an icon and help text.
  const connect = (nodes: React.ReactNode): React.ReactNode => Children.map(nodes, child => {
    if (!isValidElement<{ id?: string; children?: React.ReactNode }>(child)) return child;
    if (['input', 'select', 'textarea'].includes(child.type as string)) return cloneElement(child, { id });
    return child.props.children ? cloneElement(child, { children: connect(child.props.children) }) : child;
  });
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-semibold text-aegis-text-dim uppercase tracking-wider mb-1.5">{label}</label>
      {connect(children)}
    </div>
  );
}
