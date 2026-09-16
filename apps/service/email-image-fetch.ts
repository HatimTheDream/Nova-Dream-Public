import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { emailImageUrl } from '../../packages/domain/email-images.js';
import { imagePreviewType } from './image-preview.js';
import { fitEmailImage, MAX_EMAIL_IMAGE_BYTES } from './email-image-resize.js';
export { MAX_EMAIL_IMAGE_BYTES } from './email-image-resize.js';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) denied.addSubnet(address, prefix, 'ipv4');
export const publicImageAddress = (address: string) => isIP(address) === 4 && !denied.check(address, 'ipv4');

/** GIFs need a bound across all frames, not just their logical canvas. */
export function emailImageType(bytes: Buffer): string | undefined {
  const type = imagePreviewType(bytes); if (type) return type;
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return;
  const bounded = (w: number, h: number) => w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= 16_777_216;
  if (!bounded(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) return;
  let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), pixels = 0, frames = 0;
  const blocks = () => { while (offset < bytes.length) { const size = bytes[offset++]; if (!size) return true; offset += size; } return false; };
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    if (tag === 0x3b) return frames ? 'image/gif' : undefined;
    if (tag === 0x21) { offset++; if (!blocks()) return; continue; }
    if (tag !== 0x2c || offset + 9 > bytes.length) return;
    const width = bytes.readUInt16LE(offset + 4), height = bytes.readUInt16LE(offset + 6);
    if (!bounded(width, height) || (pixels += width * height) > 16_777_216 || ++frames > 120) return;
    const flags = bytes[offset + 8]; offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return;
    offset++; if (!blocks()) return;
  }
}

/** Only public image GETs. DNS is checked and pinned again on every redirect. */
export async function fetchEmailImage(source: string, signal: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
  let current = source;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const valid = emailImageUrl(current); if (!valid) throw Error('Unsupported image address');
    const url = new URL(valid), resolver = new Resolver();
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    let addresses: { address: string }[];
    try { addresses = (isIP(url.hostname) ? [url.hostname] : await resolver.resolve4(url.hostname)).map(address => ({ address })); }
    finally { signal.removeEventListener('abort', cancel); }
    if (!addresses.length || addresses.some(item => !publicImageAddress(item.address))) throw Error('Private image address');
    signal.throwIfAborted();
    const result = await new Promise<{ bytes?: Buffer; location?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', agent: false, family: 4, signal,
        lookup: (_host, _options, done) => done(null, addresses[0].address, 4),
        headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity', 'User-Agent': 'NovaDream-Email-Images/1' },
      }, response => {
        if ([301,302,303,307,308].includes(response.statusCode ?? 0) && response.headers.location) {
          const location = response.headers.location; response.destroy(); resolve({ location }); return;
        }
        if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_EMAIL_IMAGE_BYTES || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy(); reject(Error('Image unavailable')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_EMAIL_IMAGE_BYTES) response.destroy(Error('Image too large')); else chunks.push(chunk); });
        response.on('error', reject); response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      });
      request.on('error', reject); request.end();
    });
    if (result.location) { current = new URL(result.location, url).href; continue; }
    let bytes = result.bytes!, mimeType = emailImageType(bytes);
    if (!mimeType) { bytes = await fitEmailImage(bytes, signal); mimeType = emailImageType(bytes); }
    if (!mimeType) throw Error('Unsupported image');
    return { bytes, mimeType };
  }
  throw Error('Too many image redirects');
}
