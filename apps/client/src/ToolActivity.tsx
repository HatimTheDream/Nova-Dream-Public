import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Device, FileText, Interrupted, Search, Shield, Sparkles } from './icons';
import type { RunStep } from '../../../packages/domain/run-plan';
import type { AssistantOperation, ConversationMessage } from '../../../packages/domain/assistant';
import type { ToolActivity as ToolAction } from '../../../packages/domain/tool-activity';
import './work-phase.css';

const activityNames: Record<string, [string, string, string]> = {
  nova_read: ['Reading your workspace', 'Read your workspace', 'Workspace read'],
  nova_write: ['Requesting a workspace change', 'Requested a workspace change', 'Workspace change'],
  browser: ['Using the browser', 'Used the browser', 'Browser action'],
  computer: ['Using the computer', 'Used the computer', 'Computer action'],
  web_search: ['Searching the web', 'Searched the web', 'Web search'],
  web_fetch: ['Reading a page', 'Read a page', 'Page read'],
  read: ['Reading a file', 'Read a file', 'File read'],
  write: ['Writing a file', 'Wrote a file', 'File write'],
  edit: ['Editing a file', 'Edited a file', 'File edit'],
  exec: ['Running a command', 'Ran a command', 'Command'],
  imagegen: ['Creating an image', 'Created an image', 'Image creation'],
  github_identity_status: ['Checking GitHub identity', 'Checked GitHub identity', 'GitHub identity check'],
};
const aliases: Record<string, string> = { exec_command: 'exec', run_command: 'exec', read_file: 'read', write_file: 'write', edit_file: 'edit', image_generate: 'imagegen', generate_image: 'imagegen' };
function activityName(name: string) { const leaf = name.split(/__|\./).at(-1) ?? name; return aliases[leaf] ?? leaf; }
function readableName(name: string) { const label = activityName(name).replace(/[_-]+/g, ' ').replace(/\bgithub\b/gi, 'GitHub'); return label.charAt(0).toUpperCase() + label.slice(1); }
export function activityLabel(name: string, running = false) { return activityNames[activityName(name)]?.[running ? 0 : 1] ?? readableName(name); }
function neutralLabel(name: string) { return activityNames[activityName(name)]?.[2] ?? readableName(name); }

// Restore Nova 6bf1b26 RunPlanDock: one centered dock for the counter and its expanded plan.
export function StepsPill({ plan, operation }: { plan?: RunStep[]; operation?: AssistantOperation }) {
  const [pinned, setPinned] = useState(false), [hovered, setHovered] = useState(false);
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), panelId = useId();
  // Keep the saved plan on the operation, but remove its live dock once the
  // runtime confirms completion even when its final step update was omitted.
  const visible = !!plan?.length && operation?.state !== 'completed';
  const expanded = visible && (pinned || hovered);
  const settled = !!operation && ['completed', 'failed', 'cancelled'].includes(operation.state);
  const unconfirmed = operation?.state === 'unknown';
  useEffect(() => { if (!expanded || settled || unconfirmed) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [expanded, settled, unconfirmed]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setPinned(false); setHovered(false); } };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  if (!visible || !plan?.length) return null;
  const complete = plan.filter(step => step.status === 'complete').length, activeIndex = plan.findIndex(step => step.status === 'active');
  const counter = activeIndex >= 0 && !settled ? `Step ${activeIndex + 1} of ${plan.length}` : `${complete} of ${plan.length} complete`;
  const interrupted = operation?.state === 'failed' || operation?.state === 'cancelled';
  const status = unconfirmed ? 'Last reported' : operation?.cancelRequested && !settled ? 'Stopping' : operation?.state === 'failed' ? 'Needs attention' : operation?.state === 'cancelled' ? 'Stopped' : complete === plan.length ? 'Steps complete' : 'Live';
  const start = Date.parse(operation?.createdAt ?? ''), end = settled ? Date.parse(operation!.settledAt ?? operation!.updatedAt) : unconfirmed ? Date.parse(operation!.updatedAt) : now;
  const seconds = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined;
  const elapsed = seconds === undefined ? '' : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  const close = () => { setPinned(false); setHovered(false); };
  return <section ref={root} className="steps-pill" onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse') setHovered(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus({ preventScroll: true }); } }}>
    {expanded && <div id={panelId} className="run-plan-popover" role="region" aria-label="Task steps">
      <header><strong>Steps</strong><span>{status}{elapsed && ` · ${elapsed}`}</span></header>
      <ol className="run-steps">{plan.map(step => <li key={step.id} className={`run-step run-step--${step.status}`} aria-current={step.status === 'active' && !unconfirmed && !settled ? 'step' : undefined}><span className="run-step-indicator" aria-label={step.status === 'complete' ? 'Complete' : step.status === 'active' ? unconfirmed || settled ? 'Last reported active' : 'In progress' : 'Not started'}>{step.status === 'complete' ? <Check size={15}/> : <span className="run-step-ring"/>}</span><span><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}</span></li>)}</ol>
    </div>}
    <button ref={trigger} className={`run-plan-pill${interrupted ? ' run-plan-pill--interrupted' : ''}`} type="button" aria-label={`${unconfirmed ? 'Last reported: ' : ''}${counter}, ${complete} complete`} title={`${complete} of ${plan.length} steps complete`} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined} onClick={() => { if (pinned) close(); else setPinned(true); }}><span className="steps-pill-face">{interrupted ? <Interrupted size={13}/> : unconfirmed ? <span className="run-step-ring"/> : complete === plan.length ? <Check size={15}/> : settled ? <span className="run-step-ring"/> : <span className="run-pulse"/>}<strong>{unconfirmed ? 'Last reported · ' : ''}{counter}</strong></span></button>
  </section>;
}
export function ToolActivity({ operation, paused = false }: { operation: AssistantOperation; paused?: boolean }) {
  const tools = (operation.tools ?? []).filter(tool => !['progress_card', 'update_plan'].includes(activityName(tool.name)));
  if (!tools.length) return null;
  return <div className="work-activity" aria-label={paused || operation.state === 'unknown' ? 'Last reported activity' : 'Tool activity'}>
    {tools.length === 100 && <p className="work-activity-note">Showing the latest 100 actions.</p>}
    <ol className="work-activity-list">{tools.map(tool => <li key={tool.id}><ActivityRow tool={tool} unconfirmed={paused || operation.state === 'unknown' || ['completed', 'failed', 'cancelled'].includes(operation.state)}/></li>)}</ol>
  </div>;
}

function activityDetailText(tool: Pick<ToolAction, 'input' | 'output'>) { return [tool.input, tool.output].filter(Boolean).join('\n\n'); }
export function copyActivityDetails(tool: Pick<ToolAction, 'input' | 'output'>) { return navigator.clipboard.writeText(activityDetailText(tool)); }

function ActivityDetails({ tool, state, forceOpen = false, revealKey }: { tool: ToolAction; state: ToolAction['state']; forceOpen?: boolean; revealKey?: string }) {
  const [expanded, setExpanded] = useState(forceOpen), [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const value = activityDetailText(tool);
  const lines = value.split('\n'), preview = lines.slice(0, 12).join('\n').slice(0, 1400), clipped = preview.length < value.length;
  const label = activityName(tool.name) === 'exec' ? 'Shell' : 'Details';
  useEffect(() => { setCopyState('idle'); }, [value]);
  useEffect(() => { if (forceOpen) setExpanded(true); }, [forceOpen, revealKey]);
  useEffect(() => { if (copyState === 'idle') return; const timer = setTimeout(() => setCopyState('idle'), 2500); return () => clearTimeout(timer); }, [copyState]);
  async function copy() { try { await copyActivityDetails(tool); setCopyState('copied'); } catch { setCopyState('failed'); } }
  return <section className="work-activity-value" aria-label={label === 'Shell' ? 'Shell details' : 'Action details'}>
    <header><span>{label}</span>{value && <button type="button" className="work-detail-button" onClick={() => void copy()} aria-label="Copy details"><Copy size={14}/><span>{copyState === 'copied' ? 'Copied' : 'Copy'}</span></button>}</header>
    {!tool.input && <p className="work-activity-note">Input details are not available in this view.</p>}
    {value && <pre>{expanded || !clipped ? value : `${preview}\n…`}</pre>}
    {!tool.output && <p className="work-activity-note">{state === 'running' ? 'Waiting for a result.' : 'No output was included in this saved result.'}</p>}
    {clipped && <button type="button" className="work-detail-button work-detail-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show full saved text'}</button>}
    {tool.truncated && <p className="work-activity-note">Only part of this result was saved here. The full result remains in the source conversation.</p>}
    {copyState !== 'idle' && <span className="work-copy-status" role="status">{copyState === 'failed' ? 'Could not copy. Select the text to copy it.' : 'Details copied.'}</span>}
  </section>;
}

export function ActivityRow({ tool, forceOpen = false, revealKey, unconfirmed = false }: { tool: ToolAction; forceOpen?: boolean; revealKey?: string; unconfirmed?: boolean }) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen, revealKey]);
  const state = unconfirmed && tool.state === 'running' ? 'unknown' : tool.state;
  const status = state === 'failed' ? 'Failed' : state === 'blocked' ? 'Blocked' : state === 'unknown' ? 'Outcome unconfirmed' : '';
  const name = activityName(tool.name), Icon = ['read', 'write', 'edit', 'nova_read', 'nova_write'].includes(name) ? FileText : ['web_search', 'web_fetch'].includes(name) ? Search : ['exec', 'browser', 'computer'].includes(name) ? Device : state === 'blocked' ? Shield : Sparkles;
  const label = state === 'running' || state === 'completed' ? activityLabel(tool.name, state === 'running') : neutralLabel(tool.name);
  const explanation = state === 'blocked'
    ? tool.output?.includes('approval requires a resolved executable') ? 'The command did not run. Approval needs an identified executable.' : 'This action was blocked before it could run.'
    : state === 'failed' ? `This action returned an error.${tool.output ? ' Its result is below.' : ''}`
    : state === 'unknown' ? 'The saved activity does not confirm how this action ended.' : undefined;
  return <details className={`work-activity-row work-activity-row--${state}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon size={16}/><span className="work-activity-label">{label}</span>{status && <span className="work-activity-status">{status}</span>}<ChevronDown size={13} className="work-disclosure-chevron"/></summary>
    <div className="work-activity-details">
      {explanation && <p className="work-activity-explanation">{explanation}</p>}
      {tool.title && tool.title !== label && <p className="work-activity-note">{tool.title}</p>}
      <ActivityDetails tool={tool} state={state} forceOpen={forceOpen} revealKey={revealKey}/>
    </div>
  </details>;
}

export function HistoryTool({ message }: { message: ConversationMessage }) {
  if (!message.toolInfo) return null;
  const info = message.toolInfo;
  if (info.state === 'called') {
    const entries = info.entries?.length ? info.entries : (info.calls ?? [info.name]).map(name => ({ name, id: undefined, input: undefined }));
    return <div className="work-activity"><ol className="work-activity-list">{entries.map((entry, index) => <li key={entry.id ?? `${entry.name}:${index}`}><ActivityRow tool={{ id: entry.id ?? `${message.id}:${index}`, name: entry.name, input: entry.input, state: 'unknown', sequence: message.sequence ?? 0 }}/></li>)}</ol></div>;
  }
  return <ActivityRow tool={{ id: info.id ?? message.id, name: info.name, state: info.state, output: message.role === 'tool' ? message.text : undefined, sequence: message.sequence ?? 0 }}/>;
}
