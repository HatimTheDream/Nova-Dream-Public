import { memo, Suspense } from 'react';
import { lazy } from './preload-lazy';
import { RenderingFallback } from './RenderingFallback';
import type { ConversationMessage } from '../../../packages/domain/assistant';

const ReplyMarkdown = lazy(() => import('./dreamclaw/components/Chat/ReplyMarkdown').then(module => ({ default: module.ReplyMarkdown })));

export const ReplyText = memo(function ReplyText({ text, role, streaming = false }: { text: string; role: string; streaming?: boolean }) {
  const fallback = <div className="message-text preserve-lines">{text}</div>;
  return role === 'assistant' ? <RenderingFallback fallback={fallback}><Suspense fallback={fallback}><ReplyMarkdown text={text} streaming={streaming}/></Suspense></RenderingFallback> : fallback;
});

export function SavedMessageText({ message, text = message.authoredText ?? message.text }: { message: ConversationMessage; text?: string }) {
  if (message.role === 'tool') return null;
  if (message.role === 'user' && !text.trim() && !message.attachments.length && !message.toolInfo) return <p className="metadata">This saved message has no text or files.</p>;
  return <ReplyText text={text} role={message.role}/>;
}
