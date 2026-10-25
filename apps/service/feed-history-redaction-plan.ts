import {z} from 'zod';
import {canonical} from '../../packages/domain/contracts.js';
import type {HistoryStoreLimits} from '../../packages/domain/news-feed-history-storage.js';
import type {WorkerIdentity} from '../../packages/domain/worker.js';
import {historyJsonBytes} from './feed-history-bounds.js';
import type {HistoryInventoryAccess} from './feed-history-inventory.js';
import {withHistoryProtectedReceipts, type HistoryReceiptClosureLimits} from './feed-history-receipt-protection.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitsSchema = z.object({
  qualification: z.literal('unqualified'),
  visited: positive,
  candidates: positive,
  receiptBytes: positive,
  bytes: positive,
  entries: positive,
}).strict();
export type HistoryRedactionPlanLimits = z.infer<typeof limitsSchema>;
export type HistoryReceiptRedaction = Readonly<{
  requestId: string;
  deviceId: string;
  digest: string;
  previousValueJson: string;
  replacementValueJson: string;
}>;
type Native = (worker: WorkerIdentity) => {runId: string; sessionKey: string};
function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}

/** Private logical data only. The Store must separately authorize removal,
 * own the transaction, bind actual encrypted predecessors, reserve capacity,
 * apply conditional writes and prove actual history before committing.
 * These JSON strings preserve parsed result order, not original ciphertext
 * or plaintext whitespace. No SQL, protected predicate or proof ticket escapes.
 */
export function planHistoryReceiptRedaction(
  access: HistoryInventoryAccess,
  storeLimits: HistoryStoreLimits,
  native: Native,
  closureLimits: HistoryReceiptClosureLimits,
  rawLimits: HistoryRedactionPlanLimits,
  removedWork: 'draft' | 'conversation',
  matches: (isolatedValue: unknown) => boolean,
): readonly HistoryReceiptRedaction[] {
  historyJsonBytes(rawLimits, 2048);
  const limits = limitsSchema.parse(rawLimits);
  need(canonical(limits) === canonical(rawLimits), 'Exact redaction plan limits required');
  need(removedWork === 'draft' || removedWork === 'conversation', 'Exact removed-work kind required');
  need(typeof matches === 'function', 'Synchronous removal policy required');
  const token = access.token();
  let entries = 0, copiedBytes = 0, visited = 0;
  const guard = () => need(access.token() === token, 'Redaction plan snapshot changed');
  const entry = () => {
    need(entries < limits.entries, 'Redaction plan wrapper bound');
    entries++;
  };
  const charge = (size: number) => {
    need(Number.isSafeInteger(size) && size >= 0 &&
      Number.isSafeInteger(copiedBytes + size) && copiedBytes + size <= limits.bytes,
    'Redaction plan copy byte bound');
    copiedBytes += size;
  };
  const replacementValueJson = removedWork === 'draft'
    ? '{"removedWork":"draft"}' : '{"removedWork":"conversation"}';
  charge(historyJsonBytes(replacementValueJson, limits.bytes));

  return withHistoryProtectedReceipts(access, storeLimits, native, closureLimits, protectedReceipt => {
    guard();
    entry();
    const result: HistoryReceiptRedaction[] = [];
    entry(); // Charge the one scan iterator before asking the port for it.
    for (const receipt of access.receipts()) {
      guard();
      need(visited < limits.visited, 'Redaction plan visited receipt bound');
      visited++;
      charge(historyJsonBytes(receipt, limits.receiptBytes));
      if (protectedReceipt(receipt.requestId)) {
        guard();
        continue;
      }
      // Charge serialization and the separate mutable policy copy before
      // allocating either. The actual value is never passed to the policy.
      const size = historyJsonBytes(receipt.value, limits.receiptBytes);
      charge(size);
      const previousValueJson = JSON.stringify(receipt.value);
      charge(size);
      entry();
      const value = JSON.parse(previousValueJson) as unknown;
      guard();
      const selected: unknown = matches(value);
      const then = selected !== null && (typeof selected === 'object' || typeof selected === 'function')
        ? (selected as {then?: unknown}).then : undefined;
      if (typeof then === 'function') {
        // Observe the exact method we inspected, with its original receiver.
        // Promise.resolve(selected) would read a stateful getter again.
        void new Promise((resolve, reject) => {
          try { Reflect.apply(then, selected, [resolve, reject]); }
          catch (error) { reject(error); }
        }).then(() => undefined, () => undefined);
        throw Error('Removal policy must be synchronous');
      }
      guard();
      need(typeof selected === 'boolean', 'Removal policy must return a boolean');
      if (!selected) continue;
      need(result.length < limits.candidates, 'Redaction plan candidate bound');
      entry();
      const candidate = {
        requestId: receipt.requestId, deviceId: receipt.deviceId, digest: receipt.digest,
        previousValueJson, replacementValueJson,
      };
      // Envelope accounting includes escaped JSON strings and identity fields.
      charge(historyJsonBytes(candidate, limits.bytes - copiedBytes));
      result.push(Object.freeze(candidate));
    }
    guard();
    return Object.freeze(result);
  });
}
