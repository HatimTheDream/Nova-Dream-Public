type IndexProgress = { indexStatus?: 'idle' | 'indexing' | 'paused' | 'complete' | 'error'; indexUpdatedAt?: string; indexError?: string; threads: unknown[] };

/** A saved "indexing" flag is not evidence of current progress. This only
 * describes the last observed state; it never restarts or reclassifies the job. */
export function inboxSyncStatus(snapshots: IndexProgress[], now: number) {
  const active = snapshots.filter(item => item.indexStatus === 'indexing');
  const error = snapshots.find(item => item.indexStatus === 'error');
  const paused = snapshots.some(item => item.indexStatus === 'paused');
  const stale = active.some(item => !item.indexUpdatedAt || !Number.isFinite(Date.parse(item.indexUpdatedAt)) || now - Date.parse(item.indexUpdatedAt) > 90_000);
  const loaded = snapshots.reduce((sum, item) => sum + item.threads.length, 0).toLocaleString('en-US');
  if (error) return { label: 'Sync needs attention', detail: error.indexError || 'One mailbox could not finish syncing. Your loaded messages remain available.', warning: true };
  if (stale) return { label: 'Waiting for sync progress', detail: `No recent progress has been reported for one or more mailboxes. ${loaded} conversations are available. Refresh to check, or pause syncing.`, warning: true };
  if (active.length) return { label: `Syncing · ${loaded} loaded`, detail: `Older messages are syncing in the background.${paused ? ' Another mailbox is paused.' : ''} You can keep reading.`, warning: false };
  if (paused) return { label: 'Sync paused', detail: `${loaded} conversations remain searchable. Resume to load older messages.`, warning: false };
  if (snapshots.length && snapshots.every(item => item.indexStatus === 'complete')) return { label: 'Sync complete', detail: `${loaded} conversations are searchable. Refresh to check for new mail.`, warning: false };
  return { label: 'Sync status', detail: 'Open sync details or refresh to check your mailboxes. Loaded messages remain available.', warning: false };
}
