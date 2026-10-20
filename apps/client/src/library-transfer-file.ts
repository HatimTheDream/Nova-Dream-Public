import { apiFailure, clientHeaders } from './api';
import { isLibraryPortable, libraryPortableBytes, libraryTextCharacters, parseLibraryPortable, readLibraryExportQuery, serializeLibraryPortable, type LibraryPortable } from '../../../packages/domain/home-library-portable';
import type { LibraryExportQuery } from '../../../packages/domain/home-library-portable';

/** Count actual bytes, even when Content-Length is absent or dishonest. */
export async function readBoundedLibraryResponse(response: Response, limit = libraryPortableBytes): Promise<Uint8Array> {
 const reader = response.body?.getReader();if (!reader) throw Error('The Library file response is unavailable.');
 const chunks: Uint8Array[] = [];let size = 0;
 try {
  for (;;) {
   const next = await reader.read();if (next.done) break;
   size += next.value.byteLength;
   if (size > limit) { await reader.cancel();throw Error('The Library file exceeds the bounded download size. Nothing was imported.'); }
   chunks.push(next.value);
  }
 } finally { reader.releaseLock(); }
 const result = new Uint8Array(size);let offset = 0;
 for (const chunk of chunks) { result.set(chunk, offset);offset += chunk.byteLength; }
 return result;
}
export async function exportLibraryFile(query: LibraryExportQuery, signal: AbortSignal): Promise<LibraryPortable> {
 const params = new URLSearchParams({ epoch: query.epoch, collection: query.collection, revision: String(query.revision), ...(query.positions ? { positions: query.positions.join(',') } : {}) });
 const parsed = readLibraryExportQuery(params);
 const response = await fetch(`/api/home/library/export?${params}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
  headers: clientHeaders(), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
 const bytes = await readBoundedLibraryResponse(response, response.ok ? libraryPortableBytes : 16 * 1024);
 if (!response.ok) {
  let failure: unknown;try { failure = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw Error('The Library file could not be downloaded. Your original sources are kept.'); }
  if (!failure || typeof failure !== 'object') throw Error('The host refused this Library export.');
  throw apiFailure(failure, response.status);
 }
 const document = parseLibraryPortable(bytes), positions = parsed.positions;
 if (document.source.epoch !== parsed.epoch || document.source.collection.id !== parsed.collection || document.source.collection.revision !== parsed.revision ||
     document.selection !== (positions ? 'selected' : 'all') || positions && (document.entries.length !== positions.length || !document.entries.every((row, index) => row.position === positions[index])))
  throw Error('The exported file does not match the exact selected collection. Nothing was downloaded.');
 return document;
}
export async function readLibraryInput(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, format: 'nova-json' | 'url-text') {
 const limit = format === 'nova-json' ? libraryPortableBytes : libraryTextCharacters * 4;
 if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit || file.name.length > 255) throw Error('Choose a bounded Library JSON or URL text file. The original file is unchanged.');
 const bytes = new Uint8Array(await file.arrayBuffer());
 if (bytes.byteLength !== file.size || bytes.byteLength > limit) throw Error('The chosen file changed or exceeded its size bound. Choose the original file again.');
 const hash = await crypto.subtle.digest('SHA-256', bytes), sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
 if (format === 'nova-json') return { name: file.name, sha256, document: parseLibraryPortable(bytes) };
 const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
 if (text.length > libraryTextCharacters) throw Error('URL text is limited to 50,000 characters. No text was truncated.');
 return { name: file.name, sha256, text };
}
export function downloadLibraryFile(document: LibraryPortable, text?: string): void {
 if (!isLibraryPortable(document)) throw Error('Review the exact Library file before downloading.');
 const blob = new Blob([text ?? serializeLibraryPortable(document)], { type: text === undefined ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
 const url = URL.createObjectURL(blob);
 try {
  const link = window.document.createElement('a');link.href = url;link.download = text === undefined ? 'nova-library.json' : 'nova-library-urls.txt';
  window.document.body.appendChild(link);try { link.click(); } finally { link.remove(); }
 } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}

/** Adopt text into the original Paste Links writer before changing its visible value. */
export function keepImportedLibraryText(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, currentText: string, incoming: string, replace: boolean, current: () => boolean): boolean {
 if (!current() || incoming.length > libraryTextCharacters || currentText.length > libraryTextCharacters || currentText && currentText !== incoming && !replace) return false;
 try {
  const raw = storage.getItem(key), kept: unknown = raw === null ? null : JSON.parse(raw);
  if (!(kept === null || typeof kept === 'string' && kept.length <= libraryTextCharacters)) return false;
  const desired = JSON.stringify(incoming);
  // The exact desired bytes also acknowledge our own successful write whose
  // readback failed. A different current writer is never silently replaced.
  if (raw !== desired) {
   if ((kept ?? '') !== currentText || !current()) return false;
   storage.setItem(key, desired);
  }
  return current() && storage.getItem(key) === desired;
 } catch { return false; }
}
