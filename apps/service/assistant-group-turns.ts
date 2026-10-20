import { z } from 'zod';
import { groupPreparationCommandSchema, groupPreparationReceipt, parseGroupDraft } from '../../packages/domain/assistant-group-turns.js';
import { Fault, Store } from './store.js';

const uuid = z.string().uuid(), group = { groupId: uuid };
const querySchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('summary'), ...group }).strict(),
  z.object({ view: z.literal('rounds'), ...group, sequence: z.coerce.number().int().nonnegative().max(1000),
    after: z.coerce.number().int().nonnegative().max(1000).default(0) }).strict(),
  z.object({ view: z.literal('drafts'), ...group, sequence: z.coerce.number().int().nonnegative().max(1000),
    after: z.string().regex(/^draft:group:[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ view: z.literal('round'), ...group, roundId: uuid }).strict(),
  z.object({ view: z.literal('draft'), ...group, draftId: z.string().regex(/^draft:group:[a-f0-9]{64}$/) }).strict(),
  z.object({ view: z.literal('grant'), ...group, grantId: uuid }).strict(),
  z.object({ view: z.literal('request'), ...group, requestId: uuid }).strict(),
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
  read(device: string, raw: unknown) {
    const input = querySchema.parse(raw);
    try {
      return this.store.internalAtomic(() => {
        const { group, preparation } = this.store.readGroupPreparation(input.groupId);
        if (!group.group) throw new Fault(404, 'group_missing', 'The original Group is unavailable.');
        const base = { epoch: this.store.epoch, groupId: input.groupId, view: input.view,
          sequence: preparation.events.length, execution: 'unavailable' as const, mode: 'provided-context-only' as const };
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
      if (error instanceof Fault) throw error;
      throw new Fault(409, 'group_preparation_changed', error instanceof Error ? error.message : 'This original Group preparation needs review.');
    }
  }
}
