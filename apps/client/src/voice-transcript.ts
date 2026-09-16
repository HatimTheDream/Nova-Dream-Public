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

export type TranscriptMessage = ConversationMessage & { voiceParts?: TranscriptMessage[]; pendingVoice?: boolean; streaming?: boolean };
const callIdentity = (message: ConversationMessage) => /^voice:([a-f0-9-]{36}):[A-Za-z0-9_-]+$/.exec(message.id)?.[1];
export const transcriptParts = (message: TranscriptMessage) => message.voiceParts ?? [message];
export const transcriptText = (message: TranscriptMessage) => transcriptParts(message).map(part => part.authoredText ?? part.text).join(' ');
export const transcriptContains = (message: TranscriptMessage, id: string, role: string) => transcriptParts(message).some(part => part.id === id && part.role === role);

/** One speaking turn can contain several provider items. Group only adjacent
 * user captions from the same call; keep every source identity and native hash. */
export function groupVoiceMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const rows: TranscriptMessage[] = [];
  for (const message of messages) {
    const previous = rows.at(-1), call = callIdentity(message);
    const joinable = message.role === 'user' && call && message.text.trim() && !message.attachments.length && !message.toolInfo;
    if (joinable && previous?.role === 'user' && callIdentity(previous) === call && previous.text.trim() && !previous.attachments.length && !previous.toolInfo) {
      rows[rows.length - 1] = { ...previous, voiceParts: [...transcriptParts(previous), ...transcriptParts(message)], streaming: !!previous.streaming || !!message.streaming };
    } else rows.push(message);
  }
  return rows;
}

/** Include pending captions in the same rows as history so a save acknowledgement
 * never splits a live bubble into one saved half and one pending half. */
export function voiceHistoryMessages(voice: ReturnType<VoiceController['getSnapshot']>, conversation?: Conversation, history?: ConversationHistory): TranscriptMessage[] {
  const pending = history?.hasNewer ? [] : pendingVoiceTurns(voice, conversation, history);
  return [...(history?.messages ?? []), ...pending.map(turn => ({ id: `voice:${voice.attempt!.id}:${turn.turnId}`, role: turn.role, text: turn.text, textHash: '', attachments: [], pendingVoice: true, streaming: !turn.final }))];
}
