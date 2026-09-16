import { lazy, memo, Suspense } from 'react';
import { RenderingFallback } from './RenderingFallback';

const ReplyMarkdown = lazy(() => import('./dreamclaw/components/Chat/ReplyMarkdown').then(module => ({ default: module.ReplyMarkdown })));

export const ReplyText = memo(function ReplyText({ text, role, streaming = false }: { text: string; role: string; streaming?: boolean }) {
  const fallback = <div className="message-text preserve-lines">{text}</div>;
  return role === 'assistant' ? <RenderingFallback fallback={fallback}><Suspense fallback={fallback}><ReplyMarkdown text={text} streaming={streaming}/></Suspense></RenderingFallback> : fallback;
});
