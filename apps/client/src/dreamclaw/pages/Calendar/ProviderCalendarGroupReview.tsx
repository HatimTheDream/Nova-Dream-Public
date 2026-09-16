import { useEffect, useRef, useState } from 'react';
import { calendarGroupRemoved, calendarGroupUncertain } from '../../../../../../packages/domain/calendar-groups';
import type { CalendarEditorState } from '../../calendar-editor';
import { EventValues } from './ProviderCalendarReview';

export function ProviderCalendarGroupReview({ editor }: { editor: CalendarEditorState }) {
  const group = editor.draft?.provider?.group, operation = group?.operation;
  const [guests, setGuests] = useState(false), section = useRef<HTMLElement>(null);
  useEffect(() => { setGuests(false); }, [operation?.id, operation?.revision]);
  useEffect(() => { section.current?.focus(); }, [operation?.id, operation?.state]);
  if (!group) return null;
  const items = operation?.items ?? [], removed = items.filter(calendarGroupRemoved).length, remaining = items.length - removed;
  const uncertain = items.some(calendarGroupUncertain), busy = editor.busy;
  const pending = !operation || !!group.command || ['preparing', 'applying'].includes(operation.state);
  const attendees = items.filter(item => !calendarGroupRemoved(item)).reduce((sum, item) => sum + (item.operation?.attendees ?? 0), 0);
  const primary = 'min-h-11 px-4 py-2 rounded-xl text-[13px] font-semibold bg-aegis-primary text-aegis-btn-primary-text hover:bg-aegis-primary-hover disabled:opacity-50 shadow-md shadow-aegis-primary/20';
  return <section ref={section} tabIndex={-1} className="calendar-draft-review space-y-3 outline-none" aria-label="Schedule deletion review" aria-live="polite">
    <strong>{operation?.closed ? 'Schedule results saved' : operation?.state === 'review' ? removed ? 'Review remaining patterns' : 'Review selected patterns' : 'Check schedule results'}</strong>
    <p className="text-[12px]">{operation?.label ?? group.prepare.label}</p>
    {operation && <>
      <p className="text-[12px]">{operation.source.provider === 'google' ? 'Google' : 'Outlook'} · {operation.source.name} · {operation.source.accountLabel}</p>
      <p className="text-[12px]">{operation.detail}</p>
      <p className="text-[12px] font-semibold">{removed} of {items.length} selected patterns removed</p>
    </>}
    {group.otherSelection && <p className="text-[12px]">Another window prepared a different selection from this draft. These are its original results. Your writing remains kept separately.</p>}
    <ol className="space-y-3">
      {items.map((item, index) => <li key={item.seriesId} className="rounded-xl border border-aegis-border p-3 text-[12px] space-y-2">
        <strong className="block break-words">{item.operation?.before?.title ?? `Selected pattern ${index + 1}`}</strong>
        <p>{calendarGroupRemoved(item) ? 'Removed' : item.operation?.state === 'review' ? 'Ready for review' : item.operation?.state === 'cancelled' ? 'Kept' : item.operation?.state === 'unknown' ? 'Result not confirmed' : item.operation?.state === 'conflict' ? 'Changed since review' : item.operation?.state === 'failed' ? 'Not removed' : 'Awaiting review'}</p>
        {item.error && <p>{item.error}</p>}
        {item.operation?.detail && !['review', 'confirmed'].includes(item.operation.state) && <p>{item.operation.detail}</p>}
        {item.operation?.before && <details><summary>Pattern details</summary><EventValues value={item.operation.before}/></details>}
        {!!item.operation?.attendees && <p>{item.operation.attendees} existing guest{item.operation.attendees === 1 ? '' : 's'}</p>}
      </li>)}
    </ol>
    {operation && !operation.closed && !pending && operation.state === 'review' && <>
      {!!attendees && <label className="flex min-h-11 items-start gap-2 text-[12px]"><input type="checkbox" className="mt-1" checked={guests} onChange={event => setGuests(event.target.checked)} disabled={busy}/>I understand the provider may notify guests of the remaining series.</label>}
      <button className={primary} disabled={busy || Boolean(attendees && !guests)} onClick={() => void editor.groupAction('confirm', guests)}>Confirm deletion of {remaining} pattern{remaining === 1 ? '' : 's'}</button>
    </>}
    {(pending || uncertain || operation?.state === 'partial' && !operation.closed) && <button className="btn-secondary" disabled={busy} onClick={() => void editor.checkGroup()}>Check original schedule request</button>}
    {operation && !operation.closed && !pending && <div className="flex flex-wrap gap-2">
      {operation.state === 'partial' && !uncertain && <button className="btn-secondary" disabled={busy} onClick={() => void editor.groupAction('review')}>Review remaining patterns</button>}
      <button className="btn-secondary" disabled={busy} onClick={() => void editor.groupAction('cancel')}>{removed ? 'Keep remaining patterns' : 'Keep selected patterns'}</button>
    </div>}
    {operation?.closed && <button className={primary} disabled={busy} onClick={editor.finishGroup}>Done</button>}
  </section>;
}
