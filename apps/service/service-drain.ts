/** A private service owner, never a browser-facing receipt. The Feed port is
 * structurally identical to the reviewed controller close return contract. */
export interface FeedDrainPort {
  close(waitMs?: number): Promise<{ localSettled: boolean; blockers: Record<string, number> }>;
}
type Phase = 'admission' | 'listeners' | 'feed' | 'dependents' | 'disposal';
export type ServiceDrainOutcome = { state: 'closed'; localSettled: true } | {
  state: 'pending'; localSettled: false; phase: Phase; reason: 'waiting' | 'unsettled' | 'failed';
  readonly owner: ServiceDrain; readonly failure?: unknown;
};
type Tracked<T> = { state: 'pending' | 'fulfilled' | 'rejected'; settled: Promise<void>; value?: T; failure?: unknown };
function track<T>(call: () => Promise<T>): Tracked<T> {
  const result: Tracked<T> = { state: 'pending', settled: Promise.resolve() };
  let original: Promise<T>;
  try { original = Promise.resolve(call()); } catch (failure) { original = Promise.reject(failure); }
  // The original promise stays reachable through this settlement continuation.
  // Both outcomes are consumed even after a bounded observer has returned.
  result.settled = original.then(value => { result.state = 'fulfilled'; result.value = value; },
    failure => { result.state = 'rejected'; result.failure = failure; });
  return result;
}
function bound(waitMs: number) {
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 90000) throw new Error('Invalid finite service drain bound');
}
export class ServiceDrainPendingError extends Error {
  declare readonly owner: ServiceDrain;
  constructor(readonly outcome: Extract<ServiceDrainOutcome, { state: 'pending' }>, cause?: unknown) {
    super('The service is still closing. Original work and its saved workspace remain owned.', { cause });
    this.name = 'ServiceDrainPendingError';
    Object.defineProperty(this, 'owner', { value: outcome.owner, enumerable: false });
  }
}
export class ServiceStartPendingError extends ServiceDrainPendingError {
  constructor(outcome: Extract<ServiceDrainOutcome, { state: 'pending' }>, originalStartFailure: unknown) {
    super(outcome, originalStartFailure); this.name = 'ServiceStartPendingError';
  }
}

/** Closing is monotonic. Only bounded observation can be repeated: listener
 * close and disposal each retain one original promise, including its failure.
 * A Feed false/error response permits a later observation of that same owner;
 * an unresolved Feed promise is never replaced. */
export class ServiceDrain {
  private feed?: FeedDrainPort;
  private sealed = false;
  private closing = false;
  private closed = false;
  private admissionFailed = false;
  private admissionFailure?: unknown;
  private listeners?: Tracked<void>;
  private feedWait?: Tracked<Awaited<ReturnType<FeedDrainPort['close']>>>;
  private firstFeedWait?: Tracked<Awaited<ReturnType<FeedDrainPort['close']>>>;
  private dependentsWait?: Tracked<{ localSettled: boolean }>;
  private readonly dependentObservations: Tracked<{ localSettled: boolean }>[] = [];
  private disposal?: Tracked<void>;
  private observation?: Promise<ServiceDrainOutcome>;
  private closeObservation?: Promise<void>;
  constructor(private readonly ports: {
    stopAdmission(): void;
    closeListeners(): Promise<void>;
    settleDependents?(waitMs: number): Promise<{ localSettled: boolean }>;
    dispose(): Promise<void>;
  }) {}
  /** Composition calls this once with its own controller before listener bind. */
  attachFeed(feed: FeedDrainPort) {
    if (this.sealed || this.closing || this.feed) throw new Error('The service drain owner is already sealed');
    if (!feed || typeof feed.close !== 'function') throw new Error('An owned Feed close port is required');
    this.feed = feed;
  }
  seal() { this.sealed = true; }
  status() { return { closing: this.closing, closed: this.closed, feedAttached: !!this.feed }; }
  private pending(phase: Phase, reason: 'waiting' | 'unsettled' | 'failed', failure?: unknown): Extract<ServiceDrainOutcome, { state: 'pending' }> {
    const outcome = { state: 'pending' as const, localSettled: false as const, phase, reason } as Extract<ServiceDrainOutcome, { state: 'pending' }>;
    Object.defineProperty(outcome, 'owner', { value: this, enumerable: false });
    if (reason === 'failed') Object.defineProperty(outcome, 'failure', { value: failure, enumerable: false });
    return outcome;
  }
  observe(waitMs = 30000): Promise<ServiceDrainOutcome> {
    bound(waitMs);
    if (this.observation) return this.observation;
    if (!this.closing) {
      this.closing = true; this.sealed = true;
      try {
        const result: unknown = this.ports.stopAdmission();
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => { /* The invalid async hook is still observed. */ });
          throw new Error('Service admission closure must be synchronous');
        }
      } catch (failure) { this.admissionFailed = true; this.admissionFailure = failure; }
      this.listeners = track(() => this.ports.closeListeners());
    }
    if (this.feed && (!this.feedWait || this.feedWait.state === 'rejected' || this.feedWait.state === 'fulfilled' && !this.feedWait.value?.localSettled)) {
      this.feedWait = track(() => this.feed!.close(waitMs));
      this.firstFeedWait ??= this.feedWait;
    }
    const operation = this.observeOwned(waitMs); this.observation = operation;
    void operation.then(outcome => { if (!outcome.localSettled && this.observation === operation) this.observation = undefined; },
      () => { if (this.observation === operation) this.observation = undefined; });
    return operation;
  }
  private async observeOwned(waitMs: number): Promise<ServiceDrainOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); });
    try {
      await Promise.race([Promise.all([this.listeners!.settled, ...(this.feedWait ? [this.feedWait.settled] : [])]), expired]);
      if (this.admissionFailed) return this.pending('admission', 'failed', this.admissionFailure);
      if (this.listeners!.state === 'pending') return this.pending('listeners', 'waiting');
      if (this.listeners!.state === 'rejected') return this.pending('listeners', 'failed', this.listeners!.failure);
      if (this.feedWait?.state === 'pending') return this.pending('feed', 'waiting');
      if (this.feedWait?.state === 'rejected') return this.pending('feed', 'failed', this.feedWait.failure);
      if (this.feedWait && this.feedWait.value?.localSettled !== true) return this.pending('feed', 'unsettled');
      if (this.ports.settleDependents) {
        if (!this.dependentsWait || this.dependentsWait.state === 'fulfilled' && !this.dependentsWait.value?.localSettled) {
          this.dependentsWait = track(() => this.ports.settleDependents!(waitMs));
          this.dependentObservations.push(this.dependentsWait);
        }
        await Promise.race([this.dependentsWait.settled, expired]);
        if (this.dependentsWait.state === 'pending') return this.pending('dependents', 'waiting');
        if (this.dependentsWait.state === 'rejected') return this.pending('dependents', 'failed', this.dependentsWait.failure);
        if (this.dependentsWait.value?.localSettled !== true) return this.pending('dependents', 'unsettled');
      }
      this.disposal ??= track(() => this.ports.dispose());
      await Promise.race([this.disposal.settled, expired]);
      if (this.disposal.state === 'pending') return this.pending('disposal', 'waiting');
      if (this.disposal.state === 'rejected') return this.pending('disposal', 'failed', this.disposal.failure);
      this.closed = true; return { state: 'closed', localSettled: true };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  close(waitMs = 30000): Promise<void> {
    bound(waitMs);
    if (this.closeObservation) return this.closeObservation;
    const operation = this.observe(waitMs).then(outcome => { if (!outcome.localSettled) throw new ServiceDrainPendingError(outcome, outcome.failure); });
    this.closeObservation = operation;
    void operation.catch(() => { if (this.closeObservation === operation) this.closeObservation = undefined; });
    return operation;
  }
  /** Bind/start failure cannot lose the owner through an ordinary thrown error.
   * A fully drained failure preserves its original cause for ordinary fallback. */
  async failedStart(originalFailure: unknown, waitMs = 30000): Promise<never> {
    const outcome = await this.observe(waitMs);
    if (!outcome.localSettled) throw new ServiceStartPendingError(outcome, originalFailure);
    throw originalFailure;
  }
}

/** One explicit signal observation at a time. Pending/error cannot call the
 * successful-exit callback; the caller can request another bounded observation. */
export function serviceShutdownObserver(close: () => Promise<void>, completed: () => void, pending: (failure: unknown) => void) {
  let active: Promise<void> | undefined, done = false;
  return () => {
    if (active) return active;
    if (done) return Promise.resolve();
    const operation = (async () => { try { await close(); done = true; completed(); } catch (failure) { pending(failure); } })();
    active = operation;
    void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => { /* Preserve caller observation rejection. */ });
    return operation;
  };
}
