import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, chmodSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import { workerReceiptSchema, workerObservationSchema, isSettledWorkerObservation, type WorkerReceipt, type WorkerStatus } from '../../../packages/domain/worker.js';

/** Native effect metadata plus encrypted, immutable terminal handoff records.
 * This owns no workspace entities and never modifies OpenClaw registry tables. */
export class WorkerJournal {
  private db: DatabaseSync;
  private key: Buffer;
  readonly hostId: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('The worker receipt directory must be absolute.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'receipts.sqlite');
    if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink())) throw new Error('The worker receipt directory must be owned local storage.');
    this.db = new DatabaseSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    const schema = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (schema > 2) { this.db.close(); throw new Error('The worker receipt journal requires a newer adapter.'); }
    if (schema === 0 && Number(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n)) { this.db.close(); throw new Error('Unrecognized worker journal. No data was replaced.'); }
    const keyPath = join(directory, 'outcomes.key');
    try {
      if (schema >= 2 && Number(this.db.prepare('SELECT count(*) AS n FROM outcomes').get()?.n) && !existsSync(keyPath)) throw new Error('The original worker outcome key is missing. No replacement was made.');
      if (existsSync(keyPath) && lstatSync(keyPath).isSymbolicLink()) throw new Error('The worker outcome key must use owned local storage.');
      if (!existsSync(keyPath)) {
        const file = openSync(keyPath, 'wx', 0o600);
        try { writeFileSync(file, randomBytes(32)); fsyncSync(file); } finally { closeSync(file); }
        if (process.platform !== 'win32') { const folder = openSync(directory, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); } }
      }
      this.key = readFileSync(keyPath); if (this.key.length !== 32) throw new Error('The original worker outcome key is invalid.');
    } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),host_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(attempt_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS receipts_run ON receipts(json_extract(payload,\'$.runId\')); CREATE TABLE IF NOT EXISTS outcomes(attempt_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,payload BLOB NOT NULL); PRAGMA user_version=2;');
    this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?)').run(randomUUID());
    this.hostId = z.string().uuid().parse(this.db.prepare('SELECT host_id FROM identity WHERE id=1').get()?.host_id);
    try {
      const existing = this.db.prepare('SELECT r.payload FROM receipts r JOIN outcomes o ON o.attempt_id=r.attempt_id LIMIT 1').get();
      if (existing) this.outcome(workerReceiptSchema.parse(JSON.parse(String(existing.payload))));
    } catch { this.db.close(); throw new Error('The original native outcome key did not verify. No result was replaced.'); }
  }
  lookup(id: string) { const row = this.db.prepare('SELECT payload FROM receipts WHERE attempt_id=?').get(id); return row ? workerReceiptSchema.parse(JSON.parse(String(row.payload))) : undefined; }
  lookupRun(runId: string) { const row = this.db.prepare("SELECT payload FROM receipts WHERE json_extract(payload,'$.runId')=?").get(runId); return row ? workerReceiptSchema.parse(JSON.parse(String(row.payload))) : undefined; }
  pending(epoch: string) { return this.db.prepare("SELECT r.payload FROM receipts r LEFT JOIN outcomes o ON o.attempt_id=r.attempt_id WHERE r.epoch=? AND o.attempt_id IS NULL AND json_extract(r.payload,'$.state')!='cancelled' LIMIT 100").all(epoch).map(row => workerReceiptSchema.parse(JSON.parse(String(row.payload)))); }
  hasCapacity() {
    const used = Number(this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM outcomes').get()?.n);
    const pending = Number(this.db.prepare("SELECT count(*) AS n FROM receipts r LEFT JOIN outcomes o ON o.attempt_id=r.attempt_id WHERE o.attempt_id IS NULL AND json_extract(r.payload,'$.state')!='cancelled'").get()?.n);
    // Reserve room for each admitted terminal envelope before another native effect.
    return used + (pending + 1) * 36 * 1024 * 1024 <= 256 * 1024 * 1024;
  }
  outcome(receipt: WorkerReceipt) {
    const row = this.db.prepare('SELECT payload FROM outcomes WHERE attempt_id=?').get(receipt.attemptId);
    if (!row) return undefined;
    const bytes = Buffer.from(row.payload as Uint8Array), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${receipt.epoch}:${receipt.hostId}:${receipt.attemptId}:${receipt.runId}`)); decipher.setAuthTag(bytes.subarray(12, 28));
    const value = workerObservationSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')));
    if (value.runId !== receipt.runId || !isSettledWorkerObservation(value)) throw new Error('The saved native outcome does not match its original receipt.');
    return value;
  }
  retainOutcome(receipt: WorkerReceipt, raw: NonNullable<WorkerStatus['observation']>) {
    const value = workerObservationSchema.parse(raw);
    if (value.runId !== receipt.runId || !isSettledWorkerObservation(value)) return undefined;
    const previous = this.outcome(receipt); if (previous) return previous;
    const text = Buffer.from(JSON.stringify(value));
    if (text.length > 36 * 1024 * 1024) throw new Error('The complete native outcome exceeds its reserved storage.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${receipt.epoch}:${receipt.hostId}:${receipt.attemptId}:${receipt.runId}`));
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]), payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    this.db.prepare('INSERT OR IGNORE INTO outcomes VALUES(?,?,?)').run(receipt.attemptId, payload.length, payload);
    return this.outcome(receipt);
  }
  registerIfAbsent(id: string, value: WorkerReceipt) {
    const receipt = workerReceiptSchema.parse(value);
    if (id !== receipt.attemptId || receipt.hostId !== this.hostId) throw new Error('The receipt identity does not match this worker host.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.lookup(id)) { this.db.exec('COMMIT'); return false; }
      if (receipt.state !== 'cancelled' && !this.hasCapacity()) throw new Error('The native outcome journal is full. Existing results and stop controls remain available.');
      if (Number(this.db.prepare('SELECT count(*) AS n FROM receipts').get()?.n) >= 10000) throw new Error('The worker receipt journal is full. Existing execution records are kept.');
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id, receipt.epoch, JSON.stringify(receipt));
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  register(id: string, value: WorkerReceipt) {
    const receipt = workerReceiptSchema.parse(value);
    if (id !== receipt.attemptId || receipt.hostId !== this.hostId) throw new Error('The receipt identity does not match this worker host.');
    const changed = this.db.prepare('UPDATE receipts SET payload=? WHERE attempt_id=? AND epoch=?').run(JSON.stringify(receipt), id, receipt.epoch).changes;
    if (changed !== 1) throw new Error('The original worker receipt is unavailable. No replacement was created.');
  }
  close() { this.db.close(); }
}
