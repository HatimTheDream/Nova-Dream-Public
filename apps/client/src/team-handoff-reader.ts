import type { TeamHandoff, TeamHandoffPage } from '../../../packages/domain/team-work';

export type HandoffReadState = { text: string; loaded: number; complete: boolean; loading: boolean; error: string };
export const emptyHandoffRead = (): HandoffReadState => ({ text: '', loaded: 0, complete: false, loading: false, error: '' });

/** One immutable result per reader. Failed pages never discard earlier text. */
export class TeamHandoffReader {
  private state = emptyHandoffRead();
  private pending?: AbortController;
  private closed = false;
  constructor(private handoff: TeamHandoff, private read: (offset: number, signal: AbortSignal) => Promise<TeamHandoffPage>, private update: (state: HandoffReadState) => void) {}
  async load() {
    if (this.closed || this.pending || this.state.complete) return;
    const controller = new AbortController(), offset = this.state.loaded;
    this.pending = controller;
    this.state = { ...this.state, loading: true, error: '' }; this.update(this.state);
    try {
      const page = await this.read(offset, controller.signal);
      if (this.closed || controller.signal.aborted) return;
      const loaded = offset + Array.from(page.text).length;
      if (page.id !== this.handoff.id || page.sha256 !== this.handoff.sha256 || page.characters !== this.handoff.characters || page.offset !== offset || loaded > page.characters || (page.nextOffset === null ? loaded !== page.characters : page.nextOffset !== loaded || loaded <= offset)) throw Error('This handoff page did not match the saved result. Read it again.');
      this.state = { text: this.state.text + page.text, loaded, complete: page.nextOffset === null, loading: false, error: '' };
    } catch (error) {
      if (this.closed || controller.signal.aborted) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : 'This handoff could not load. Your earlier pages are kept.' };
    } finally {
      this.pending = undefined;
      if (!this.closed) this.update(this.state);
    }
  }
  close() { this.closed = true; this.pending?.abort(); }
}
