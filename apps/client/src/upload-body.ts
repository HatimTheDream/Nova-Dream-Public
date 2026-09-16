import { request } from './api';

/** Keep each authenticated request below routing-provider body limits. The
 * final POST retains the original payload and its durable request identity. */
export async function uploadBody(path: string, blob: Blob, epoch: string, signal?: AbortSignal) {
  const transfer = await request<{ id: string; pieceBytes: number }>('transfers/start', { epoch, path: '/api/' + path, type: blob.type, bytes: blob.size }, signal, 30000);
  for (let index = 0, offset = 0; offset < blob.size; index++, offset += transfer.pieceBytes) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + transfer.pieceBytes).arrayBuffer());
    let text = ''; for (let p = 0; p < bytes.length; p += 16384) text += String.fromCharCode(...bytes.subarray(p, p + 16384));
    const piece = { epoch, id: transfer.id, index, base64: btoa(text) };
    const saved = await request<{ next: number }>('transfers/piece', piece, signal, 30000);
    if (saved.next !== index + 1) throw new Error('Retry the retained upload.');
  }
  return { 'X-Edition3-Transfer': transfer.id };
}
