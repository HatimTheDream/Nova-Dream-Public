import type { CalendarDisplayEvent } from './calendar.js';
/** Position by elapsed time so repeated hours occupy distinct places on the day. */
export function dayEventLayout(events: CalendarDisplayEvent[], start: number, end: number) {
  const rows = events.filter(e => e.interval.kind === 'instant' && Date.parse(e.interval.start) < end && Date.parse(e.interval.end) > start).map(event => {
    const from = Math.max(start, Date.parse(event.interval.start)), to = Math.min(end, Date.parse(event.interval.end));
    return { event, top: (from - start) / 3600000 * 64, height: Math.max(48, (to - from) / 3600000 * 64) };
  });
  return assignEventColumns(rows);
}

/** Shared collision placement for E3 intervals and the reused Dream Claw cards. */
export function assignEventColumns<T extends { event: { id: string }; top: number; height: number }>(input: T[]) {
  const rows = input.map(row => ({ ...row, column: 0, columns: 1 })).sort((a, b) => a.top - b.top || b.height - a.height || a.event.id.localeCompare(b.event.id));
  let group: typeof rows = [], edges: number[] = [], bottom = -1;
  const finish = () => { for (const row of group) row.columns = edges.length; group = []; edges = []; bottom = -1; };
  for (const row of rows) {
    if (row.top >= bottom) finish();
    let column = edges.findIndex(edge => edge <= row.top); if (column < 0) column = edges.length;
    row.column = column; edges[column] = row.top + row.height; bottom = Math.max(bottom, edges[column]); group.push(row);
  }
  finish(); return rows;
}
