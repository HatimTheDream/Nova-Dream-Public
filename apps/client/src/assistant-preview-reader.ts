export const previewByteLimit = 8 * 1024 * 1024;

function cancel(body: ReadableStream<Uint8Array> | null) {
  // A faulty source's cancellation promise must not hold the preview open.
  if (body) void body.cancel().catch(() => {});
}

/** Bound decoded bytes before copying; never use an unbounded arrayBuffer fallback. */
export async function readPreviewBytes(response: Response, expectedSize: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, completed = false;
  const aborted = () => { if (reader) void reader.cancel(signal.reason).catch(() => {}); };
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > previewByteLimit) throw Error('This file is too large or cannot be verified for preview. Download the original instead.');
    if (!response.ok) throw Error('This file could not be opened. Download or reopen it to try again.');
    const header = response.headers.get('content-length');
    if (header !== null) {
      if (!/^\d+$/.test(header)) throw Error('The saved file length could not be verified. Download the original instead.');
      const length = Number(header), encoded = response.headers.get('content-encoding');
      // Fetch returns decoded chunks; a proxy's compressed transfer length is a different measure.
      if (!Number.isSafeInteger(length) || length > previewByteLimit || (!encoded || encoded === 'identity') && length !== expectedSize) throw Error('The saved file length does not match this preview.');
    }
    reader = response.body?.getReader();
    if (!reader && expectedSize !== 0) throw Error('The saved file body is unavailable. Download the original instead.');
    const data = new Uint8Array(expectedSize);
    let offset = 0;
    signal.addEventListener('abort', aborted, { once: true });
    signal.throwIfAborted();
    if (reader) while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > expectedSize - offset) throw Error('The saved file exceeds its expected preview size.');
      data.set(next.value, offset); offset += next.value.byteLength;
    }
    if (offset !== expectedSize) throw Error('The saved file is incomplete. Download or reopen the original to try again.');
    completed = true;
    return data;
  } finally {
    signal.removeEventListener('abort', aborted);
    if (reader) {
      if (!completed) void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else cancel(response.body);
  }
}
