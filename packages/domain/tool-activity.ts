export type ToolOutcome = 'completed' | 'failed' | 'blocked' | 'unknown';
export type ToolActivity = { id: string; name: string; title?: string; input?: string; state: 'running' | ToolOutcome; output?: string; truncated?: boolean; sequence: number };
export type HistoryToolCall = { id?: string; name: string; input?: string };
export type HistoryToolInfo = { id?: string; name: string; state: 'called' | ToolOutcome; calls?: string[]; entries?: HistoryToolCall[] };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const callId = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 500 ? value : undefined;
const settled = (state: ToolActivity['state']) => ['completed', 'failed', 'blocked'].includes(state);

/** Display a small, selected input rather than retaining a tool's raw arguments.
 * Omit multiline/script bodies and sensitive-looking inputs conservatively. */
export function toolDisplayInput(name: string, raw: unknown): string | undefined {
  const args = object(raw);
  const fields = ['exec', 'exec_command'].includes(name) ? ['command', 'cmd']
    : ['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file'].includes(name) ? ['path', 'file_path', 'filePath']
    : name === 'web_search' ? ['query'] : name === 'web_fetch' ? ['url'] : [];
  const value = fields.map(field => args[field]).find(value => typeof value === 'string' && value.trim());
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(value)) return undefined;
  // A command can embed credentials in flags, shell assignments, URLs or
  // scripts. Do not retain these strings; the native tool still owns its input.
  if (/\b(?:authorization|bearer|password|passwd|secret|token|api[_-]?key|private[_ -]?key|client[_-]?secret|credential|cookie)\b/i.test(value)
    || /(?:\b[A-Za-z_][A-Za-z0-9_]*=|https?:\/\/[^\s/]+@|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/.test(value)
    || /(?:^|\s)(?:-H|--header|-u|--user|--data(?:-raw|-binary)?|-d|-c|--command|-e|--eval|--encodedcommand)(?:\s|=)/i.test(value)) return undefined;
  if (name === 'web_fetch') {
    try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined; } catch { return undefined; }
  }
  const trimmed = value.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 599)}…` : trimmed;
}

const textOutput = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  const record = object(value);
  if (typeof record.output === 'string') return record.output;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return Array.isArray(record.content) ? record.content.filter((part: any) => ['text', 'toolResult'].includes(part?.type) && typeof part.text === 'string').map((part: any) => part.text).join('\n') : undefined;
};
function toolOutcome(raw: Record<string, any>, output?: string): ToolOutcome {
  const result = object(raw.result), error = object(raw.error), resultError = object(result.error);
  // A familiar word such as "denied" in arbitrary output is not evidence that
  // access was blocked. Only the runtime's exact denial marker is recognized.
  if ([raw.code, error.code, result.code, resultError.code].includes('SYSTEM_RUN_DENIED')
    || /^\s*(?:(?:Error:\s*)?SYSTEM_RUN_DENIED(?:\s*:|\s*$)|Exec denied \(SYSTEM_RUN_DENIED:)/.test((output ?? '').slice(0, 16000))) return 'blocked';
  return raw.isError === true || result.isError === true ? 'failed' : raw.isError === false || result.isError === false ? 'completed' : 'unknown';
}

export function toolActivity(previous: ToolActivity[] = [], raw: unknown, sequence: number): ToolActivity[] {
  const data = object(raw), id = callId(data.toolCallId);
  if (data.hideFromChannelProgress === true || !id || typeof data.name !== 'string' || !data.name || !['start', 'update', 'result'].includes(data.phase)) return previous;
  const index = previous.findIndex(tool => tool.id === id), prior = previous[index];
  if (prior && (prior.sequence >= sequence || settled(prior.state))) return previous;
  const output = typeof data.output === 'string' ? data.output : textOutput(data.result);
  const input = toolDisplayInput(data.name, data.args ?? data.arguments);
  const state = data.phase !== 'result' ? 'running' : toolOutcome(data, output);
  const tool: ToolActivity = { ...prior, id, name: data.name.slice(0, 200), sequence, state, ...(typeof data.title === 'string' ? { title: data.title.slice(0, 500) } : {}), ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output: output.slice(0, 16000), truncated: output.length > 16000 } : {}) };
  if (index < 0) return [...previous, tool].slice(-100);
  return previous.map((item, at) => at === index ? tool : item);
}

export function historyToolInfo(raw: unknown): HistoryToolInfo | undefined {
  const message = object(raw);
  if (message.role === 'toolResult' || message.role === 'tool') {
    const id = callId(message.toolCallId);
    return { ...(id ? { id } : {}), name: typeof message.toolName === 'string' ? message.toolName.slice(0, 200) : 'Tool', state: toolOutcome(message, textOutput(message)) };
  }
  const entries: HistoryToolCall[] = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === 'toolCall' && typeof part.name === 'string').slice(0, 100).map((part: any) => {
    const id = callId(part.id ?? part.toolCallId), input = toolDisplayInput(part.name, part.arguments ?? part.args);
    return { ...(id ? { id } : {}), name: part.name.slice(0, 200), ...(input !== undefined ? { input } : {}) };
  }) : [];
  const calls = entries.map(entry => entry.name);
  return calls.length ? { ...(entries.length === 1 && entries[0].id ? { id: entries[0].id } : {}), name: calls.length === 1 ? calls[0] : `${calls.length} tools`, state: 'called', calls, entries } : undefined;
}
