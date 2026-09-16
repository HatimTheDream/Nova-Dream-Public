import { clientHeaders } from './api';
export type CompanionDownload = { platform: string; arch: string; version: string; name: string; bytes: number; sha256: string; chunks: string[]; signing: string };
const hash = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
export async function downloadCompanion(file: CompanionDownload, progress: (percent: number) => void, signal: AbortSignal) {
  const parts: ArrayBuffer[] = []; let size = 0;
  for (let part = 0; part < file.chunks.length; part++) {
    const response = await fetch(`/api/companions/download?name=${encodeURIComponent(file.name)}&part=${part}`, { credentials: 'same-origin', headers: clientHeaders(), cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
    if (!response.ok) throw new Error('Download interrupted. Reconnect and try again.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024 || await hash(bytes) !== file.chunks[part]) throw new Error('Download verification failed. No installer was saved.');
    size += bytes.byteLength; parts.push(bytes); progress(Math.round(size / file.bytes * 100));
  }
  if (size !== file.bytes) throw new Error('The download is incomplete.');
  const blob = new Blob(parts, { type: 'application/zip' });
  if (await hash(await blob.arrayBuffer()) !== file.sha256) throw new Error('The complete download did not match its checksum.');
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
