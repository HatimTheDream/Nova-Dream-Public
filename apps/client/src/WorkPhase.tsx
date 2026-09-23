import { useEffect, useId, useState, type ReactNode } from 'react';
import type { AssistantOperation } from '../../../packages/domain/assistant';
import { ChevronDown } from './icons';
import { activityLabel } from './ToolActivity';
import './work-phase.css';

const isSettled = (operation?: AssistantOperation) => !!operation && ['completed', 'failed', 'cancelled'].includes(operation.state);

/** The saved end time remains fixed when later history enriches an operation. */
export function workPhaseLabel(operation: AssistantOperation | undefined, active: boolean, now: number): string {
  if (!operation) return active ? 'Working' : 'Work details';
  const stopped = isSettled(operation), unknown = operation.state === 'unknown';
  const start = Date.parse(operation.createdAt), end = stopped ? Date.parse(operation.settledAt ?? operation.updatedAt) : unknown || !active ? Date.parse(operation.updatedAt) : now;
  const seconds = Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.floor((end - start) / 1000) : undefined;
  const duration = seconds === undefined ? '' : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  if (unknown || !active && !stopped) return `Progress unconfirmed${duration ? ` · ${duration} observed` : ''}`;
  if (operation.state === 'cancelled') return duration ? `Stopped after ${duration}` : 'Stopped';
  if (operation.state === 'failed') return duration ? `Work interrupted after ${duration}` : 'Work interrupted';
  if (operation.state === 'completed') return duration ? `Worked for ${duration}` : 'Work finished';
  if (operation.cancelRequested) return duration ? `Stopping · ${duration}` : 'Stopping';
  return duration ? `Working for ${duration}` : 'Working';
}

function activitySummary(operation?: AssistantOperation): string | undefined {
  if (!operation) return undefined;
  const tools = (operation.tools ?? []).filter(tool => !['progress_card', 'update_plan'].includes(tool.name));
  if (!tools.length) return undefined;
  const completed = [...new Set(tools.filter(tool => tool.state === 'completed').map(tool => activityLabel(tool.name)))];
  const attention = tools.some(tool => tool.state === 'failed' || tool.state === 'blocked') ? 'Some actions need attention.' : tools.some(tool => tool.state === 'unknown' || tool.state === 'running') ? 'Some outcomes are unconfirmed.' : '';
  const actions = completed.slice(0, 3).join(' · ');
  return [actions && `${actions}${completed.length > 3 ? ' · More activity below' : ''}.`, attention].filter(Boolean).join(' ') || undefined;
}

export function WorkPhase({ operation, active = !!operation && !isSettled(operation), children, forceOpen = false, revealKey, summary }: {
  operation?: AssistantOperation;
  active?: boolean;
  children: ReactNode | ((expanded: boolean) => ReactNode);
  forceOpen?: boolean;
  revealKey?: string;
  summary?: string;
}) {
  const [open, setOpen] = useState(active || forceOpen), [now, setNow] = useState(Date.now), panelId = useId();
  const ticking = active && !!operation && !isSettled(operation) && operation.state !== 'unknown';
  useEffect(() => { setOpen(active || forceOpen); }, [active, operation?.id]);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen, revealKey]);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, operation?.id]);
  const label = workPhaseLabel(operation, active, now), description = summary ?? (!active ? activitySummary(operation) : undefined);
  return <section className={`work-phase${ticking ? ' work-phase--active' : ''}${open ? ' work-phase--open' : ''}`}>
    <button className="work-phase-trigger" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span className="work-phase-label">{label}</span><ChevronDown size={14} className="work-disclosure-chevron"/>
    </button>
    <div id={panelId} className="work-phase-content" hidden={!open && typeof children !== 'function'}>
      {open && description && <p className="work-phase-summary">{description}</p>}
      {typeof children === 'function' ? children(open) : children}
    </div>
  </section>;
}
