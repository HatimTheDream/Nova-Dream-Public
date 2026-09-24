/** Own only the dictated span; surrounding writing always belongs to the user. */
export class DictationDraft {
  private id?: string;
  private value = '';
  private start = 0;
  private end = 0;
  private begun = false;
  private detached = false;

  begin(text: string, start = text.length, end = start) {
    this.id = undefined; this.value = text; this.start = Math.max(0, Math.min(start, text.length));
    this.end = Math.max(this.start, Math.min(end, text.length)); this.begun = true; this.detached = false;
  }

  /** A manual edit wins even when repeated words make a text diff ambiguous. */
  replace(text: string) { this.value = text; this.detached = true; }

  /** Edits around speech move its span. Editing speech itself retires ownership. */
  edit(text: string) {
    if (!this.begun || this.detached || text === this.value) return !this.detached;
    let from = 0, tail = 0;
    while (from < Math.min(text.length, this.value.length) && text[from] === this.value[from]) from++;
    while (tail < Math.min(text.length, this.value.length) - from && text[text.length - 1 - tail] === this.value[this.value.length - 1 - tail]) tail++;
    const oldEnd = this.value.length - tail, shift = text.length - this.value.length;
    if (oldEnd <= this.start) { this.start += shift; this.end += shift; }
    else if (from < this.end) this.detached = true;
    this.value = text;
    return !this.detached;
  }

  update(current: string, speech: string, id: string) {
    if (!this.begun) this.begin(current);
    if (this.id && this.id !== id || this.detached) return current;
    this.id = id;
    if (!this.edit(current)) throw Error('Dictation stopped because the draft changed. Your edits are kept.');
    if (!speech.trim()) return current;
    const before = current.slice(0, this.start), after = current.slice(this.end), words = speech.trim();
    const inserted = `${/\S$/.test(before) && !/^[,.;:!?)}\]]/.test(words) ? ' ' : ''}${words}${/^\S/.test(after) && !/^[,.;:!?)}\]]/.test(after) ? ' ' : ''}`;
    const next = before + inserted + after;
    if (next.length > 100000) throw Error('This draft is full. Shorten it before adding more dictated words.');
    this.value = next; this.end = this.start + inserted.length;
    return next;
  }
}
