import { canonical } from '../../packages/domain/contracts.js';
import { assertDirectConfiguration } from './direct-agent-runtime-policy.js';

// Keep the packaged policy independent of the full persisted execution graph.
export const groupRuntimeAgent = 'edition3-group';
export const groupRuntimePolicy = {
  name: 'Nova Dream Group recipient', skills: [] as string[], contextInjection: 'never',
  tools: { allow: [] as string[], deny: ['*'], elevated: { enabled: false } },
  subagents: { allowAgents: [] as string[] },
};
/** Both literal branches belong to the same packaged plugin/configuration
 * digest. The Group branch has no tools, including the personal read tool. */
export function assertGroupConfiguration(raw: unknown, expected: string) {
  assertDirectConfiguration(raw, expected);
  const entries = (raw as { agents: { entries: Record<string, Record<string, unknown>> } }).agents.entries;
  const entry = entries[groupRuntimeAgent];
  if (!entry) throw Error('The dedicated Group runtime policy is unavailable.');
  const { workspace, agentDir, ...policy } = entry;
  if (typeof workspace !== 'string' || !workspace || typeof agentDir !== 'string' || !agentDir
    || workspace === agentDir || canonical(policy) !== canonical(groupRuntimePolicy)
    || Object.entries(entries).some(([id, value]) => id !== groupRuntimeAgent
      && [value.workspace, value.agentDir].some(path => path === workspace || path === agentDir)))
    throw Error('The Group recipient workspace or provided-context-only policy changed.');
}
