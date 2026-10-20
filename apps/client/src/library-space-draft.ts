import type { HomeShelvesCommand, HomeShelvesReceipt } from '../../../packages/domain/home-library';
import { isHomeShelvesReceipt } from '../../../packages/domain/home-library-view';

export type LibrarySpaceScope = { deviceId: string; epoch: string; windowId: string };
export type LibrarySpaceDraft = { id: string; name: string; expectedRevision: number };
type Journal = LibrarySpaceScope & { format: 1; draft: LibrarySpaceDraft };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const draft = (value: unknown): value is LibrarySpaceDraft => {
 const row = value as LibrarySpaceDraft | undefined;
 return !!row && typeof row === 'object' && Object.keys(row).every(key => ['id', 'name', 'expectedRevision'].includes(key)) &&
  typeof row.id === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(row.id) && typeof row.name === 'string' && row.name.length <= 100 &&
  Number.isSafeInteger(row.expectedRevision) && row.expectedRevision >= 0;
};

/** One authored-name owner; the existing Library controller still owns every command. */
export class LibrarySpaceDraftOwner {
 readonly key: string;
 value?: LibrarySpaceDraft;
 invalid = false;
 error = '';
 private raw: string | null = null;
 constructor(private storage: StoragePort, readonly scope: LibrarySpaceScope, private current: () => boolean) {
  this.key = `e3:library-space-draft:${scope.deviceId}:${scope.epoch}:${scope.windowId}`;
  try {
   this.raw = storage.getItem(this.key);
   if (this.raw === null || this.raw === 'null') return;
   const value = this.raw.length <= 2048 ? JSON.parse(this.raw) as Journal : undefined;
   if (!value || Object.keys(value).some(key => !['format', 'deviceId', 'epoch', 'windowId', 'draft'].includes(key)) ||
       value.format !== 1 || value.deviceId !== scope.deviceId || value.epoch !== scope.epoch || value.windowId !== scope.windowId || !draft(value.draft))
    throw Error('The kept Space name cannot be verified. Original writing is preserved; use another window for new writing.');
   this.value = value.draft;
  } catch (reason) { this.invalid = true;this.error = reason instanceof Error ? reason.message : 'Browser storage is unavailable. Original writing is preserved.'; }
 }
 private persist(value: LibrarySpaceDraft | undefined): boolean {
  if (!this.current()) return false;
  if (this.invalid) return false;
  try {
   if (value && !draft(value)) throw Error('Keep the complete Space name within 100 characters.');
   const next = value ? JSON.stringify({ format: 1, ...this.scope, draft: value }) : 'null';
   const actual = this.storage.getItem(this.key);
   // A prior successful write with failed readback can acknowledge only its exact desired bytes.
   if (actual !== next) {
    if (actual !== this.raw) throw Error('This Space draft changed in another window. Keep this window open to preserve your writing.');
    this.storage.setItem(this.key, next);
    if (this.storage.getItem(this.key) !== next) throw Error('The Space name could not be confirmed in browser storage. Keep this window open.');
   }
   this.raw = next;this.error = '';return true;
  } catch (reason) { this.error = reason instanceof Error ? reason.message : 'The Space name could not be kept. Keep this window open.';return false; }
 }
 open(value: LibrarySpaceDraft): boolean {
  if (!this.current() || this.invalid) return false;
  if (this.value) {
   if (this.value.id !== value.id) { this.error = 'A different unfinished Space name is kept. Resume or explicitly discard it before starting another.';return false; }
   return this.keep();
  }
  this.value = value;return this.keep();
 }
 edit(name: string): boolean {
  if (!this.current() || this.invalid || !this.value || name.length > 100) return false;
  this.value = { ...this.value, name };return this.keep();
 }
 keep(): boolean { return this.value ? this.persist(this.value) : !this.invalid; }
 discard(): boolean {
  if (!this.persist(undefined)) return false;
  this.value = undefined;return true;
 }
 reviewRevision(revision: number): boolean {
  if (!this.current() || !this.value || !Number.isSafeInteger(revision) || revision < 0) return false;
  this.value = { ...this.value, expectedRevision: revision };return this.keep();
 }
 acknowledge(command: HomeShelvesCommand, receipt: HomeShelvesReceipt): boolean {
  if (!this.current() || !this.value || command.type !== 'space-save' || command.epoch !== this.scope.epoch ||
      !isHomeShelvesReceipt(receipt) || receipt.type !== command.type || receipt.operationId !== command.requestId || receipt.epoch !== command.epoch ||
      command.id !== this.value.id) return false;
  const saved = receipt.shelves.spaces.find(space => space.id === command.id);
  if (!saved || saved.name !== command.name || receipt.shelves.revision !== command.expectedRevision + Number(receipt.changed)) return false;
  if (this.value.expectedRevision === receipt.shelves.revision && this.value.expectedRevision !== command.expectedRevision) return this.keep();
  if (command.expectedRevision !== this.value.expectedRevision) return false;
  const original = { id: command.id, name: command.name, expectedRevision: command.expectedRevision };
  if (exact(this.value, original)) return this.discard();
  this.value = { ...this.value, expectedRevision: receipt.shelves.revision };return this.keep();
 }
}
