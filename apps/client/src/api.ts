import type { Command, Entity, Snapshot } from '../../../packages/domain/contracts';
import { ConditionalReads } from './conditional-reads';
const conditionalReads = new ConditionalReads();
export const mayPoll = (path: string) => conditionalReads.mayPoll(path);

export class ApiError extends Error {
  constructor(public code: string, message: string, public current?: Entity<unknown>, public status?: number) { super(message); }
}
// Capture the identity of this document once. Never adopt the newer service's
// identity without loading its client code as well.
const candidate = typeof document === 'undefined' ? undefined : document.querySelector<HTMLMetaElement>('meta[name="e3-candidate"]')?.content;
export const clientHeaders = (): Record<string, string> => ({ 'X-Edition3-Client': '1', ...(candidate ? { 'X-Edition3-Candidate': candidate } : {}) });
export function apiFailure(result: { code?: string; message?: string; current?: Entity<unknown> }, status: number): ApiError {
  if (typeof window !== 'undefined') {
    if (result.code === 'phone_pair_required') window.dispatchEvent(new Event('e3:pair-required'));
    if (result.code === 'client_update') window.dispatchEvent(new Event('e3:update-required'));
  }
  return new ApiError(result.code ?? 'request_failed', result.message ?? 'This request could not be completed.', result.current, status);
}
export async function request<T>(url: string, data?: unknown, signal?: AbortSignal, timeoutMs = 12000): Promise<T> {
  if (url === 'session' && data !== undefined) conditionalReads.clear();
  const ticket = conditionalReads.begin(url);
  try {
    let payload = data === undefined ? undefined : JSON.stringify(data);
    let transferHeaders: Record<string, string> = {};
    if (payload && new Blob([payload]).size > 2 * 1024 * 1024) {
      const { uploadBody } = await import('./upload-body');
      transferHeaders = await uploadBody(url, new Blob([payload], { type: 'application/json' }), (data as { epoch: string }).epoch, signal);
      payload = undefined;
    }
    const response = await fetch(`/api/${url}`, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...clientHeaders(), ...transferHeaders, ...(data === undefined ? ticket.entry ? { 'If-None-Match': ticket.entry.tag } : {} : { 'Content-Type': 'application/json' }) }, body: payload, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (response.status === 304 && data === undefined) return conditionalReads.accept(url, ticket, response.headers.get('etag'), undefined) as T;
    const json = await response.text();
    if (!response.ok) {
      if ([401, 403].includes(response.status)) conditionalReads.clear();
      let result;
      try { result = JSON.parse(json); }
      catch { throw new ApiError(response.status === 413 ? 'upload_too_large' : 'host_unavailable', response.status === 413 ? 'Upload rejected: too large. Your file is kept.' : 'Open Nova’s address again and sign in to reconnect.', undefined, response.status); }
      if (result.code === 'client_update') conditionalReads.clear();
      throw apiFailure(result, response.status);
    }
    return (data === undefined ? conditionalReads.accept(url, ticket, response.headers.get('etag'), json) : JSON.parse(json)) as T;
  } catch (error) { conditionalReads.forget(url); throw error; }
}
export const fetchSnapshot = () => request<Snapshot>('snapshot');
export const commit = <T>(command: Command) => request<Entity<T>>('commands', command);
export const readLocal = <T>(key: string): T | undefined => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; } catch { return undefined; } };
export function saveLocal(key: string, value: unknown): boolean { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }

export type PendingFile = { draftId?: string; draftRemovalRevision?: number; id: string; epoch: string; deviceId: string; name: string; base64: string };
async function filesDb(): Promise<IDBDatabase> {
  return new Promise((accept, reject) => {
    const open = indexedDB.open('edition3-pending-files', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files', { keyPath: 'id' });
    open.onsuccess = () => accept(open.result); open.onerror = () => reject(open.error);
  });
}
export async function stagedFile(action: 'put' | 'delete' | 'list', value?: PendingFile | string): Promise<PendingFile[]> {
  const db = await filesDb();
  try {
    return await new Promise((accept, reject) => {
      const transaction = db.transaction('files', action === 'list' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('files');
      const operation = action === 'list' ? store.getAll() : action === 'put' ? store.put(value) : store.delete(value as string);
      transaction.oncomplete = () => accept(action === 'list' ? operation.result as PendingFile[] : []);
      transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
