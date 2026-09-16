import type { Content } from '../../../packages/domain/workspace-records';
import { reminderInstant } from '../../../packages/domain/reminders';

export function ContentTiming({ value, change, timezone }: { value: Content; change(patch: Partial<Content>): void; timezone: string }) {
  const zone = value.plannedTimezone ?? timezone;
  const resolution = value.plannedDate && value.plannedTime ? reminderInstant({ date: value.plannedDate, time: value.plannedTime, timezone: zone, overlap: value.plannedOverlap }) : undefined;
  return <section className="content-timing"><h3>Calendar plan</h3><p className="metadata">This saved Content item appears in Calendar. A date alone stays all-day; adding a time reserves a planning block.</p>
    <div className="record-field-grid"><label>Planned time<input type="time" disabled={!value.plannedDate} value={value.plannedTime ?? ''} onChange={event => change({ plannedTime: event.target.value, plannedTimezone: zone, plannedOverlap: undefined })}/></label>
    {value.plannedTime && <><label>Planning timezone<select value={zone} onChange={event => change({ plannedTimezone: event.target.value, plannedOverlap: undefined })}>{[...new Set([zone, timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(item => <option key={item}>{item}</option>)}</select></label><label>Time reserved<select value={value.plannedMinutes ?? 30} onChange={event => change({ plannedMinutes: Number(event.target.value) })}>{[...new Set([value.plannedMinutes ?? 30, 15, 30, 45, 60, 90, 120])].sort((a, b) => a - b).map(minutes => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></label></>}
    {resolution?.choices.length === 2 && <label>Clock-change occurrence<select value={value.plannedOverlap ?? ''} onChange={event => change({ plannedOverlap: event.target.value as 'earlier' | 'later' || undefined })}><option value="">Choose an occurrence</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label>}</div>
    {resolution?.instant === null && <p className="field-error" role="status">{resolution.problem === 'overlap' ? 'Choose which occurrence of this repeated clock time you mean.' : 'This time does not exist on the selected date. Choose another time.'}</p>}
  </section>;
}
