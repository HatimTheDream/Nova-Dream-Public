import { memoryChangeSchema, type MemoryEntry, type MemorySnapshot, type MemoryState } from '../../packages/domain/memory.js';
import type { Conversation, ConversationHistory } from '../../packages/domain/assistant.js';
import { Store, Fault } from './store.js';
import { matchesMessageSource } from '../../packages/domain/conversation-source.js';

/** Owner-selected memories share the workspace authority; no native memory files are rewritten. */
export class AssistantMemory {
  constructor(private store: Store, private conversation: (id: string) => Conversation, private history: (id: string) => ConversationHistory | undefined) {}
  state(): MemoryState { return this.store.internalRead<MemoryState>('assistant:memory') ?? { revision: 0, entries: [] }; }
  capture(projectId: string | null): MemorySnapshot | undefined {
    const state = this.state();
    return state.revision ? { revision: state.revision, entries: state.entries.filter(entry => entry.projectId === null || entry.projectId === projectId).map(({ id, revision, text, projectId }) => ({ id, revision, text, projectId })) } : undefined;
  }
  change(device: string, raw: unknown) {
    const input = memoryChangeSchema.parse(raw);
    return this.store.admit(device, input, { type: 'assistant.memory', ...input }, () => {
      const state = this.state(), previous = state.entries.find(entry => entry.id === input.id);
      // Tombstones fence a stale editor without retaining the removed text here.
      const removed = this.store.internalRead<{ revision: number }>(`assistant:memory-removed:${input.id}`);
      if ((previous?.revision ?? removed?.revision ?? 0) !== input.expectedRevision || removed) throw new Fault(409, 'memory_changed', 'This memory changed or was removed in another window. Review the current memories before saving.');
      if (input.action === 'remove') {
        if (!previous) throw new Fault(404, 'memory_missing', 'This memory is no longer available.');
        this.store.internalWrite(`assistant:memory-removed:${input.id}`, { revision: previous.revision + 1 });
        this.store.internalWrite('assistant:memory', { revision: state.revision + 1, entries: state.entries.filter(entry => entry.id !== input.id) });
        return { id: input.id, revision: previous.revision + 1, removed: true };
      }
      if (input.projectId && !this.store.readEntity('project', input.projectId)) throw new Fault(409, 'memory_project_missing', 'Choose an available Project for this memory.');
      let source = previous?.source;
      if (input.source) {
        if (previous) throw new Fault(409, 'memory_source_changed', 'A saved memory keeps its original source. Create a new memory to use another source.');
        const conversation = this.conversation(input.source.conversationId), history = this.history(conversation.id);
        const message = history?.messages.find(message => matchesMessageSource(message, input.source!, history.nativeId));
        if (conversation.deleted || !message) throw new Fault(409, 'memory_source_changed', 'Reopen the exact original message before saving it to memory.');
        source = { ...input.source, title: conversation.title, excerpt: (message.authoredText ?? message.text).slice(0, 240) };
      }
      const at = new Date().toISOString();
      const entry: MemoryEntry = { id: input.id, revision: (previous?.revision ?? 0) + 1, text: input.text, projectId: input.projectId, ...(source ? { source } : {}), createdAt: previous?.createdAt ?? at, updatedAt: at };
      const entries = [...state.entries.filter(item => item.id !== input.id), entry];
      if (entries.length > 200 || entries.reduce((length, item) => length + item.text.length, 0) > 64000) throw new Fault(409, 'memory_capacity', 'Memory supports 200 notes and 64,000 characters. Shorten or remove an existing note before saving this one.');
      this.store.internalWrite('assistant:memory', { revision: state.revision + 1, entries });
      return { id: entry.id, revision: entry.revision, removed: false };
    }).value;
  }
}
