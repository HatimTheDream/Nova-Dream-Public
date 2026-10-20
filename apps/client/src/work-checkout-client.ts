import { checkoutSchema, type WorkCheckout } from '../../../packages/domain/work-repositories';
import { draftBrowserStorage } from './draft-browser-storage';

export type CheckoutRequest = ReturnType<typeof checkoutSchema.parse>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const sameCommand = (a: CheckoutRequest, b: CheckoutRequest) => a.requestId === b.requestId && a.epoch === b.epoch && a.repository === b.repository && a.baseBranch === b.baseBranch;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
/** The public result deliberately does not contain the private request's device or base branch. */
export function validCheckout(value: unknown): value is WorkCheckout {
  if (!value || typeof value !== 'object') return false;
  const c = value as WorkCheckout, r = c.repository;
  return typeof c.id === 'string' && uuid.test(c.id) && typeof c.operationId === 'string' && uuid.test(c.operationId)
    && !!r && typeof r === 'object' && Number.isSafeInteger(r.id) && r.id > 0
    && text(r.fullName, 220) && text(r.description, 10000) && text(r.defaultBranch, 200)
    && typeof r.private === 'boolean' && typeof r.archived === 'boolean' && typeof r.canPush === 'boolean'
    && c.branch === `nova/${c.id.slice(0, 12)}` && text(c.folder, 32768) && c.folder.length > 0
    && ['preparing', 'ready', 'failed', 'unknown'].includes(c.state) && text(c.message, 32768)
    && Number.isSafeInteger(c.createdAt) && c.createdAt >= 0 && Number.isSafeInteger(c.accountId) && c.accountId > 0;
}
export function sameCheckout(a: WorkCheckout, b: WorkCheckout) {
  return a.id === b.id && a.operationId === b.operationId && a.repository.id === b.repository.id
    && a.repository.fullName === b.repository.fullName && a.branch === b.branch
    // The maintained clone worker replaces its initial path with realpath on success.
    && (a.folder === b.folder || a.state === 'preparing' && b.state === 'ready')
    && a.accountId === b.accountId && a.createdAt === b.createdAt;
}
export function checkoutList(value: unknown): WorkCheckout[] {
  const rows = (value as { checkouts?: unknown })?.checkouts;
  if (!Array.isArray(rows) || !rows.every(validCheckout) || new Set(rows.map(c => c.id)).size !== rows.length
    || new Set(rows.map(c => c.operationId)).size !== rows.length) throw Error('The host checkout list could not be verified. The original request is kept.');
  return rows;
}

/** One existing request key; no additional queue or mount-time command. */
export class CheckoutRequestOwner {
  pending?: CheckoutRequest;
  known?: WorkCheckout;
  error = '';
  private raw: string | null = null;
  private attempted?: string;
  private invalid = false;
  private alive = true;
  private generation = 0;
  constructor(readonly key: string, readonly epoch: string, private currentScope: () => boolean, private storage: StoragePort = draftBrowserStorage) { this.read(); }
  current(ticket = this.generation) { return this.alive && this.currentScope() && ticket === this.generation; }
  ticket() { return this.generation; }
  activate() { this.alive = true; }
  retire() { this.alive = false; this.generation++; }
  private requireCurrent() { if (!this.current()) throw Error('This checkout picker is no longer current.'); }
  read() {
    this.requireCurrent();
    // A failed write's in-memory original is never replaced by a convenience read.
    if (this.pending) { this.check(); return; }
    try {
      const raw = this.storage.getItem(this.key);
      const value = raw === null || raw === 'null' ? undefined : raw.length <= 4096 ? checkoutSchema.parse(JSON.parse(raw)) : (() => { throw Error(); })();
      if (value && value.epoch !== this.epoch) throw Error();
      this.raw = raw; this.pending = value; this.invalid = false; this.error = '';
    } catch {
      this.invalid = true;
      this.error = 'The kept checkout request cannot be read safely. Its original bytes are preserved. Restore browser storage access or review the original window.';
    }
  }
  check() {
    this.requireCurrent();
    if (this.invalid) throw Error(this.error);
    const actual = this.storage.getItem(this.key);
    if (actual !== this.raw && actual !== this.attempted) throw Error('The checkout request changed in another window. Reopen this picker to review that original request.');
    return true;
  }
  private write(value: CheckoutRequest | null) {
    this.check();
    const desired = JSON.stringify(value), actual = this.storage.getItem(this.key);
    if (actual !== desired) {
      // check again immediately before writing; reads must not bypass another writer.
      if (actual !== this.raw && actual !== this.attempted) throw Error('The checkout request changed in another window.');
      this.attempted = desired;
      this.storage.setItem(this.key, desired);
    }
    if (this.storage.getItem(this.key) !== desired) throw Error('The original checkout request could not be confirmed in browser storage. Keep this picker open and retry.');
    this.raw = desired; this.attempted = undefined; this.error = '';
  }
  retain(command: CheckoutRequest) {
    this.requireCurrent();
    const parsed = checkoutSchema.parse(command);
    if (parsed.epoch !== this.epoch || this.pending && !sameCommand(this.pending, parsed)) throw Error('The original checkout request must be reconciled first.');
    this.check();
    this.pending ??= parsed;
    this.write(this.pending);
    return this.pending;
  }
  accept(command: CheckoutRequest, value: unknown) {
    this.requireCurrent();
    if (!this.pending || !sameCommand(this.pending, command) || !validCheckout(value)
      || value.operationId !== command.requestId || value.repository.fullName !== command.repository
      || this.known && !sameCheckout(this.known, value)) throw Error('The host reply does not match the original checkout request. Reconcile that request before continuing.');
    // A genuine response stays in this owner even if the subsequent raw ownership read fails.
    this.known = value;
    this.check();
    return value;
  }
  observe(rows: WorkCheckout[]) {
    if (!this.known) return;
    const row = rows.find(c => c.id === this.known!.id);
    if (row && sameCheckout(this.known, row)) this.known = row;
  }
  originalStatus(rows: WorkCheckout[]) {
    this.check();
    const row = this.known && rows.find(c => sameCheckout(this.known!, c));
    if (!row || !this.pending || row.operationId !== this.pending.requestId || row.repository.fullName !== this.pending.repository) throw Error('Reconcile the original checkout request before continuing.');
    this.known = row;
    return row;
  }
  clearCompleted(result: WorkCheckout, state: 'ready' | 'failed') {
    this.requireCurrent();
    if (!this.pending || !this.known || !sameCheckout(this.known, result) || result.state !== state || this.known.state !== state
      || result.operationId !== this.pending.requestId || result.repository.fullName !== this.pending.repository) throw Error('Only the verified completed original request can be cleared.');
    this.write(null); this.pending = undefined; this.known = undefined;
  }
  empty() { this.check(); if (this.pending) throw Error('Keep the original checkout request until it is resolved.'); }
}
