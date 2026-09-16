// Extracted from Nova Dream MessageBubble's shared/final/streaming Markdown.
// Native artifacts continue to use the E3 source-bearing output components.
import { memo, Suspense, useId } from 'react';
import { lazy } from '../../../preload-lazy';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkUnderline from '../../processing/remarkUnderline';
import { toSafeReplyUrl } from '../../processing/replyUrl';
import { RenderingFallback } from '../../../RenderingFallback';
import '../../reply-markdown.css';

const CodeBlock = lazy(() => import('./CodeBlock').then(module => ({ default: module.CodeBlock })));
const assistantRemarkPlugins = [remarkGfm, remarkUnderline, remarkBreaks];

// The original streaming renderer balances unfinished fences for presentation.
// The authored source is never changed by this display-only completion.
function closeIncompleteCodeBlocks(text: string): string {
  const matches = text.match(/^```/gm);
  if (!matches || matches.length % 2 === 0) return text;
  return text + '\n```';
}

function StreamingCode({ language, code }: { language: string; code: string }) {
  return <div className="dc-code-block" dir="ltr"><div className="dc-code-header"><span className="dc-code-language">{language || 'code'}</span></div><pre><code>{code}</code></pre></div>;
}

export const ReplyMarkdown = memo(function ReplyMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const prefix = `reply-${useId().replaceAll(':', '')}-`;
  const components: Components = {
    table({ children }) { return <div className="table-wrapper" role="region" aria-label="Scrollable table" tabIndex={0}><table>{children}</table></div>; },
    h1({ children }) { return <h1 className="dc-markdown-document-title">{children}</h1>; },
    h2({ node: _node, id, ...props }) { return <h2 {...props} id={id ? prefix + id : undefined}/>; },
    u({ children }) { return <u className="dc-markdown-underline">{children}</u>; },
    // Remote inline media needs the original media bridge. Preserve a source
    // link without making network requests merely by reading model output.
    img({ src, alt }) {
      const href = toSafeReplyUrl(typeof src === 'string' ? src : undefined);
      return href ? <a href={href} target="_blank" rel="noopener noreferrer">{alt || 'Image source'}</a> : <span>{alt || 'Image'}</span>;
    },
    a({ href, children, node: _node, id, 'aria-describedby': describedBy, ...props }) {
      const safeHref = toSafeReplyUrl(href);
      if (!safeHref) return <span>{children}</span>;
      if (safeHref.startsWith('#')) return <a {...props} id={id ? prefix + id : undefined} aria-describedby={describedBy ? prefix + describedBy : undefined} href={`#${prefix}${safeHref.slice(1)}`}>{children}</a>;
      return <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    li({ node: _node, id, ...props }) { return <li {...props} id={id ? prefix + id : undefined}/>; },
    section({ node: _node, 'aria-labelledby': labelledBy, ...props }) { return <section {...props} aria-labelledby={labelledBy ? prefix + labelledBy : undefined}/>; },
    // Rendering at the pre node also handles a one-line fence with no language
    // and avoids putting the original CodeBlock's divs inside a nested pre.
    pre({ node }) {
      const child = node?.children.find(item => item.type === 'element' && item.tagName === 'code');
      if (!child || child.type !== 'element') return null;
      const code = child.children.map(item => item.type === 'text' ? item.value : '').join('').replace(/\n$/, '');
      const language = /language-([\w+-]+)/.exec(String(child.properties.className || ''))?.[1] ?? '';
      const fallback = <StreamingCode language={language} code={code}/>;
      return streaming ? fallback : <RenderingFallback fallback={fallback}><Suspense fallback={fallback}><CodeBlock language={language} code={code}/></Suspense></RenderingFallback>;
    },
  };
  return <div className="message-text dc-reply-markdown"><ReactMarkdown remarkPlugins={assistantRemarkPlugins} components={components} skipHtml>{streaming ? closeIncompleteCodeBlocks(text) : text}</ReactMarkdown></div>;
});
