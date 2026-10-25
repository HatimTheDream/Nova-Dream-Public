import { canonical } from '../../../packages/domain/contracts';
import { closeSetupRequestSchema, setupRequestReferenceSchema, type CloseSetupRequest, type SetupRequestReference, type SetupRequestView } from '../../../packages/domain/setup-request';

type Record = { format: 1; reference: SetupRequestReference; dispatched: boolean; result?: SetupRequestView; closing?: CloseSetupRequest };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const terminal = (view?: SetupRequestView) => !!view && ['applied', 'failed', 'closed'].includes(view.state);
export function setupViewMatches(value: unknown, ref: SetupRequestReference): value is SetupRequestView {
  if (!value || typeof value !== 'object') return false;
  const view = value as SetupRequestView;
  return view.requestId === ref.requestId && view.epoch === ref.epoch && view.kind === ref.kind && view.sha256 === ref.sha256
    && Number.isInteger(view.revision) && view.revision >= 0
    && ['not-found', 'working', 'applied', 'failed', 'unknown', 'closed'].includes(view.state)
    && typeof view.message === 'string' && view.message.length <= 2048
    && (view.revision === 0 ? view.state === 'not-found' : view.state !== 'not-found');
}
/** Only identity/digest/status are stored here; Gateway credentials are never stored in the browser. */
export class SetupRequestJournal {
  value?: Record;
  error = '';
  private raw: string | null = null;
  private invalid = false;
  private attempted?: string;
  private staged?: Record;
  constructor(private storage: Storage, readonly key: string, private epoch: string) {
    try {
      this.raw = storage.getItem(key);
      if (this.raw !== null) {
        if (this.raw.length > 8192) throw Error();
        const value = JSON.parse(this.raw) as Record;
        if (value.format !== 1 || value.reference.epoch !== epoch || typeof value.dispatched !== 'boolean'
          || !setupRequestReferenceSchema.safeParse(value.reference).success
          || value.result && !setupViewMatches(value.result, value.reference)
          || value.closing && (!closeSetupRequestSchema.safeParse(value.closing).success || canonical(value.closing.original) !== canonical(value.reference))) throw Error();
        this.value = value;
      }
    } catch { this.invalid = true; this.error = 'The original setup request could not be read. Its stored copy is kept.'; }
  }
  get pending() { return this.value && !terminal(this.value.result) ? this.value : undefined; }
  get retentionPending() { return !!this.staged && !!this.error; }
  retryRetention() { return !!this.staged && this.write(this.staged); }
  private write(value: Record) {
    this.staged = value;
    try {
      if (this.invalid) throw Error();
      const next = canonical(value), before = this.storage.getItem(this.key);
      if (before !== this.raw && !(before === this.attempted && before === next)) throw Error();
      this.attempted = next; this.storage.setItem(this.key, next);
      if (this.storage.getItem(this.key) !== next) throw Error();
      this.raw = next; this.value = value; this.attempted = undefined; this.staged = undefined; this.error = ''; return true;
    } catch { this.error = 'The original setup request could not be retained. Keep this window open; check the original request before another setup.'; return false; }
  }
  begin(reference: SetupRequestReference) {
    if (this.pending || !setupRequestReferenceSchema.safeParse(reference).success || reference.epoch !== this.epoch) return false;
    return this.write({ format: 1, reference, dispatched: false });
  }
  dispatch() {
    return !!this.pending && !this.pending.dispatched && this.write({ ...this.pending, dispatched: true });
  }
  accept(value: unknown) {
    const record = this.value;
    if (!record || !setupViewMatches(value, record.reference) || value.revision < (record.result?.revision ?? 0)
      || terminal(record.result) && canonical(record.result) !== canonical(value)) return false;
    return this.write({ ...record, result: value });
  }
  prepareClose(requestId: string) {
    const record = this.pending;
    if (!record?.result || record.result.state === 'working') return undefined;
    if (record.closing) return record.closing;
    const closing = { requestId, epoch: this.epoch, original: record.reference, revision: record.result.revision };
    return closeSetupRequestSchema.safeParse(closing).success && this.write({ ...record, closing }) ? closing : undefined;
  }
  clearRejectedClose() {
    if (!this.pending?.closing) return true;
    const { closing: _, ...kept } = this.pending; return this.write(kept);
  }
}
