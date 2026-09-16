import { downloadPercent, type DownloadProgress } from './download-progress';

// Download progress has one denominator; only a validated snapshot completes it.
export function workspaceLoadingPercent(download?: DownloadProgress, complete = false) {
  const measured = download ? downloadPercent(download) : 0;
  return complete ? 100 : measured === undefined ? undefined : Math.min(99, measured);
}
export function playfulStartupSubtitle(percent: number) {
  if (percent === 100) return 'Let’s make something good.';
  if (percent >= 85) return 'One last whisker check…';
  if (percent >= 45) return 'Putting a little order in the universe…';
  if (percent > 0) return 'Gathering your good ideas…';
  return 'Stretching our paws…';
}
export const moduleLoadingSubtitles: Record<string, string> = {
  Assistant: 'Pulling up a chair…',
  Calendar: 'Making room for good days…',
  Inbox: 'Rounding up your digital letters…',
  Tasks: 'Lining up your next little victories…',
  Settings: 'Getting the little details just right…',
  Contacts: 'Getting everyone’s name tags ready…',
  Agents: 'Getting the team together…',
  Content: 'Dusting off the idea shelf…',
  Profile: 'Polishing your little corner…',
  'Phone pairing': 'Making room for one more screen…',
};
