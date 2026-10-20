import { z } from 'zod';
import { canonical, draftSchema } from '../../../packages/domain/contracts';
import { createConversationSchema, submitSchema, type AssistantState, type Conversation, type DirectConnectionStatus } from '../../../packages/domain/assistant';
import { directAgentBindingSchema, directAgentRecipientSchema } from '../../../packages/domain/direct-agent';

const scopeSchema = z.object({ epoch: z.string().uuid(), deviceId: z.string().min(1), windowId: z.string().min(1) }).strict();
export type DirectChatScope = z.infer<typeof scopeSchema>;
export type DirectChatRecipient = z.infer<typeof directAgentRecipientSchema>;
const continueSchema = z.object({
  requestId: z.string().uuid(), epoch: z.string().uuid(), conversationId: z.string().uuid(),
  expectedRevision: z.number().int().positive(), action: z.literal('continue-unsent'),
  originalRequestId: z.string().uuid(), expectedSetupSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), body: createConversationSchema }).strict(),
  z.object({ kind: z.literal('continue'), body: continueSchema }).strict(),
]);
export type DirectChatCommand = z.infer<typeof requestSchema>;
const confirmationSchema = z.object({ conversationId: z.string().uuid(), revision: z.number().int().positive() }).strict();
const journalSchema = z.object({
  format: z.literal(1), scope: scopeSchema, recipient: directAgentRecipientSchema,
  command: requestSchema, confirmation: confirmationSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (row.command.body.epoch !== row.scope.epoch
    || row.command.kind === 'create' && (canonical(row.command.body.recipient) !== canonical(row.recipient)
      || row.command.body.space !== 'chat' || row.command.body.projectId !== null
      || row.command.body.permissionMode !== 'read-only')
    || row.command.kind === 'continue' && row.confirmation && row.confirmation.conversationId !== row.command.body.conversationId)
    ctx.addIssue({ code: 'custom', message: 'The original direct-chat command does not match this owner.' });
});
export type DirectChatJournal = z.infer<typeof journalSchema>;
export type DirectChatStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const directChatStorage: DirectChatStorage = {
  getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
};
const retainedOwners = new Set<() => boolean>();
export function registerDirectChatOwner(retain: () => boolean) {
  retainedOwners.add(retain); return () => { retainedOwners.delete(retain); };
}
export function mayLeaveDirectChat(): boolean {
  let retained = true;
  for (const owner of retainedOwners) { try { if (!owner()) retained = false; } catch { retained = false; } }
  return retained;
}
export const directChatCommandKey = (scope: DirectChatScope, target: string) =>
  `e3:direct-chat-command:${scope.epoch}:${scope.deviceId}:${scope.windowId}:${target}`;

/** Any existing or unreadable original request is a reconciliation boundary.
 * Malformed JSON must never be mistaken for permission to send again. */
export function hasKeptDirectSubmit(storage: Pick<Storage, 'getItem'>, key: string): boolean {
  try { return storage.getItem(key) !== null; } catch { return true; }
}

export function confirmedDirectConversation(command: DirectChatJournal, value: unknown): Conversation | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Conversation, binding = directAgentBindingSchema.safeParse(row.directAgent);
  if (!binding.success || !z.string().uuid().safeParse(row.id).success || !Number.isSafeInteger(row.revision) || row.revision < 1
    || row.space !== 'chat' || row.permissionMode !== 'read-only'
    || canonical(binding.data.recipient) !== canonical(command.recipient)) return;
  if (command.command.kind === 'create') {
    if (canonical(binding.data.createdBy) !== canonical({
      requestId: command.command.body.requestId, epoch: command.scope.epoch, deviceId: command.scope.deviceId,
    })) return;
  } else if (row.id !== command.command.body.conversationId || row.revision < command.command.body.expectedRevision) return;
  return row;
}

/** Exact command retention, not a second draft or execution queue. No read,
 * constructor or observation can send a command. A kept unknown is never replayed. */
export class DirectChatCommands {
  private raw: string | null | undefined;
  value?: DirectChatJournal;
  error = '';
  busy = false;
  private known?: DirectChatJournal;
  constructor(readonly storage: DirectChatStorage, readonly key: string, readonly scope: DirectChatScope, readonly recipient: DirectChatRecipient) {
    try {
      this.raw = storage.getItem(key);
      if (this.raw !== null) {
        const parsed: unknown = this.raw.length <= 128000 ? JSON.parse(this.raw) : undefined;
        if (parsed !== null) {
          const value = journalSchema.parse(parsed);
          if (canonical(value.scope) !== canonical(scope) || value.recipient.agentId !== recipient.agentId) throw Error();
          this.value = value;
        }
      }
    } catch { this.raw = undefined; this.error = 'The original connection request cannot be read. Its kept data has not been replaced.'; }
  }
  private keep(value: DirectChatJournal) {
    const parsed = journalSchema.parse(value), next = JSON.stringify(parsed);
    if (this.raw === undefined || this.storage.getItem(this.key) !== this.raw) throw Error('This connection request changed or could not be read. Keep this window open.');
    this.storage.setItem(this.key, next);
    this.raw = next; this.value = parsed;
  }
  /** A known reply whose storage write failed stays recoverable without POST. */
  retain(): boolean {
    if (!this.known) return true;
    try { this.keep(this.known); this.known = undefined; this.error = ''; return true; }
    catch { this.error = 'The confirmed connection reply is only kept in this window. Free browser storage before leaving.'; return false; }
  }
  /** Explicit new work only after a genuine matching reply/observation. Keep
   * the old command bytes separately before replacing the current pointer. */
  beginAnother(): boolean {
    if (this.busy || !this.retain() || !this.value?.confirmation || this.raw === undefined) return false;
    try {
      if (this.storage.getItem(this.key) !== this.raw) return false;
      const archive = `${this.key}:confirmed:${this.value.command.body.requestId}`, previous = this.storage.getItem(archive);
      if (previous !== null && previous !== this.raw) return false;
      if (previous === null) this.storage.setItem(archive, this.raw!);
      this.storage.setItem(this.key, 'null'); this.raw = 'null'; this.value = undefined; this.error = ''; return true;
    } catch { this.error = 'The previous confirmed request could not be kept. No new request was started.'; return false; }
  }
  async send(command: DirectChatCommand, post: (path: string, body: object) => Promise<unknown>, current: () => boolean): Promise<Conversation | undefined> {
    if (this.busy || this.value || this.error || !current()) return;
    this.busy = true;
    try {
      const original: DirectChatJournal = { format: 1, scope: this.scope, recipient: this.recipient, command };
      this.keep(original);
      if (!current()) throw Error('The original chat view changed before connecting. Its request is kept; no command was sent.');
      const reply = await post(command.kind === 'create' ? 'assistant/conversations' : 'assistant/conversation/direct-connect', command.body);
      const conversation = confirmedDirectConversation(original, reply);
      if (!conversation) throw Error('The reply did not confirm this original direct chat. Check its original status.');
      // Keep a valid late reply for its original owner, but never navigate here.
      this.known = { ...original, confirmation: { conversationId: conversation.id, revision: conversation.revision } };
      if (!this.retain()) return;
      return conversation;
    } catch (reason) {
      this.error = reason instanceof Error ? reason.message : 'Connection is unconfirmed. Check its original status; do not send another request.';
    } finally { this.busy = false; }
  }
  /** Create has a durable exact request join in the saved conversation. Continue
   * observations are only current status: they are not a receipt for its command. */
  observe(state: AssistantState): Conversation | undefined {
    if (!this.retain() || !this.value || this.value.command.kind !== 'create') return;
    const matches = state.conversations.filter(row => confirmedDirectConversation(this.value!, row));
    if (matches.length !== 1) return;
    const row = matches[0];
    try {
      this.keep({ ...this.value, confirmation: { conversationId: row.id, revision: row.revision } }); this.error = ''; return row;
    } catch (reason) { this.error = reason instanceof Error ? reason.message : 'The original result could not be kept.'; }
  }
}

export function createDirectChat(scope: DirectChatScope, recipient: DirectChatRecipient, name: string, requestId: string): DirectChatCommand {
  return { kind: 'create', body: createConversationSchema.parse({
    requestId, epoch: scope.epoch, title: name.trim().slice(0, 140) || 'Direct chat', projectId: null,
    space: 'chat', permissionMode: 'read-only', recipient,
  }) };
}
export function continueDirectChat(scope: DirectChatScope, conversation: Conversation, status: DirectConnectionStatus | undefined, requestId: string): DirectChatCommand {
  if (!conversation.directAgent || conversation.archived || conversation.deleted || conversation.nativeId
    || !status || status.conversationId !== conversation.id || status.conversationRevision !== conversation.revision
    || status.state !== 'failed' || !status.canContinueUnsent) throw Error('The original unsent connection cannot currently be continued.');
  return { kind: 'continue', body: continueSchema.parse({
    requestId, epoch: scope.epoch, conversationId: conversation.id, expectedRevision: conversation.revision,
    action: 'continue-unsent', originalRequestId: status.originalRequestId, expectedSetupSha256: status.setupSha256,
  }) };
}

const targetSchema = z.object({
  format: z.literal(1), scope: scopeSchema, recipient: directAgentRecipientSchema, token: z.string().uuid(),
  origin: z.enum(['agents', 'assistant']), conversationId: z.string().uuid().optional(),
  previousSelection: z.object({ space: z.enum(['chat', 'work']), id: z.string().uuid().nullable() }).strict(),
}).strict();
export type DirectChatTarget = z.infer<typeof targetSchema>;
type SelectionWrite = { key: string; before: string | null; after: string | null };
export type PreparedDirectView = { write: SelectionWrite; accept: () => void };
/** View identity only, with exact raw CAS. Writing remains in its existing owner. */
export class DirectChatNavigation {
  private raw: string | null | undefined;
  value?: DirectChatTarget;
  error = '';
  constructor(readonly storage: DirectChatStorage, readonly key: string, readonly scope: DirectChatScope) {
    try {
      this.raw = directSelectionSlot(storage, scope.epoch, scope.deviceId, key);
      if (this.raw !== null) {
        const value: unknown = JSON.parse(this.raw);
        if (value !== null) { const target = targetSchema.parse(value); if (canonical(target.scope) !== canonical(scope)) throw Error(); this.value = target; }
      }
    } catch { this.raw = undefined; this.error = 'The kept direct-chat view cannot be read. Its original reference is preserved.'; }
  }
  exact(token: string) { try { return this.value?.token === token && this.raw !== undefined && directSelectionSlot(this.storage, this.scope.epoch, this.scope.deviceId, this.key) === this.raw; } catch { return false; } }
  prepare(next: DirectChatTarget | undefined, retain: () => boolean, expectedToken: string): PreparedDirectView | undefined {
    try {
      if (!retain() || !settleDirectSelection(this.storage, this.scope.epoch, this.scope.deviceId)
        || !this.exact(expectedToken)) throw Error();
      if (next && canonical(targetSchema.parse(next).scope) !== canonical(this.scope)) throw Error();
      const raw = JSON.stringify(next ?? null);
      return { write: { key: this.key, before: this.raw!, after: raw }, accept: () => { this.raw = raw; this.value = next; this.error = ''; } };
    } catch { this.error = 'The prior selection is kept. Restore browser storage before opening or returning from this chat.'; return; }
  }
  set(next: DirectChatTarget | undefined, retain: () => boolean, expectedToken?: string): boolean {
    try {
      if (this.raw === undefined || !retain() || !settleDirectSelection(this.storage, this.scope.epoch, this.scope.deviceId) || expectedToken && !this.exact(expectedToken)
        || this.storage.getItem(this.key) !== this.raw) throw Error();
      if (next && canonical(targetSchema.parse(next).scope) !== canonical(this.scope)) throw Error();
      const raw = JSON.stringify(next ?? null); this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw Error();
      this.raw = raw; this.value = next; this.error = ''; return true;
    } catch { this.error = 'Keep the current writing and free browser storage before changing this direct-chat view.'; return false; }
  }
}

const selectionTransactionSchema = z.object({
  format: z.literal(1), epoch: z.string().uuid(), deviceId: z.string().min(1), id: z.string().uuid(),
  phase: z.enum(['pending', 'committed']),
  writes: z.array(z.object({ key: z.string(), before: z.string().nullable(), after: z.string().nullable() }).strict()).min(2).max(3),
}).strict();
const selectionTransactionKey = (epoch: string, device: string) => `e3:direct-selection:${epoch}:${device}`;
function selectionTransaction(storage: Pick<Storage, 'getItem'>, epoch: string, device: string) {
  const key = selectionTransactionKey(epoch, device), raw = storage.getItem(key);
  if (raw === null) return;
  if (raw.length > 256000) throw Error('The original selection record is too large.');
  const value = selectionTransactionSchema.parse(JSON.parse(raw));
  const keys = value.writes.map(write => write.key), spaceKey = `e3:assistant-space:${epoch}:${device}`;
  if (value.epoch !== epoch || value.deviceId !== device || new Set(keys).size !== keys.length || !keys.includes(spaceKey)
    || !keys.some(item => item === `e3:conversation:${device}` || item === `e3:conversation:${device}:work`)
    || keys.some(item => item !== spaceKey && item !== `e3:conversation:${device}` && item !== `e3:conversation:${device}:work`
      && !item.startsWith(`e3:direct-chat-view:${epoch}:${device}:`))) throw Error('The original selection does not match this workspace.');
  if (value.phase === 'committed' && value.writes.some(write => storage.getItem(write.key) !== write.after))
    throw Error('The committed selection no longer matches its exact stored slots.');
  return { key, raw, value };
}
function directSelectionSlot(storage: Pick<Storage, 'getItem'>, epoch: string, device: string, key: string) {
  const pending = selectionTransaction(storage, epoch, device), write = pending?.value.writes.find(item => item.key === key);
  return write ? write[pending!.value.phase === 'committed' ? 'after' : 'before'] : storage.getItem(key);
}
/** Read only. A partial transaction keeps its original selection authoritative
 * on reload even if storage also refused rollback. No editor is mounted from
 * a partially written destination. */
export function readDirectSelection(storage: Pick<Storage, 'getItem'>, epoch: string, device: string) {
  try {
    const pending = selectionTransaction(storage, epoch, device);
    if (!pending) return;
    const rawSpace = directSelectionSlot(storage, epoch, device, `e3:assistant-space:${epoch}:${device}`);
    const space = rawSpace === null ? 'chat' : z.enum(['chat', 'work']).parse(JSON.parse(rawSpace));
    const rawId = directSelectionSlot(storage, epoch, device, `e3:conversation:${device}${space === 'work' ? ':work' : ''}`);
    const id = rawId === null ? null : z.string().nullable().parse(JSON.parse(rawId));
    return { space, id, error: pending.value.phase === 'pending' ? 'The previous chat selection is kept. Browser storage refused a selection change; retry only after storage is available.' : '' };
  } catch { return { space: 'chat' as const, id: null, error: 'The original chat selection cannot be read. Its records are preserved; no new selection can replace them.' }; }
}
/** Only an explicit navigation/recovery action calls this. Exact changed slots
 * refuse recovery; they are never overwritten by an old rollback. */
export function settleDirectSelection(storage: DirectChatStorage, epoch: string, device: string): boolean {
  try {
    const pending = selectionTransaction(storage, epoch, device);
    if (!pending) return true;
    const { value, key, raw } = pending;
    for (const write of value.writes) {
      const current = storage.getItem(write.key);
      if (value.phase === 'committed' ? current !== write.after : current !== write.before && current !== write.after) return false;
    }
    if (value.phase === 'pending') for (const write of [...value.writes].reverse()) {
      if (storage.getItem(key) !== raw) return false;
      const current = storage.getItem(write.key);
      if (current === write.before) continue;
      if (current !== write.after) return false;
      if (write.before === null) storage.removeItem(write.key); else storage.setItem(write.key, write.before);
      if (storage.getItem(write.key) !== write.before) return false;
    }
    if (storage.getItem(key) !== raw || value.writes.some(write => storage.getItem(write.key) !== write[value.phase === 'pending' ? 'before' : 'after'])) return false;
    storage.removeItem(key); return storage.getItem(key) === null;
  } catch { return false; }
}
/** Identity-only transaction over the existing selection and view slots.
 * A durable commit precedes React publication. Draft data is never copied. */
export function keepDirectChatSelection(storage: DirectChatStorage, epoch: string, deviceId: string, conversationId: string | null,
  space: 'chat' | 'work' = 'chat', view?: PreparedDirectView): boolean {
  const spaceKey = `e3:assistant-space:${epoch}:${deviceId}`, selectionKey = `e3:conversation:${deviceId}${space === 'work' ? ':work' : ''}`;
  let committed: string | undefined, pendingRaw: string | undefined;
  let writes: SelectionWrite[] = [];
  const key = selectionTransactionKey(epoch, deviceId);
  try {
    if (!settleDirectSelection(storage, epoch, deviceId)) return false;
    const oldSpace = storage.getItem(spaceKey), oldSelection = storage.getItem(selectionKey);
    if (oldSpace !== null && !['chat', 'work'].includes(JSON.parse(oldSpace))) return false;
    if (oldSelection !== null && JSON.parse(oldSelection) !== null && typeof JSON.parse(oldSelection) !== 'string') return false;
    writes = [
      { key: selectionKey, before: oldSelection, after: JSON.stringify(conversationId) },
      { key: spaceKey, before: oldSpace, after: JSON.stringify(space) }, ...(view ? [view.write] : []),
    ];
    if (writes.some(write => storage.getItem(write.key) !== write.before)) return false;
    const value = { format: 1 as const, epoch, deviceId, id: crypto.randomUUID(), phase: 'pending' as const, writes };
    const raw = JSON.stringify(value); pendingRaw = raw; committed = JSON.stringify({ ...value, phase: 'committed' });
    storage.setItem(key, raw);
    for (const write of writes) {
      if (storage.getItem(key) !== raw || storage.getItem(write.key) !== write.before) throw Error('The original selection changed.');
      if (write.after === null) storage.removeItem(write.key); else storage.setItem(write.key, write.after);
    }
    if (storage.getItem(key) !== raw || writes.some(write => storage.getItem(write.key) !== write.after)) throw Error('The selection changed before confirmation.');
    storage.setItem(key, committed);
    if (storage.getItem(key) !== committed || writes.some(write => storage.getItem(write.key) !== write.after)) throw Error('The selection commit could not be verified.');
    // A retained exact committed marker is valid reload authority if cleanup fails.
    try {
      if (storage.getItem(key) !== committed) throw Error('The selection owner changed.');
      storage.removeItem(key);
    } catch { /* final readback below distinguishes kept authority from another owner */ }
    const marker = storage.getItem(key);
    if (marker !== null && marker !== committed || writes.some(write => storage.getItem(write.key) !== write.after)) throw Error('The selection changed before publication.');
    view?.accept(); return true;
  } catch {
    try {
      const marker = storage.getItem(key);
      if (committed && marker === committed && writes.every(write => storage.getItem(write.key) === write.after)) { view?.accept(); return true; }
      // Never roll back another owner's replacement marker.
      if (pendingRaw && marker === pendingRaw) settleDirectSelection(storage, epoch, deviceId);
    } catch { /* uncertain local result stays kept */ }
    return false;
  }
}

export function observedDirectSubmit(value: unknown, state: AssistantState, scope: DirectChatScope, conversation: Conversation) {
  const pending = z.object({ request: submitSchema, captured: draftSchema }).strict().safeParse(value);
  if (!pending.success || !conversation.directAgent) return;
  const { request, captured } = pending.data;
  if (request.epoch !== scope.epoch || request.conversationId !== conversation.id || captured.conversationId !== conversation.id) return;
  const matches = state.operations.filter(op => op.requestId === request.requestId && op.epoch === scope.epoch
    && op.deviceId === scope.deviceId && op.conversationId === conversation.id && op.conversationRevision === request.conversationRevision
    && op.input === captured.text && canonical(op.context.attachments) === canonical(captured.attachments)
    && op.context.draftId === request.draftId && op.context.draftRevision === request.draftRevision
    && op.context.directAgent?.conversationId === conversation.id && op.context.directAgent.requestId === request.requestId
    && canonical(op.context.directAgent.recipient) === canonical(conversation.directAgent!.recipient));
  return matches.length === 1 ? { ...pending.data, operation: matches[0] } : undefined;
}
