type Cycle = { identity: string; abort: AbortController; dirty: boolean; done: Promise<void> };

/** Polls join a pending read. Explicit refreshes wait for a read after their mutation. */
export class RefreshReader<T> {
  private current?: Cycle;
  constructor(private options: {
    identity: () => string;
    read: (signal: AbortSignal) => Promise<T>;
    accept: (value: T) => void;
    fail?: (error: unknown) => void;
    mayPoll?: () => boolean;
  }) {}

  poll(): Promise<void> { return !this.current && this.options.mayPoll?.() === false ? Promise.resolve() : this.start(false); }
  refresh(): Promise<void> { return this.start(true); }
  cancel(): void { this.current?.abort.abort(); this.current = undefined; }

  private start(fresh: boolean): Promise<void> {
    if (this.current?.identity !== this.options.identity()) this.cancel();
    if (this.current) { if (fresh) this.current.dirty = true; return this.current.done; }
    const cycle: Cycle = { identity: this.options.identity(), abort: new AbortController(), dirty: false, done: Promise.resolve() };
    this.current = cycle;
    cycle.done = Promise.resolve().then(() => this.drain(cycle));
    return cycle.done;
  }

  private async drain(cycle: Cycle): Promise<void> {
    const current = () => this.current === cycle && !cycle.abort.signal.aborted && cycle.identity === this.options.identity();
    try {
      do {
        cycle.dirty = false;
        if (!current()) return;
        try {
          const value = await this.options.read(cycle.abort.signal);
          if (current() && !cycle.dirty) this.options.accept(value);
        } catch (error) { if (current() && !cycle.dirty) this.options.fail?.(error); }
      } while (current() && cycle.dirty);
    } finally { if (this.current === cycle) this.current = undefined; }
  }
}
