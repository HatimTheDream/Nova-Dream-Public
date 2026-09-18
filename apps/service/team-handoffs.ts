import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AssistantOperation } from '../../packages/domain/assistant.js';
import { handoffReadSchema, type TeamHandoff, type TeamHandoffPage } from '../../packages/domain/team-work.js';
import { canonical } from '../../packages/domain/contracts.js';
import { Fault, type Store } from './store.js';

const identitySchema = z.object({
  epoch: z.uuid(), teamId: z.uuid(), stage: z.number().int().nonnegative(), attempt: z.number().int().nonnegative(),
  id: z.uuid(), conversationId: z.uuid(), requestId: z.uuid(), nativeId: z.string().min(1).max(2000), nativeKey: z.string().min(1).max(2000), connectionGeneration: z.string().min(1).max(2000), nativeRunId: z.string().min(1).max(2000).nullable(),
}).strict();
const settledState = z.enum(['completed', 'failed', 'cancelled']);
const savedSchema = identitySchema.extend({
  state: settledState, text: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  characters: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), createdAt: z.number().finite().nonnegative(),
}).strict();
type SavedHandoff = z.infer<typeof savedSchema>;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const characterCount = (text: string) => { let count = 0; for (const _character of text) count++; return count; };
const metadata = ({ id, sha256, characters, bytes, state, createdAt }: SavedHandoff): TeamHandoff => ({ id, sha256, characters, bytes, state, createdAt });

function saved(store: Store, teamId: string, id: string): SavedHandoff {
  const parsed = savedSchema.safeParse(store.internalRead('team:handoff:' + id));
  if (!parsed.success || parsed.data.id !== id || parsed.data.teamId !== teamId || parsed.data.epoch !== store.epoch)
    throw new Fault(404, 'team_handoff_missing', 'This complete handoff is unavailable in the current workflow.');
  const value = parsed.data;
  if (value.sha256 !== hash(value.text) || value.bytes !== Buffer.byteLength(value.text, 'utf8') || value.characters !== characterCount(value.text))
    throw new Fault(409, 'team_handoff_changed', 'The saved handoff does not match its original content.');
  return value;
}

/** Capture once, independently of conversation retention. Later observations of
 * the same execution cannot rewrite the result already supplied to its team. */
export function captureTeamHandoff(store: Store, input: { epoch: string; teamId: string; stage: number; attempt: number; operation: AssistantOperation }, now = Date.now()): TeamHandoff {
  const { operation } = input;
  if (input.epoch !== store.epoch || operation.epoch !== input.epoch)
    throw new Fault(409, 'team_handoff_epoch', 'The handoff belongs to a different workspace.');
  const identity = identitySchema.parse({ epoch: input.epoch, teamId: input.teamId, stage: input.stage, attempt: input.attempt, id: operation.id,
    conversationId: operation.conversationId, requestId: operation.requestId, nativeId: operation.nativeId, nativeKey: operation.nativeKey, connectionGeneration: operation.connectionGeneration, nativeRunId: operation.nativeRunId });
  const state = settledState.safeParse(operation.state);
  if (!state.success) throw new Fault(409, 'team_handoff_unsettled', 'Confirm the original execution before capturing its handoff.');
  const key = 'team:handoff:' + operation.id;
  if (store.internalRead(key) !== undefined) {
    const previous = saved(store, input.teamId, operation.id);
    if (canonical(identitySchema.parse(Object.fromEntries(Object.keys(identity).map(key => [key, previous[key as keyof SavedHandoff]])))) !== canonical(identity))
      throw new Fault(409, 'team_handoff_identity', 'This handoff identity belongs to a different execution.');
    return metadata(previous);
  }
  const value = savedSchema.parse({ ...identity, state: state.data, text: operation.text, sha256: hash(operation.text), characters: characterCount(operation.text), bytes: Buffer.byteLength(operation.text, 'utf8'), createdAt: now });
  store.internalWrite(key, value);
  return metadata(value);
}

export function teamHandoffMetadata(store: Store, teamId: string, id: string): TeamHandoff {
  return metadata(saved(store, teamId, z.uuid().parse(id)));
}

/** Offsets count Unicode code points. A page never splits a surrogate pair. */
export function readTeamHandoff(store: Store, teamId: string, id: string, offset = 0, limit = 12000): TeamHandoffPage {
  const input = handoffReadSchema.parse({ id, offset, limit }), value = saved(store, teamId, input.id);
  if (input.offset > value.characters) throw new Fault(400, 'team_handoff_offset', 'Choose an offset within this complete handoff.');
  const end = Math.min(value.characters, input.offset + input.limit);
  let text = '', position = 0;
  for (const character of value.text) { if (position >= end) break; if (position >= input.offset) text += character; position++; }
  return { ...metadata(value), text, offset: input.offset, nextOffset: end < value.characters ? end : null };
}
