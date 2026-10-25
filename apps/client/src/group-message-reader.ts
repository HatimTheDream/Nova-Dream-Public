import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { groupStopSchema } from '../../../packages/domain/assistant-group-execution';
import { preparedGroupRoundSchema, groupResponseRefSchema, type PreparedGroupRound,
  type GroupHistoryRef, type GroupResponseRef } from '../../../packages/domain/assistant-group-turns';
const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{64}$/), sequence = z.number().int().min(0).max(1000);
const base = z.object({ epoch: uuid, groupId: uuid, sequence,
  execution: z.literal('unavailable'), mode: z.literal('provided-context-only') });
const summarySchema = base.extend({ view: z.literal('summary'), rounds: sequence, grants: sequence, drafts: sequence }).strict();
const roundSummarySchema = z.object({ id: uuid, sequence: sequence.min(1), at: z.string().datetime(),
  preview: z.string().max(240), recipientMembershipIds: z.array(uuid).min(1).max(32),
  state: z.literal('prepared'), mode: z.literal('provided-context-only') }).strict();
const roundsSchema = base.extend({ view: z.literal('rounds'), rounds: z.array(roundSummarySchema).max(32),
  total: sequence, next: sequence.min(1).nullable() }).strict();
const roundSchema = base.extend({ view: z.literal('round'), round: preparedGroupRoundSchema,
  availability: z.object({ current: z.boolean(), execution: z.literal('unavailable'),
    mode: z.literal('provided-context-only'), reason: z.string().optional(), message: z.string().optional() }).strict() }).strict();
const responseSchema = z.object({
  attemptId: uuid, author: z.object({ agentId: z.string(), agentRevision: z.number().int().positive(),
    membershipId: uuid, name: z.string().max(200), position: z.string().max(200) }).strict(),
  state: z.enum(['not-sent', 'preparing', 'dispatching', 'ready', 'accepted', 'completed', 'failed', 'cancelled', 'unknown']),
  stop: groupStopSchema.nullable(),
  selectable: z.boolean(), reason: z.enum(['original-turn-unavailable', 'not-completed']).nullable(),
  text: z.string().max(262144), ref: groupResponseRefSchema.nullable(),
}).strict();
const responsesSchema = base.extend({ view: z.literal('responses'), roundId: uuid, roundSha256: sha,
  responses: z.array(responseSchema).max(32), sha256: sha }).strict();
export type GroupResponseView = z.infer<typeof responseSchema>;
export type GroupRoundView = { round: PreparedGroupRound; sha256: string;
  responses: GroupResponseView[]; availability: z.infer<typeof roundSchema>['availability'] };
export async function groupDigest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export const preparationUrl = (groupId: string, fields: Record<string, string | number>) =>
  'assistant/group-preparations?' + new URLSearchParams({ groupId, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])) });
type Get = (url: string) => Promise<unknown>;
/** Inspect an exact captured input even when it is outside the visible page.
 * Reading context does not select it, grant it or observe native work. */
export async function inspectGroupContext(epoch: string, groupId: string, ref: GroupHistoryRef | GroupResponseRef, get: Get) {
  const result = roundSchema.parse(await get(preparationUrl(groupId, { view: 'round', roundId: ref.roundId })));
  const round = result.round;
  if (result.epoch !== epoch || result.groupId !== groupId || round.epoch !== epoch || round.groupId !== groupId || round.id !== ref.roundId)
    throw Error('This context belongs to a different original message.');
  const hash = await groupDigest(round);
  if ('sha256' in ref) {
    if (ref.sha256 !== hash) throw Error('The captured message changed. Its original reference is kept.');
    return { round, sha256: hash, reply: null };
  }
  const replies = responsesSchema.parse(await get(preparationUrl(groupId, { view: 'responses', roundId: round.id, roundSha256: hash })));
  if (replies.epoch !== epoch || replies.groupId !== groupId || replies.roundId !== round.id
    || replies.roundSha256 !== hash || replies.sha256 !== await groupDigest(replies.responses)
    || replies.responses.length !== round.recipients.length
    || new Set(replies.responses.map(row => row.attemptId)).size !== replies.responses.length)
    throw Error('The captured reply identity could not be verified.');
  const reply = replies.responses.find(row => row.attemptId === ref.attemptId);
  const recipient = round.recipients.find(row => row.attempt.id === ref.attemptId);
  if (!reply?.selectable || reply.state !== 'completed' || reply.reason !== null || canonical(reply.ref) !== canonical(ref) || !recipient
    || reply.author.agentId !== recipient.captured.id || reply.author.agentRevision !== recipient.captured.revision
    || reply.author.membershipId !== recipient.membership.id || reply.author.name !== recipient.captured.value.name
    || reply.author.position !== recipient.captured.value.position)
    throw Error('This exact completed reply is unavailable. Its original reference is kept.');
  return { round, sha256: hash, reply };
}
/** All reads are local saved history. Nothing here observes or dispatches native work. */
export class GroupMessageReader {
  sequence: number | null = null;
  total = 0;
  next: number | null = null;
  rows: z.infer<typeof roundSummarySchema>[] = [];
  details = new Map<string, GroupRoundView>();
  busy = false;
  error = '';
  constructor(readonly epoch: string, readonly groupId: string, private current: () => boolean) {}
  private identity(value: { epoch: string; groupId: string }) {
    if (value.epoch !== this.epoch || value.groupId !== this.groupId) throw Error('This history belongs to another Group or workspace.');
  }
  async load(get: Get, more = false) {
    if (this.busy || !this.current() || more && (this.next === null || this.sequence === null)) return false;
    this.busy = true;
    try {
      let seq = this.sequence;
      if (!more) {
        const summary = summarySchema.parse(await get(preparationUrl(this.groupId, { view: 'summary' })));
        this.identity(summary); seq = summary.sequence;
      }
      const after = more ? this.next! : 0;
      const page = roundsSchema.parse(await get(preparationUrl(this.groupId, { view: 'rounds', sequence: seq!, after })));
      this.identity(page);
      if (page.sequence !== seq || page.rounds.some((row, i) => row.sequence <= (i ? page.rounds[i - 1].sequence : after) || row.sequence > seq!)
        || new Set(page.rounds.map(row => row.id)).size !== page.rounds.length
        || page.next !== null && (page.rounds.length !== 32 || page.next !== page.rounds.at(-1)?.sequence)
        || more && page.rounds.some(row => this.rows.some(old => old.id === row.id))
        || more && page.total !== this.total
        || page.total < (more ? this.rows.length : 0) + page.rounds.length
        || page.next === null && page.total !== (more ? this.rows.length : 0) + page.rounds.length)
        throw Error('The saved message page changed. Refresh the original Group history.');
      if (!this.current()) return false;
      this.rows = more ? [...this.rows, ...page.rounds] : page.rounds;
      this.sequence = seq; this.next = page.next; this.total = page.total; this.error = ''; return true;
    } catch (e) { if (this.current()) this.error = e instanceof Error ? e.message : 'Saved messages could not be read.'; return false; }
    finally { this.busy = false; }
  }
  async open(id: string, get: Get) {
    if (this.busy || !this.current() || !this.rows.some(row => row.id === id)) return false;
    this.busy = true;
    try {
      const result = roundSchema.parse(await get(preparationUrl(this.groupId, { view: 'round', roundId: id })));
      this.identity(result);
      const round = result.round, row = this.rows.find(row => row.id === id)!;
      if (round.id !== id || round.groupId !== this.groupId || round.epoch !== this.epoch
        || round.sequence !== row.sequence || round.text.slice(0, 240) !== row.preview
        || canonical(round.recipients.map(r => r.membership.id)) !== canonical(row.recipientMembershipIds))
        throw Error('The original message identity changed.');
      const digest = await groupDigest(round);
      const view = responsesSchema.parse(await get(preparationUrl(this.groupId, { view: 'responses', roundId: id, roundSha256: digest })));
      this.identity(view);
      if (view.roundId !== id || view.roundSha256 !== digest || view.sha256 !== await groupDigest(view.responses)
        || view.responses.length !== round.recipients.length) throw Error('These replies do not belong to the original message.');
      view.responses.forEach((response, i) => {
        const recipient = round.recipients[i];
        const author = { agentId: recipient.captured.id, agentRevision: recipient.captured.revision,
          membershipId: recipient.membership.id, name: recipient.captured.value.name, position: recipient.captured.value.position };
        if (response.attemptId !== recipient.attempt.id || canonical(response.author) !== canonical(author)
          || response.selectable !== !!response.ref || response.selectable && (response.reason !== null || response.state !== 'completed'
            || response.ref!.roundId !== id || response.ref!.attemptId !== response.attemptId))
          throw Error('A reply lost its original speaker or completion evidence.');
      });
      if (!this.current()) return false;
      this.details.set(id, { round, sha256: digest, responses: view.responses, availability: result.availability });
      this.error = ''; return true;
    } catch (e) { if (this.current()) this.error = e instanceof Error ? e.message : 'The original message could not be opened.'; return false; }
    finally { this.busy = false; }
  }
}
