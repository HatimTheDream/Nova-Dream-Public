import { createHash } from 'node:crypto';
import { canonical, type Attachment } from '../../packages/domain/contracts.js';
import type { AssistantOperation, Conversation, ConversationHistory, ConversationMessage } from '../../packages/domain/assistant.js';
import type { VoiceAttempt } from '../../packages/domain/voice.js';
import { Fault, type Store } from './store.js';

type Binding = {
  id: string; conversationId: string; nativeId: string; nativeKey: string; generation: string; order: string[];
  observedAt: string; complete: boolean; status: 'partial' | 'capturing' | 'complete' | 'conflict';
  capture?: { head: string; nextOffset?: number; finished: boolean }; verifiedHead?: string; conflicts: number;
};
type State = { version: 1; conversationId: string; revision: number; bindings: string[]; migrated?: boolean; operationsMigrated?: boolean };
type Entry = { key: string; message: ConversationMessage; final: boolean; conflicts?: { hash: string; observedAt: string }[] };
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const messageHash = (text: string) => createHash('sha256').update(canonical(text)).digest('hex');
const base = (id: string) => `assistant:transcript:${id}:`;
const stateKey = (id: string) => `assistant:transcript-state:${id}`;
const headSignature = (page: ConversationHistory) => hash(page.messages.map(m => [m.id, m.textHash]));
const bindingId = (conversation: Conversation, nativeId: string) => hash([conversation.connectionGeneration, conversation.nativeKey, nativeId]);

/** Incremental encrypted reading archive. Inference admission never uses this as a native receipt. */
export class NovaTranscript {
  private migrating = false;
  constructor(private store: Store, private project?: (conversation: Conversation, history: ConversationHistory) => ConversationHistory) {}
  private available(conversation: Conversation) {
    if (conversation.deleted || this.store.internalRead<Conversation>(`assistant:conversation:${conversation.id}`)?.deleted || this.store.internalRead(`assistant:removed:${conversation.id}`)) return false;
    const removalId = this.store.internalRead<string>(`assistant:removal-current:${conversation.id}`);
    const removal = removalId && this.store.internalRead<{ state: string }>(`assistant:removal:${removalId}`);
    return !removal || !['prepared', 'unknown', 'completed'].includes(removal.state);
  }
  private state(conversation: Conversation): State { return this.store.internalRead<State>(stateKey(conversation.id)) ?? { version: 1, conversationId: conversation.id, revision: 0, bindings: [] }; }
  private binding(conversation: Conversation, nativeId: string): Binding {
    const id = bindingId(conversation, nativeId);
    return this.store.internalRead<Binding>(base(conversation.id) + 'binding:' + id) ?? { id, conversationId: conversation.id, nativeId, nativeKey: conversation.nativeKey, generation: conversation.connectionGeneration, order: [], observedAt: new Date().toISOString(), complete: false, status: 'partial', conflicts: 0 };
  }
  private entries(conversation: Conversation, binding: Binding) { return binding.order.map(key => this.store.internalRead<Entry>(base(conversation.id) + 'message:' + key)).filter((entry): entry is Entry => !!entry); }
  private persist(conversation: Conversation, binding: Binding, entries: Entry[], aliases: { id: string; value: unknown }[] = []) {
    if (!this.available(conversation)) return;
    const state = this.state(conversation);
    if (!state.bindings.includes(binding.id)) state.bindings.push(binding.id);
    this.store.internalBatchJoined([
      ...entries.map(entry => ({ id: base(conversation.id) + 'message:' + entry.key, value: entry })),
      ...aliases,
      { id: base(conversation.id) + 'binding:' + binding.id, value: binding },
      { id: stateKey(conversation.id), value: { ...state, revision: state.revision + 1 } },
    ]);
  }
  observe(conversation: Conversation, page: ConversationHistory, options: { source?: 'native' | 'legacy'; complete?: boolean } = {}) {
    if (!this.available(conversation) || page.conversationId !== conversation.id || !page.nativeId || page.retained && options.source !== 'legacy') return false;
    if (options.source !== 'legacy') this.migrate(conversation);
    const binding = this.binding(conversation, page.nativeId), entries = this.entries(conversation, binding), known = new Map(entries.map(entry => [entry.key, entry]));
    const originalBinding = canonical({ ...binding, observedAt: undefined }), originals = new Map(entries.map(entry => [entry.key, canonical({ ...entry, message: { ...entry.message, source: entry.message.source && { ...entry.message.source, observedAt: undefined } } })]));
    const aliases: { id: string; value: unknown }[] = [], at = new Date().toISOString(), pageKeys: string[] = [];
    const operationLinks = new Map<string, string | undefined>();
    const previousKeys = new Set(binding.order);
    for (const message of page.messages) {
      // Projection positions are not identities. Keep legacy projections available,
      // but do not admit them as complete migration evidence.
      const unstable = message.id.startsWith('projection:');
      const sourceKey = base(conversation.id) + 'source:' + hash([binding.id, message.id, message.role]);
      let existingKey = this.store.internalRead<string>(sourceKey);
      const operationLookup = message.operationId ? base(conversation.id) + 'operation:' + hash([binding.id, message.operationId, message.role]) : undefined;
      if (operationLookup && !operationLinks.has(operationLookup)) operationLinks.set(operationLookup, this.store.internalRead<string>(operationLookup));
      const operationKey = operationLookup && operationLinks.get(operationLookup), linked = operationKey ? known.get(operationKey) : undefined;
      // An operation may emit several native messages with the same role. Its
      // lookup can replace the provisional record only once, never a different
      // native message that already claimed that stable Nova identity.
      if (!existingKey && linked && (linked.message.source?.kind === 'operation' || linked.message.id === message.id)) existingKey = linked.key;
      if (!existingKey && message.runId) {
        const matches = [...known.values()].filter(entry => entry.message.source?.kind === 'operation' && entry.message.runId === message.runId && entry.message.role === message.role);
        if (matches.length === 1) existingKey = matches[0].key;
      }
      const key = existingKey ?? hash([binding.id, 'native', message.id, message.role]);
      const previous = known.get(key);
      const final = options.complete === true || message.role === 'user' || page.activeRunIds?.length === 0 || !!message.runId && page.activeRunIds !== null && !page.activeRunIds.includes(message.runId);
      if (previous?.final && previous.message.source?.kind !== 'operation' && previous.message.textHash !== message.textHash) {
        if (!previous.conflicts?.some(conflict => conflict.hash === message.textHash)) {
          previous.conflicts = [...previous.conflicts ?? [], { hash: message.textHash, observedAt: at }]; binding.conflicts++;
          // Retain conflicting versions privately for reconciliation; never erase a final.
          aliases.push({ id: base(conversation.id) + 'conflict:' + hash([key, message.textHash]), value: message });
        }
        binding.complete = false; binding.status = 'conflict';
      } else {
        const priorAliases = previous?.message.aliases ?? [];
        const previousFiles = previous?.message.attachments.filter(attachment => attachment.localFile) ?? [];
        const attached = message.attachments.map(attachment => {
          const localFile = attachment.localFile ?? previousFiles.find(previous => !!attachment.artifactId && previous.artifactId === attachment.artifactId)?.localFile;
          return { ...attachment, ...(localFile ? { localFile } : {}), availability: localFile ? 'local' as const : attachment.artifactId ? 'native-reference' as const : 'unavailable' as const };
        });
        for (const attachment of previousFiles) if (!attached.some(current => current.localFile?.id === attachment.localFile?.id)) attached.push({ ...attachment, availability: 'local' });
        const merged: ConversationMessage = { ...message, novaId: previous?.message.novaId ?? `nova:${key}`, aliases: [...new Set([...priorAliases, previous?.message.id, message.id].filter((id): id is string => !!id))],
          ...(previous?.message.operationId && !message.operationId ? { operationId: previous.message.operationId } : {}),
          source: { bindingId: binding.id, nativeId: page.nativeId, nativeKey: binding.nativeKey, connectionGeneration: binding.generation, nativeMessageId: message.id, kind: options.source ?? 'native', observedAt: at },
          ...(final ? { delivery: 'completed' as const } : {}), attachments: attached };
        known.set(key, { key, message: merged, final, ...(previous?.conflicts ? { conflicts: previous.conflicts } : {}) });
      }
      aliases.push({ id: sourceKey, value: key }); pageKeys.push(key);
      if (operationLookup && !operationLinks.get(operationLookup)) { operationLinks.set(operationLookup, key); aliases.push({ id: operationLookup, value: key }); }
      if (unstable) { binding.complete = false; if (binding.status !== 'conflict') binding.status = 'partial'; }
    }
    // Merge using overlap anchors, never visible wording or changing page positions.
    const order = [...binding.order];
    for (let i = 0; i < pageKeys.length; i++) {
      const key = pageKeys[i]; if (order.includes(key)) continue;
      const following = pageKeys.slice(i + 1).find(id => order.includes(id));
      const preceding = pageKeys.slice(0, i).findLast(id => order.includes(id));
      if (following) order.splice(order.indexOf(following), 0, key);
      else if (preceding) order.splice(order.indexOf(preceding) + 1, 0, key);
      else if ((page.offset ?? 0) > 0) order.unshift(key); else order.push(key);
    }
    binding.order = order; binding.observedAt = at;
    if (binding.complete && (page.offset ?? 0) === 0 && page.hasMore && !pageKeys.some(key => previousKeys.has(key))) binding.complete = false;
    if (options.complete === true && !binding.conflicts && !page.messages.some(m => m.id.startsWith('projection:'))) { binding.complete = true; binding.verifiedHead = headSignature(page); }
    binding.status = binding.conflicts ? 'conflict' : binding.complete ? 'complete' : binding.capture ? 'capturing' : 'partial';
    const changed = [...new Set(pageKeys)].map(key => known.get(key)!).filter(entry => originals.get(entry.key) !== canonical({ ...entry, message: { ...entry.message, source: entry.message.source && { ...entry.message.source, observedAt: undefined } } }));
    if (!changed.length && originalBinding === canonical({ ...binding, observedAt: undefined })) return false;
    this.persist(conversation, binding, changed, aliases); return true;
  }
  observeOperation(conversation: Conversation, operation: AssistantOperation, legacy = false) {
    if (!this.available(conversation) || operation.conversationId !== conversation.id || !legacy && operation.epoch !== this.store.epoch) return false;
    const beforeMigration = this.state(conversation).revision;
    this.migrate(conversation);
    const migrated = this.state(conversation).revision !== beforeMigration;
    const target = { ...conversation, nativeId: operation.nativeId, nativeKey: operation.nativeKey, connectionGeneration: operation.connectionGeneration };
    const binding = this.binding(target, operation.nativeId), aliases: { id: string; value: string }[] = [], changed: Entry[] = [];
    // Streaming deltas update at most the two operation records. Only an initial
    // legacy/native association needs to inspect the rest of the transcript.
    let entries: Entry[] | undefined;
    const allEntries = () => entries ??= this.entries(conversation, binding);
    for (const role of ['user', 'assistant'] as const) {
      if (role === 'assistant' && !operation.text) continue;
      const lookup = base(conversation.id) + 'operation:' + hash([binding.id, operation.id, role]);
      const mappedKey = this.store.internalRead<string>(lookup);
      let entry = mappedKey ? this.store.internalRead<Entry>(base(conversation.id) + 'message:' + mappedKey) : undefined;
      const nativeMatches = !entry && operation.nativeRunId ? allEntries().filter(entry => entry.message.runId === operation.nativeRunId && entry.message.role === role && entry.message.source?.kind !== 'operation') : [];
      if (nativeMatches.length > 1) continue; // A multi-part native reply already retains its separate authored messages.
      const key = entry?.key ?? nativeMatches[0]?.key ?? hash([binding.id, 'operation', operation.id, role]);
      entry ??= nativeMatches[0];
      if (mappedKey !== key) aliases.push({ id: lookup, value: key });
      const text = role === 'user' ? operation.input : operation.text;
      const files = role === 'user' ? operation.context.attachments.map(file => ({ name: file.name, size: file.size, localFile: file, availability: 'local' as const })) : [];
      if (entry?.message.source && entry.message.source.kind !== 'operation') {
        const missing = files.filter(file => !entry!.message.attachments.some(attachment => attachment.localFile?.id === file.localFile.id));
        if (missing.length) { entry.message.attachments.push(...missing); changed.push(entry); }
        continue;
      }
      const message: ConversationMessage = { id: `operation:${operation.id}:${role}`, novaId: `nova:${key}`, operationId: operation.id, role, text, textHash: messageHash(text), createdAt: role === 'user' ? operation.createdAt : operation.updatedAt, ...(operation.nativeRunId ? { runId: operation.nativeRunId } : {}), attachments: files,
        delivery: operation.state, source: { bindingId: binding.id, nativeId: operation.nativeId, nativeKey: binding.nativeKey, connectionGeneration: binding.generation, kind: 'operation', observedAt: operation.updatedAt } };
      const next: Entry = { key, message, final: ['completed', 'failed', 'cancelled'].includes(operation.state) };
      if (entry && canonical(entry) === canonical(next)) continue;
      if (entry) Object.assign(entry, next); else {
        entry = next;
        const time = Date.parse(message.createdAt ?? ''), later = legacy ? allEntries().find(candidate => Number.isFinite(time) && Date.parse(candidate.message.createdAt ?? '') > time) : undefined;
        if (legacy && later) binding.order.splice(binding.order.indexOf(later.key), 0, key); else binding.order.push(key);
        entries?.push(entry);
      }
      changed.push(entry);
    }
    if (!changed.length) { if (aliases.length) this.store.internalBatchJoined(aliases); return migrated; }
    binding.observedAt = operation.updatedAt; this.persist(conversation, binding, changed, aliases); return true;
  }
  observeVoice(conversation: Conversation, attempt: VoiceAttempt, legacy = false) {
    if (!this.available(conversation) || !legacy && attempt.epoch !== this.store.epoch || attempt.target.conversation.id !== conversation.id) return false;
    const target = attempt.target.conversation, binding = this.binding(target, target.nativeId), entries = this.entries(conversation, binding);
    const changed: Entry[] = [], aliases: { id: string; value: string }[] = [], order: string[] = [];
    for (const final of [...attempt.entries].sort((a, b) => a.ordinal - b.ordinal || a.timestamp - b.timestamp)) {
      // Pinned runtime uses this eventId as the native transcript message ID.
      const nativeMessageId = `voice:${attempt.id}:${final.entryId}`, sourceKey = base(conversation.id) + 'source:' + hash([binding.id, nativeMessageId, final.role]);
      const key = this.store.internalRead<string>(sourceKey) ?? hash([binding.id, 'voice', attempt.id, final.entryId, final.role]);
      order.push(key); const previous = entries.find(entry => entry.key === key);
      if (previous?.message.source?.kind === 'native') continue;
      if (previous && previous.message.text === final.text && previous.message.delivery === (final.saved ? 'completed' : 'unknown')) continue;
      if (previous && previous.message.text !== final.text) continue; // Voice admission owns final-conflict validation.
      const message: ConversationMessage = { id: nativeMessageId, novaId: previous?.message.novaId ?? `nova:${key}`, role: final.role, text: final.text, textHash: messageHash(final.text), createdAt: new Date(final.timestamp).toISOString(), attachments: [], delivery: final.saved ? 'completed' : 'unknown', source: { bindingId: binding.id, nativeId: target.nativeId, nativeKey: binding.nativeKey, connectionGeneration: binding.generation, nativeMessageId, kind: 'voice', observedAt: new Date().toISOString() } };
      const entry = { key, message, final: true }; changed.push(entry); if (!previous) entries.push(entry);
      aliases.push({ id: sourceKey, value: key });
    }
    for (let index = 0; index < order.length; index++) {
      const key = order[index]; if (binding.order.includes(key)) continue;
      const next = order.slice(index + 1).find(id => binding.order.includes(id)), previous = order.slice(0, index).findLast(id => binding.order.includes(id));
      if (next) binding.order.splice(binding.order.indexOf(next), 0, key);
      else if (previous) binding.order.splice(binding.order.indexOf(previous) + 1, 0, key); else binding.order.push(key);
    }
    if (!changed.length) return false;
    this.persist(conversation, binding, changed, aliases); return true;
  }
  migrate(conversation: Conversation) {
    if (!this.available(conversation) || this.migrating) return;
    const state = this.state(conversation); if (state.migrated && (state.operationsMigrated || !this.project)) return;
    this.migrating = true;
    try {
    const saved = this.store.internalRead<{ history: ConversationHistory; complete: boolean }>('assistant:retained-history:' + conversation.id);
    const cached = this.store.internalRead<ConversationHistory>('assistant:history:' + conversation.id);
    // These originals are left untouched and travel in the existing encrypted backup.
    for (const [page, complete] of [[saved?.history, saved?.complete], [cached, false]] as const) if (page?.conversationId === conversation.id) this.observe(conversation, { ...(this.project?.(conversation, page) ?? page), retained: undefined }, { source: 'legacy', complete: complete === true });
    const operations = this.store.internalList<AssistantOperation>('assistant:operation:').filter(operation => operation.conversationId === conversation.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const operation of operations) {
      const binding = this.binding({ ...conversation, nativeKey: operation.nativeKey, connectionGeneration: operation.connectionGeneration }, operation.nativeId);
      if (this.project || !this.entries(conversation, binding).some(entry => ['native', 'legacy'].includes(entry.message.source?.kind ?? ''))) this.observeOperation(conversation, operation, true);
    }
    for (const attempt of this.store.internalList<VoiceAttempt>('voice:attempt:')) if (attempt.target.conversation.id === conversation.id) this.observeVoice(conversation, attempt, true);
    this.store.internalWrite(stateKey(conversation.id), { ...this.state(conversation), migrated: true, operationsMigrated: !!this.project });
    } finally { this.migrating = false; }
  }
  all(conversation: Conversation, nativeId?: string) {
    if (!this.available(conversation)) return;
    this.migrate(conversation);
    const state = this.state(conversation), bindings = state.bindings.map(id => this.store.internalRead<Binding>(base(conversation.id) + 'binding:' + id)).filter((binding): binding is Binding => !!binding && (!nativeId || binding.nativeId === nativeId));
    if (!bindings.length) return;
    const messages = bindings.flatMap(binding => this.entries(conversation, binding).map(entry => ({ ...entry.message, attachments: entry.message.attachments.map(attachment => {
      if (!attachment.localFile) return attachment;
      let available = false; try { available = canonical(this.store.blobMetadata(attachment.localFile.id)) === canonical(attachment.localFile); } catch { /* Preserve the reference with truthful availability. */ }
      return { ...attachment, availability: available ? 'local' as const : 'unavailable' as const };
    }) })));
    const transcript: NonNullable<ConversationHistory['transcript']> = { revision: state.revision, savedMessages: messages.length, complete: bindings.every(binding => binding.complete), conflicts: bindings.reduce((n, binding) => n + binding.conflicts, 0), unavailableAttachments: messages.flatMap(message => message.attachments).filter(attachment => attachment.availability !== 'local').length,
      synchronizedAt: bindings.map(binding => binding.observedAt).sort().at(-1), bindings: bindings.map(binding => ({ id: binding.id, nativeId: binding.nativeId, complete: binding.complete, status: binding.status, observedAt: binding.observedAt, ...(binding.capture?.nextOffset === undefined ? {} : { nextOffset: binding.capture.nextOffset }) })) };
    return { messages, transcript, nativeId: nativeId ?? conversation.nativeId ?? bindings.at(-1)!.nativeId };
  }
  target(conversation: Conversation, nativeId: string) {
    if (!this.available(conversation)) return;
    this.migrate(conversation);
    const bindings = this.state(conversation).bindings.map(id => this.store.internalRead<Binding>(base(conversation.id) + 'binding:' + id)).filter((binding): binding is Binding => !!binding && binding.nativeId === nativeId);
    if (bindings.length !== 1) return;
    const binding = bindings[0]; return { nativeId: binding.nativeId, nativeKey: binding.nativeKey, connectionGeneration: binding.generation };
  }
  retainAttachment(conversation: Conversation, target: { nativeId: string; messageId: string; messageHash: string; artifactId: string }, localFile: Attachment) {
    if (!this.available(conversation) || canonical(this.store.blobMetadata(localFile.id)) !== canonical(localFile)) return false;
    this.migrate(conversation);
    const candidates = this.state(conversation).bindings.map(id => this.store.internalRead<Binding>(base(conversation.id) + 'binding:' + id)).filter((binding): binding is Binding => !!binding && binding.nativeId === target.nativeId)
      .flatMap(binding => this.entries(conversation, binding).filter(entry => entry.message.textHash === target.messageHash && (entry.message.id === target.messageId || entry.message.novaId === target.messageId || entry.message.aliases?.includes(target.messageId)) && entry.message.attachments.some(attachment => attachment.artifactId === target.artifactId)).map(entry => ({ binding, entry })));
    if (candidates.length !== 1) return false;
    const { binding, entry } = candidates[0], previous = entry.message.attachments.find(attachment => attachment.artifactId === target.artifactId)!;
    if (canonical(previous.localFile) === canonical(localFile) && previous.availability === 'local') return false;
    entry.message = { ...entry.message, attachments: entry.message.attachments.map(attachment => attachment.artifactId === target.artifactId ? { ...attachment, localFile, availability: 'local' } : attachment) };
    this.persist(conversation, binding, [entry]); return true;
  }
  read(conversation: Conversation, options: { offset?: number; messageId?: string; nativeId?: string } = {}): ConversationHistory | undefined {
    const all = this.all(conversation, options.nativeId); if (!all) return;
    let offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Fault(400, 'history_offset', 'Use a valid saved conversation page.');
    if (options.messageId) {
      const index = all.messages.findIndex(message => message.id === options.messageId || message.novaId === options.messageId || message.aliases?.includes(options.messageId!));
      if (index < 0) throw new Fault(404, 'saved_message_missing', 'That message is not in the saved transcript. Its original source may have additional history.');
      offset = Math.max(0, all.messages.length - index - 50);
    }
    const end = Math.max(0, all.messages.length - offset), start = Math.max(0, end - 100);
    return { conversationId: conversation.id, nativeId: all.nativeId, messages: all.messages.slice(start, end), offset, totalMessages: all.messages.length, hasMore: start > 0, hasNewer: offset > 0, ...(start > 0 ? { nextOffset: offset + end - start } : {}), activeRunIds: null, retained: { complete: all.transcript.complete, capturedAt: all.transcript.synchronizedAt }, transcript: all.transcript };
  }
  async captureNext(conversations: Conversation[], read: (id: string, offset: number) => Promise<ConversationHistory>, maxPages = 2) {
    const epoch = this.store.epoch; let budget = Math.max(1, Math.min(200, maxPages));
    const eligible = conversations.filter(c => this.available(c) && c.nativeId && c.state === 'ready' && (!c.forkSource || c.forkSource.resolved));
    // Round-robin progress survives restart; a disconnected old chat cannot starve new ones.
    const cursor = this.store.internalRead<{ id: string }>('assistant:transcript-migration-cursor')?.id;
    const start = cursor ? (eligible.findIndex(c => c.id === cursor) + 1) % Math.max(1, eligible.length) : 0;
    for (let index = 0; index < eligible.length && budget > 0; index++) {
      const conversation = eligible[(start + index) % eligible.length];
      this.migrate(conversation);
      let binding = this.binding(conversation, conversation.nativeId!);
      if (binding.complete && !binding.capture) continue;
      const valid = () => epoch === this.store.epoch && this.available(conversation);
      try {
        if (!binding.capture) {
          budget--; const head = await read(conversation.id, 0); if (!valid() || head.nativeId !== binding.nativeId || head.retained) continue;
          this.observe(conversation, head); binding = this.binding(conversation, binding.nativeId);
          binding.capture = head.hasMore && !(head.nextOffset !== undefined && head.nextOffset > 0) ? undefined : { head: headSignature(head), nextOffset: head.hasMore ? head.nextOffset : undefined, finished: !head.hasMore };
          binding.status = binding.conflicts ? 'conflict' : 'capturing'; this.persist(conversation, binding, []);
        }
        while (budget > 0 && valid() && binding.capture && !binding.capture.finished && binding.capture.nextOffset !== undefined) {
          const offset: number = binding.capture.nextOffset; budget--; const page = await read(conversation.id, offset);
          if (!valid() || page.nativeId !== binding.nativeId || page.retained) break;
          this.observe(conversation, page); binding = this.binding(conversation, binding.nativeId);
          binding.capture = { ...binding.capture!, nextOffset: page.hasMore && page.nextOffset !== undefined && page.nextOffset > offset ? page.nextOffset : undefined, finished: !page.hasMore };
          this.persist(conversation, binding, []);
          if (page.hasMore && binding.capture.nextOffset === undefined) { binding.capture = undefined; binding.status = 'partial'; this.persist(conversation, binding, []); break; }
        }
        if (budget > 0 && valid() && binding.capture?.finished) {
          budget--; const head = await read(conversation.id, 0); if (!valid() || head.nativeId !== binding.nativeId || head.retained) continue;
          const stable = headSignature(head) === binding.capture.head && head.activeRunIds?.length === 0;
          this.observe(conversation, head, { complete: stable }); binding = this.binding(conversation, binding.nativeId);
          binding.capture = undefined; binding.status = binding.conflicts ? 'conflict' : binding.complete ? 'complete' : 'partial'; this.persist(conversation, binding, []);
        }
      } catch { /* Every admitted page and its cursor remain intact for a later bounded retry. */ }
      if (valid()) this.store.internalWrite('assistant:transcript-migration-cursor', { id: conversation.id });
    }
  }
}
