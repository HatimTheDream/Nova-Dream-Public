import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Fault } from './store.js';

export const companionChunkBytes = 2 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.object({ platform: z.literal('darwin'), arch: z.literal('arm64'), version: z.string().regex(/^\d+\.\d+\.\d+$/), name: z.string().regex(/^Nova-Dream-Desktop-[a-zA-Z0-9.-]+\.zip$/), bytes: z.number().int().positive().max(300 * 1024 * 1024), sha256: digest, chunks: z.array(digest).min(1).max(150), signing: z.enum(['local-ad-hoc', 'developer-id-notarized']) }).strict();
const catalog = z.object({ format: z.literal(1), files: z.array(artifact).max(4) }).strict();
export class CompanionDownloads {
  constructor(private directory?: string) {}
  async list() {
    if (!this.directory) return [];
    const file = join(this.directory, 'downloads.json'), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) throw new Fault(503, 'download_catalog', 'Desktop downloads are temporarily unavailable.');
    const data = catalog.parse(JSON.parse(await readFile(file, 'utf8')));
    for (const item of data.files) if (item.chunks.length !== Math.ceil(item.bytes / companionChunkBytes)) throw new Fault(503, 'download_catalog', 'Desktop download metadata is incomplete.');
    return data.files;
  }
  async chunk(name: string, part: number) {
    const item = (await this.list()).find(file => file.name === name);
    if (!item || !Number.isInteger(part) || part < 0 || part >= item.chunks.length) throw new Fault(404, 'download_missing', 'This desktop download is unavailable.');
    const file = await open(join(this.directory!, item.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== item.bytes) throw new Error('Download bytes changed.');
      const bytes = Buffer.alloc(Math.min(companionChunkBytes, item.bytes - part * companionChunkBytes));
      const read = await file.read(bytes, 0, bytes.length, part * companionChunkBytes);
      if (read.bytesRead !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== item.chunks[part]) throw new Error('Download integrity check failed.');
      return bytes;
    } finally { await file.close(); }
  }
}
