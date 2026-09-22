import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { observationSchema, type AssistantObservation } from '../../packages/domain/assistant-observation.js';
import type { AssistantState } from '../../packages/domain/assistant.js';
import type { AssistantService } from './assistant.js';
import { Fault, type Store } from './store.js';

/** Transient tool observations, not a background screen recorder. */
export class AssistantObservations {
  private frames = new Map<string, { metadata: AssistantObservation; bytes: Buffer }>();
  private nextTicket = 0;
  private tickets = new Map<string, number>();
  constructor(private store: Store, private assistant: AssistantService) {}
  async accept(raw: unknown) {
    const input = observationSchema.parse(raw);
    const operation = this.assistant.operations().find(op => op.epoch === input.epoch && op.epoch === this.store.epoch && op.nativeId === input.nativeId && op.nativeKey === input.nativeKey && op.nativeRunId === input.runId);
    if (!operation) throw new Fault(409, 'observation_source', 'This view has no matching workspace run.');
    const conversation = this.conversation(operation.conversationId);
    if (conversation.nativeId !== operation.nativeId || conversation.deleted || conversation.connectionGeneration !== operation.connectionGeneration) throw new Fault(409, 'observation_source', 'The original conversation changed.');
    if (this.tickets.size >= 4) throw new Fault(429, 'observation_busy', 'View processing is busy.');
    const ticket = ++this.nextTicket; this.tickets.set(operation.id, ticket);
    try {
    const { data, info } = await sharp(Buffer.from(input.image.data, 'base64'), { limitInputPixels: 24000000, animated: false }).rotate().resize({ width: 1920, height: 1440, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (data.length > 2 * 1024 * 1024) throw new Fault(413, 'observation_size', 'This view is too large.');
    if (this.tickets.get(operation.id) !== ticket || this.store.epoch !== operation.epoch || this.conversation(operation.conversationId).nativeId !== operation.nativeId) return;
    const metadata: AssistantObservation = { id: createHash('sha256').update(operation.id).update(input.toolCallId).update(data).digest('hex'), operationId: operation.id, toolCallId: input.toolCallId, toolName: input.toolName, capturedAt: new Date().toISOString(), width: info.width, height: info.height };
    this.frames.delete(operation.id); this.frames.set(operation.id, { metadata, bytes: data });
    while (this.frames.size > 12) { const key = this.frames.keys().next().value!; this.frames.delete(key); this.tickets.delete(key); }
    } finally { if (this.tickets.get(operation.id) === ticket) this.tickets.delete(operation.id); }
  }
  private conversation(id: string) { const value = this.assistant.conversations().find(c => c.id === id); if (!value) throw new Fault(404, 'observation_source', 'This conversation is unavailable.'); return value; }
  private frame(operationId: string) {
    const operation = this.assistant.operations().find(op => op.id === operationId);
    if (!operation) throw new Fault(404, 'observation_source', 'This run is unavailable.');
    const conversation = this.conversation(operation.conversationId);
    if (operation.epoch !== this.store.epoch || conversation.deleted || conversation.nativeId !== operation.nativeId || conversation.connectionGeneration !== operation.connectionGeneration) throw new Fault(409, 'observation_source', 'The original conversation changed.');
    return this.frames.get(operationId);
  }
  read(operationId: string) { return this.frame(operationId)?.metadata ?? null; }
  withHints(state: AssistantState): AssistantState {
    if (!this.frames.size) return state;
    const conversations = new Map(state.conversations.map(conversation => [conversation.id, conversation]));
    return { ...state, operations: state.operations.map(operation => {
      const frame = this.frames.get(operation.id), conversation = conversations.get(operation.conversationId);
      return frame && operation.epoch === this.store.epoch && conversation && !conversation.deleted && conversation.nativeId === operation.nativeId && conversation.connectionGeneration === operation.connectionGeneration
        ? { ...operation, observationId: frame.metadata.id } : operation;
    }) };
  }
  image(operationId: string, id: string) { const frame = this.frame(operationId); if (!frame || frame.metadata.id !== id) throw new Fault(404, 'observation_missing', 'A newer view is available.'); return frame.bytes; }
}
