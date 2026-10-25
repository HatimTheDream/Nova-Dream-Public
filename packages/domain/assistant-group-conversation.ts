import { canonical } from './contracts.js';
import type { GroupBundle } from './assistant-groups.js';
import { verifyGroupPreparations, hasGroupPreparationReceipt, type GroupPreparationAuthority,
  type GroupResponseCapture, type GroupResponseRef } from './assistant-group-turns.js';
import { executionChildPrefix, groupExecutionPrefix, groupExecutionSchema, groupExecutionGroupBytes,
  groupExecutionReceiptSchema, hasGroupExecutionReceipt, verifyGroupExecutions } from './assistant-group-execution.js';

type Row = { id: string; revision: number; value: unknown };
type Receipt = { requestId: string; deviceId: string; digest: string; value: unknown };
type Child = ReturnType<typeof verifyGroupExecutions> extends Map<string, infer Value> ? Value : never;
function need(value: unknown, message: string): asserts value { if (!value) throw Error(message); }

/** Replay each prepared round before its children, then expose only verified
 * terminal contributions to later rounds. No partial graph escapes this call. */
export function verifyGroupConversation(schema: number, records: Row[], receipts: Receipt[],
  groups: Map<string, GroupBundle>, saved: GroupPreparationAuthority['saved'], digest: GroupPreparationAuthority['digest']) {
  const byChild = new Map<string, Row[]>(), byReceipt = new Map<string, Receipt[]>();
  const rowIds = new Set<string>(), requestIds = new Set<string>(), bytes = new Map<string, number>();
  for (const row of records) {
    if (!row.id.startsWith(groupExecutionPrefix)) continue;
    need(!rowIds.has(row.id), 'A retained Group child row is duplicated.'); rowIds.add(row.id);
    const match = /^assistant:group-execution:([0-9a-f-]{36}):([0-9a-f-]{36}):(current|event:\d{3})$/.exec(row.id);
    need(match, 'An unsupported Group child row is retained.');
    const key = executionChildPrefix(match[1], match[2]);
    const size = (bytes.get(match[1]) ?? 0) + new TextEncoder().encode(canonical(row.value)).byteLength;
    need(size <= groupExecutionGroupBytes, 'The complete Group child history exceeds its supported byte bound.');
    bytes.set(match[1], size);
    const children = byChild.get(key) ?? []; children.push(row); byChild.set(key, children);
  }
  for (const receipt of receipts) {
    if (!hasGroupPreparationReceipt(receipt.value) && !hasGroupExecutionReceipt(receipt.value)) continue;
    need(!requestIds.has(receipt.requestId), 'An original Group request receipt is duplicated.');
    requestIds.add(receipt.requestId);
    if (!hasGroupExecutionReceipt(receipt.value)) continue;
    const original = groupExecutionReceiptSchema.parse(receipt.value);
    const key = executionChildPrefix(original.groupId, original.attemptId);
    const list = byReceipt.get(key) ?? []; list.push(receipt); byReceipt.set(key, list);
  }
  need(schema >= 59 || byChild.size === 0 && byReceipt.size === 0, 'Group execution needs workspace schema 59.');
  const executions = new Map<string, Child>(), contributions = new Map<string, GroupResponseCapture>();
  const consumed = new Set<string>();
  const response = (groupId: string, ref: GroupResponseRef) => {
    const result = contributions.get(executionChildPrefix(groupId, ref.attemptId));
    return result && result.roundId === ref.roundId && result.terminalSequence === ref.terminalSequence
      && result.terminalSha256 === ref.terminalSha256 ? result : undefined;
  };
  const preparations = verifyGroupPreparations(schema, records, receipts, groups, saved, digest, {
    response,
    round(round) {
      for (const recipient of round.recipients) {
        const key = executionChildPrefix(round.groupId, recipient.attempt.id);
        need(!consumed.has(key), 'An original child belongs to more than one prepared round.');
        consumed.add(key);
        const rows = byChild.get(key) ?? [], originalReceipts = byReceipt.get(key) ?? [];
        if (!rows.length && !originalReceipts.length) continue;
        const verified = verifyGroupExecutions(schema, rows, originalReceipts,
          (groupId, roundId) => groupId === round.groupId && roundId === round.id ? round : undefined, digest);
        const child = verified.get(key);
        need(child && verified.size === 1, 'The prepared child has no complete original execution.');
        executions.set(key, child);
        const terminal = child.events.find(event => event.observation?.kind === 'terminal'
          && event.observation.state === 'completed' && event.observation.nativeTurnId?.trim());
        if (!terminal) continue;
        const value = groupExecutionSchema.parse(terminal.value);
        need(value.send?.state === 'completed' && value.send.dispatchStarted && value.nativeTurnId?.trim()
          && value.setup.state === 'ready' && value.setup.dispatchStarted
          && value.setup.proof && value.send.proof && value.nativeId && value.nativeRunId === value.send.requestId,
        'The completed contribution is missing its original native identity.');
        const nativeTurnId = value.nativeTurnId;
        need(typeof nativeTurnId === 'string' && nativeTurnId.trim(), 'The original native turn identity is unavailable.');
        contributions.set(key, {
          roundId: round.id, attemptId: recipient.attempt.id, terminalSequence: terminal.sequence,
          terminalSha256: digest(terminal), sourceRoundSha256: digest(round), nativeTurnId,
          text: value.text, author: { agentId: recipient.captured.id, agentRevision: recipient.captured.revision,
            membershipId: recipient.membership.id, name: recipient.captured.value.name, position: recipient.captured.value.position },
        });
      }
    },
  });
  need([...byChild.keys(), ...byReceipt.keys()].every(key => consumed.has(key)),
    'An original Group child or receipt has no verified prepared round.');
  return { preparations, executions, response };
}
