import { useEffect, useRef, useState } from 'react';
import type { LocalEventInput } from '../../../../../../packages/domain/calendar';
import type { CalendarEditorState } from '../../calendar-editor';

export function EventValues({ value }: { value: LocalEventInput }) {
  return <dl className="space-y-1 text-[12px] break-words">
    <dt className="font-semibold">{value.title}</dt>
    <dd>{value.start.date} {value.allDay ? '· All day' : value.start.time} → {value.end.date} {!value.allDay && value.end.time}</dd>
    <dd>{value.timezone.replaceAll('_', ' ')}{value.allDay && ' · End date is exclusive'}</dd>
    {!!value.location && <dd>{value.location}</dd>}
    <dd>Category in Edition 3: {value.category ?? 'other'}</dd>
    <dd>Reminder: {value.reminderMinutes ? `${value.reminderMinutes} minutes before` : 'Unchanged default or no reminder'}</dd>
    {value.repeat && <dd>Repeat: {value.repeat.cadence}, every {value.repeat.interval}{value.repeat.count ? ` · ${value.repeat.count} dates` : value.repeat.endsOn ? ` · through ${value.repeat.endsOn}` : ''}</dd>}
    <dd className="whitespace-pre-wrap">{value.notes || 'No description'}</dd>
  </dl>;
}

export function ProviderCalendarReview({ editor }: { editor: CalendarEditorState }) {
  const provider = editor.draft?.provider, operation = provider?.operation;
  const section = useRef<HTMLElement>(null);
  const [guests, setGuests] = useState(false);
  useEffect(() => setGuests(false), [operation?.id, operation?.revision]);
  useEffect(() => { if (operation) section.current?.focus(); }, [operation?.id, operation?.state]);
  if (!provider || !provider.prepare) return null;
  const busy = editor.busy, state = operation?.state;
  const primary = 'min-h-11 px-4 py-2 rounded-xl text-[13px] font-semibold bg-aegis-primary text-aegis-btn-primary-text hover:bg-aegis-primary-hover transition-colors disabled:opacity-50 shadow-md shadow-aegis-primary/20';
  return <section ref={section} tabIndex={-1} className="calendar-draft-review mt-4 space-y-3 outline-none" aria-label="Provider Calendar review" aria-live="polite">
    <strong>{state === 'review' ? 'Review Calendar change' : state === 'confirmed' || state === 'observed' ? 'Calendar result saved' : state === 'unknown' ? 'Check the original save' : state === 'conflict' ? 'The event changed' : state === 'failed' ? 'Your proposal is kept' : state === 'cancelled' ? 'Review cancelled' : 'Checking Calendar operation'}</strong>
    <p className="text-[12px]">{provider.source.provider === 'google' ? 'Google' : 'Outlook'} · {provider.source.name} · {provider.source.accountLabel}</p>
    {operation?.detail && <p className="text-[12px]">{operation.detail}</p>}
    {provider.separateProposal && <p className="text-[12px]">Another window saved a different version of this proposal. Your writing above is still kept; this result describes that original save.</p>}
    {operation && <>
      <p className="text-[12px] font-semibold">{operation.action === 'delete' ? 'Delete' : operation.action === 'create' ? 'Create' : 'Update'} · {operation.target?.scope === 'series' ? 'Entire series' : operation.target?.scope === 'occurrence' ? 'Only this occurrence' : 'This event'}</p>
      {operation.changes.length > 0 && <p className="text-[12px]">Changes: {operation.changes.join(', ')}</p>}
      {operation.warnings.map(warning => <p className="text-[12px]" key={warning}>{warning}</p>)}
      {(operation.value ?? operation.before) && <details open={state === 'review'}><summary>{operation.action === 'delete' ? 'Event to delete' : 'Your proposed event'}</summary><EventValues value={(operation.value ?? operation.before)!}/></details>}
      {operation.before && operation.value && <details><summary>Before your changes</summary><EventValues value={operation.before}/></details>}
      {provider.current && <details open><summary>Current provider event</summary><EventValues value={provider.current.value}/></details>}
    </>}
    {operation && state === 'review' && !provider.confirmation && <>
      {!!operation.attendees && <label className="flex min-h-11 items-start gap-2 text-[12px]"><input className="mt-1" type="checkbox" checked={guests} onChange={event => setGuests(event.target.checked)} disabled={busy}/>I understand the provider may notify {operation.attendees} existing guests.</label>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={busy} onClick={() => void editor.confirmProvider('cancel')}>Back to editing</button>
        <button className={primary} disabled={busy || Boolean(operation.attendees && !guests)} onClick={() => void editor.confirmProvider('confirm', guests)}>{operation.action === 'delete' ? 'Confirm deletion' : 'Confirm Calendar save'}</button>
      </div>
    </>}
    {(!operation || ['preparing', 'applying', 'unknown'].includes(state!) || state === 'review' && provider.confirmation) && <button className="btn-secondary" disabled={busy} onClick={() => void editor.checkProvider()}>Check original request</button>}
    {['failed', 'conflict', 'cancelled'].includes(state!) && <div className="flex flex-wrap gap-2">
      {provider.editable && state !== 'cancelled' && <button className="btn-secondary" disabled={busy} onClick={() => void editor.reviewProvider()}>Check current event</button>}
      <button className="btn-secondary" disabled={busy || Boolean(provider.editable && state !== 'cancelled' && !provider.current)} onClick={editor.editProvider}>{provider.current ? 'Keep my edits with the current event' : 'Continue editing'}</button>
    </div>}
    {['confirmed', 'observed'].includes(state!) && <button className={primary} disabled={busy} onClick={editor.finishProvider}>{provider.separateProposal ? 'Keep my writing as a separate new event' : 'Done · return to Calendar'}</button>}
  </section>;
}
