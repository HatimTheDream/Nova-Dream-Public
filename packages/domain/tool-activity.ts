export type ToolActivity = { id: string; name: string; title?: string; state: 'running' | 'completed' | 'failed' | 'unknown'; output?: string; truncated?: boolean; sequence: number };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function toolActivity(previous: ToolActivity[] = [], raw: unknown, sequence: number): ToolActivity[] {
  const data = object(raw);
  if (data.hideFromChannelProgress === true || typeof data.toolCallId !== 'string' || !data.toolCallId || data.toolCallId.length > 500 || typeof data.name !== 'string' || !data.name || !['start', 'update', 'result'].includes(data.phase)) return previous;
  const index = previous.findIndex(tool => tool.id === data.toolCallId), prior = previous[index];
  if (prior && (prior.sequence >= sequence || ['completed', 'failed'].includes(prior.state))) return previous;
  const result = object(data.result);
  const output = typeof data.output === 'string' ? data.output : typeof result.output === 'string' ? result.output : Array.isArray(result.content) ? result.content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n') : typeof data.result === 'string' ? data.result : undefined;
  const state = data.phase !== 'result' ? 'running' : data.isError === true || result.isError === true ? 'failed' : data.isError === false || result.isError === false ? 'completed' : 'unknown';
  const tool: ToolActivity = { ...prior, id: data.toolCallId, name: data.name.slice(0, 200), sequence, state, ...(typeof data.title === 'string' ? { title: data.title.slice(0, 500) } : {}), ...(output !== undefined ? { output: output.slice(0, 16000), truncated: output.length > 16000 } : {}) };
  if (index < 0) return [...previous, tool].slice(-100);
  return previous.map((item, at) => at === index ? tool : item);
}

export function historyToolInfo(raw: unknown): { id?: string; name: string; state: 'called' | 'completed' | 'failed'; calls?: string[] } | undefined {
  const message = object(raw);
  if (message.role === 'toolResult' || message.role === 'tool') return { ...(typeof message.toolCallId === 'string' && message.toolCallId.length <= 500 ? { id: message.toolCallId } : {}), name: typeof message.toolName === 'string' ? message.toolName.slice(0, 200) : 'Tool', state: message.isError === true ? 'failed' : 'completed' };
  const calls = Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === 'toolCall' && typeof p.name === 'string').map((p: any) => p.name.slice(0, 200)).slice(0, 100) : [];
  return calls.length ? { name: calls.length === 1 ? calls[0] : `${calls.length} tools`, state: 'called', calls } : undefined;
}
