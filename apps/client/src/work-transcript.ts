import type { AssistantOperation } from '../../../packages/domain/assistant';
import type { HistoryToolCall, ToolActivity } from '../../../packages/domain/tool-activity';
import type { TranscriptMessage } from './voice-transcript';

type WorkOptions = { operations: AssistantOperation[]; conversationId: string; nativeId?: string; active?: AssistantOperation };
export type WorkEntry = { kind: 'message'; message: TranscriptMessage } | { kind: 'tool'; tool: ToolActivity; sources: TranscriptMessage[] };
const hasText = (message: TranscriptMessage) => !!(message.authoredText ?? message.text).trim();
const voice = (message: TranscriptMessage) => !!message.voiceParts || !!message.pendingVoice || message.source?.kind === 'voice' || message.id.startsWith('voice:');
const assistantWork = (message: TranscriptMessage) => !voice(message) && (message.role === 'assistant' || message.role === 'tool');
const sourceScope = (message: TranscriptMessage) => JSON.stringify([
  message.source?.bindingId ?? '', message.source?.nativeId ?? '', message.source?.nativeKey ?? '',
  message.source?.connectionGeneration ?? '', message.operationId ?? '', message.runId ?? '',
]);
const sourceIdentity = (message: TranscriptMessage) => `${message.role}:${message.novaId ?? message.id}`;
const operationScope = (message: TranscriptMessage, operation: AssistantOperation) => JSON.stringify([
  message.source?.bindingId ?? '', message.source?.nativeId ?? operation.nativeId,
  message.source?.nativeKey ?? operation.nativeKey, message.source?.connectionGeneration ?? operation.connectionGeneration,
  operation.id, operation.nativeRunId,
]);
const liveStates = new Set<AssistantOperation['state']>(['prepared', 'dispatching', 'accepted', 'running']);
const terminalTool = (state: ToolActivity['state']) => state === 'completed' || state === 'failed' || state === 'blocked';

function matchesOperation(message: TranscriptMessage, operation: AssistantOperation, nativeId?: string) {
  const source = message.source;
  if (operation.steerTarget || (source?.nativeId ?? nativeId) !== operation.nativeId
    || source && (source.connectionGeneration !== operation.connectionGeneration || source.nativeKey !== operation.nativeKey)) return false;
  if (message.operationId) return message.operationId === operation.id && (!message.runId || !operation.nativeRunId || message.runId === operation.nativeRunId);
  return !!message.runId && !!operation.nativeRunId && message.runId === operation.nativeRunId;
}

/** Streaming text can disappear only after this exact operation's words are
 * already visible. A similar reply from another binding is not a receipt. */
export function hasVisibleOperationText(messages: TranscriptMessage[], operation: AssistantOperation, nativeId?: string): boolean {
  if (!operation.text?.trim()) return false;
  return messages.some(message => message.workParts || message.voiceParts
    ? hasVisibleOperationText(message.workParts ?? message.voiceParts!, operation, nativeId)
    : message.role === 'assistant' && !voice(message) && matchesOperation(message, operation, nativeId)
      && (message.authoredText ?? message.text) === operation.text);
}

/** Preserve narration unless the saved operation proves where its final answer
 * is. A split turn keeps separate tool groups: a second elapsed header must not
 * imply that either fragment contains the whole operation. */
export function groupWorkMessages(messages: TranscriptMessage[], options: WorkOptions): TranscriptMessage[] {
  const operations = [...options.operations, ...(options.active && !options.operations.some(item => item.id === options.active!.id) ? [options.active] : [])]
    .filter(operation => operation.conversationId === options.conversationId && !operation.steerTarget);
  const owners = messages.map(message => {
    if (!assistantWork(message)) return undefined;
    const matching = operations.filter(operation => matchesOperation(message, operation, options.nativeId));
    return matching.length === 1 ? matching[0] : undefined;
  });
  const segments: { start: number; end: number; operation?: AssistantOperation }[] = [];
  for (let index = 0; index < messages.length;) {
    const start = index, operation = owners[index];
    if (!operation) { segments.push({ start, end: ++index }); continue; }
    // A provider binding is part of the source identity even when two bindings
    // happen to name the same native session and run.
    while (++index < messages.length && owners[index]?.id === operation.id && operationScope(messages[index], operation) === operationScope(messages[start], operation)) { /* one contiguous source */ }
    segments.push({ start, end: index, operation });
  }
  const counts = new Map<string, number>();
  for (const segment of segments) if (segment.operation) counts.set(segment.operation.id, (counts.get(segment.operation.id) ?? 0) + 1);
  const rows: TranscriptMessage[] = [];
  let legacy: TranscriptMessage[] = [];
  const flushLegacy = () => {
    if (legacy.length) rows.push({ ...legacy[0], workParts: legacy });
    legacy = [];
  };
  const appendLegacy = (message: TranscriptMessage) => {
    if ((assistantWork(message) && message.toolInfo && !hasText(message)) || (!voice(message) && message.role === 'tool')) {
      if (legacy.length && sourceScope(legacy[0]) !== sourceScope(message)) flushLegacy();
      legacy.push(message);
    } else { flushLegacy(); rows.push(message); }
  };
  for (const { start, end, operation } of segments) {
    const parts = messages.slice(start, end);
    const plain = parts.filter(message => message.role === 'assistant' && !message.toolInfo && hasText(message));
    const interrupted = operation?.state === 'failed' || operation?.state === 'cancelled';
    const matchingFinals = operation && (operation.state === 'completed' || interrupted) && operation.text.trim() ? plain.filter(message => message.text === operation.text) : [];
    const final = matchingFinals.length === 1 && plain.at(-1) === matchingFinals[0] ? matchingFinals[0] : undefined;
    const settledTools = (interrupted || operation?.state === 'completed' && !operation.text.trim())
      && parts.every(message => message.role === 'tool' || !!message.toolInfo && !hasText(message));
    const active = operation && options.active?.id === operation.id && (liveStates.has(operation.state) || operation.state === 'unknown');
    if (operation && counts.get(operation.id) === 1 && (active || final || settledTools)) {
      flushLegacy();
      rows.push({ ...parts[0], workParts: parts, workOperation: operation, ...(final ? { workFinal: final } : {}) });
    } else for (const message of parts) appendLegacy(message);
  }
  flushLegacy();
  return resolveLegacyActivity(rows, operations, options.nativeId);
}

/** A steering message can split one run's activity without splitting its tool
 * identity. Resolve only trusted tool fragments; keep user text and narration
 * outside them, and do not imply that a fragment is a complete timed turn. */
function resolveLegacyActivity(rows: TranscriptMessage[], operations: AssistantOperation[], nativeId?: string): TranscriptMessage[] {
  const groups = new Map<string, { operation: AssistantOperation; rows: { index: number; parts: TranscriptMessage[] }[] }>();
  rows.forEach((row, index) => {
    if (row.workOperation || !row.workParts?.length || !row.workParts.every(part => !!part.toolInfo)) return;
    const matches = operations.filter(operation => row.workParts!.every(part => matchesOperation(part, operation, nativeId)));
    if (matches.length !== 1) return;
    const operation = matches[0], key = operationScope(row.workParts[0], operation);
    const group = groups.get(key) ?? { operation, rows: [] };
    group.rows.push({ index, parts: row.workParts }); groups.set(key, group);
  });
  const replacements = new Map<number, TranscriptMessage | undefined>();
  for (const { operation, rows: fragments } of groups.values()) {
    const parts = fragments.flatMap(fragment => fragment.parts);
    const positions = new Map(fragments.flatMap(fragment => fragment.parts.map(part => [part, fragment.index] as const)));
    const placed = new Map<number, Set<TranscriptMessage>>();
    for (const entry of workEntries(parts, operation, { includeUnseen: false })) {
      if (entry.kind !== 'tool') continue;
      const index = Math.min(...entry.sources.map(source => positions.get(source)!));
      const sources = placed.get(index) ?? new Set<TranscriptMessage>();
      entry.sources.forEach(source => sources.add(source)); placed.set(index, sources);
    }
    for (const fragment of fragments) {
      const sources = placed.get(fragment.index);
      const kept = sources && parts.filter(part => sources.has(part));
      replacements.set(fragment.index, kept?.length ? { ...kept[0], workParts: kept, workActivityOperation: operation } : undefined);
    }
  }
  return rows.flatMap((row, index) => replacements.has(index) ? replacements.get(index) ? [replacements.get(index)!] : [] : [row]);
}

/** The one active fallback owns only activity not already shown in trusted
 * fragments. Conflicting receipts remain separate because workEntries retains
 * the unmatched runtime observation with no saved source. */
export function unrepresentedWorkTools(rows: TranscriptMessage[], operation: AssistantOperation): ToolActivity[] {
  const parts = rows.filter(row => row.workActivityOperation?.id === operation.id).flatMap(row => row.workParts ?? []);
  return workEntries(parts, operation).flatMap(entry => entry.kind === 'tool' && !entry.sources.length ? [entry.tool] : []);
}

type ToolEvent = { tool: ToolActivity; source: TranscriptMessage; call: boolean; key?: string; order: number };
const callsFor = (message: TranscriptMessage): HistoryToolCall[] => {
  const info = message.toolInfo;
  if (!info || info.state !== 'called') return [];
  if (info.entries?.length) return info.entries;
  return (info.calls?.length ? info.calls : [info.name]).map(name => ({ name, ...(info.calls?.length && info.calls.length > 1 ? {} : { id: info.id }) }));
};
const eventSignature = (event: ToolEvent) => JSON.stringify([event.tool.name, event.tool.input ?? '', event.tool.state, event.tool.output ?? '']);
const uniqueSources = (events: ToolEvent[]) => [...new Set(events.map(event => event.source))];
const runtimeScope = (message: TranscriptMessage, operation: AssistantOperation) => matchesOperation(message, operation, operation.nativeId);
const sameOutput = (saved: ToolActivity, runtime: ToolActivity) => saved.output === runtime.output
  || !!runtime.truncated && !!runtime.output && saved.output?.startsWith(runtime.output)
  || !!saved.truncated && !!saved.output && runtime.output?.startsWith(saved.output);

function mergeRuntime(saved: ToolActivity, runtime: ToolActivity, hasResult: boolean): ToolActivity | undefined {
  // The runtime bounds large results. Its explicitly truncated prefix is not
  // a contradictory receipt when saved history retains the complete text.
  const matchingOutput = sameOutput(saved, runtime);
  if (saved.name !== runtime.name || terminalTool(saved.state) && terminalTool(runtime.state)
    && (saved.state !== runtime.state || saved.output !== undefined && runtime.output !== undefined && !matchingOutput)) return undefined;
  // An unconfirmed result can carry useful text, but it must not replace a
  // different confirmed receipt or borrow that receipt's success state. Keep
  // both rows when the text differs; identical text can share its proven state.
  if (hasResult && (saved.state === 'unknown' && terminalTool(runtime.state) && saved.output !== undefined && !matchingOutput
    || runtime.state === 'unknown' && terminalTool(saved.state) && runtime.output !== undefined && !matchingOutput)) return undefined;
  const savedWins = terminalTool(saved.state) || hasResult && runtime.state === 'running';
  const output = saved.output === undefined || saved.truncated && runtime.output !== undefined && matchingOutput
    && (runtime.output.length > saved.output.length || !runtime.truncated) ? runtime : saved;
  return { ...saved, ...runtime, state: savedWins ? saved.state : runtime.state,
    input: saved.input ?? runtime.input, output: output.output, truncated: output.truncated };
}

/** Join call and outcome by exact identity, never by tool name or proximity.
 * Sources remain attached to a folded row for search, links and file actions. */
export function workEntries(parts: TranscriptMessage[], operation?: AssistantOperation, { includeUnseen = true }: { includeUnseen?: boolean } = {}): WorkEntry[] {
  const ordered: ({ kind: 'message'; message: TranscriptMessage } | ToolEvent)[] = [];
  const buckets = new Map<string, ToolEvent[]>();
  const add = (event: ToolEvent) => {
    ordered.push(event);
    if (event.key) buckets.set(event.key, [...(buckets.get(event.key) ?? []), event]);
  };
  for (const message of parts) {
    const info = message.toolInfo;
    if (!info || voice(message) || message.role !== 'assistant' && message.role !== 'tool') {
      ordered.push({ kind: 'message', message }); continue;
    }
    const scope = operation && runtimeScope(message, operation) ? operationScope(message, operation) : sourceScope(message), identity = sourceIdentity(message);
    if (message.role === 'assistant' && hasText(message)) ordered.push({ kind: 'message', message: { ...message, toolInfo: undefined } });
    if (info.state === 'called') {
      for (const [index, call] of callsFor(message).entries()) {
        const id = call.id?.trim() ? call.id : undefined;
        add({ call: true, source: message, order: ordered.length, ...(id ? { key: `${scope}:${id}` } : {}),
          tool: { id: id ?? `history:${identity}:call:${index}`, name: call.name, input: call.input, state: 'unknown', sequence: message.sequence ?? 0 } });
      }
    } else {
      const id = info.id?.trim() ? info.id : undefined;
      add({ call: false, source: message, order: ordered.length, ...(id ? { key: `${scope}:${id}` } : {}),
        tool: { id: id ?? `history:${identity}:result`, name: info.name, state: info.state, output: message.text || undefined, sequence: message.sequence ?? 0 } });
    }
  }
  const folded = new Map<ToolEvent, { tool: ToolActivity; sources: TranscriptMessage[]; events: ToolEvent[] }>();
  const consumed = new Set<ToolEvent>();
  for (const events of buckets.values()) {
    const calls = events.filter(event => event.call), results = events.filter(event => !event.call);
    // Duplicate deliveries can fold only if every reported value agrees. A
    // conflicting result stays inspectable and cannot silently become success.
    if (new Set(calls.map(eventSignature)).size > 1 || new Set(results.map(eventSignature)).size > 1 || new Set(events.map(event => event.tool.name)).size > 1) continue;
    const first = events[0], call = calls[0], result = results[0];
    folded.set(first, { tool: { ...(call ?? result).tool, ...(result ? result.tool : {}), input: call?.tool.input, sequence: Math.max(...events.map(event => event.tool.sequence)) }, sources: uniqueSources(events), events });
    for (const event of events.slice(1)) consumed.add(event);
  }
  const rows: WorkEntry[] = [], usedRuntime = new Set<ToolActivity>();
  for (const item of ordered) {
    if ('kind' in item) { rows.push(item); continue; }
    if (consumed.has(item)) continue;
    const group = folded.get(item) ?? { tool: item.tool, sources: [item.source], events: [item] };
    let tool = group.tool;
    const matchingRuntime = operation && group.events.every(event => !!event.key && runtimeScope(event.source, operation))
      ? operation.tools?.filter(candidate => candidate.id === tool.id) ?? [] : [];
    if (matchingRuntime.length === 1) {
      const runtime = matchingRuntime[0], merged = mergeRuntime(tool, runtime, group.events.some(event => !event.call));
      if (merged) {
        tool = merged;
        // A stale saved start is not proof of ongoing execution after the
        // operation has stopped or lost confirmation.
        if (tool.state === 'running' && !liveStates.has(operation!.state)) tool = { ...tool, state: 'unknown' };
        usedRuntime.add(runtime);
      }
    }
    rows.push({ kind: 'tool', tool, sources: group.sources });
  }
  if (operation && includeUnseen) for (const runtime of operation.tools ?? []) {
    if (usedRuntime.has(runtime)) continue;
    // Only a trusted group may carry activity that has not entered history.
    if (parts.length && !parts.every(message => runtimeScope(message, operation))) continue;
    rows.push({ kind: 'tool', tool: runtime.state === 'running' && !liveStates.has(operation.state) ? { ...runtime, state: 'unknown' } : runtime, sources: [] });
  }
  return rows;
}
