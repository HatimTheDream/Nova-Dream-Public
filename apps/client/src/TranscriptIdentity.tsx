import type { ReactNode } from 'react';
import type { ConversationMessage } from '../../../packages/domain/assistant';
import { UserRound } from './icons';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import './transcript-identity.css';

/** Roles are captured by the transcript; current profiles are not historical authors. */
export function messageSpeaker(message: ConversationMessage) {
  if (message.role === 'user') return 'You';
  if (message.role === 'assistant' && (!message.toolInfo || (message.authoredText ?? message.text).trim())) return 'Nova';
  return undefined;
}

export function TranscriptIdentity({ message, badge }: { message: ConversationMessage; badge?: string }) {
  const speaker = messageSpeaker(message);
  if (!speaker) return null;
  return <div className={`transcript-identity identity-${message.role}`}>
    <span className="transcript-identity-avatar" aria-hidden="true">{message.role === 'user'
      ? <UserRound size={18}/>
      : <SquareLynx appearance={undefined} size="icon" accessibility={{ mode: 'decorative' }}/>}</span>
    <span className="transcript-identity-name">{speaker}</span>
    {badge && <span className="match-label">{badge}</span>}
  </div>;
}

/** Keep actions, delivery state, source links and attachments outside the writing. */
export function MessageWriting({ message, children, text = message.authoredText ?? message.text }: { message: ConversationMessage; children: ReactNode; text?: string }) {
  if (!messageSpeaker(message)) return children;
  if (message.role === 'user' && !text.trim() && message.attachments.length > 0 && !message.toolInfo) return null;
  return <div className="message-writing">{children}</div>;
}
