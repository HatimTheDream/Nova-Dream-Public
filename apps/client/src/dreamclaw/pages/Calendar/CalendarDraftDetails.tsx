import { addDays, type LocalEventInput } from '../../../../../../packages/domain/calendar';
import { reminderInstant } from '../../../../../../packages/domain/reminders';
import type { EventDraft } from '../../../calendar-edit';
import { CalendarRepeatEditor } from '../../../CalendarRepeatEditor';
import { valueForDraft } from '../../calendar-editor';

// Reuses Edition 3's existing repeat, clock-choice and exception controls inside
// Dream Claw's original event editor. The common journal owns every change.
export function CalendarDraftDetails({ draft, change, chooseExceptions }: {
  draft: EventDraft; change(patch: Partial<LocalEventInput>): void; chooseExceptions(policy: 'keep' | 'reset'): void;
}) {
  let v: LocalEventInput;
  try { v = valueForDraft(draft); }
  catch { return <p className="text-[12px] text-aegis-danger">Complete the event date to review timing and repeats.</p>; }
  const overlap = (which: 'start' | 'end') => {
    try { return reminderInstant({ ...v[which], timezone: v.timezone, overlap: undefined }).problem === 'overlap'; }
    catch { return false; }
  };
  return <>
    <details className="calendar-draft-details">
      <summary>Timing and repeat details</summary>
      <div className="calendar-draft-detail-fields">
        <label>{v.allDay ? 'Through' : 'Ends on'}<input type="date" required value={v.allDay ? addDays(v.end.date, -1) : v.end.date}
          onChange={e => { if (e.target.value) change({ end: { ...v.end, date: v.allDay ? addDays(e.target.value, 1) : e.target.value, overlap: undefined } }); }}/></label>
        <label>Event timezone<input required value={v.timezone} onChange={e => change({ timezone: e.target.value, start: { ...v.start, overlap: undefined }, end: { ...v.end, overlap: undefined } })}/><small>{v.allDay ? 'All-day dates stay the same in every viewing timezone.' : 'The times above use this event’s timezone.'}</small></label>
        {!v.allDay && (['start', 'end'] as const).map(which => overlap(which) && <label key={which}>{which === 'start' ? 'Start occurrence' : 'End occurrence'}<select value={v[which].overlap ?? ''} onChange={e => change({ [which]: { ...v[which], overlap: e.target.value || undefined } })}><option value="">Ask me to choose</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select><small>This time occurs twice because clocks go back.</small></label>)}
        {draft.scope !== 'occurrence' && (!draft.provider?.editable?.repeating || draft.provider.editable.recurrenceEditable || draft.provider.replaceRecurrence) && <CalendarRepeatEditor value={v} change={change}/>}
        {!draft.provider && draft.revision > 0 && <label>Event status<select value={v.state} onChange={e => change({ state: e.target.value as LocalEventInput['state'] })}><option value="confirmed">Scheduled</option><option value="cancelled">Cancelled</option></select><small>Cancelled events keep their history and can be restored.</small></label>}
      </div>
    </details>
    {!draft.provider && draft.scope === 'series' && draft.revision > 0 && <div className="calendar-draft-details">
      <strong>{draft.detail?.exceptionCount ?? 0} individually adjusted dates</strong>
      <label>Adjusted occurrences<select value={draft.exceptions ?? 'keep'} onChange={e => chooseExceptions(e.target.value as 'keep' | 'reset')}><option value="keep">Keep changes</option><option value="reset">Reset changes</option></select></label>
      <p>{draft.exceptions === 'reset' ? 'Individual moves, edits and cancellations will be removed from the active schedule. Their saved history is retained.' : 'Individual moves, edits and cancellations stay as they are, including dates no longer in the repeat rule.'}</p>
      {!!draft.detail?.exceptions.length && <details><summary>Review adjusted dates</summary><ul>{draft.detail.exceptions.map(item => <li key={item.originalDate}>{item.originalDate} → {item.start.date} {item.start.time} · {item.title}{item.state === 'cancelled' ? ' · Cancelled' : ''}</li>)}</ul>{draft.detail.exceptionCount > draft.detail.exceptions.length && <p>Showing {draft.detail.exceptions.length} of {draft.detail.exceptionCount} adjusted dates. This choice applies to all of them.</p>}</details>}
    </div>}
  </>;
}
