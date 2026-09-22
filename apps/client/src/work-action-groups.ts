import type { WorkEntry } from './work-transcript';

export type WorkToolEntry = Extract<WorkEntry, { kind: 'tool' }>;
export type WorkActionGroup = { kind: 'actions'; entries: WorkToolEntry[]; summary: string };
export type WorkActionDisplayEntry = WorkEntry | WorkActionGroup;

const aliases: Record<string, string> = {
  exec_command: 'exec', run_command: 'exec', read_file: 'read', write_file: 'write',
  edit_file: 'edit', image_generate: 'imagegen',
};
const families: Record<string, [singular: string, plural: string]> = {
  read: ['Read a file', 'Read files'],
  write: ['Wrote a file', 'Wrote files'],
  edit: ['Edited a file', 'Edited files'],
  exec: ['Ran a command', 'Ran commands'],
  web_search: ['Searched the web', 'Searched the web'],
  web_fetch: ['Read a page', 'Read pages'],
  browser: ['Used the browser', 'Used the browser'],
  computer: ['Used the computer', 'Used the computer'],
  nova_read: ['Read your workspace', 'Read your workspace'],
  nova_write: ['Requested a workspace change', 'Requested workspace changes'],
  imagegen: ['Created an image', 'Created images'],
  github_identity_status: ['Checked GitHub identity', 'Checked GitHub identity'],
};
const familyFor = (name: string) => {
  const leaf = name.split(/__|\./).at(-1) ?? name;
  const family = aliases[leaf] ?? leaf;
  return families[family] ? family : 'other';
};
const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);

/** Describe only confirmed successes, without exposing raw tool names or inputs. */
export function completedActionSummary(entries: readonly WorkToolEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.tool.state !== 'completed') continue;
    const family = familyFor(entry.tool.name);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const ordered = [...counts];
  const visible = ordered.length > 3 ? ordered.slice(0, 2) : ordered;
  const phrases = visible.map(([family, count]) => family === 'other'
    ? count === 1 ? 'Completed an action' : 'Completed actions'
    : families[family][count === 1 ? 0 : 1]);
  if (ordered.length > 3) {
    const remaining = ordered.slice(2).reduce((sum, [, count]) => sum + count, 0);
    phrases.push(`${remaining} other ${remaining === 1 ? 'action' : 'actions'}`);
  }
  return phrases.map((phrase, index) => index ? lowerFirst(phrase) : phrase).join(', ');
}

/** A display disclosure never merges action identities. Its original entries,
 * inputs, results and sources remain available for exact search and file actions.
 * Attached files stay at the original level; renderers open a group when one of
 * its retained sources matches a navigation target. */
export function groupWorkActions(entries: readonly WorkEntry[]): WorkActionDisplayEntry[] {
  const rows: WorkActionDisplayEntry[] = [];
  let completed: WorkToolEntry[] = [];
  const flush = () => {
    if (completed.length === 1) rows.push(completed[0]);
    else if (completed.length > 1) rows.push({ kind: 'actions', entries: completed, summary: completedActionSummary(completed) });
    completed = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.tool.state === 'completed' && !entry.sources.some(source => source.attachments.length)) completed.push(entry);
    else { flush(); rows.push(entry); }
  }
  flush();
  return rows;
}
