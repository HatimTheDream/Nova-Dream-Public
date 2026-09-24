import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Research } from './icons';
import { Dialog } from './ui';
import { ReplyText } from './ReplyText';
import { researchSources } from './research-sources';
import './research-report.css';

export function ResearchReport({ text, children }: { text: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false), [sources, setSources] = useState<ReturnType<typeof researchSources>>([]);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const collect = () => {
      const next = researchSources([...element.querySelectorAll<HTMLAnchorElement>('a[href]')].map(link => ({ href: link.getAttribute('href') ?? '', title: link.textContent ?? '' })));
      setSources(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    collect();
    // Markdown is lazy-loaded; observe its rendered links, not raw text or code.
    const observer = new MutationObserver(collect);
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
    return () => observer.disconnect();
  }, [text]);
  const sourceList = sources.length > 0 && <details className="research-report-sources"><summary>Sources · {sources.length}</summary><ul>{sources.map(source => <li key={source.href}><a href={source.href} target="_blank" rel="noopener noreferrer">{source.title}</a><span>{source.host}</span></li>)}</ul></details>;
  return <section className="research-report" aria-label="Research report">
    <div className="research-report-toolbar"><span><Research size={15}/>Research</span><button type="button" className="text-button" onClick={() => setExpanded(true)}>Expand</button></div>
    <div ref={body}>{children}</div>
    {sourceList}
    {expanded && <Dialog title="Research" close={() => setExpanded(false)}><div className="research-report-reader"><ReplyText text={text} role="assistant"/>{sourceList}</div></Dialog>}
  </section>;
}
