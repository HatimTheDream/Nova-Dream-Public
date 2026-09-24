import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AssistantOperation } from '../../../packages/domain/assistant';
import { Download, FileText } from './icons';
import { ToolActivity } from './ToolActivity';
import { researchSources } from './research-sources';
import { researchReportElapsed, researchReportExport, researchReportTitle } from './research-report-export';
import './research-report.css';

type ReaderView = 'report' | 'sources' | 'activity';
export function ResearchReport({ text, children, operation, title }: { text: string; children: ReactNode; operation?: AssistantOperation; title?: string }) {
  const body = useRef<HTMLDivElement>(null), reportId = useId(), sourceId = useId(), activityId = useId();
  const [expanded, setExpanded] = useState(false), [view, setView] = useState<ReaderView>('report');
  const [sources, setSources] = useState<ReturnType<typeof researchSources>>([]), [error, setError] = useState('');
  const reportTitle = researchReportTitle(text, title), elapsed = researchReportElapsed(operation);
  const tools = operation?.tools?.filter(tool => !['progress_card', 'update_plan'].includes(tool.name)) ?? [];
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const collect = () => {
      const next = researchSources([...element.querySelectorAll<HTMLAnchorElement>('a[href]')].map(link => ({ href: link.getAttribute('href') ?? '', title: link.textContent ?? '' })));
      setSources(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    collect();
    // The saved reply's rendered links are evidence; raw tool text is not a
    // trustworthy list of visited sources and must not manufacture a count.
    const observer = new MutationObserver(collect);
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] });
    return () => observer.disconnect();
  }, [text]);
  const open = (next: ReaderView) => { setView(next); setExpanded(true); };
  const download = () => {
    setError('');
    let url: string | undefined;
    try {
      const file = researchReportExport(text, title);
      url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType }));
      const link = document.createElement('a');
      link.href = url; link.download = file.name; link.style.display = 'none';
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch { setError('The Markdown download could not start. You can still copy the report from the conversation.'); }
    finally { if (url) { const saved = url; setTimeout(() => URL.revokeObjectURL(saved), 1000); } }
  };
  const exportButton = <button type="button" className="research-report-action" onClick={download} aria-label="Export report as Markdown" title="Export as Markdown (.md)"><Download size={16}/></button>;
  const metadata = <p className="research-report-meta">Research completed{elapsed && ` in ${elapsed}`}{sources.length > 0 && ` · ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`}</p>;
  return <section className="research-report" aria-label="Research report">
    {metadata}
    <div className={`research-report-document${expanded ? ' research-report-document--expanded' : ''}`}>
      <header className="research-report-toolbar"><span className="research-report-title"><FileText size={17}/><strong title={reportTitle}>{reportTitle}</strong></span><div className="research-report-actions">{exportButton}<button type="button" className="research-report-action" aria-expanded={expanded} aria-controls={reportId} onClick={() => { setView('report'); setExpanded(value => !value); }}>{expanded ? 'Collapse' : 'Expand'}</button></div></header>
      <div className={`research-report-reader research-report-reader--${view}`}>
        {expanded && <nav className="research-reader-toolbar" aria-label="Research views"><div className="research-reader-tabs">{(['report', 'sources', 'activity'] as const).filter(item => item !== 'activity' || tools.length > 0).map(item => <button key={item} type="button" className="research-report-action" aria-pressed={view === item} aria-controls={item === 'sources' ? sourceId : item === 'activity' ? activityId : reportId} onClick={() => setView(item)}>{item === 'report' ? 'Report' : item === 'sources' ? 'Sources' : 'Activity'}</button>)}</div></nav>}
        <div className="research-reader-layout">
          <div id={reportId} ref={body} className="research-report-body research-reader-document" role="region" aria-label="Report text" tabIndex={expanded ? undefined : 0}>{children}</div>
          {view === 'sources' && <aside id={sourceId} className="research-reader-panel" aria-label="Report sources"><h3>Sources · {sources.length}</h3>{sources.length > 0 ? <ol className="research-source-list">{sources.map((source, index) => <li key={source.href}><span className="research-source-number" aria-hidden="true">{index + 1}</span><div><span className="research-source-host">{source.host}</span><a href={source.href} target="_blank" rel="noopener noreferrer">{source.title}</a><span className="research-source-url">{source.href}</span></div></li>)}</ol> : <p className="metadata">No source links were saved in this report.</p>}</aside>}
          {view === 'activity' && operation && <aside id={activityId} className="research-reader-panel" aria-label="Research activity"><h3>Activity{elapsed && <span> · {elapsed}</span>}</h3><ToolActivity operation={operation}/></aside>}
        </div>
      </div>
      {!expanded && <footer className="research-report-footer"><button type="button" className="research-report-action" onClick={() => open('sources')}>Sources{sources.length > 0 && ` · ${sources.length}`}</button>{tools.length > 0 && <button type="button" className="research-report-action" onClick={() => open('activity')}>Activity</button>}</footer>}
    </div>
    {error && <p role="alert" className="metadata">{error}</p>}
  </section>;
}
