import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Fault } from './store.js';

const pieceBytes = 1024 * 1024, lifetime = 15 * 60 * 1000;
const beginSchema = z.object({ epoch: z.string().uuid(), path: z.string().regex(/^\/api\/[a-z0-9/-]+$/).max(160), type: z.enum(['application/json', 'application/octet-stream']), bytes: z.number().int().positive().max(384 * 1024 * 1024) }).strict();
const pieceSchema = z.object({ epoch: z.string().uuid(), id: z.string().uuid(), index: z.number().int().nonnegative(), base64: z.string().min(4).max(Math.ceil(pieceBytes / 3) * 4) }).strict();
type Transfer = z.infer<typeof beginSchema> & { owner: string; expires: number; hashes: string[]; received: number; busy: boolean };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Temporary encrypted transport pieces. No command runs until its original
 * route authenticates again and reads the complete body. Restarts discard the
 * in-memory key; retries keep the original application's request identity. */
export class UploadTransfers {
  private root: string;
  private key = randomBytes(32);
  private entries = new Map<string, Transfer>();
  private timer: ReturnType<typeof setInterval>;
  constructor(directory: string, private epoch: string, private now = Date.now) {
    this.root = mkdtempSync(join(directory, '.upload-pieces-'));
    this.timer = setInterval(() => { void this.expire().catch(() => undefined); }, 60000); this.timer.unref();
  }
  private async expire() { for (const [id, entry] of this.entries) if (!entry.busy && entry.expires <= this.now()) await this.remove(id); }
  async begin(owner: string, raw: unknown) {
    const input = beginSchema.parse(raw);
    if (input.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Retry the retained upload.');
    if (input.path.startsWith('/api/transfers/') || input.path === '/api/session' || input.path === '/api/pair' || input.type === 'application/octet-stream' && input.path !== '/api/storage/backups/upload' || input.type === 'application/json' && input.bytes > 64 * 1024 * 1024) throw new Fault(400, 'transfer_target', 'This operation does not accept this upload.');
    await this.expire();
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < input.bytes + 256 * 1024 * 1024) throw new Fault(507, 'transfer_space', 'Free space on the host before retrying this upload. Your file stays on this device.');
    if ([...this.entries.values()].filter(e => e.owner === owner).length >= 4 || [...this.entries.values()].reduce((sum, e) => sum + e.bytes, input.bytes) > 768 * 1024 * 1024) throw new Fault(429, 'transfer_busy', 'Wait for the current uploads to finish, then retry.');
    const id = randomUUID(); this.entries.set(id, { ...input, owner, expires: this.now() + lifetime, hashes: [], received: 0, busy: false });
    return { id, pieceBytes };
  }
  private owned(owner: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.expires <= this.now()) throw new Fault(409, 'transfer_expired', 'This upload expired. Retry the file kept on your device.');
    return entry;
  }
  async piece(owner: string, raw: unknown) {
    const input = pieceSchema.parse(raw), entry = this.owned(owner, input.id);
    if (input.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Retry the retained upload.');
    const bytes = Buffer.from(input.base64, 'base64'), digest = hash(bytes);
    if (bytes.toString('base64') !== input.base64 || bytes.length !== Math.min(pieceBytes, entry.bytes - input.index * pieceBytes)) throw new Fault(400, 'transfer_piece', 'The upload piece is incomplete. Retry the retained file.');
    if (entry.busy) throw new Fault(409, 'transfer_busy', 'This upload is already being processed.');
    if (input.index < entry.hashes.length) {
      if (entry.hashes[input.index] !== digest) throw new Fault(409, 'transfer_changed', 'An upload piece changed. Start the retained upload again.');
      return { next: entry.hashes.length };
    }
    if (input.index !== entry.hashes.length) throw new Fault(409, 'transfer_order', 'Upload the preceding piece first.');
    entry.busy = true;
    try {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from(input.id + ':' + input.index));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      await writeFile(join(this.root, input.id + '-' + input.index), Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
      entry.hashes.push(digest); entry.received += bytes.length; entry.expires = this.now() + lifetime;
      return { next: entry.hashes.length };
    } finally { entry.busy = false; }
  }
  read(owner: string, id: string, path: string, type: string) {
    const entry = this.owned(owner, id);
    if (entry.path !== path || entry.type !== type || entry.received !== entry.bytes || entry.busy) throw new Fault(409, 'transfer_incomplete', 'The original upload is incomplete or belongs to another operation.');
    entry.busy = true;
    const self = this;
    return { bytes: entry.bytes, stream: (async function* () {
      try {
        for (let i = 0; i < entry.hashes.length; i++) {
          const encrypted = await readFile(join(self.root, id + '-' + i)), decipher = createDecipheriv('aes-256-gcm', self.key, encrypted.subarray(0, 12));
          decipher.setAAD(Buffer.from(id + ':' + i)); decipher.setAuthTag(encrypted.subarray(12, 28));
          const plain = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
          if (hash(plain) !== entry.hashes[i]) throw new Fault(409, 'transfer_changed', 'The uploaded bytes did not verify. Retry the retained file.');
          yield plain;
        }
      } finally { entry.busy = false; await self.remove(id); }
    })(), discard: async () => { entry.busy = false; await self.remove(id); } };
  }
  private async remove(id: string) { const entry = this.entries.get(id); if (!entry) return; this.entries.delete(id); await Promise.all(entry.hashes.map((_, i) => rm(join(this.root, id + '-' + i), { force: true }))); }
  async close() { clearInterval(this.timer); this.entries.clear(); this.key.fill(0); await rm(this.root, { recursive: true, force: true }); }
}
