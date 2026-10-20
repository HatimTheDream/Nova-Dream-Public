import { z } from 'zod';
import { canonical, type Kind } from '../../packages/domain/contracts.js';
import type { AssistantOperation, Conversation } from '../../packages/domain/assistant.js';
import { directAgentMayRead, assertDirectAgentOperation } from '../../packages/domain/direct-agent.js';
import type { Store } from './store.js';
import {
  directReadInput, directReadInputSchema, directReadOriginSchema, directRuntimeAgent,
  type DirectReadInput, type DirectReadOrigin,
} from './direct-agent-tool-calls.js';

const text = z.string().min(1).max(512), sha = z.string().regex(/^[a-f0-9]{64}$/);
const policyRequest = z.object({
  epoch: z.uuid(), policySha256: sha, agentId: z.literal(directRuntimeAgent),
  sessionKey: text, sessionId: z.uuid(), runId: z.uuid(), toolCallId: text,
  inputSha256: sha, read: directReadInputSchema,
}).strict();
const readRequest = z.object({ origin: directReadOriginSchema, read: directReadInputSchema }).strict();
const kinds = ['layout', 'task', 'project', 'routine', 'contact', 'content', 'profile'] as const;
const listInput = z.object({
  kind: z.enum(kinds), query: z.string().max(300).default(''), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
const recordInput = z.object({ kind: z.enum(kinds), id: z.string().min(1).max(2000) }).strict();
type ReadStore = Pick<Store, 'epoch' | 'recoveryEffectsPaused' | 'updateMaintenanceHeld' | 'internalList' | 'internalRead' | 'readEntity' | 'listEntities'>;

/** Internal bridge target, not an HTTP endpoint. Its future owner must bind the
 * existing loopback credential and exact managed runtime before exposing it.
 * Reads use only current retained entities; no snapshot/materialization,
 * account refresh, cursor write, receipt or native operation is performed. */
export class DirectAgentReadAuthority {
  constructor(private readonly store: ReadStore, private readonly owner: {
    epoch: string; generation: string; policySha256: string; assertCurrent(): void;
  }) {}
  private checkOwner() {
    this.owner.assertCurrent();
    if (this.store.epoch !== this.owner.epoch || this.store.recoveryEffectsPaused || this.store.updateMaintenanceHeld)
      throw Error('The original workspace is unavailable for this native read.');
  }
  authorize(raw: unknown): DirectReadOrigin {
    this.checkOwner();
    const request = policyRequest.parse(raw), parsed = directReadInput(request.read);
    if (request.epoch !== this.owner.epoch || request.policySha256 !== this.owner.policySha256
      || request.inputSha256 !== parsed.inputSha256) throw Error('The original direct read changed.');
    if (!['records.list', 'records.read'].includes(request.read.operation))
      throw Error('This source does not yet have a qualified pure read projection. Read permitted saved records instead.');
    // Match the original request, never the first active conversation operation.
    const matches = this.store.internalList<AssistantOperation>('assistant:operation:').filter(op => op.requestId === request.runId);
    if (matches.length !== 1) throw Error('The exact original native run is unavailable or ambiguous.');
    const operation = matches[0];
    const conversation = this.store.internalRead<Conversation>(`assistant:conversation:${operation.conversationId}`);
    if (!conversation) throw Error('The original conversation is unavailable.');
    const capture = assertDirectAgentOperation(conversation, operation);
    const origin: DirectReadOrigin = {
      epoch: request.epoch, operationId: operation.id, requestId: operation.requestId, conversationId: conversation.id,
      agentId: directRuntimeAgent, sessionKey: request.sessionKey, sessionId: request.sessionId,
      runId: request.runId, toolCallId: request.toolCallId, generation: this.owner.generation,
      accountId: capture.account.profileId, policySha256: request.policySha256, inputSha256: parsed.inputSha256,
    };
    const currentAgent = this.store.readEntity('agent', capture.agent.id);
    if (!directAgentMayRead(conversation, operation, currentAgent, {
      epoch: origin.epoch, operationId: origin.operationId, requestId: origin.requestId, nativeKey: origin.sessionKey,
      nativeId: origin.sessionId, generation: origin.generation, runId: origin.runId, accountId: origin.accountId,
    }, request.read.operation, request.read.input, false)) throw Error('The original captured and current read permissions do not permit this source.');
    // Native callbacks can arrive before the original acceptance is saved.
    // Missing nativeRunId stays unconfirmed; this read never fabricates it.
    if (request.read.operation === 'records.list') listInput.parse(request.read.input);
    else recordInput.parse(request.read.input);
    return directReadOriginSchema.parse(origin);
  }
  private original(origin: DirectReadOrigin, read: DirectReadInput) {
    const current = this.authorize({
      epoch: origin.epoch, policySha256: origin.policySha256, agentId: origin.agentId,
      sessionKey: origin.sessionKey, sessionId: origin.sessionId, runId: origin.runId, toolCallId: origin.toolCallId,
      inputSha256: origin.inputSha256, read,
    });
    if (canonical(current) !== canonical(origin)) throw Error('The original read authority was replaced.');
  }
  async read(raw: unknown) {
    const { origin, read } = readRequest.parse(raw);
    this.original(origin, read);
    const result = await this.readRecord(read);
    this.original(origin, read);
    return result;
  }
  private readRecord(read: DirectReadInput): unknown {
    if (read.operation === 'records.read') {
      const input = recordInput.parse(read.input), entity = this.store.readEntity(input.kind, input.id);
      if (!entity) throw Error('This saved record is unavailable.');
      return entity;
    }
    if (read.operation !== 'records.list') throw Error('Only pure saved-record reads are available.');
    const input = listInput.parse(read.input);
    const rows = this.store.listEntities(input.kind as Kind).filter(entity =>
      !input.query || canonical(entity.value).toLocaleLowerCase().includes(input.query.toLocaleLowerCase()));
    return {
      total: rows.length, more: input.offset + input.limit < rows.length,
      records: rows.slice(input.offset, input.offset + input.limit).map(entity => ({
        id: entity.id, revision: entity.revision, updatedAt: entity.updatedAt,
        ...Object.fromEntries(Object.entries(entity.value).filter(([field]) =>
          ['name', 'title', 'status', 'planned', 'due', 'projectId', 'organization', 'email', 'stage', 'archived', 'state'].includes(field))),
      })),
    };
  }
}
