/** Keep the latest writing in this document when browser persistence is unavailable. */
export class RetainedLocalDrafts<T> {
  private volatile = new Map<string, T>();
  constructor(private storage: { read: (key: string) => T | undefined; write: (key: string, value: T) => boolean }, private changed: (unsaved: boolean) => void = () => {}) {}
  read(key: string): T | undefined { return this.volatile.get(key) ?? this.storage.read(key); }
  unsaved(key: string): boolean { return this.volatile.has(key); }
  write(key: string, value: T): boolean {
    this.volatile.set(key, value);
    const saved = this.storage.write(key, value);
    if (saved) this.volatile.delete(key);
    this.changed(this.volatile.size > 0);
    return saved;
  }
}
