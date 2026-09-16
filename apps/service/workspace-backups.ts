import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir, open, statfs } from 'node:fs/promises';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { backupCommandSchema, restoreCommandSchema, backupMaxBytes, summarizeBackup, type BackupSummary, type BackupSnapshot } from '../../packages/domain/workspace-backup.js';
import { Fault, Store } from './store.js';
import { encryptBackup, decryptBackup } from './backup-crypto.js';
import type { NativeBackup } from './native-backup.js';
import { importReviewCommand, importRestoreCommand, type ImportReview, type ImportSource } from '../../packages/domain/workspace-import.js';
import { planWorkspaceImport } from './workspace-import.js';
import { canonical } from '../../packages/domain/contracts.js';
import { withRetainedNative } from './retained-native.js';

export type BackupJob = { id: string; kind: 'export' | 'inspect' | 'restore'; state: 'working' | 'ready' | 'failed' | 'removed'; createdAt: string; summary?: BackupSummary; message?: string; sha256?: string; bytes?: number };
type SavedJob = BackupJob & { deviceId: string; epoch: string; uploadId?: string; sourceHash?: string; restoreName?: string };
type SavedImport = { deviceId: string; epoch: string; review: ImportReview };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const publicJob = ({ deviceId: _device, epoch: _epoch, uploadId: _upload, sourceHash: _hash, restoreName: _restore, ...job }: SavedJob): BackupJob => job;
const idSchema = z.string().uuid();
/** One bounded private job at a time. Passwords are never journaled, and only
 * encrypted archives survive export. Restoration never replaces a workspace. */
export class WorkspaceBackups {
  private job?: Promise<void>;
  private closed = false;
  private uploading = false;
  private root: string;
  constructor(private store: Store, private version: string, private native?: NativeBackup, private captureHistories?: () => Promise<void>) {
    this.root = join(store.directory, 'workspace-backups');
    for (const record of store.internalList<SavedJob>('backup:job:')) if (record.state === 'working') {
      const marker = join(store.directory, 'recovered-workspaces', record.id, 'recovery-complete.json');
      if (record.kind === 'restore' && existsSync(marker) && lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink()) {
        try { const proof = JSON.parse(readFileSync(marker, 'utf8')); if (proof.jobId === record.id && proof.sourceHash === record.sourceHash && proof.summary?.id === record.summary?.id) { this.save({ ...record, state: 'ready', restoreName: record.id, summary: proof.summary, sourceHash: proof.sourceHash, message: 'The recovered copy was verified before the service restarted.' }); continue; } } catch { /* Keep unverified recovery data isolated. */ }
      }
      this.save({ ...record, state: 'failed', message: 'The service restarted during preparation. Start a new backup or review; existing saved work is unchanged.' });
    }
  }
  private async folders() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Fault(409, 'backup_directory', 'The private backup folder is unavailable.');
    for (const record of this.store.internalList<SavedJob>('backup:job:')) if (record.state === 'failed') {
      await rm(join(this.root, 'scratch-' + record.id), { recursive: true, force: true });
      await rm(join(this.root, record.id + '.novabackup.tmp'), { force: true });
      await rm(join(this.store.directory, 'recovered-workspaces', '.staging-' + record.id), { recursive: true, force: true });
    }
  }
  private async capacity() {
    await this.folders();
    let used = 0;
    for (const name of await readdir(this.root)) {
      if (!/^(?:upload-[a-f0-9-]{36}|[a-f0-9-]{36}\.novabackup)$/.test(name)) continue;
      const path = join(this.root, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Fault(409, 'backup_directory', 'A backup file has an unexpected identity.');
      if (name.startsWith('upload-') && Date.now() - info.mtimeMs > 24*3600000) { await rm(path); this.store.internalDelete('backup:upload:' + name.slice(7)); }
      else used += info.size;
    }
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < 1536*1024*1024) throw new Fault(507, 'backup_space', 'Free at least 1.5 GB on this computer before preparing a backup or recovery copy. Existing work is kept.');
    if (used > 768*1024*1024) throw new Fault(507, 'backup_cache_full', 'Download your prepared backups, then remove unneeded local copies to make room.');
  }
  private save(value: SavedJob) { return this.store.internalWrite('backup:job:' + value.id, value); }
  private read(device: string, id: string) {
    idSchema.parse(id); const value = this.store.internalRead<SavedJob>('backup:job:' + id);
    if (!value || value.deviceId !== device || value.epoch !== this.store.epoch) throw new Fault(404, 'backup_missing', 'This backup operation is unavailable in this browser.');
    return value;
  }
  list(device: string) { return this.store.internalList<SavedJob>('backup:job:').filter(j => j.deviceId === device && j.epoch === this.store.epoch).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,30).map(publicJob); }
  imports(device: string) {
    return [...this.store.internalList<SavedImport>('backup:import:').filter(r => r.deviceId === device && r.epoch === this.store.epoch).map(r => r.review), ...this.store.internalList<ImportReview>('migration:review:').map(r => ({ ...r, savedInWorkspace: true }))];
  }
  reviewImport(device: string, raw: unknown) {
    const input = importReviewCommand.parse(raw), plan = planWorkspaceImport(input.source, this.version);
    const review = { ...plan.review, id: input.requestId };
    const receipt = this.store.admit(device, input, { requestId: input.requestId, epoch: input.epoch, sourceHash: review.sourceHash, type: 'backup.import-review' }, () => {
      if (this.store.internalList('backup:import:').length >= 10) throw new Fault(409, 'import_reviews_full', 'Remove an earlier import review before adding another.');
      this.store.internalWrite('backup:import-source:' + input.requestId, input.source);
      this.store.internalWrite('backup:import:' + input.requestId, { deviceId: device, epoch: input.epoch, review } satisfies SavedImport);
      return review;
    });
    return receipt.value;
  }
  removeImport(device: string, raw: unknown) {
    const input = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), reviewId: z.string().uuid() }).strict().parse(raw);
    return this.store.admit(device, input, { ...input, type: 'backup.import-remove' }, () => {
      const saved = this.store.internalRead<SavedImport>('backup:import:' + input.reviewId);
      if (!saved || saved.deviceId !== device || saved.epoch !== this.store.epoch) throw new Fault(404, 'import_missing', 'This import review is unavailable.');
      if (this.job) throw new Fault(409, 'backup_busy', 'Wait for the current backup operation to finish.');
      this.store.internalDelete('backup:import:' + input.reviewId); this.store.internalDelete('backup:import-source:' + input.reviewId); return { removed: true };
    }).value;
  }
  importSource(device: string, id: string) {
    idSchema.parse(id);
    const saved = this.store.internalRead<SavedImport>('backup:import:' + id);
    if (saved?.deviceId === device && saved.epoch === this.store.epoch) { const source = this.store.internalRead<ImportSource>('backup:import-source:' + id); if (source) return source; }
    const source = this.store.internalRead<ImportSource>('migration:source:' + id);
    if (!source) throw new Fault(404, 'import_missing', 'The preserved source is unavailable in this workspace.');
    return source;
  }
  restoreImport(device: string, raw: unknown) {
    const input = importRestoreCommand.parse(raw);
    const saved = this.store.internalRead<SavedImport>('backup:import:' + input.reviewId);
    if (!saved || saved.deviceId !== device || saved.epoch !== this.store.epoch) throw new Fault(404, 'import_missing', 'Review this export again before importing it.');
    const plan = planWorkspaceImport(this.importSource(device, input.reviewId), this.version);
    if (plan.review.sourceHash !== input.sourceHash || plan.review.targetHash !== input.targetHash || saved.review.targetHash !== input.targetHash) throw new Fault(409, 'import_changed', 'The source or import rules changed. Review the export again.');
    const prior = this.store.internalRead('backup:job:' + input.requestId);
    if (!prior) this.available();
    const receipt = this.store.admit(device, input, { ...input, type: 'backup.import-restore' }, () => {
      if (saved.review.restoreId && saved.review.restoreId !== input.requestId) throw new Fault(409, 'import_already_restored', 'This review already has a separate workspace. Open its saved recovery copy.');
      this.store.internalWrite('backup:import:' + input.reviewId, { ...saved, review: { ...saved.review, restoreId: input.requestId } });
      return this.save({ id: input.requestId, deviceId: device, epoch: input.epoch, kind: 'restore', state: 'working', createdAt: new Date().toISOString(), sourceHash: input.sourceHash, summary: summarizeBackup(plan.snapshot) });
    });
    if (!receipt.fresh) return publicJob(this.read(device, input.requestId));
    return this.launch(receipt.value, () => this.writeRecovery(input.requestId, input.sourceHash, plan.snapshot));
  }
  private available() { if (this.closed) throw new Fault(503, 'backup_closed', 'The workspace is restarting.'); if (this.job || this.uploading) throw new Fault(409, 'backup_busy', 'Wait for the current backup operation to finish.'); }
  async whileIdle<T>(action: () => Promise<T>): Promise<T> {
    this.available();
    const work = Promise.resolve().then(action), settled = work.then(() => {}, () => {});
    this.job = settled;
    try { return await work; } finally { if (this.job === settled) this.job = undefined; }
  }
  private launch(record: SavedJob, action: () => Promise<Partial<SavedJob>>) {
    const work = (async () => {
      try { await this.capacity(); const result = await action(); this.save({ ...record, ...result, state: 'ready' }); }
      catch (error) { this.save({ ...record, state: 'failed', message: error instanceof Fault ? error.message : 'This operation could not be verified. Existing workspace data is unchanged.' }); }
    })();
    this.job = work; void work.finally(() => { if (this.job === work) this.job = undefined; });
    return publicJob(record);
  }
  create(device: string, raw: unknown) {
    const input = backupCommandSchema.parse(raw);
    const old = this.store.internalRead<SavedJob>('backup:job:' + input.requestId);
    if (!old) this.available();
    const receipt = this.store.admit(device, input, { ...input, passphrase: hash(input.passphrase), type: 'backup.export' }, () => this.save({ id: input.requestId, deviceId: device, epoch: input.epoch, kind: 'export', state: 'working', createdAt: new Date().toISOString() }));
    if (!receipt.fresh) return publicJob(this.read(device, input.requestId));
    return this.launch(receipt.value, async () => {
      const scratch = join(this.root, 'scratch-' + input.requestId); await mkdir(scratch, { mode: 0o700 });
      try {
        await this.captureHistories?.();
        const captured: BackupSnapshot['native'] = this.native && !this.store.recoveryEffectsPaused ? await this.native.capture(scratch) : { status: this.store.internalRead('gateway:configuration') ? 'separate-host' : 'not-configured', notes: ['History on a separately connected Assistant host must be backed up on that host.'] };
        const native = await withRetainedNative(this.store, captured);
        const snapshot = this.store.captureBackup(this.version, native), encrypted = await encryptBackup(snapshot, input.passphrase);
        // Reopen and verify the completed archive before offering a download.
        const checked = await decryptBackup(encrypted, input.passphrase);
        const final = join(this.root, input.requestId + '.novabackup'), temporary = final + '.tmp';
        const fd = await open(temporary, 'wx', 0o600); try { await fd.writeFile(encrypted); await fd.sync(); } finally { await fd.close(); }
        await rename(temporary, final);
        const durable = await readFile(final); if (hash(durable) !== hash(encrypted)) throw new Fault(503, 'backup_write', 'The saved archive did not verify.');
        return { summary: summarizeBackup(checked), sha256: hash(encrypted), bytes: encrypted.length };
      } finally { input.passphrase = ''; await rm(scratch, { recursive: true, force: true }); }
    });
  }
  async download(device: string, id: string) {
    const job = this.read(device, id);
    if (job.kind !== 'export' || job.state !== 'ready') throw new Fault(409, 'backup_not_ready', 'Wait for a verified backup before downloading.');
    const bytes = await readFile(join(this.root, id + '.novabackup'));
    if (bytes.length !== job.bytes || hash(bytes) !== job.sha256) throw new Fault(409, 'backup_changed', 'The saved archive changed. Create a new backup.');
    return { bytes, name: 'Nova-Dream-' + job.createdAt.slice(0,10) + '-' + id.slice(0,8) + '.novabackup' };
  }
  async upload(device: string, epoch: string, stream: AsyncIterable<Buffer>, reauthorize: () => void) {
    this.available(); if (epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Select your backup again.');
    this.uploading = true;
    try { await this.capacity(); } catch (error) { this.uploading = false; throw error; }
    const id = randomUUID(), path = join(this.root, 'upload-' + id); let fd;
    try { fd = await open(path, 'wx', 0o600); } catch (error) { this.uploading = false; throw error; }
    let size = 0; const digest = createHash('sha256');
    try {
      for await (const part of stream) { size += part.length; if (size > backupMaxBytes) throw new Fault(413, 'backup_large', 'Choose a backup smaller than 384 MB.'); digest.update(part); await fd.write(part); }
      if (!size) throw new Fault(400, 'backup_empty', 'Choose a backup file.');
      await fd.sync(); reauthorize();
      this.store.internalWrite('backup:upload:' + id, { deviceId: device, epoch, sha256: digest.digest('hex'), size, createdAt: Date.now() });
      return { uploadId: id, bytes: size };
    } catch (error) { await fd.close(); await rm(path, { force: true }); throw error; } finally { this.uploading = false; await fd.close(); }
  }
  private async uploaded(device: string, id: string) {
    const upload = this.store.internalRead<{ deviceId: string; epoch: string; sha256: string; size: number; createdAt: number }>('backup:upload:' + id);
    if (!upload || upload.deviceId !== device || upload.epoch !== this.store.epoch || Date.now() - upload.createdAt > 24*3600000) throw new Fault(404, 'backup_upload_missing', 'Select the backup again; its temporary upload is unavailable.');
    const path = join(this.root, 'upload-' + id), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== upload.size) throw new Fault(409, 'backup_upload_changed', 'The uploaded backup changed. Select it again.');
    const bytes = await readFile(path); if (hash(bytes) !== upload.sha256) throw new Fault(409, 'backup_upload_changed', 'The uploaded backup changed.');
    return { bytes, hash: upload.sha256 };
  }
  inspect(device: string, raw: unknown) {
    const input = restoreCommandSchema.parse(raw);
    if (!this.store.internalRead('backup:job:' + input.requestId)) this.available();
    const receipt = this.store.admit(device, input, { ...input, passphrase: hash(input.passphrase), type: 'backup.inspect' }, () => this.save({ id: input.requestId, deviceId: device, epoch: input.epoch, kind: 'inspect', uploadId: input.uploadId, state: 'working', createdAt: new Date().toISOString() }));
    if (!receipt.fresh) return publicJob(this.read(device, input.requestId));
    return this.launch(receipt.value, async () => { try { const file = await this.uploaded(device, input.uploadId), snapshot = await decryptBackup(file.bytes, input.passphrase); return { summary: summarizeBackup(snapshot), sourceHash: file.hash }; } finally { input.passphrase = ''; } });
  }
  restore(device: string, raw: unknown) {
    const input = restoreCommandSchema.extend({ reviewId: z.string().uuid() }).parse(raw), review = this.read(device, input.reviewId);
    if (review.kind !== 'inspect' || review.state !== 'ready' || review.uploadId !== input.uploadId) throw new Fault(409, 'backup_review_required', 'Review this backup before restoring it.');
    if (!this.store.internalRead('backup:job:' + input.requestId)) this.available();
    const receipt = this.store.admit(device, input, { ...input, passphrase: hash(input.passphrase), type: 'backup.restore' }, () => this.save({ id: input.requestId, deviceId: device, epoch: input.epoch, kind: 'restore', state: 'working', createdAt: new Date().toISOString(), uploadId: input.uploadId, sourceHash: review.sourceHash, summary: review.summary }));
    if (!receipt.fresh) return publicJob(this.read(device, input.requestId));
    return this.launch(receipt.value, async () => {
      try {
        const file = await this.uploaded(device, input.uploadId);
        if (file.hash !== review.sourceHash) throw new Fault(409, 'backup_review_changed', 'Review the changed backup again.');
        const snapshot = await decryptBackup(file.bytes, input.passphrase);
        return await this.writeRecovery(input.requestId, file.hash, snapshot);
      } finally { input.passphrase = ''; }
    });
  }
  private async writeRecovery(id: string, sourceHash: string, snapshot: BackupSnapshot): Promise<Partial<SavedJob>> {
    const parent = join(this.store.directory, 'recovered-workspaces'); await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Fault(409, 'recovery_directory', 'The private recovery folder has an unexpected identity.');
    const target = join(parent, id), scratch = join(parent, '.staging-' + id);
    try {
      const recovered = Store.restoreBackup(scratch, snapshot);
      try {
        const checked = recovered.captureBackup(snapshot.version, snapshot.native);
        const byId = <T extends { id: string }>(records: T[]) => [...records].sort((a,b)=>a.id.localeCompare(b.id));
        if (canonical(byId(checked.entities)) !== canonical(byId(snapshot.entities)) || canonical(byId(checked.files)) !== canonical(byId(snapshot.files)) || canonical(checked.history) !== canonical(snapshot.history)) throw new Fault(409, 'restore_verification', 'Recovered records or files do not match the archive.');
        for (const original of snapshot.services.filter(s => s.id.startsWith('migration:'))) if (canonical(recovered.internalRead(original.id)) !== canonical(original.value)) throw new Fault(409, 'import_verification', 'The preserved source did not match after reopening.');
      } finally { recovered.close(); }
      if (snapshot.native.status === 'included') {
        if (!this.native) throw new Fault(409, 'native_restore_required', 'Install the supported OpenClaw runtime to verify the included Assistant archive.');
        const archive = join(scratch, 'assistant.tar.gz'); await writeFile(archive, Buffer.from(snapshot.native.archive!, 'base64'), { flag: 'wx', mode: 0o600 });
        await this.native.restore(archive, join(scratch, 'assistant-recovery'));
      }
      for (const prior of snapshot.native.retained ?? []) {
        if (!this.native) throw new Fault(409, 'native_restore_required', 'Install the supported OpenClaw runtime to verify the earlier Assistant archives.');
        const archive = join(scratch, 'assistant-retained-' + prior.sha256 + '.tar.gz');
        await writeFile(archive, Buffer.from(prior.archive, 'base64'), { flag: 'wx', mode: 0o600 });
        await this.native.restore(archive, join(scratch, 'assistant-retained-' + prior.sha256));
      }
      const proof = await open(join(scratch, 'recovery-complete.json'), 'wx', 0o600);
      try { await proof.writeFile(JSON.stringify({ jobId: id, sourceHash, summary: summarizeBackup(snapshot) })); await proof.sync(); } finally { await proof.close(); }
      await rename(scratch, target);
      return { restoreName: id, summary: summarizeBackup(snapshot), message: 'Saved into a separate copy. Review it before activation; the current workspace is unchanged.' };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  recoveredDirectory(device: string, id: string) {
    const job = this.read(device, id); if (job.kind !== 'restore' || job.state !== 'ready' || job.restoreName !== id) throw new Fault(409, 'recovery_not_ready', 'Wait for a verified recovery copy.');
    return join(this.store.directory, 'recovered-workspaces', id);
  }
  async remove(device: string, raw: unknown) {
    const input = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), backupId: z.string().uuid() }).strict().parse(raw);
    const job = this.read(device, input.backupId);
    if (job.kind !== 'export' || job.state === 'working') throw new Fault(409, 'backup_busy', 'Only a finished local export copy can be removed here.');
    this.store.admit(device, input, { ...input, type: 'backup.remove' }, () => this.save({ ...job, state: 'removed', message: 'Local download copy removed. Files you downloaded elsewhere are unchanged.' }));
    await rm(join(this.root, job.id + '.novabackup'), { force: true }); return publicJob(this.read(device, job.id));
  }
  async close() { this.closed = true; await this.job; }
}
