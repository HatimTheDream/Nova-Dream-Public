import type { HomeCollection, HomeItem, HomeReference } from './home-library.js';
import { exactHomeReference, isHomeReference, isSavedHomeCollection, isSavedHomeItem } from './home-library-view.js';

export const libraryPortableBytes = 16 * 1024 * 1024;
export const libraryCaptureBytes = 500_000;
export const libraryTextCharacters = 50_000;
type CollectionIdentity = Omit<HomeCollection, 'references'>;
export type LibraryPortableEntry = { position: number; reference: HomeReference } & (
 { status: 'portable'; item: HomeItem } |
 { status: 'reference-only'; reason: 'workspace-reference' } |
 { status: 'unavailable'; reason: 'saved-version-unavailable' }
);
export type LibraryPortable = {
 format: 'nova-library'; version: 1; exportedAt: string;
 source: { epoch: string; collection: CollectionIdentity; memberCount: number };
 selection: 'all' | 'selected'; entries: LibraryPortableEntry[];
};
export type LibraryExportQuery = { epoch: string; collection: string; revision: number; positions?: number[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const position = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 200;
export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
export class LibraryPortableError extends Error {
 constructor(public code: 'library_file_invalid' | 'library_file_large' | 'library_export_changed', message: string) { super(message); }
}
const invalid = () => new LibraryPortableError('library_file_invalid', 'Use a supported Nova Library file. The original file and saved writing are kept.');
const tooLarge = () => new LibraryPortableError('library_file_large', 'This file exceeds 16 MiB. Export fewer selected sources; nothing was truncated.');

export function readLibraryExportQuery(params: URLSearchParams): LibraryExportQuery {
 if (params.toString().length > 2400 || [...params.keys()].some(key => !['epoch', 'collection', 'revision', 'positions'].includes(key) || params.getAll(key).length !== 1)) throw invalid();
 const epoch = params.get('epoch'), collection = params.get('collection'), revision = params.get('revision'), selected = params.get('positions');
 if (!uuid(epoch) || !collection || collection.length > 200 || !/^[a-zA-Z0-9:_-]+$/.test(collection) ||
     !revision || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw invalid();
 let positions: number[] | undefined;
 if (selected !== null) {
  if (!/^(?:0|[1-9]\d{0,2})(?:,(?:0|[1-9]\d{0,2}))*$/.test(selected)) throw invalid();
  positions = selected.split(',').map(Number);
  if (!positions.length || positions.length > 200 || !positions.every(position) || new Set(positions).size !== positions.length) throw invalid();
  positions.sort((a, b) => a - b);
 }
 return { epoch, collection, revision: Number(revision), ...(positions ? { positions } : {}) };
}

export function isLibraryPortable(value: unknown): value is LibraryPortable {
 if (!object(value) || !keys(value, ['format', 'version', 'exportedAt', 'source', 'selection', 'entries']) ||
     value.format !== 'nova-library' || value.version !== 1 || !time(value.exportedAt) ||
     !object(value.source) || !keys(value.source, ['epoch', 'collection', 'memberCount']) || !uuid(value.source.epoch) ||
     !object(value.source.collection) || !keys(value.source.collection, ['id', 'revision', 'updatedAt', 'title', 'subtitle', 'icon', 'pinned', 'archived']) ||
     !Number.isSafeInteger(value.source.memberCount) || (value.source.memberCount as number) < 0 || (value.source.memberCount as number) > 200 ||
     !['all', 'selected'].includes(value.selection as string) || !Array.isArray(value.entries) || value.entries.length > 200) return false;
 const entries = value.entries;
 for (let index = 0; index < entries.length; index++) {
  const entry = entries[index];
  if (!object(entry) || !position(entry.position) || entry.position >= (value.source.memberCount as number) ||
      index > 0 && entry.position <= entries[index - 1].position || !isHomeReference(entry.reference)) return false;
  const portable = entry.reference.kind === 'note' || entry.reference.kind === 'link';
  if (entry.status === 'portable') {
   if (!keys(entry, ['position', 'reference', 'status', 'item']) || !portable || !isSavedHomeItem(entry.item) ||
       !exactHomeReference(entry.reference, { kind: entry.item.kind, id: entry.item.id, revision: entry.item.revision })) return false;
  } else if (entry.status === 'reference-only') {
   if (!keys(entry, ['position', 'reference', 'status', 'reason']) || portable || entry.reason !== 'workspace-reference') return false;
  } else if (entry.status === 'unavailable') {
   if (!keys(entry, ['position', 'reference', 'status', 'reason']) || !portable || entry.reason !== 'saved-version-unavailable') return false;
  } else return false;
 }
 if (!isSavedHomeCollection({ ...value.source.collection, references: entries.map(entry => entry.reference) }) ||
     value.selection === 'all' && (entries.length !== value.source.memberCount || entries.some((entry, index) => entry.position !== index)) ||
     value.selection === 'selected' && !entries.length) return false;
 return true;
}

/** Pure exact-version projection. The caller supplies only synchronous saved row reads. */
export function buildLibraryPortable(epoch: string, collection: HomeCollection, query: LibraryExportQuery, exportedAt: string, savedItem: (reference: HomeReference) => unknown): LibraryPortable {
 if (!uuid(epoch) || epoch !== query.epoch || !isSavedHomeCollection(collection) || collection.id !== query.collection || collection.revision !== query.revision) {
  throw new LibraryPortableError('library_export_changed', 'The exact collection or workspace changed. Review it before exporting.');
 }
 if (!time(exportedAt)) throw invalid();
 const positions = query.positions ?? collection.references.map((_, index) => index);
 if (query.positions && (!positions.length || positions.length > 200 || positions.some((n, i) => !position(n) || i > 0 && n <= positions[i - 1])) || positions.some(n => n >= collection.references.length)) throw invalid();
 const { references: _references, ...identity } = collection;
 const result: LibraryPortable = { format: 'nova-library', version: 1, exportedAt, source: { epoch, collection: identity, memberCount: collection.references.length }, selection: query.positions ? 'selected' : 'all', entries: [] };
 let bytes = utf8Bytes(JSON.stringify(result));
 for (const index of positions) {
  const reference = collection.references[index];
  let entry: LibraryPortableEntry;
  if (reference.kind !== 'note' && reference.kind !== 'link') entry = { position: index, reference, status: 'reference-only', reason: 'workspace-reference' };
  else {
   const item = savedItem(reference);
   entry = isSavedHomeItem(item) && exactHomeReference(reference, { kind: item.kind, id: item.id, revision: item.revision }) ?
    { position: index, reference, status: 'portable', item } : { position: index, reference, status: 'unavailable', reason: 'saved-version-unavailable' };
  }
  bytes += utf8Bytes(JSON.stringify(entry)) + (result.entries.length ? 1 : 0);
  if (bytes > libraryPortableBytes) throw tooLarge();
  result.entries.push(entry);
 }
 return result;
}

export function serializeLibraryPortable(value: unknown): string {
 if (!isLibraryPortable(value)) throw invalid();
 const text = JSON.stringify(value);
 if (utf8Bytes(text) > libraryPortableBytes) throw tooLarge();
 return text;
}
export function parseLibraryPortable(bytes: Uint8Array): LibraryPortable {
 if (bytes.byteLength > libraryPortableBytes) throw tooLarge();
 try {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isLibraryPortable(value)) throw invalid();
  return value;
 } catch (error) { if (error instanceof LibraryPortableError) throw error;throw invalid(); }
}
export function libraryPortableUrls(value: LibraryPortable): { text: string; included: number; excluded: number } {
 const urls = value.entries.filter((entry): entry is LibraryPortableEntry & { status: 'portable'; item: HomeItem & { kind: 'link' } } => entry.status === 'portable' && entry.item.kind === 'link');
 const text = urls.map(entry => entry.item.url).join('\n');
 if (text.length > libraryTextCharacters) throw new LibraryPortableError('library_file_large', 'The URL text exceeds 50,000 characters. Export fewer selected sources.');
 return { text, included: urls.length, excluded: value.entries.length - urls.length };
}
