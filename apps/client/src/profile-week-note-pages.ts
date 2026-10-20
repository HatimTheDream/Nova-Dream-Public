import { weekNoteIdentityKey, weekNotesPageSchema, type WeekNotesPage } from '../../../packages/domain/profile-week-note';

type Row = WeekNotesPage['rows'][number];
type Pending = { rows: Row[]; next: string | null; version: string; total: number; wanted: number };
/** Paged read cache only. A changed page chain never replaces confirmed rows partially. */
export class WeekNotePages {
  rows: Row[] = []; next: string | null = null; total = 0; version = '';
  busy = false; loaded = false; error = ''; active = true;
  private generation = 0; private pending?: Pending;
  constructor(readonly epoch: string, private read: (before?: string, version?: string) => Promise<unknown>,
    private notify: () => void = () => {}) {}
  get refreshing() { return !!this.pending; }
  retire() { this.active = false; this.generation++; this.busy = false; }
  private current(token: number) { return this.active && token === this.generation; }
  private page(value: unknown) {
    const result = weekNotesPageSchema.parse(value), ids = result.rows.map(row => weekNoteIdentityKey(row.identity));
    if (result.epoch !== this.epoch || new Set(ids).size !== ids.length || result.total < result.rows.length ||
      result.next !== null && result.next !== ids.at(-1) || result.total > 0 && !result.rows.length ||
      result.total === 0 && result.next !== null) throw Error('This note list could not be verified. Your confirmed list is kept.');
    return result;
  }
  private length(page: WeekNotesPage, count: number) {
    if (count > page.total || (page.next === null ? count !== page.total : count >= page.total)) throw Error('This page does not match the complete note count.');
  }
  async more() {
    if (!this.active || this.busy || !this.loaded || !this.next || this.pending) return false;
    const token = ++this.generation; this.busy = true; this.error = ''; this.notify();
    try {
      const result = await this.read(this.next, this.version); if (!this.current(token)) return false;
      const page = this.page(result);
      if (page.version !== this.version || page.total !== this.total || page.rows.some(row => this.rows.some(old =>
        weekNoteIdentityKey(old.identity) === weekNoteIdentityKey(row.identity)))) throw Error('The saved notes changed. Refresh the list; your current rows stay here.');
      this.length(page, this.rows.length + page.rows.length);
      this.rows = [...this.rows, ...page.rows]; this.next = page.next; return true;
    } catch (problem) { if (this.current(token)) this.error = problem instanceof Error ? problem.message : 'Saved notes are unavailable.'; return false; }
    finally { if (this.current(token)) { this.busy = false; this.notify(); } }
  }
  async refresh(resume = false) {
    if (!this.active || this.busy) return false;
    const token = ++this.generation; this.busy = true; this.error = ''; if (!resume) this.pending = undefined; this.notify();
    try {
      for (let reads = 0; reads < 8; reads++) {
        const pending = this.pending;
        const result = await this.read(pending?.next ?? undefined, pending?.version);
        if (!this.current(token)) return false;
        const page = this.page(result);
        if (pending && (page.version !== pending.version || page.total !== pending.total || page.rows.some(row =>
          pending.rows.some(old => weekNoteIdentityKey(old.identity) === weekNoteIdentityKey(row.identity))))) {
          this.pending = undefined; throw Error('Notes changed during refresh. Your earlier confirmed list is kept.');
        }
        const rows = pending ? [...pending.rows, ...page.rows] : page.rows;
        this.length(page, rows.length);
        const wanted = pending?.wanted ?? (this.loaded ? Math.max(50, this.rows.length + Math.max(0, page.total - this.total)) : 50);
        this.pending = { rows, next: page.next, version: page.version, total: page.total, wanted };
        if (page.next === null || rows.length >= wanted) {
          this.rows = rows; this.next = page.next; this.total = page.total; this.version = page.version;
          this.pending = undefined; this.loaded = true; return true;
        }
      }
      return false;
    } catch (problem) { if (this.current(token)) this.error = problem instanceof Error ? problem.message : 'Saved notes are unavailable.'; return false; }
    finally { if (this.current(token)) { this.busy = false; this.notify(); } }
  }
}
