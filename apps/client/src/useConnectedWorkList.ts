import { useEffect, useState } from 'react';
import type { AssignmentAttempt } from '../../../packages/domain/assignments';
import { request } from './api';
import { resultJournalKey } from './connected-result-draft';

type Item = Pick<AssignmentAttempt, 'assignmentId' | 'state' | 'connectedStatus' | 'savedContentId'> & { attemptId: string; sha256?: string };
const labels = {
  'awaiting-result': 'In Progress', 'needs-review': 'Ready To Review', reviewing: 'In Review',
  'review-unknown': 'Review Status Unknown', 'review-blocked': 'Review Needs Attention', reviewed: 'Reviewed', accepted: 'Accepted', saved: 'Saved To Content',
};
function label(item: Item, deviceId: string, epoch: string) {
  if (item.savedContentId || item.connectedStatus === 'saved') return 'Saved To Content';
  if (item.sha256) {
    try {
      const raw = localStorage.getItem(resultJournalKey(deviceId, epoch, item.attemptId, item.sha256));
      if (raw && JSON.parse(raw)?.action === 'save') return 'Save Confirmation Needed';
    } catch { return 'Check Original Work'; }
  }
  if (item.state === 'unknown') return 'Status Unknown';
  if (item.state === 'failed') return 'Work Failed';
  if (item.state === 'cancelled') return 'Work Stopped';
  return item.connectedStatus ? labels[item.connectedStatus] : 'Check Original Work';
}
export function useConnectedWorkList(enabled: boolean, deviceId: string, epoch: string) {
  const [items, setItems] = useState(new Map<string, string>());
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let controller = new AbortController();
    async function read() {
      const signal = controller.signal;
      try {
        const value = await request<{ items: Item[] }>('assignments/connected-work-list', undefined, signal);
        if (signal.aborted) return;
        setItems(new Map(value.items.map(item => [item.assignmentId, label(item, deviceId, epoch)])));
        if (value.items.some(item => ['prepared','dispatching','running','stopping'].includes(item.state) || item.connectedStatus === 'reviewing'))
          timer = setTimeout(read, 3000);
      } catch { if (!signal.aborted) setItems(new Map()); }
    }
    function refresh() { clearTimeout(timer); controller.abort(); controller = new AbortController(); void read(); }
    void read(); window.addEventListener('focus', refresh);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', refresh); };
  }, [enabled, deviceId, epoch]);
  return items;
}
