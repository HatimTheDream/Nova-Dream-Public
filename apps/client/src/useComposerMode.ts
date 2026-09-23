import { useEffect, useRef, useState } from 'react';
import { canonical, type Draft } from '../../../packages/domain/contracts';
import { readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';

type Mode = NonNullable<Draft['workMode']>;
type Consumption = { id: string; mode: Mode; requestKey: string; durable?: boolean };
const storageKey = (epoch: string, draftId: string) => `e3:consumed-mode:${epoch}:${draftId}:${retainedWindowId}`;

export function consumeDraftMode(epoch: string, draftId: string, requestKey: string, mode: Mode = 'chat') {
  const consumed = { id: crypto.randomUUID(), mode, requestKey };
  return { ...consumed, durable: saveLocal(storageKey(epoch, draftId), consumed) };
}

/** A feature belongs to one send. Do not autosave its removal while the host
 * may still be admitting the original draft revision or reconciling its receipt. */
export function useComposerMode(epoch: string, draftId: string, journal: { value: Draft; change: (update: (value: Draft) => Draft) => boolean }) {
  const key = storageKey(epoch, draftId);
  const [consumed, setConsumed] = useState(() => readLocal<Consumption>(key));
  const current = useRef(consumed);
  const remember = (value: Consumption | undefined) => { current.current = value; setConsumed(value); };
  const mode = journal.value.workMode ?? 'chat';
  const consume = (requestKey: string) => { const value = consumeDraftMode(epoch, draftId, requestKey, mode); remember(value); return value.id; };
  const select = (value: Mode) => {
    // A deliberate new choice, even the same feature, belongs to the next draft.
    remember(undefined); localStorage.removeItem(key);
    journal.change(draft => ({ ...draft, workMode: value }));
  };
  const finish = (id: string, captured?: Draft, sourceHash?: string) => {
    const intent = current.current;
    if (intent?.id !== id || (intent.durable !== false && readLocal<Consumption>(key)?.id !== id)) return;
    const saved = journal.change(value => {
      const next = { ...value, ...(value.workMode === intent.mode ? { workMode: 'chat' as const } : {}) };
      if (!captured || canonical(value) !== canonical(captured)) return next;
      next.text = '';
      next.attachments = sourceHash ? value.attachments.filter(file => file.sha256 === sourceHash) : [];
      if (!sourceHash) delete next.refineSource;
      return next;
    });
    if (saved) { remember(undefined); localStorage.removeItem(key); }
  };
  // A rejected first send can open its copied conversation. Normalize that
  // retained draft before its next send, once no original request needs it.
  useEffect(() => { if (consumed && !readLocal(consumed.requestKey)) finish(consumed.id); }, [consumed]);
  return { mode: consumed?.mode === mode ? 'chat' as const : mode, pendingKey: consumed && readLocal(consumed.requestKey) ? consumed.requestKey : undefined, consume, select, finish };
}
