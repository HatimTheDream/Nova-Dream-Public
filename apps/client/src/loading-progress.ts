import { downloadPercent, type DownloadProgress } from './download-progress';

// One overall pass: transfer occupies the first tenth; completed preparation
// advances the remainder. This measures work completed, not seconds remaining.
export function workspaceLoadingPercent(download?: DownloadProgress, complete = false, preparation?: number) {
  const measured = download ? downloadPercent(download) : 0;
  return complete ? 100 : preparation !== undefined ? Math.min(99, preparation) : measured === undefined ? 0 : Math.floor(Math.min(100, measured) * .1);
}
export function playfulStartupSubtitle(percent: number) {
  if (percent === 100) return 'Let’s make something good.';
  if (percent >= 85) return 'One last whisker check…';
  if (percent >= 45) return 'Putting a little order in the universe…';
  if (percent > 0) return 'Gathering your good ideas…';
  return 'Stretching our paws…';
}
