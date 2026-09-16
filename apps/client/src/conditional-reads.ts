const paths = new Set(['snapshot', 'assistant/state', 'assistant/outputs']);
type Entry = { tag: string; json: string; nextPoll: number };
export type ReadTicket = { generation: number; entry?: Entry };

/** A bounded memory-only copy of three polled responses. A 304 is usable only
 * after the server has authenticated this particular request again. */
export class ConditionalReads {
  private generation = 0;
  private entries = new Map<string, Entry>();
  constructor(private now = () => Date.now()) {}
  begin(path: string): ReadTicket { return { generation: this.generation, entry: this.entries.get(path) }; }
  clear() { this.generation++; this.entries.clear(); }
  forget(path: string) { this.entries.delete(path); }
  mayPoll(path: string) { return (this.entries.get(path)?.nextPoll ?? 0) <= this.now(); }
  accept(path: string, ticket: ReadTicket, tag: string | null, json: string | undefined) {
    if (ticket.generation !== this.generation) throw new Error('The connection changed. Read the workspace again.');
    if (json === undefined) {
      if (!ticket.entry || tag !== ticket.entry.tag) throw new Error('Read the current workspace again.');
      // Workspace cadence is unchanged for reminders/device continuity. Only
      // unchanged Assistant state/outputs back off, bounded to the next 5 s.
      if (this.entries.get(path) === ticket.entry && path !== 'snapshot') ticket.entry.nextPoll = this.now() + 5000;
      return JSON.parse(ticket.entry.json);
    }
    const value: unknown = JSON.parse(json);
    if (paths.has(path) && tag && /^"e3-[a-f0-9]{64}"$/.test(tag) && json.length <= 4 * 1024 * 1024) this.entries.set(path, { tag, json, nextPoll: 0 });
    else this.entries.delete(path);
    return value;
  }
}
