/** Complete history inventories use SQLite UTF-8 BINARY byte order. Key
 * schemas impose their own nonempty/length bounds; the empty cursor is valid.
 * Never normalize, case-fold, locale-sort or silently replace a key. The
 * maintained Node SQLite TEXT reader truncates NUL, so that input is refused. */
function exactUtf8KeyBytes(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('Invalid history UTF-8 key');
  if (value.includes('\u0000')) throw new Error('History key cannot round-trip through SQLite UTF-8 TEXT');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) throw new Error('History key cannot round-trip through UTF-8');
  return bytes;
}
export function assertHistoryUtf8Key(value: unknown): asserts value is string {
  exactUtf8KeyBytes(value);
}
export function compareHistoryKeys(a: string, b: string): number {
  return Buffer.compare(exactUtf8KeyBytes(a), exactUtf8KeyBytes(b));
}
/** Select CAST(key AS BLOB) alongside TEXT. A truncated or replaced TEXT value
 * must never impersonate the original saved key, including before migration. */
export function assertHistorySqlKey(text: unknown, raw: Uint8Array): asserts text is string {
  const expected = exactUtf8KeyBytes(text);
  if (!(raw instanceof Uint8Array) || Buffer.compare(expected, raw) !== 0) throw new Error('History SQLite key bytes do not match exact UTF-8 text');
}
