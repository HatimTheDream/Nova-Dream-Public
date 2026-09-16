import { transcriptContains, type TranscriptMessage } from './voice-transcript';
import { createContext, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ConversationHistory } from '../../../packages/domain/assistant';
import { cacheTranscriptWindow, readTranscriptPosition, saveTranscriptPosition, type TranscriptPosition } from './transcript-position';
import { saveLocal } from './api';
import type { useTranscriptScroll } from './useTranscriptScroll';

const Tail = createContext<ReactNode>(null);
function TranscriptFooter() { return <>{useContext(Tail)}</>; }
const components = { Footer: TranscriptFooter };
export type TranscriptHandle = { keepReadingPosition: () => void };

/** Virtualized messages with a native-message reading anchor, independent of live following. */
export function VirtualTranscript({ messages, parent, render, footer, ref, positionKey, cacheKey, history, scroll }: { messages: TranscriptMessage[]; parent: HTMLElement; render: (message: TranscriptMessage, index: number) => ReactNode; footer: ReactNode; ref?: Ref<TranscriptHandle>; positionKey?: string; cacheKey?: string; history: ConversationHistory; scroll: ReturnType<typeof useTranscriptScroll> }) {
  const list = useRef<VirtuosoHandle>(null), current = useRef({ messages, scroll, history }); current.current = { messages, scroll, history };
  const previous = useRef<{ first?: string; index: number }>({ first: messages[0]?.id, index: 100000 });
  const saved = useRef(readTranscriptPosition(positionKey)), pendingPrepend = useRef<TranscriptPosition | undefined>(undefined);
  const restore = useRef<(position: TranscriptPosition) => void>(() => {}), capture = useRef<() => void>(() => {});
  const initial = useRef<{ index: number | 'LAST'; align: 'start' | 'end'; offset?: number } | null>(null);
  if (!initial.current) {
    const kept = saved.current, anchor = kept?.following === false ? kept.anchor : undefined;
    const index = anchor ? messages.findIndex(m => transcriptContains(m, anchor.id, anchor.role)) : -1;
    initial.current = index >= 0 ? { index, align: 'start', offset: -anchor!.offset } : { index: 'LAST', align: 'end' };
  }
  useImperativeHandle(ref, () => ({ keepReadingPosition() { current.current.scroll.beginRestore(); current.current.scroll.endRestore(); capture.current(); pendingPrepend.current = saved.current; } }), []);
  if (previous.current.first !== messages[0]?.id) {
    const prepended = messages.findIndex(m => m.id === previous.current.first);
    if (prepended > 0) previous.current.index -= prepended;
    previous.current.first = messages[0]?.id;
  }
  useLayoutEffect(() => {
    let frame = 0, saveTimer: ReturnType<typeof setTimeout> | undefined, restoring = false, live = true, width = parent.clientWidth;
    const write = () => { if (saved.current) { saveTranscriptPosition(positionKey, saved.current); if (cacheKey) saveLocal(cacheKey, cacheTranscriptWindow(current.current.history, saved.current)); } };
    const sample = () => {
      if (!live || restoring || !parent.clientWidth || !parent.clientHeight || parent.clientWidth !== width) return;
      const { scroll } = current.current;
      if (scroll.following.current) saved.current = { version: 1, following: true, savedAt: Date.now() };
      else {
        const top = parent.getBoundingClientRect().top;
        const item = [...parent.querySelectorAll<HTMLElement>('[data-transcript-id]')].find(node => node.getBoundingClientRect().bottom > top && node.getBoundingClientRect().top < top + parent.clientHeight);
        if (!item) return;
        const identity = item.dataset.transcriptId!, split = identity.indexOf(':');
        saved.current = { version: 1, following: false, anchor: { role: identity.slice(0, split), id: identity.slice(split + 1), offset: item.getBoundingClientRect().top - top }, savedAt: Date.now() };
      }
      clearTimeout(saveTimer); saveTimer = setTimeout(write, 150);
    };
    capture.current = sample;
    const finish = () => { cancelAnimationFrame(frame); restoring = false; current.current.scroll.endRestore(); sample(); };
    const restorePosition = (position: TranscriptPosition) => {
      const anchor = position.following ? undefined : position.anchor;
      if (!anchor || !parent.clientWidth) return;
      const index = current.current.messages.findIndex(m => transcriptContains(m, anchor.id, anchor.role));
      if (index < 0) return;
      cancelAnimationFrame(frame); restoring = true; current.current.scroll.beginRestore();
      frame = requestAnimationFrame(() => {
        if (!live) return;
        list.current?.scrollToIndex({ index, align: 'start', offset: -anchor.offset, behavior: 'auto' });
        const until = performance.now() + 1200;
        const settle = () => {
          if (!live) return;
          if (!current.current.scroll.restoring.current || performance.now() > until) { finish(); return; }
          const row = current.current.messages.find(message => transcriptContains(message, anchor.id, anchor.role));
          if (!row) { finish(); return; }
          const item = [...parent.querySelectorAll<HTMLElement>('[data-transcript-id]')].find(node => node.dataset.transcriptId === `${row.role}:${row.id}`);
          if (item) {
            const offset = Math.max(anchor.offset, -Math.max(0, item.getBoundingClientRect().height - 32));
            const delta = item.getBoundingClientRect().top - parent.getBoundingClientRect().top - offset;
            if (Math.abs(delta) > 1) parent.scrollTop += delta;
          }
          frame = requestAnimationFrame(settle);
        };
        frame = requestAnimationFrame(settle);
      });
    };
    restore.current = restorePosition;
    const cancel = () => { pendingPrepend.current = undefined; if (restoring) finish(); };
    const flush = () => { sample(); clearTimeout(saveTimer); write(); };
    const resize = new ResizeObserver(() => {
      const next = parent.clientWidth;
      if (next && next !== width && !current.current.scroll.following.current && saved.current) restorePosition(saved.current);
      width = next;
    });
    resize.observe(parent);
    parent.addEventListener('scroll', sample, { passive: true }); parent.addEventListener('wheel', cancel, { passive: true }); parent.addEventListener('touchstart', cancel, { passive: true }); parent.addEventListener('pointerdown', cancel); parent.addEventListener('keydown', cancel);
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', flush);
    if (saved.current?.following === false) restorePosition(saved.current); else frame = requestAnimationFrame(sample);
    return () => {
      flush(); live = false; cancelAnimationFrame(frame); resize.disconnect(); clearTimeout(saveTimer);
      current.current.scroll.endRestore(); parent.removeEventListener('scroll', sample); parent.removeEventListener('wheel', cancel); parent.removeEventListener('touchstart', cancel); parent.removeEventListener('pointerdown', cancel); parent.removeEventListener('keydown', cancel); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush);
    };
  }, [parent, positionKey, cacheKey]);
  useLayoutEffect(() => { if (pendingPrepend.current) { const kept = pendingPrepend.current; pendingPrepend.current = undefined; restore.current(kept); } }, [messages[0]?.id, messages.at(-1)?.id]);
  useEffect(() => { if (!scroll.restoring.current) capture.current(); }, [messages]);
  return <Tail.Provider value={footer}><Virtuoso ref={list} data={messages} customScrollParent={parent} firstItemIndex={previous.current.index} initialTopMostItemIndex={initial.current} followOutput={false} increaseViewportBy={{ top: 500, bottom: 500 }} components={components} computeItemKey={(_, message) => `${message.role}:${message.id}`} itemContent={(index, message) => <div className="transcript-item" data-transcript-id={`${message.role}:${message.id}`}>{render(message, index - previous.current.index)}</div>}/></Tail.Provider>;
}
