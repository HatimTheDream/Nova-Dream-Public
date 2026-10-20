export type ProfileReadPage<T extends { id: string }> = { epoch: string; revision: number; head: string | null; entries: T[]; next: string | null; total: number };
type Version = { revision: number; head: string | null; total: number };
type Refresh<T extends { id: string }> = { rows: T[]; next: string | null; version: Version; wanted: number };
const sameVersion = (a: Version, b: Version) => a.revision === b.revision && a.head === b.head && a.total === b.total;

/** A read cache, not a second ledger. Only a complete, consistent page chain replaces confirmed rows. */
export class ProfilePages<T extends { id: string }> {
  rows: T[] = []; total = 0; next: string | null = null; busy = false; loaded = false; stale = false; error = '';
  active = true; private generation = 0; private version?: Version; private rebuilding?: Refresh<T>;
  constructor(readonly epoch: string, private read: (before?: string) => Promise<ProfileReadPage<T>>, private changed: () => void = () => {}) {}
  get refreshing() { return !!this.rebuilding; }
  get refreshedRows() { return this.rebuilding?.rows.length ?? 0; }
  retire() { this.active = false; this.generation++; this.busy = false; }
  noteHead(head: string | null, total: number) {
    if (this.loaded && (this.version?.head !== head || this.version?.total !== total)) { this.stale = true; this.changed(); }
  }
  private validate(value: ProfileReadPage<T>) {
    if (!value || value.epoch !== this.epoch || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Array.isArray(value.entries) || value.entries.length > 50 || !Number.isSafeInteger(value.total) || value.total < value.entries.length ||
      value.entries.some(row => !row || typeof row.id !== 'string' || !row.id) || new Set(value.entries.map(row => row.id)).size !== value.entries.length ||
      (value.head !== null && typeof value.head !== 'string') || (value.total === 0) !== (value.head === null) ||
      (value.next !== null && value.next !== value.entries.at(-1)?.id)) throw Error('This Profile page could not be verified. Your confirmed history is kept.');
  }
  private current(token: number) { return this.active && token === this.generation; }
  private validateLength(page: ProfileReadPage<T>, length: number) {
    if (length > page.total || (page.next === null ? length !== page.total : length >= page.total)) {
      throw Error('This Profile page does not match the complete history count. Your confirmed rows are kept.');
    }
  }
  private failure(problem: unknown) { this.error = problem instanceof Error ? problem.message : 'This page is unavailable. Your confirmed history is kept.'; }
  async more() {
    if (!this.active || this.busy || !this.loaded || !this.next || this.rebuilding) return false;
    const token = ++this.generation, cursor = this.next; this.busy = true; this.error = ''; this.changed();
    try {
      const page = await this.read(cursor); if (!this.current(token)) return false; this.validate(page);
      if (!this.version || !sameVersion(this.version, page)) { this.stale = true; throw Error('The saved activity changed. Refresh to join its current pages; your loaded history is kept.'); }
      if (!page.entries.length || page.entries.some(row => this.rows.some(old => old.id === row.id))) throw Error('This page does not continue the original history. Refresh to review it; your loaded rows are kept.');
      this.validateLength(page, this.rows.length + page.entries.length);
      this.rows = [...this.rows, ...page.entries]; this.total = page.total; this.next = page.next; return true;
    } catch (problem) { if (this.current(token)) this.failure(problem); return false; }
    finally { if (this.current(token)) { this.busy = false; this.changed(); } }
  }
  async refresh(wanted = this.rows.length || 50, resume = false) {
    if (!this.active || this.busy) return false;
    const token = ++this.generation; this.busy = true; this.error = ''; if (!resume) this.rebuilding = undefined; this.changed();
    try {
      // At most eight real requests in one action. Long retained histories can continue explicitly.
      for (let reads = 0; reads < 8; reads++) {
        const pending = this.rebuilding, cursor = pending?.next ?? undefined;
        const page = await this.read(cursor); if (!this.current(token)) return false; this.validate(page);
        if (pending && (!sameVersion(pending.version, page) || page.entries.some(row => pending.rows.some(old => old.id === row.id)) || !page.entries.length)) {
          this.rebuilding = undefined; this.stale = true; throw Error('Activity changed during refresh. Retry Refresh; your earlier confirmed history is kept.');
        }
        const rows = pending ? [...pending.rows, ...page.entries] : page.entries;
        this.validateLength(page, rows.length);
        if (!pending && page.head !== (page.entries[0]?.id ?? null)) throw Error('The first Profile page could not be verified. Your confirmed history is kept.');
        const target = pending?.wanted ?? Math.max(wanted, this.loaded ? this.rows.length + Math.max(0, page.total - this.total) : wanted);
        this.rebuilding = { rows, next: page.next, version: { revision: page.revision, head: page.head, total: page.total }, wanted: target };
        if (!page.next || rows.length >= target) {
          this.rows = rows; this.next = page.next; this.total = page.total; this.version = this.rebuilding.version;
          this.loaded = true; this.stale = false; this.rebuilding = undefined; return true;
        }
      }
      return false;
    } catch (problem) { if (this.current(token)) this.failure(problem); return false; }
    finally { if (this.current(token)) { this.busy = false; this.changed(); } }
  }
}
