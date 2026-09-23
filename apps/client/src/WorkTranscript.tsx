import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { ConversationMessage } from '../../../packages/domain/assistant';
import { ActivityRow, activityLabel } from './ToolActivity';
import { WorkPhase } from './WorkPhase';
import { ReplyText } from './ReplyText';
import { transcriptContains, type TranscriptMessage } from './voice-transcript';
import { workEntries, type WorkEntry } from './work-transcript';
import { groupWorkActions } from './work-action-groups';
import { ChevronDown, Device } from './icons';
import { QuestionReceipts } from './QuestionReceipts';

function ActionGroup({ summary, forceOpen, revealKey, children }: { summary: string; forceOpen: boolean; revealKey?: string; children: ReactNode }) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen, revealKey]);
  return <details className="work-action-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Device size={16}/><span>{summary}</span><ChevronDown size={13} className="work-disclosure-chevron"/></summary>
    <div className="work-action-group-content">{children}</div>
  </details>;
}

export function WorkTranscript({ message, renderMessage, match, onMatch, checkStatus, hideStream = false }: {
  message: TranscriptMessage;
  renderMessage: (message: ConversationMessage, options?: { hideTool?: boolean }) => ReactNode;
  match?: { id: string; role?: string };
  onMatch?: (node: HTMLDivElement | null) => void;
  checkStatus?: () => void;
  hideStream?: boolean;
}) {
  const operation = message.workOperation ?? message.workActivityOperation;
  const fragment = !!message.workActivityOperation && !message.workOperation;
  const active = !!operation && !['completed', 'failed', 'cancelled'].includes(operation.state);
  const parts = (message.workParts ?? []).filter(part => part !== message.workFinal);
  const entries = workEntries(parts, operation, { includeUnseen: !fragment }).filter(entry => entry.kind !== 'tool' || !['progress_card', 'update_plan'].includes(entry.tool.name));
  const tools = entries.filter(entry => entry.kind === 'tool').map(entry => entry.tool);
  const labels = [...new Set(tools.filter(tool => tool.state === 'completed').map(tool => activityLabel(tool.name)))];
  const issues = tools.filter(tool => ['failed', 'blocked', 'unknown'].includes(tool.state)).length;
  const summary = active ? undefined : labels.length ? `${labels.slice(0, 3).join(' · ')}${labels.length > 3 ? ' · More activity' : ''}${issues ? ' · Some actions need review' : ''}` : undefined;
  const matches = (part: TranscriptMessage) => !!match && transcriptContains(part, match.id, match.role ?? part.role);
  const revealKey = match ? JSON.stringify([match.role, match.id]) : undefined;
  const containsMatch = parts.some(matches);
  const streamed = !hideStream && active && operation?.text && !parts.some(part => part.role === 'assistant' && part.text === operation.text);
  const renderedSources = new Set<string>();
  const renderEntry = (entry: WorkEntry, index: number) => entry.kind === 'message'
    ? <Fragment key={`message:${entry.message.novaId ?? entry.message.id}`}>{renderMessage(entry.message)}</Fragment>
    : <div key={`tool:${entry.tool.id}:${index}`} tabIndex={entry.sources.some(matches) ? -1 : undefined} ref={entry.sources.some(matches) ? onMatch : undefined} className={entry.sources.some(matches) ? 'work-action matched-message' : 'work-action'}>
      <ActivityRow tool={entry.tool} unconfirmed={operation?.state === 'unknown' || !!operation && !active} forceOpen={entry.sources.some(matches)} revealKey={revealKey}/>
      {entry.sources.filter(source => {
        const identity = `${source.role}:${source.novaId ?? source.id}`;
        if (!source.attachments.length || source.role === 'assistant' && source.text.trim() || renderedSources.has(identity)) return false;
        renderedSources.add(identity); return true;
      }).map(source => <Fragment key={`files:${source.novaId ?? source.id}`}>{renderMessage({ ...source, text: '', authoredText: '' }, { hideTool: true })}</Fragment>)}
    </div>;
  const activity = groupWorkActions(entries).map((entry, index) => entry.kind === 'actions'
    ? <ActionGroup key={`actions:${entry.entries[0].tool.id}:${index}`} summary={entry.summary} forceOpen={entry.entries.some(action => action.sources.some(matches))} revealKey={revealKey}>{entry.entries.map(renderEntry)}</ActionGroup>
    : renderEntry(entry, index));
  return <div className="work-transcript">
    {fragment ? activity : <WorkPhase operation={operation} active={active} forceOpen={containsMatch} revealKey={revealKey} summary={summary}>
      {activity}
      {streamed && <ReplyText text={operation!.text} role="assistant" streaming={operation?.state !== 'unknown'}/>}
      {operation?.error && <p className="metadata">{operation.error}</p>}
      {operation?.state === 'unknown' && checkStatus && <button className="text-button" onClick={checkStatus}>Check status</button>}
      {!entries.length && !streamed && <p className="metadata">{active ? 'Preparing your reply…' : 'No activity details were saved for this reply.'}</p>}
    </WorkPhase>}
    <QuestionReceipts items={message.questionReceipts}/>
    {message.workFinal && renderMessage(message.workFinal)}
  </div>;
}
