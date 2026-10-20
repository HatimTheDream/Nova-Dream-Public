import type { CollectionGuard, HomeItemValue, HomeLibraryCommand, HomeLibraryReceipt, HomeReference } from '../../../packages/domain/home-library';
import { captureResultMatches, isHomeItemDraft, isHomeItemValue, isHomeReference } from '../../../packages/domain/home-library-view';
import { libraryCaptureBytes, libraryPortableBytes, libraryTextCharacters, utf8Bytes } from '../../../packages/domain/home-library-portable';

export type LibraryTransferScope = { deviceId: string; epoch: string; windowId: string };
export type TransferFile = { name: string; sha256: string; format: 'nova-json' | 'url-text'; entries: number; unsupported: number; archived: number };
export type TransferRow = {
 position: number; rowId: string; id: string; value: HomeItemValue; selected: boolean;
 confirmation?: { requestId: string; disposition: 'created-and-added' | 'already-in-destination' | 'duplicate-in-batch'; reference: HomeReference; submittedValue: HomeItemValue };
};
export type LibraryTransferDraft = { file: TransferFile; rows: TransferRow[]; destination: CollectionGuard | null; text?: string };
type Journal = LibraryTransferScope & { format: 1; draft: LibraryTransferDraft };
type Capture = Extract<HomeLibraryCommand, { type: 'items-capture' }>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 200;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function isLibraryTransferDraft(value: unknown): value is LibraryTransferDraft {
 if (!object(value) || !keys(value, ['file', 'rows', 'destination', 'text']) || !object(value.file) ||
     !keys(value.file, ['name', 'sha256', 'format', 'entries', 'unsupported', 'archived']) || typeof value.file.name !== 'string' || value.file.name.length > 255 ||
     typeof value.file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.file.sha256) || !['nova-json', 'url-text'].includes(value.file.format as string) ||
     !count(value.file.entries) || !count(value.file.unsupported) || !count(value.file.archived) ||
     value.file.unsupported + value.file.archived > value.file.entries || !Array.isArray(value.rows) || value.rows.length > 20 ||
     !(value.destination === null || object(value.destination) && keys(value.destination, ['id', 'expectedRevision']) && id(value.destination.id) &&
       Number.isSafeInteger(value.destination.expectedRevision) && (value.destination.expectedRevision as number) > 0)) return false;
 if (value.file.format === 'url-text') return value.rows.length === 0 && typeof value.text === 'string' && value.text.length <= libraryTextCharacters;
 if (value.text !== undefined) return false;
 for (const row of value.rows) {
  if (!object(row) || !keys(row, ['position', 'rowId', 'id', 'value', 'selected', 'confirmation']) || !count(row.position) ||
      row.position >= 200 || !id(row.rowId) || !id(row.id) || !isHomeItemDraft(row.value) || row.value.archived || typeof row.selected !== 'boolean') return false;
  if (row.confirmation !== undefined) {
   const c = row.confirmation;
   if (!object(c) || !keys(c, ['requestId', 'disposition', 'reference', 'submittedValue']) || !uuid(c.requestId) ||
       !['created-and-added', 'already-in-destination', 'duplicate-in-batch'].includes(c.disposition as string) ||
       !isHomeReference(c.reference) || !isHomeItemValue(c.submittedValue) || c.submittedValue.kind !== row.value.kind ||
       c.reference.kind !== row.value.kind || c.submittedValue.archived || row.selected ||
       c.disposition === 'created-and-added' && (c.reference.id !== row.id || c.reference.revision !== 1) ||
       c.disposition !== 'created-and-added' && row.value.kind !== 'link') return false;
  }
 }
 return new Set(value.rows.map(row => row.position)).size === value.rows.length && new Set(value.rows.map(row => row.id)).size === value.rows.length &&
  new Set(value.rows.map(row => row.rowId)).size === value.rows.length;
}

/** This owner keeps review writing only. The existing Library controller owns the sole pending command. */
export class LibraryTransferDraftOwner {
 readonly key: string;
 value?: LibraryTransferDraft;
 invalid = false;
 error = '';
 private raw: string | null = null;
 constructor(private storage: StoragePort, readonly scope: LibraryTransferScope, private current: () => boolean) {
  this.key = `e3:library-transfer-draft:${scope.deviceId}:${scope.epoch}:${scope.windowId}`;
  try {
   this.raw = storage.getItem(this.key);
   if (this.raw === null || this.raw === 'null') return;
   if (utf8Bytes(this.raw) > libraryPortableBytes) throw Error('The kept import review is too large to open safely. Its original browser data is preserved.');
   const journal: unknown = JSON.parse(this.raw);
   if (!object(journal) || !keys(journal, ['format', 'deviceId', 'epoch', 'windowId', 'draft']) || journal.format !== 1 ||
       journal.deviceId !== scope.deviceId || journal.epoch !== scope.epoch || journal.windowId !== scope.windowId || !isLibraryTransferDraft(journal.draft))
    throw Error('The kept import review cannot be verified. Its original browser data is preserved.');
   this.value = journal.draft;
  } catch (reason) { this.invalid = true;this.error = reason instanceof Error ? reason.message : 'Browser storage is unavailable. Keep this window open.'; }
 }
 private persist(value: LibraryTransferDraft | undefined): boolean {
  if (!this.current() || this.invalid) return false;
  try {
   if (value && !isLibraryTransferDraft(value)) throw Error('The complete import review could not be kept. Keep this window open.');
   const desired = value ? JSON.stringify({ format: 1, ...this.scope, draft: value } satisfies Journal) : 'null';
   if (utf8Bytes(desired) > libraryPortableBytes) throw Error('The kept import review exceeds 16 MiB. Keep the original file and this window open.');
   const actual = this.storage.getItem(this.key);
   if (actual !== desired) {
    if (actual !== this.raw) throw Error('This import review changed elsewhere. Neither version was replaced. Keep this window open.');
    this.storage.setItem(this.key, desired);
    if (this.storage.getItem(this.key) !== desired) throw Error('This import review was not confirmed in browser storage. Retry Keeping Review.');
   }
   this.raw = desired;this.error = '';return true;
  } catch (reason) { this.error = reason instanceof Error ? reason.message : 'This import review could not be kept. Keep this window open.';return false; }
 }
 begin(value: LibraryTransferDraft): boolean {
  if (!this.current() || this.invalid || !isLibraryTransferDraft(value)) return false;
  if (this.value) {
   if (this.value.file.sha256 !== value.file.sha256 || this.value.file.format !== value.file.format) {
    this.error = 'Another import review is kept. Resume it or explicitly discard it before choosing a different file.';return false;
   }
   return this.keep();
  }
  this.value = structuredClone(value);return this.keep();
 }
 keep(): boolean { return this.value ? this.persist(this.value) : !this.invalid; }
 change(change: (value: LibraryTransferDraft) => LibraryTransferDraft): boolean {
  if (!this.current() || this.invalid || !this.value) return false;
  const next = change(structuredClone(this.value));
  if (!isLibraryTransferDraft(next)) { this.error = 'Keep at most 20 reviewed rows, including unfinished writing.';return false; }
  this.value = next;return this.keep();
 }
 discard(): boolean {
  if (!this.persist(undefined)) return false;
  this.value = undefined;return true;
 }
 command(requestId: string): Capture | undefined {
  if (!this.current() || !this.value || !uuid(requestId) || !this.keep() || !this.value.destination) return;
  const rows = this.value.rows.filter(row => row.selected && !row.confirmation);
  if (!rows.length || rows.length > 20 || !rows.every(row => isHomeItemValue(row.value))) {
   this.error = 'Review the selected titles and addresses before saving. Your writing is kept.';return;
  }
  const command: Capture = { type: 'items-capture', requestId, epoch: this.scope.epoch, destination: { ...this.value.destination },
   rows: rows.map(({ rowId, id, value }) => ({ rowId, id, value: structuredClone(value) })) };
  if (utf8Bytes(JSON.stringify(command)) > libraryCaptureBytes) {
   this.error = 'This selection exceeds the 500,000-byte save limit. Select fewer rows; no writing was truncated.';return;
  }
  return command;
 }
 acknowledge(command: HomeLibraryCommand, receipt: unknown): boolean {
  if (!this.current() || !this.value || command.type !== 'items-capture' || command.epoch !== this.scope.epoch || !captureResultMatches(command, receipt)) return false;
  const result: HomeLibraryReceipt = receipt;
  let matched = false;
  const rows = this.value.rows.map(row => {
   const index = command.rows.findIndex(input => input.id === row.id && input.rowId === row.rowId && input.value.kind === row.value.kind);
   if (index < 0 || row.confirmation && row.confirmation.requestId !== command.requestId) return row;
   matched = true;
   const outcome = result.outcomes[index], submittedValue = command.rows[index].value;
   return { ...row, selected: false, confirmation: { requestId: command.requestId, disposition: outcome.disposition as NonNullable<TransferRow['confirmation']>['disposition'], reference: outcome.reference, submittedValue: structuredClone(submittedValue) } };
  });
  if (!matched) return false;
  // Keep the genuine response in memory before a fallible acknowledgement write.
  this.value = { ...this.value, rows };return this.keep();
 }
 anotherCopy(position: number, itemId: string, rowId: string): boolean {
  if (!id(itemId) || !id(rowId)) return false;
  return this.change(value => ({ ...value, rows: value.rows.map(row => row.position === position && row.confirmation ?
   { position: row.position, id: itemId, rowId, value: row.value, selected: true } : row) }));
 }
 hasNewerWriting(row: TransferRow): boolean { return !!row.confirmation && !equal(row.value, row.confirmation.submittedValue); }
}
