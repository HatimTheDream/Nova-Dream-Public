import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imagePreviewType } from './image-preview.js';

export const MAX_EMAIL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_EMAIL_SOURCE_PIXELS = 64 * 1024 * 1024;
export const EMAIL_IMAGE_EDGE = 2048;
let queue = Promise.resolve(), pending = 0;

/** Large still images are decoded only in one disposable, time-bounded process. */
export async function fitEmailImage(bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (bytes.length > MAX_EMAIL_IMAGE_BYTES) throw Error('Image too large');
  if (imagePreviewType(bytes)) return bytes;
  if (!imagePreviewType(bytes, MAX_EMAIL_SOURCE_PIXELS)) throw Error('Unsupported image');
  if (pending >= 16) throw Error('Image preparation busy');
  pending++;
  const job = queue.then(() => {
    signal.throwIfAborted();
    return new Promise<Buffer>((resolve, reject) => {
      const source = import.meta.url.endsWith('.ts');
      const worker = new URL(`./email-image-resize-worker.${source ? 'ts' : 'js'}`, import.meta.url);
      const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), fileURLToPath(worker)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
      const chunks: Buffer[] = []; let size = 0, failure: Error | undefined;
      const stop = (reason: string) => { failure ??= Error(reason); child.kill('SIGKILL'); };
      const aborted = () => stop('Image preparation cancelled');
      const timer = setTimeout(() => stop('Image preparation timed out'), 8000);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      child.on('error', () => { failure ??= Error('Image preparation unavailable'); });
      child.stdin.on('error', () => { failure ??= Error('Image preparation interrupted'); });
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_EMAIL_IMAGE_BYTES) stop('Prepared image too large'); else chunks.push(chunk);
      });
      // Release the serialized slot only after the exact child has exited.
      child.once('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', aborted);
        const output = Buffer.concat(chunks);
        if (failure || code !== 0 || !imagePreviewType(output)) reject(failure ?? Error('Image preparation failed'));
        else resolve(output);
      });
      child.stdin.end(bytes);
    });
  });
  queue = job.then(() => undefined, () => undefined);
  try { return await job; } finally { pending--; }
}
