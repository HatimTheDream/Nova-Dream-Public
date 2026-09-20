import type { Conversation, ConversationHistory } from '../../../packages/domain/assistant';
import { readLocal, saveLocal } from './api';

export type TranscriptPosition = { version: 1; following: boolean; anchor?: { id: string; role: string; offset: number }; savedAt: number };
export function transcriptPositionKey(epoch: string, device: string, conversation?: Conversation) {
  if (!conversation) return;
  const key = `e3:transcript-position:${epoch}:${device}:${conversation.id}:nova`;
  const oldKey = `e3:transcript-position:${epoch}:${device}:${conversation.connectionGeneration}:${conversation.id}:${conversation.nativeId}`;
  if (!readLocal(key)) { const previous = readTranscriptPosition(oldKey); if (previous) saveLocal(key, previous); }
  return key;
}
export function parseTranscriptPosition(value: unknown): TranscriptPosition | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as TranscriptPosition, a = p.anchor;
  if (p.version !== 1 || typeof p.following !== 'boolean' || !Number.isFinite(p.savedAt)) return;
  if (!p.following && (!a || typeof a.id !== 'string' || !a.id || a.id.length > 1000 || !['assistant', 'user', 'tool', 'system'].includes(a.role) || !Number.isFinite(a.offset) || Math.abs(a.offset) > 100000)) return;
  return p;
}
export const readTranscriptPosition = (key?: string) => key ? parseTranscriptPosition(readLocal(key)) : undefined;
export const saveTranscriptPosition = (key: string | undefined, value: TranscriptPosition) => { if (key) saveLocal(key, value); };

export const transcriptCacheKey = (epoch: string, conversation: Conversation) => `e3:history:${epoch}:${conversation.id}:nova`;
/** Keep the visible neighborhood offline, not an ever-growing browser copy of the chat. */
export function cacheTranscriptWindow(history: ConversationHistory, position?: TranscriptPosition): ConversationHistory {
  const anchor = position?.following === false ? position.anchor : undefined;
  const index = anchor ? history.messages.findIndex(m => (m.id === anchor.id || m.novaId === anchor.id || m.aliases?.includes(anchor.id)) && m.role === anchor.role) : -1;
  const start = index < 0 ? Math.max(0, history.messages.length - 100) : Math.max(0, index - 35);
  const window = history.messages.slice(start, start + 100), costs = window.map(message => JSON.stringify(message).length);
  const target = index < 0 ? window.length - 1 : index - start;
  let left = 0, right = window.length, cost = costs.reduce((sum, size) => sum + size, 0);
  while (cost > 300000 && right - left > 1) {
    if (target - left > right - 1 - target) cost -= costs[left++]; else cost -= costs[--right];
  }
  const messages = window.slice(left, right);
  // A cached neighborhood is a saved view, not a native pagination cursor.
  const limited = start + left > 0 || start + right < history.messages.length;
  return limited ? { ...history, messages, hasMore: false, nextOffset: undefined, offset: undefined, hasNewer: true } : { ...history, messages };
}
