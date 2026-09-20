import type { Conversation, ConversationHistory, ConversationMessage } from '../../../packages/domain/assistant';
import type { VoiceController } from './voice-controller';

/** Keep partial and unsaved speech in its original chat until native history owns it. */
export function pendingVoiceTurns(voice: ReturnType<VoiceController['getSnapshot']>, conversation?: Conversation, history?: ConversationHistory) {
  const attempt = voice.attempt;
  if (!attempt || !conversation || attempt.target.conversation.id !== conversation.id || attempt.target.conversation.nativeId !== conversation.nativeId) return [];
  // Native transcript event identities are stable across polling and reload.
  const saved = new Set(history?.nativeId === conversation.nativeId ? history.messages.map(message => `${message.role}:${message.id}`) : []);
  return voice.turns.filter(turn => turn.text.trim() && !saved.has(`${turn.role}:voice:${attempt.id}:${turn.turnId}`));
}

export type TranscriptMessage = ConversationMessage & { voiceParts?: TranscriptMessage[]; pendingVoice?: boolean; streaming?: boolean; unconfirmed?: boolean };
const callIdentity = (message: ConversationMessage) => /^voice:([a-f0-9-]{36}):[A-Za-z0-9_-]+$/.exec(message.id)?.[1];
export const transcriptParts = (message: TranscriptMessage) => message.voiceParts ?? [message];
export const transcriptText = (message: TranscriptMessage) => transcriptParts(message).map(part => part.authoredText ?? part.text).join(' ');
export const transcriptContains = (message: TranscriptMessage, id: string, role: string) => transcriptParts(message).some(part => part.role === role && (part.id === id || part.novaId === id || part.aliases?.includes(id)));

/** One speaking turn can contain several provider items. Group only adjacent
 * user captions from the same call; keep every source identity and native hash. */
export function groupVoiceMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const rows: TranscriptMessage[] = [];
  for (const message of messages) {
    const previous = rows.at(-1), call = callIdentity(message);
    const joinable = message.role === 'user' && call && message.text.trim() && !message.attachments.length && !message.toolInfo;
    if (joinable && previous?.role === 'user' && callIdentity(previous) === call && previous.text.trim() && !previous.attachments.length && !previous.toolInfo) {
      rows[rows.length - 1] = { ...previous, voiceParts: [...transcriptParts(previous), ...transcriptParts(message)], streaming: !!previous.streaming || !!message.streaming, unconfirmed: previous.unconfirmed || message.unconfirmed };
    } else rows.push(message);
  }
  return rows;
}

/** Include pending captions in the same rows as history so a save acknowledgement
 * never splits a live bubble into one saved half and one pending half. */
export function voiceHistoryMessages(voice: ReturnType<VoiceController['getSnapshot']>, conversation?: Conversation, history?: ConversationHistory): TranscriptMessage[] {
  const messages = history?.messages ?? [];
  const turns = history?.hasNewer ? [] : pendingVoiceTurns(voice, conversation, history);
  if (!turns.length) return [...messages];
  const identity = (message: Pick<ConversationMessage, 'id' | 'role'>) => `${message.role}:${message.id}`;
  const turnIdentity = (turn: typeof turns[number]) => `${turn.role}:voice:${voice.attempt!.id}:${turn.turnId}`;
  const order = new Map(voice.turns.map((turn, index) => [turnIdentity(turn), index]));
  const anchors = messages.flatMap(message => { const index = order.get(identity(message)); return index === undefined ? [] : [index]; });
  const firstVisible = anchors.length ? Math.min(...anchors) : undefined;
  const acknowledged = new Set(voice.attempt!.entries.filter(entry => entry.saved).map(entry => `${entry.role}:voice:${voice.attempt!.id}:${entry.entryId}`));
  // A bounded latest page deliberately omits earlier history. Do not replay
  // acknowledged turns before its first visible call anchor at the bottom.
  // Without an anchor, keep the tail: its save may precede history projection.
  const pending: TranscriptMessage[] = turns.filter(turn => !(history?.hasMore && firstVisible !== undefined && !turn.unconfirmed
    && order.get(turnIdentity(turn))! < firstVisible && acknowledged.has(turnIdentity(turn))))
    .map(turn => ({ id: `voice:${voice.attempt!.id}:${turn.turnId}`, role: turn.role, text: turn.text, textHash: '', attachments: [], pendingVoice: true, streaming: !turn.final, unconfirmed: turn.unconfirmed }));
  const rows: TranscriptMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const anchor = order.get(identity(message));
    // ASR and history acknowledgements arrive independently. Insert missing
    // captions before the next saved call turn, preserving every native row.
    while (anchor !== undefined && next < pending.length && order.get(identity(pending[next]))! < anchor) rows.push(pending[next++]);
    rows.push(message);
  }
  return [...rows, ...pending.slice(next)];
}
