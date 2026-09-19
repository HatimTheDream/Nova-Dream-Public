export type HistoryReadOptions = { offset?: number; messageId?: string; newer?: boolean; latest?: boolean };
type ReadCycle = { id: string; identity: string; options?: HistoryReadOptions; abort: AbortController; refresh: boolean; done: Promise<void> };

/** Background observations must not replace the owner's pending reading-window
 * request. Publish that page first, then check the head once for queued changes. */
export class AssistantHistoryReader {
  private current?: ReadCycle;
  constructor(private options: {
    identity: (id: string) => string;
    read: (id: string, options: HistoryReadOptions | undefined, signal: AbortSignal) => Promise<void>;
  }) {}

  poll(id: string): Promise<void> {
    if (this.current?.identity !== this.options.identity(id) || this.current?.id !== id) this.cancel();
    if (this.current) { this.current.refresh = true; return this.current.done; }
    return this.start(id);
  }

  load(id: string, options?: HistoryReadOptions): Promise<void> {
    // Explicit Latest, message jumps and status recovery take precedence over an
    // earlier request, including one with the same URL from before a mutation.
    this.cancel();
    return this.start(id, options);
  }

  cancel(): void { this.current?.abort.abort(); this.current = undefined; }

  private start(id: string, options?: HistoryReadOptions): Promise<void> {
    const cycle: ReadCycle = { id, identity: this.options.identity(id), options, abort: new AbortController(), refresh: false, done: Promise.resolve() };
    this.current = cycle;
    cycle.done = Promise.resolve().then(async () => {
      const current = () => this.current === cycle && !cycle.abort.signal.aborted && cycle.identity === this.options.identity(id);
      try {
        do {
          cycle.refresh = false;
          if (!current()) return;
          await this.options.read(id, cycle.options, cycle.abort.signal);
          cycle.options = undefined;
        } while (current() && cycle.refresh);
      } finally { if (this.current === cycle) this.current = undefined; }
    });
    return cycle.done;
  }
}
