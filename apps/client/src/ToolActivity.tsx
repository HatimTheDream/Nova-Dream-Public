const activityNames: Record<string, [string, string]> = { nova_read: ['Reading your workspace', 'Read your workspace'], nova_write: ['Requesting a workspace change', 'Requested a workspace change'], browser: ['Using the browser', 'Used the browser'], computer: ['Using the computer', 'Used the computer'], web_search: ['Searching the web', 'Searched the web'], web_fetch: ['Reading a page', 'Read a page'], read: ['Reading a file', 'Read a file'], exec: ['Running a command', 'Ran a command'], image_generate: ['Creating an image', 'Created an image'], imagegen: ['Creating an image', 'Created an image'] };
export function activityLabel(name: string, running = false) { return activityNames[name]?.[running ? 0 : 1] ?? name.replace(/_/g, ' '); }
import { useEffect, useId, useRef, useState } from 'react';
import { Check, Interrupted } from './icons';
import type { RunStep } from '../../../packages/domain/run-plan';
import type { AssistantOperation, ConversationMessage } from '../../../packages/domain/assistant';

// Restore Nova 6bf1b26 RunPlanDock: one centered dock for the counter and its expanded plan.
export function StepsPill({ plan, operation }: { plan?: RunStep[]; operation?: AssistantOperation }) {
  const [pinned, setPinned] = useState(false), [hovered, setHovered] = useState(false);
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), panelId = useId();
  const expanded = pinned || hovered;
  const settled = !!operation && ['completed', 'failed', 'cancelled'].includes(operation.state);
  const unconfirmed = operation?.state === 'unknown';
  useEffect(() => { if (!expanded || settled || unconfirmed) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [expanded, settled, unconfirmed]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setPinned(false); setHovered(false); } };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  if (!plan?.length) return null;
  const complete = plan.filter(step => step.status === 'complete').length, activeIndex = plan.findIndex(step => step.status === 'active');
  const counter = activeIndex >= 0 && !settled ? `Step ${activeIndex + 1} of ${plan.length}` : `${complete} of ${plan.length} complete`;
  const interrupted = operation?.state === 'failed' || operation?.state === 'cancelled';
  const status = unconfirmed ? 'Last reported' : operation?.cancelRequested && !settled ? 'Stopping' : operation?.state === 'failed' ? 'Needs attention' : operation?.state === 'cancelled' ? 'Stopped' : complete === plan.length ? 'Completed' : settled ? 'Reply finished' : 'Live';
  const start = Date.parse(operation?.createdAt ?? ''), end = settled || unconfirmed ? Date.parse(operation!.updatedAt) : now;
  const seconds = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined;
  const elapsed = seconds === undefined ? '' : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  const close = () => { setPinned(false); setHovered(false); };
  return <section ref={root} className="steps-pill" onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse') setHovered(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus({ preventScroll: true }); } }}>
    {expanded && <div id={panelId} className="run-plan-popover" role="region" aria-label="Task steps">
      <header><strong>Steps</strong><span>{status}{elapsed && ` · ${elapsed}`}</span></header>
      <ol className="run-steps">{plan.map(step => <li key={step.id} className={`run-step run-step--${step.status}`} aria-current={step.status === 'active' && !unconfirmed ? 'step' : undefined}><span className="run-step-indicator" aria-label={step.status === 'complete' ? 'Complete' : step.status === 'active' ? unconfirmed ? 'Last reported active' : 'In progress' : 'Not started'}>{step.status === 'complete' ? <Check size={15}/> : <span className="run-step-ring"/>}</span><span><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}</span></li>)}</ol>
    </div>}
    <button ref={trigger} className={`run-plan-pill${interrupted ? ' run-plan-pill--interrupted' : ''}`} type="button" aria-label={`${unconfirmed ? 'Last reported: ' : ''}${counter}, ${complete} complete`} title={`${complete} of ${plan.length} steps complete`} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} onClick={() => { if (pinned) close(); else setPinned(true); }}><span className="steps-pill-face">{interrupted ? <Interrupted size={13}/> : unconfirmed ? <span className="run-step-ring"/> : complete === plan.length ? <Check size={15}/> : settled ? <span className="run-step-ring"/> : <span className="run-pulse"/>}<strong>{unconfirmed ? 'Last reported · ' : ''}{counter}</strong></span></button>
  </section>;
}
export function ToolActivity({ operation }: { operation: AssistantOperation }) {
  const tools = (operation.tools ?? []).filter(tool => !['progress_card', 'update_plan'].includes(tool.name));
  if (!tools.length) return null;
  const working = tools.filter(t => t.state === 'running').length, unconfirmed = operation.state === 'unknown';
  return <details className="tool-activity compact-activity"><summary><span className="steps-status">{unconfirmed ? 'Last reported activity' : working ? activityLabel(tools.find(t => t.state === 'running')!.name, true) : tools.length === 1 ? activityLabel(tools[0].name) : 'View activity'}</span></summary>{tools.length === 100 && <p>Showing the latest 100 tool calls.</p>}<ol>{tools.map(tool => <li key={tool.id}><details><summary><span>{tool.title ?? activityLabel(tool.name, tool.state === 'running')}</span><small>{tool.state === 'unknown' || unconfirmed && tool.state === 'running' ? 'Outcome unconfirmed' : tool.state}</small></summary><p className="metadata">{tool.name}</p>{tool.output && <pre>{tool.output}</pre>}{tool.truncated && <p className="metadata">Showing the first part of this output. The full result remains in the native conversation.</p>}</details></li>)}</ol></details>;
}
export function HistoryTool({ message }: { message: ConversationMessage }) {
  if (!message.toolInfo) return null;
  const info = message.toolInfo;
  return <details className="tool-activity"><summary>{activityLabel(info.name, info.state === 'called')}<small>{info.state === 'called' ? 'Tool call' : info.state}</small></summary>{info.calls && <p>{info.calls.join(', ')}</p>}{message.role === 'tool' && (message.text ? <pre>{message.text}</pre> : <p>No output was included in this saved tool result.</p>)}</details>;
}
