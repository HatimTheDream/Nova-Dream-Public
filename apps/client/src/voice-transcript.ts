import type { Conversation, ConversationHistory } from '../../../packages/domain/assistant';
import type { VoiceController } from './voice-controller';

/** Keep partial and unsaved speech in its original chat until native history owns it. */
export function pendingVoiceTurns(voice: ReturnType<VoiceController['getSnapshot']>, conversation?: Conversation, history?: ConversationHistory) {
  const attempt = voice.attempt;
  if (!attempt || !conversation || attempt.target.conversation.id !== conversation.id || attempt.target.conversation.nativeId !== conversation.nativeId) return [];
  // Native transcript event identities are stable across polling and reload.
  const saved = new Set(history?.nativeId === conversation.nativeId ? history.messages.map(message => `${message.role}:${message.id}`) : []);
  return voice.turns.filter(turn => turn.text.trim() && !saved.has(`${turn.role}:voice:${attempt.id}:${turn.turnId}`));
}
