import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { executionChildPrefix } from '../../packages/domain/assistant-group-execution.js';
import { groupPreparationCommandSchema, groupPreparationReceipt, groupPreparationIntent, groupPreparationRejectionSchema, parseGroupDraft,
  groupDisclosureClosure, responseReference } from '../../packages/domain/assistant-group-turns.js';
import { Fault, Store } from './store.js';

const uuid = z.string().uuid(), group = { groupId: uuid };
const querySchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('summary'), ...group }).strict(),
  z.object({ view: z.literal('rounds'), ...group, sequence: z.coerce.number().int().nonnegative().max(1000),
    after: z.coerce.number().int().nonnegative().max(1000).default(0) }).strict(),
  z.object({ view: z.literal('drafts'), ...group, sequence: z.coerce.number().int().nonnegative().max(1000),
    after: z.string().regex(/^draft:group:[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ view: z.literal('round'), ...group, roundId: uuid }).strict(),
  z.object({ view: z.literal('responses'), ...group, roundId: uuid,
    roundSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ view: z.literal('draft'), ...group, draftId: z.string().regex(/^draft:group:[a-f0-9]{64}$/) }).strict(),
  z.object({ view: z.literal('grant'), ...group, grantId: uuid }).strict(),
  z.object({ view: z.literal('request'), ...group, requestId: uuid }).strict(),
  z.object({ view: z.literal('grant-request'), ...group, requestId: uuid }).strict(),
  z.object({ view: z.literal('grant-preview'), ...group, command: z.string().max(24000) }).strict(),
]);
export function groupPreparationQuery(params: URLSearchParams) {
  const raw: Record<string, string> = { view: 'summary' }, seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) throw new Fault(400, 'group_preparation_query', 'Use each Group preparation query field once.');
    seen.add(key); raw[key] = value;
  }
  return querySchema.parse(raw);
}
/** Authenticated owner preparation only. This class cannot create or send a native request. */
export class AssistantGroupPreparations {
  constructor(private store: Store) {}
  /** Body-based read avoids HTTP header limits for a full 64-message/32-reply selection. */
  preview(device: string, raw: unknown) {
    const command = groupPreparationCommandSchema.parse(raw);
    if (command.action !== 'grant-history-v2') throw new Fault(400, 'group_history_preview', 'Choose an exact history-sharing selection.');
    return this.read(device, { view: 'grant-preview', groupId: command.groupId, command: JSON.stringify(command) });
  }
  read(device: string, raw: unknown) {
    const input = querySchema.parse(raw);
    try {
      return this.store.internalAtomic(() => {
        const { group, preparation, executions, response, authority } = this.store.readGroupPreparation(input.groupId);
        if (!group.group) throw new Fault(404, 'group_missing', 'The original Group is unavailable.');
        const base = { epoch: this.store.epoch, groupId: input.groupId, view: input.view,
          sequence: preparation.events.length, execution: 'unavailable' as const, mode: 'provided-context-only' as const };
        if (input.view === 'grant-preview') {
          const command = groupPreparationCommandSchema.parse(JSON.parse(input.command));
          if (command.action !== 'grant-history-v2' || command.epoch !== this.store.epoch || command.groupId !== input.groupId
            || command.expectedGroupRevision !== group.group.revision || group.group.archived || group.group.trashed
            || !group.group.activeMembershipIds.includes(command.membershipId)
            || command.expectedSequence !== preparation.events.length || command.throughSequence > preparation.events.length
            || preparation.events.length >= 1000)
            throw new Fault(409, 'group_history_changed', 'Review the current member and exact earlier history before sharing.');
          const closure = groupDisclosureClosure(command.history, command.responses, preparation, command.throughSequence + 1, authority);
          if (!closure.history.length) throw new Fault(409, 'group_history_empty', 'Choose an earlier message or completed reply to share.');
          return { ...base, command, includedHistory: closure.history.map(round => ({ roundId: round.id, sha256: authority.digest(round) })),
            includedResponses: closure.responses.map(responseReference) };
        }
        if (input.view === 'grant-request') {
          const event = preparation.events.find(event => event.command.requestId === input.requestId && event.deviceId === device);
          if (!event || event.command.action !== 'grant-history-v2' || !event.grant)
            throw new Fault(404, 'group_grant_request_missing', 'This device has no original history-sharing request with that identity.');
          return { ...base, command: event.command, receipt: groupPreparationReceipt(event), grant: event.grant };
        }
        if (input.view === 'summary') return { ...base, rounds: preparation.rounds.size, grants: preparation.grants.length,
          drafts: [...preparation.drafts.values()].map(parseGroupDraft).filter(draft => draft.scope.deviceId === device).length };
        if (input.view === 'drafts') {
          if (input.sequence !== preparation.events.length) throw new Fault(409, 'group_preparation_changed', 'Refresh the saved draft list before continuing.');
          const drafts = [...preparation.drafts.values()].map(parseGroupDraft).filter(draft => draft.scope.deviceId === device)
            .sort((a, b) => a.id.localeCompare(b.id));
          if (input.after && !drafts.some(draft => draft.id === input.after))
            throw new Fault(409, 'group_draft_cursor_changed', 'Refresh the original draft list before continuing.');
          const start = input.after ? drafts.findIndex(draft => draft.id === input.after) + 1 : 0, page = drafts.slice(start, start + 32);
          return { ...base, drafts: page.map(draft => ({ id: draft.id, revision: draft.revision, scope: draft.scope,
            preparedRoundId: draft.preparedRoundId })), total: drafts.length, next: start + page.length < drafts.length ? page.at(-1)!.id : null };
        }
        if (input.view === 'draft') {
          const raw = preparation.drafts.get(input.draftId), draft = raw ? parseGroupDraft(raw) : null;
          if (!draft || draft.scope.deviceId !== device)
            throw new Fault(404, 'group_draft_missing', 'This device has no saved Group draft with that identity.');
          return { ...base, raw, draft };
        }
        if (input.view === 'round') {
          const round = preparation.rounds.get(input.roundId);
          if (!round) throw new Fault(404, 'group_round_missing', 'This exact prepared input is unavailable.');
          return { ...base, round, availability: this.store.groupPreparationAvailability(round, group) };
        }
        if (input.view === 'responses') {
          const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
          const round = preparation.rounds.get(input.roundId);
          if (!round || digest(round) !== input.roundSha256)
            throw new Fault(409, 'group_round_changed', 'Review the exact original input before selecting its replies.');
          const responses = round.recipients.map(recipient => {
            const child = executions.get(executionChildPrefix(input.groupId, recipient.attempt.id));
            const terminal = child?.events.find(event => event.observation?.kind === 'terminal'
              && event.observation.state === 'completed' && event.observation.nativeTurnId?.trim());
            const ref = terminal ? { roundId: round.id, attemptId: recipient.attempt.id,
              terminalSequence: terminal.sequence, terminalSha256: digest(terminal) } : null;
            const completed = ref ? response(input.groupId, ref) : undefined;
            return { attemptId: recipient.attempt.id, author: {
              agentId: recipient.captured.id, agentRevision: recipient.captured.revision,
              membershipId: recipient.membership.id, name: recipient.captured.value.name, position: recipient.captured.value.position,
            }, state: child?.value.send?.state ?? 'not-sent', stop: child?.value.stop ?? null, selectable: !!completed,
            reason: completed ? null : child?.value.send?.state === 'completed' ? 'original-turn-unavailable' : 'not-completed',
            text: completed?.text ?? child?.value.text ?? '', ref: completed ? ref : null };
          });
          return { ...base, roundId: round.id, roundSha256: input.roundSha256, responses, sha256: digest(responses) };
        }
        if (input.view === 'grant') {
          const grant = preparation.grants.find(grant => grant.id === input.grantId);
          if (!grant) throw new Fault(404, 'group_grant_missing', 'This exact earlier-history choice is unavailable.');
          return { ...base, grant };
        }
        if (input.view === 'request') {
          const event = preparation.events.find(event => event.command.requestId === input.requestId && event.deviceId === device);
          if (!event) throw new Fault(404, 'group_preparation_request_missing', 'This device has no original admitted preparation with that identity.');
          return { ...base, receipt: groupPreparationReceipt(event) };
        }
        if (input.sequence !== preparation.events.length || input.after > input.sequence)
          throw new Fault(409, 'group_preparation_changed', 'Refresh the saved preparation list before continuing.');
        const rounds = [...preparation.rounds.values()].filter(round => round.sequence > input.after).sort((a, b) => a.sequence - b.sequence);
        const page = rounds.slice(0, 32);
        return { ...base, rounds: page.map(round => ({ id: round.id, sequence: round.sequence, at: round.at,
          preview: round.text.slice(0, 240), recipientMembershipIds: round.recipients.map(row => row.membership.id),
          state: round.state, mode: round.mode })), total: preparation.rounds.size,
          next: rounds.length > 32 ? page.at(-1)!.sequence : null };
      });
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(409, 'group_preparation_unreadable', 'This original Group preparation cannot be verified. Its saved writing is kept.');
    }
  }
  save(device: string, raw: unknown) {
    const input = groupPreparationCommandSchema.parse(raw);
    try { return this.store.admitGroupPreparation(device, input); }
    catch (error) {
      // The synchronous original has ended. Never turn a timeout, receipt
      // collision, changed epoch or unverifiable joined state into this proof.
      let absent = false;
      try {
        absent = this.store.internalAtomic(() => {
          if (this.store.replayAdmission(device, input, groupPreparationIntent(input)) !== undefined) return false;
          const { preparation } = this.store.readGroupPreparation(input.groupId);
          return !preparation.events.some(event => event.command.requestId === input.requestId);
        });
      } catch { /* Preserve the original failure when absence is not verifiable. */ }
      if (absent) throw new Fault(error instanceof Fault ? error.status : 409,
        error instanceof Fault ? error.code : 'group_preparation_changed',
        error instanceof Error ? error.message : 'Review this Group message before preparing a new request.',
        groupPreparationRejectionSchema.parse({ kind: 'assistant-group-preparation-rejection', command: input }));
      if (error instanceof Fault) throw error;
      throw new Fault(409, 'group_preparation_changed', error instanceof Error ? error.message : 'This original Group preparation needs review.');
    }
  }
}
