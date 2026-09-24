import { verifyImportedProgress } from './workspace-import-progress.js';
import { importedProgressSchema } from '../../packages/domain/profile-progression.js';
import { buildProfileProgress, progressHistory, questCommandSchema, type PersonalQuest } from '../../packages/domain/profile-progression.js';
import { backupFormat, backupSnapshotSchema, backupPlainMaxBytes, type BackupSnapshot } from '../../packages/domain/workspace-backup.js';
import { hubLayoutKey, reconcileHubLayout, type HubLayout } from '../../packages/domain/hub-layout.js';
import { assistantSpace, spaceDraftId, type AssistantSpace } from '../../packages/domain/assistant-space.js';
import { contactEmails, contactMergeSchema, contactRestoreSchema, mergedContactValue } from '../../packages/domain/contacts.js';
import { imagePreviewType } from './image-preview.js';
import { syncTaskSubtasks } from '../../packages/domain/task-subtasks.js';
import { invalidTaskParents } from '../../packages/domain/task-family.js';
import { inTaskDestination } from '../../packages/domain/task-presentation.js';
import { reminderActionSchema, reminderDeliverySchema, reminderInstant, reminderWindowMs, type NotificationAttempt, type Reminder } from '../../packages/domain/reminders.js';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync, openSync, closeSync, fsyncSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { attachmentSchema, canonical, commandSchema, defaultLayout, draftSchema, layoutSchema, projectSchema, taskSchema, type Attachment, type Command, type Draft, type Entity, type Kind, type Snapshot, type Values, type Project, type Task, type Layout } from '../../packages/domain/contracts.js';

import { dailyOrderSchema, inTaskView, dayInZone, focusElapsed, focusLeaseMs, focusSchema, nextDay, routineSchema, scheduled, taskHistorySchema, type DailyOrder, type Focus, type Occurrence, type Routine, type RoutineEvent, type TaskEvent, type TaskState } from '../../packages/domain/tasks.js';
import { blankRecord, contentFromAssignmentSchema, contentFromOutputSchema, contentSchema, isRecordKind, recordHistorySchema, recordSchemas, recordTaskSchema, type Assignment, type Content, type RecordKind, type RecordValue } from '../../packages/domain/workspace-records.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import type { AssistantOutput } from '../../packages/domain/assistant.js';
import { contactSchema, type Contact } from '../../packages/domain/workspace-records.js';
import { contactEmailKey, mailContactLinkSchema, mailContactSourceKey, type MailContactReview } from '../../packages/domain/mail-contact.js';
import { draftOrganizationCommandSchema, projectOrganizationCommandSchema, removeDraftSchema, type DraftRemoval, type DraftOrganization, type ProjectOrganization } from '../../packages/domain/contracts.js';

export class Fault extends Error {
  constructor(public status: number, public code: string, message: string, public current?: unknown) { super(message); }
}
type Row = { id: string; revision: number; updated_at: string; device_id: string; payload: Uint8Array };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const schemas = { layout: layoutSchema, task: taskSchema, draft: draftSchema, project: projectSchema, routine: routineSchema, ...recordSchemas };

/** Single-owner local preview. No predecessor credentials or databases are opened. */
export class Store {
  private db: DatabaseSync;
  private key: Buffer;
  private updateHold = false;
  private updateEffects = new Map<string, number>();
  readonly directory: string;
  constructor(directory: string, private now: () => number = Date.now, protectedKey?: Buffer, private reviewOnly = false) {
    this.directory = directory;
    const identityPath = join(directory, 'edition3.identity');
    const identity = 'private.novadream.edition3.preview\n';
    if (existsSync(directory) && readdirSync(directory).length && (!existsSync(identityPath) || readFileSync(identityPath, 'utf8') !== identity)) throw new Error('This directory is not an Nova Dream workspace. Choose a new empty directory.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(identityPath)) writeFileSync(identityPath, identity, { mode: 0o600, flag: 'wx' });
    mkdirSync(join(directory, 'blobs'), { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'preview.key');
    if (!protectedKey && !existsSync(keyPath)) {
      if (existsSync(join(directory, 'workspace.sqlite'))) throw new Error('Existing workspace key is missing. Restore the original key; no data was replaced.');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.key = protectedKey ? Buffer.from(protectedKey) : readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid workspace key. No data was replaced.');
    this.db = new DatabaseSync(join(directory, 'workspace.sqlite'));
    const schema = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (schema > 55) { this.db.close(); throw new Error('This workspace needs a newer Nova Dream build.'); }
    // Authenticate an existing workspace before any schema or journal-mode write.
    try {
      if (schema > 0) {
        const check = this.db.prepare("SELECT value FROM meta WHERE key='key-check'").get() as { value: string } | undefined;
        if (!check || this.open('key-check', Buffer.from(check.value, 'base64')) !== 'edition3') throw new Error('Workspace key did not verify.');
      } else if ((this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count) throw new Error('Unrecognized workspace schema. No data was replaced.');
    } catch (error) { this.db.close(); throw error; }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, device_id TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS history (cursor INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, device_id TEXT NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS service_records (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bytes INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS blob_refs (entity_id TEXT NOT NULL REFERENCES entities(id), blob_id TEXT NOT NULL REFERENCES blobs(id), PRIMARY KEY(entity_id,blob_id));
      PRAGMA user_version=55;`);
    try {
      if (!this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get()) this.transaction(() => {
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('epoch', randomUUID());
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('key-check', this.seal('key-check', 'edition3').toString('base64'));
        this.write('layout', 'layout', 'service', defaultLayout, 1);
      });
      const check = this.db.prepare("SELECT value FROM meta WHERE key='key-check'").get() as { value: string };
      if (this.open('key-check', Buffer.from(check.value, 'base64')) !== 'edition3') throw new Error('Workspace key did not verify.');
    } catch (error) { this.db.close(); throw error; }
    if (!this.recoveryHeld) this.transaction(() => this.syncHubLayout());
    // A restarted host keeps confirmed focus time, never the time it was offline.
    if (!this.recoveryHeld) for (const focus of this.internalList<Focus>('tasks:focus:')) if (focus.running) this.internalWrite(`tasks:focus:${focus.taskId}`, { ...focus, running: false, revision: focus.revision + 1 });
  }
  syncHubLayout() {
    const previous = this.internalRead<HubLayout>(hubLayoutKey);
    const next = reconcileHubLayout(previous, this.listEntities('agent').map(a => ({ id: a.id, archived: a.value.archived, name: a.value.name })), () => `room:${randomUUID()}`);
    if (next !== previous) this.internalWrite(hubLayoutKey, next);
    return next;
  }
  get epoch(): string { return (this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get() as { value: string }).value; }
  close() { this.db.close(); }
  private seal(aad: string, value: unknown): Buffer {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  private open(aad: string, data: Uint8Array): any {
    const bytes = Buffer.from(data); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private entity<T>(row: Row): Entity<T> {
    return { id: row.id, revision: row.revision, updatedAt: row.updated_at, deviceId: row.device_id, value: this.open(`entity:${row.id}`, row.payload) };
  }
  private get<K extends Kind>(kind: K, id: string): Entity<Values[K]> | undefined {
    const row = this.db.prepare('SELECT * FROM entities WHERE id=? AND kind=?').get(id, kind) as Row | undefined;
    return row ? this.entity(row) : undefined;
  }
  private list<K extends Kind>(kind: K): Entity<Values[K]>[] {
    return (this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY updated_at DESC,id').all(kind) as Row[]).map(row => this.entity(row));
  }
  private write<K extends Kind>(kind: K, id: string, device: string, value: Values[K], revision: number): Entity<Values[K]> {
    const priorCursor = this.entityCursor;
    const updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,payload=excluded.payload').run(id, kind, revision, device, updatedAt, this.seal(`entity:${id}`, value));
    const result = { id, revision, updatedAt, deviceId: device, value };
    this.db.prepare('INSERT INTO history (entity_id,revision,payload) VALUES (?,?,?)').run(id, revision, this.seal(`history:${id}:${revision}`, result));
    if (kind === 'contact') {
      this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(id);
      const photo = (value as Contact).photo;
      if (photo) this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id, photo.id);
    }
    this.advanceCursor(priorCursor);
    return result;
  }
  session(token?: string): { deviceId: string; token?: string } {
    if (token) {
      const row = this.db.prepare('SELECT device_id FROM sessions WHERE digest=? AND expires>?').get(hash(token), Date.now()) as { device_id: string } | undefined;
      if (row) return { deviceId: row.device_id };
    }
    const next = randomBytes(32).toString('base64url'); const deviceId = randomUUID();
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(next), deviceId, Date.now() + 30 * 86400000);
    return { deviceId, token: next };
  }
  authenticate(token: string): string {
    const row = this.db.prepare('SELECT device_id FROM sessions WHERE digest=? AND expires>?').get(hash(token), Date.now()) as { device_id: string } | undefined;
    if (!row) throw new Fault(401, 'session_expired', 'Reconnect this browser to continue. Your local draft is kept.');
    return row.device_id;
  }
  matchesKey(candidate: Buffer) { return candidate.length === this.key.length && timingSafeEqual(candidate, this.key); }
  get updateMaintenanceHeld() { return this.updateHold; }
  setUpdateMaintenanceHeld(held: boolean) { this.updateHold = held; }
  assertUpdateAdmission() { if (this.updateHold) throw new Fault(409, 'update_maintenance', 'An update is preparing. Existing work is kept; finish or cancel it before updating.'); }
  updateEffectsInFlight() { return Object.fromEntries(this.updateEffects); }
  async trackUpdateEffect<T>(kind: string, run: () => Promise<T>, settling = false): Promise<T> {
    if (!settling) this.assertUpdateAdmission();
    this.updateEffects.set(kind, (this.updateEffects.get(kind) ?? 0) + 1);
    try { return await run(); }
    finally { const count = (this.updateEffects.get(kind) ?? 1) - 1; if (count) this.updateEffects.set(kind, count); else this.updateEffects.delete(kind); }
  }
  get recoveryHeld() { return this.reviewOnly || this.internalRead<{ held: boolean }>('recovery:state')?.held === true; }
  get recoveryEffectsPaused() { const state = this.internalRead<{ held: boolean; effectsPaused?: boolean }>('recovery:state'); return this.reviewOnly || state?.held === true || state?.effectsPaused === true; }
  activateRecoveredLocal() {
    const state = this.internalRead<{ held: boolean; backupId: string }>('recovery:state');
    if (!state) throw new Fault(409, 'recovery_missing', 'This directory is not a recovered workspace.');
    if (!this.recoveryHeld) return;
    this.internalWrite('recovery:state', { ...state, held: false, effectsPaused: true, activatedAt: new Date().toISOString() });
  }
  /** Called within the reviewed recovery transition's transaction. */
  pauseRecoveredRoutines(device: string) {
    for (const routine of this.list('routine')) if (routine.value.state === 'active') this.write('routine', routine.id, device, { ...routine.value, state: 'paused' }, routine.revision + 1);
  }
  /** Capture committed rows and their immutable files in one synchronous SQLite
   * transaction. No live database files, key wrappers or SQL enter the archive. */
  captureBackup(version: string, native: BackupSnapshot['native']): BackupSnapshot {
    return this.transaction(() => {
      const entities = (this.db.prepare('SELECT * FROM entities ORDER BY id').all() as (Row & { kind: BackupSnapshot['entities'][number]['kind'] })[]).map(row => ({ ...this.entity(row), kind: row.kind }));
      const history = (this.db.prepare('SELECT * FROM history ORDER BY cursor').all() as { cursor: number; entity_id: string; revision: number; payload: Uint8Array }[]).map(row => ({ cursor: row.cursor, entityId: row.entity_id, revision: row.revision, value: this.open(`history:${row.entity_id}:${row.revision}`, row.payload) }));
      const receipts = (this.db.prepare('SELECT * FROM receipts ORDER BY request_id').all() as { request_id: string; digest: string; device_id: string; payload: Uint8Array }[]).map(row => ({ requestId: row.request_id, digest: row.digest, deviceId: row.device_id, value: this.open(`receipt:${row.request_id}`, row.payload) }));
      const services = (this.db.prepare('SELECT * FROM service_records ORDER BY id').all() as { id: string; revision: number; payload: Uint8Array }[]).filter(row => !row.id.startsWith('backup:')).map(row => ({ id: row.id, revision: row.revision, value: this.open(`service:${row.id}`, row.payload) }));
      const files = (this.db.prepare('SELECT id,device_id FROM blobs ORDER BY id').all() as { id: string; device_id: string }[]).map(row => { const file = this.download(row.id); return { ...file.metadata, deviceId: row.device_id, base64: file.bytes.toString('base64') }; });
      const references = (this.db.prepare('SELECT entity_id,blob_id FROM blob_refs ORDER BY entity_id,blob_id').all() as { entity_id: string; blob_id: string }[]).map(row => ({ entityId: row.entity_id, fileId: row.blob_id }));
      const value: BackupSnapshot = { format: backupFormat, schema: 55, version, id: randomUUID(), createdAt: new Date().toISOString(), epoch: this.epoch, cursor: this.entityCursor, entities, history, receipts, services, files, references, native };
      Store.verifyBackup(value); return value;
    });
  }
  static verifyBackup(input: unknown): BackupSnapshot {
    const value = backupSnapshotSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(value)) > backupPlainMaxBytes) throw new Fault(413, 'backup_large', 'This workspace exceeds the backup size limit. Nothing was changed.');
    const unique = (items: string[]) => { if (new Set(items).size !== items.length) throw new Fault(400, 'backup_duplicate', 'The backup contains duplicate identities.'); };
    unique(value.entities.map(e => e.id)); unique(value.history.map(h => String(h.cursor))); unique(value.services.map(s => s.id)); unique(value.receipts.map(r => r.requestId)); unique(value.files.map(f => f.id)); unique(value.references.map(r => r.entityId + '\0' + r.fileId));
    try { verifyImportedProgress(value.services); } catch { throw new Fault(400, 'backup_progress', 'The earlier XP balance does not match its preserved source. Nothing was restored.'); }
    const ids = new Set(value.entities.map(e => e.id)), files = new Set(value.files.map(f => f.id));
    if (value.services.some(record => record.id.startsWith('backup:'))) throw new Fault(400, 'backup_transient_state', 'Temporary backup jobs are not portable workspace records.');
    if (value.history.some(entry => entry.cursor > value.cursor)) throw new Fault(400, 'backup_cursor', 'The backup history exceeds its saved workspace cursor.');
    if (value.entities.filter(e => e.kind === 'layout' && e.id === 'layout').length !== 1) throw new Fault(400, 'backup_layout', 'The backup is missing its workspace layout.');
    for (const entity of value.entities) {
      if (entity.kind === 'layout' ? entity.id !== 'layout' : !entity.id.startsWith(entity.kind + ':')) throw new Fault(400, 'backup_identity', 'A saved record has an incompatible identity. Nothing was restored.');
      schemas[entity.kind].parse(entity.value);
    }
    if (invalidTaskParents(value.entities.filter(entity => entity.kind === 'task') as Entity<Task>[]).size) throw new Fault(400, 'backup_task_parent', 'A task parent is missing, cyclic or in Trash while its child is active. Nothing was restored.');
    for (const reference of value.references) if (!ids.has(reference.entityId) || !files.has(reference.fileId)) throw new Fault(400, 'backup_reference', 'The backup has a missing record or file reference.');
    for (const file of value.files) { const bytes = Buffer.from(file.base64, 'base64'); if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Fault(400, 'backup_file', 'A backup attachment did not pass its integrity check.'); }
    if (value.native.status === 'included') { const bytes = Buffer.from(value.native.archive ?? '', 'base64'); if (!bytes.length || bytes.length !== value.native.bytes || hash(bytes) !== value.native.sha256) throw new Fault(400, 'backup_native', 'The Assistant archive did not pass its integrity check.'); }
    else if (value.native.archive || value.native.sha256 || value.native.bytes) throw new Fault(400, 'backup_native', 'The Assistant coverage does not match the archive.');
    unique((value.native.retained ?? []).map(archive => archive.sha256));
    for (const archive of value.native.retained ?? []) { const bytes = Buffer.from(archive.archive, 'base64'); if (!bytes.length || bytes.length !== archive.bytes || hash(bytes) !== archive.sha256 || archive.sha256 === value.native.sha256) throw new Fault(400, 'backup_native', 'An earlier Assistant archive did not pass its integrity check.'); }
    return value;
  }
  /** Import data only into a new directory and encrypt it with a fresh key.
   * Retained receipts keep their old epoch. Restored authority never replays them. */
  static restoreBackup(directory: string, input: unknown): Store {
    const value = Store.verifyBackup(input);
    if (existsSync(directory)) throw new Fault(409, 'restore_exists', 'Choose a fresh recovery copy. Existing work was not replaced.');
    const restored = new Store(directory);
    try {
      restored.transaction(() => {
        restored.db.exec('DELETE FROM blob_refs; DELETE FROM entities; DELETE FROM history; DELETE FROM service_records; DELETE FROM receipts; DELETE FROM sessions; DELETE FROM blobs;');
        for (const e of value.entities) restored.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(e.id, e.kind, e.revision, e.deviceId, e.updatedAt, restored.seal(`entity:${e.id}`, e.value));
        for (const h of value.history) restored.db.prepare('INSERT INTO history (cursor,entity_id,revision,payload) VALUES (?,?,?,?)').run(h.cursor, h.entityId, h.revision, restored.seal(`history:${h.entityId}:${h.revision}`, h.value));
        for (const r of value.receipts) restored.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(r.requestId, r.digest, r.deviceId, restored.seal(`receipt:${r.requestId}`, r.value));
        for (const s of value.services) restored.db.prepare('INSERT INTO service_records VALUES (?,?,?)').run(s.id, s.revision, restored.seal(`service:${s.id}`, s.value));
        for (const f of value.files) {
          const metadata = attachmentSchema.parse({ id: f.id, name: f.name, size: f.size, sha256: f.sha256 }), bytes = restored.seal(`blob:${f.id}`, f.base64);
          const fd = openSync(join(directory, 'blobs', f.id), 'wx', 0o600);
          try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
          restored.db.prepare('INSERT INTO blobs VALUES (?,?,?,?)').run(f.id, f.deviceId, bytes.length, restored.seal(`blob-meta:${f.id}`, metadata));
        }
        for (const r of value.references) restored.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(r.entityId, r.fileId);
        restored.db.prepare("INSERT INTO meta VALUES ('workspace-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value.cursor));
        restored.internalWrite('recovery:state', { held: true, backupId: value.id, sourceEpoch: value.epoch, recoveredAt: new Date().toISOString(), native: value.native.status, nativeHash: value.native.sha256, nativeBytes: value.native.bytes });
        restored.internalWrite('recovery:retained-archives', (value.native.retained ?? []).map(({ archive: _archive, ...metadata }) => metadata));
        restored.internalDelete('http:session-cookie');
        restored.internalWrite('phone:access', { enabled: false });
      });
      for (const file of value.files) restored.download(file.id);
      return restored;
    } catch (error) { restored.close(); throw error; }
  }
  snapshot(deviceId: string): Snapshot {
    // One transaction gives a consistent cursor and all projections.
    return this.transaction(() => { if (!this.recoveryEffectsPaused && !this.updateMaintenanceHeld) { this.materializeRoutines(); this.sweepReminders(); } return { epoch: this.epoch, cursor: this.entityCursor, deviceId,
      layout: this.get('layout', 'layout')!, tasks: this.list('task').filter(t => !t.value.trashed), trashedTasks: this.list('task').filter(t => t.value.trashed), routines: this.list('routine'), calendarCompletions: this.internalList<import('../../packages/domain/calendar-completion.js').CalendarCompletion>('tasks:calendar-completion:'), taskState: this.taskState(), drafts: this.list('draft'), draftOrganization: this.internalList<DraftOrganization>('assistant:draft-organization:'), draftRemovals: this.internalList<DraftRemoval>('assistant:draft-removed:'), projects: this.list('project'),
      projectOrganization: this.internalList<ProjectOrganization>('assistant:project-organization:'),
      records: { contact: this.list('contact'), content: this.list('content'), agent: this.list('agent'), assignment: this.list('assignment'), profile: this.list('profile') },
      capabilities: { assistant: false, voice: false, reason: 'A verified Assistant and speech connection has not been configured for this workspace.' } }; });
  }
  private replay(requestId: string, digest: string, device: string): unknown | undefined {
    const existing = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId) as { digest: string; device_id: string; payload: Uint8Array } | undefined;
    if (!existing) return undefined;
    if (existing.digest !== digest || existing.device_id !== device) throw new Fault(409, 'request_reused', 'This request identity was already used for different work.');
    const value = this.open(`receipt:${requestId}`, existing.payload);
    if (value?.removedWork) throw new Fault(409, `${value.removedWork}_removed`, 'This saved work was removed. Its old request cannot restore it.');
    return value;
  }
  projectIsDeleted(projectId: string): boolean {
    return this.internalRead<ProjectOrganization>(`assistant:project-organization:${projectId}`)?.deleted === true;
  }
  organizeProject(device: string, raw: unknown): ProjectOrganization {
    const input = projectOrganizationCommandSchema.parse(raw);
    return this.admit(device, input, { type: 'project.organize', ...input }, () => {
      const project = this.get('project', input.projectId), key = `assistant:project-organization:${input.projectId}`;
      const previous = this.internalRead<ProjectOrganization>(key);
      if (!project || project.revision !== input.projectRevision || (previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'project_changed', 'This Project changed. Review its current version before organizing it.');
      // Sidebar organization must not revise captured project context or remove its files and saved work.
      const result = this.internalWrite(key, { projectId: project.id, revision: (previous?.revision ?? 0) + 1, deleted: input.action === 'delete' } satisfies ProjectOrganization);
      this.advanceCursor();
      return result;
    }).value;
  }
  organizeDraft(device: string, raw: unknown) {
    const input = draftOrganizationCommandSchema.parse(raw);
    return this.admit(device, input, { type: 'draft.organize', ...input }, () => {
      const draft = this.get('draft', input.draftId), key = `assistant:draft-organization:${input.draftId}`;
      const previous = this.internalRead<DraftOrganization>(key);
      if (!draft || draft.revision !== input.draftRevision || (previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'draft_changed', 'This saved draft changed. Review its current version before organizing it.');
      const current = previous?.draftRevision === draft.revision ? previous : undefined;
      return this.internalWrite(key, { draftId: draft.id, draftRevision: draft.revision, revision: (previous?.revision ?? 0) + 1,
        pinned: input.action === 'pin' ? true : input.action === 'unpin' ? false : current?.pinned ?? false,
        folder: input.action === 'delete' ? 'deleted' : input.action === 'archive' ? 'archive' : input.action === 'restore' ? 'active' : current?.folder ?? 'active' } satisfies DraftOrganization);
    }).value;
  }
  removeDraft(device: string, raw: unknown): DraftRemoval {
    const input = removeDraftSchema.parse(raw);
    return this.admit(device, input, { type: 'draft.remove', ...input }, () => {
      const draft = this.get('draft', input.draftId), organization = this.internalRead<DraftOrganization>(`assistant:draft-organization:${input.draftId}`);
      if (!draft || draft.revision !== input.draftRevision || organization?.draftRevision !== draft.revision || organization.revision !== input.expectedRevision || organization.folder !== 'deleted') throw new Fault(409, 'draft_changed', 'Move this saved draft to Deleted and review its current version before removing it.');
      if (this.internalList<{ draftId: string; state: string; cleanupPending?: boolean }>('dictation:').some(a => a.draftId === draft.id && (a.cleanupPending || !['ended', 'failed'].includes(a.state)))) throw new Fault(409, 'draft_busy', 'Finish dictation in the original draft before removing it.');
      return this.removeDraftData(draft);
    }).value;
  }
  private clearReceipts(matches: (value: any) => boolean, removedWork: 'draft' | 'conversation') {
    let after = '';
    for (;;) {
      const rows = this.db.prepare('SELECT request_id,payload FROM receipts WHERE request_id>? ORDER BY request_id LIMIT 100').all(after) as { request_id: string; payload: Uint8Array }[];
      for (const row of rows) if (matches(this.open(`receipt:${row.request_id}`, row.payload))) this.db.prepare('UPDATE receipts SET payload=? WHERE request_id=?').run(this.seal(`receipt:${row.request_id}`, { removedWork }), row.request_id);
      if (rows.length < 100) break; after = rows.at(-1)!.request_id;
    }
  }
  /** Deletion retains only a revision boundary; a later draft is new work. */
  private removeDraftData(draft: Entity<Draft>): DraftRemoval {
    this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(draft.id);
    this.db.prepare('DELETE FROM entities WHERE id=? AND kind=?').run(draft.id, 'draft');
    this.db.prepare('DELETE FROM history WHERE entity_id=?').run(draft.id);
    this.internalDelete(`assistant:draft-organization:${draft.id}`);
    const dictationIds = new Set(this.internalList<{ id: string; draftId: string }>('dictation:').filter(a => a.draftId === draft.id).map(a => a.id));
    for (const id of dictationIds) this.internalDelete(`dictation:${id}`);
    this.clearReceipts(value => !!(value?.id === draft.id && value.value !== undefined || value?.id && dictationIds.has(value.id)), 'draft');
    const removed = this.internalWrite(`assistant:draft-removed:${draft.id}`, { draftId: draft.id, revision: draft.revision + 1 });
    this.advanceCursor(); return removed;
  }
  private receipt(requestId: string, digest: string, device: string, result: unknown) {
    this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(requestId, digest, device, this.seal(`receipt:${requestId}`, result));
  }
  mutate(deviceId: string, raw: Command): Entity<unknown> {
    const cmd = commandSchema.parse(raw); const value = schemas[cmd.kind].parse(cmd.payload);
    const digest = hash(canonical(cmd));
    return this.transaction(() => {
      if (cmd.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The host was recovered or replaced. Review your kept work before saving again.');
      if (cmd.kind === 'layout' && cmd.entityId !== 'layout') throw new Fault(400, 'invalid_target', 'Invalid layout identity.');
      if (cmd.kind === 'draft') {
        const removed = this.internalRead<DraftRemoval>(`assistant:draft-removed:${cmd.entityId}`);
        if (removed && cmd.expectedRevision < removed.revision) throw new Fault(409, 'draft_removed', 'This draft was removed. Keep any new writing as a new draft only after reviewing it.');
        const conversationId = (value as Draft).conversationId;
        const expectedId = conversationId ? `draft:${deviceId}:${conversationId}` : spaceDraftId(deviceId, assistantSpace(value as Draft));
        if (cmd.entityId !== expectedId) throw new Fault(403, 'draft_branch', 'Continue a copy in your own device draft.');
        if (conversationId) {
          const removalId = this.internalRead<string>(`assistant:removal-current:${conversationId}`);
          const removal = removalId ? this.internalRead<{ state: string }>(`assistant:removal:${removalId}`) : undefined;
          if (removal && ['prepared', 'unknown', 'completed'].includes(removal.state)) throw new Fault(409, 'conversation_removing', 'This chat is being removed. Keep a separate copy of any new writing.');
          const conversation = this.internalRead<{ projectId: string | null; space?: AssistantSpace }>(`assistant:conversation:${conversationId}`);
          if (!conversation || conversation.projectId !== (value as Draft).projectId || ((value as Draft).space !== undefined && assistantSpace(value as Draft) !== assistantSpace(conversation))) throw new Fault(409, 'conversation_changed', 'This draft does not match the selected conversation and Project.');
        }
      }
      const previous = this.replay(cmd.requestId, digest, deviceId); if (previous) return previous as Entity<unknown>;
      if (cmd.kind !== 'layout' && !cmd.entityId.startsWith(`${cmd.kind}:`)) throw new Fault(400, 'invalid_target', 'Invalid record identity.');
      const current = this.get(cmd.kind, cmd.entityId);
      const currentRevision = current?.revision ?? (cmd.kind === 'draft' ? this.internalRead<DraftRemoval>(`assistant:draft-removed:${cmd.entityId}`)?.revision : 0) ?? 0;
      if (currentRevision !== cmd.expectedRevision) throw new Fault(409, 'revision_conflict', 'Another window saved a newer version. Your proposal is kept.', current);
      // Older layout editors do not know the icon field and cannot reset it.
      if (cmd.kind === 'layout' && (cmd.payload as Partial<Layout>).appIcon === undefined) (value as Layout).appIcon = (current?.value as Layout | undefined)?.appIcon ?? 'red';
      if (isRecordKind(cmd.kind)) this.validateRecord(cmd.kind, cmd.entityId, value as RecordValue, current as Entity<RecordValue> | undefined);
      if (cmd.kind === 'project') {
        const project = value as Project, previousProject = current?.value as Project | undefined;
        // Older forms must not change the kind of a Project or drop new context.
        project.space ??= previousProject?.space;
        project.instructions ??= previousProject?.instructions;
        project.workspace ??= previousProject?.workspace;
        if (previousProject && assistantSpace(previousProject) !== assistantSpace(project)) throw new Fault(409, 'project_space', 'Create a separate Project in the other space. Existing conversations stay with their Project.');
        if (assistantSpace(project) === 'chat' && project.workspace) throw new Fault(400, 'project_workspace', 'Chat Projects use shared sources. Create a Work Project for a working folder.');
        if (assistantSpace(project) === 'work') {
          const chosen = project.workspace?.folder.trim();
          const folder = chosen || join(this.directory, 'work-projects', hash(cmd.entityId));
          if (!isAbsolute(folder)) throw new Fault(400, 'project_folder', 'Enter an absolute path to an existing folder.');
          if (!chosen) mkdirSync(folder, { recursive: true, mode: 0o700 });
          try { if (!statSync(folder).isDirectory()) throw Error(); project.workspace = { folder: realpathSync(folder), environment: project.workspace?.environment ?? 'local' }; }
          catch { throw new Fault(400, 'project_folder', 'This working folder is unavailable on this host. Choose an existing folder.'); }
          if (project.workspace.environment === 'worktree') {
            try { execFileSync('git', ['-C', project.workspace.folder, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); }
            catch { throw new Fault(400, 'project_repository', 'Worktrees need a Git repository with at least one commit. Use Local for this folder.'); }
          }
          if (previousProject?.workspace && canonical(previousProject.workspace) !== canonical(project.workspace) && this.internalList<{ projectId: string | null }>('assistant:conversation:').some(c => c.projectId === cmd.entityId)) throw new Fault(409, 'project_bound', 'This folder is already linked to saved work. Create another Work Project to use a different folder or environment.');
        }
        // An older form that does not know source files cannot remove them.
        const previousFiles = (current?.value as Project | undefined)?.attachments;
        if (previousFiles) project.attachments ??= previousFiles;
        for (const attachment of project.attachments ?? []) if (canonical(this.blobMetadata(attachment.id)) !== canonical(attachment)) throw new Fault(409, 'attachment_changed', 'A Project source could not be verified. Choose it again.');
      }
      if (cmd.kind === 'draft') {
        const draft = value as Draft;
        if (draft.projectId && !this.get('project', draft.projectId)) throw new Fault(409, 'missing_project', 'The selected Project is unavailable. Your draft is kept.');
        if (draft.refineSource) {
          const source = this.internalRead<{ version: number; projectId: string | null; file?: Attachment }>(`assistant:output:${draft.refineSource.outputId}`);
          if (!source || source.version !== draft.refineSource.version || source.projectId !== draft.projectId || source.file?.sha256 !== draft.refineSource.sha256 || !draft.attachments.some(a => a.id === source.file?.id)) throw new Fault(409, 'output_source_changed', 'The exact output version must remain attached while refining it.');
        }
        for (const attachment of draft.attachments) {
          const stored = this.blobMetadata(attachment.id);
          if (canonical(stored) !== canonical(attachment)) throw new Fault(409, 'attachment_changed', 'An attachment could not be verified.');
        }
      }
      if (cmd.kind === 'routine') this.validateRoutine(cmd.entityId, value as Routine, current as Entity<Routine> | undefined);
      if (cmd.kind === 'task') { Object.assign(value, syncTaskSubtasks(value as Task, current?.value as Task | undefined)); this.validateTask(cmd.entityId, value as Task, current as Entity<Task> | undefined); }
      const result = this.write(cmd.kind, cmd.entityId, current?.deviceId ?? deviceId, value, currentRevision + 1);
      if (cmd.kind === 'agent') this.syncHubLayout();
      if (cmd.kind === 'task') { this.recordTask(result as Entity<Task>, current as Entity<Task> | undefined); this.syncReminder(result as Entity<Task>, current as Entity<Task> | undefined); }
      if (cmd.kind === 'routine') {
        this.internalWrite(`tasks:routine-event:${cmd.entityId}:${result.revision}`, { id: `${cmd.entityId}:${result.revision}`, routineId: cmd.entityId, revision: result.revision, at: new Date(this.now()).toISOString(), state: (value as Routine).state } satisfies RoutineEvent);
        this.materializeRoutine(result as Entity<Routine>);
      }
      if (cmd.kind === 'draft' || cmd.kind === 'project' || cmd.kind === 'content') {
        this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(cmd.entityId);
        const files = cmd.kind === 'draft' ? (value as Draft).attachments : cmd.kind === 'project' ? (value as Project).attachments ?? [] : (value as Content).assets ?? [];
        for (const attachment of files) this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(cmd.entityId, attachment.id);
      }
      this.receipt(cmd.requestId, digest, deviceId, result);
      return result;
    });
  }
  private validateRecord(kind: RecordKind, id: string, value: RecordValue, current?: Entity<RecordValue>, sourceAdmission = false) {
    if (kind === 'contact') {
      const item = value as Contact, previous = current?.value as Contact | undefined;
      // Older forms cannot erase fields they did not receive. Null explicitly removes a photo.
      if (item.photo === undefined && previous?.photo !== undefined) item.photo = previous.photo;
      if (item.otherOrganizations === undefined && previous?.otherOrganizations !== undefined) item.otherOrganizations = previous.otherOrganizations;
      for (const field of ['pipelineStage', 'keepInTouch', 'relationships'] as const) if (item[field] === undefined && previous?.[field] !== undefined) Object.assign(item, { [field]: previous[field] });
      const relationships = new Set<string>();
      for (const relation of item.relationships ?? []) {
        const other = this.get('contact', relation.contactId);
        const key = relation.kind + ':' + relation.contactId;
        if (!other || relation.contactId === id || relationships.has(key)) throw new Fault(400, 'invalid_relationship', 'Choose another saved contact and keep each relationship once.');
        relationships.add(key);
      }
      if (item.photo) {
        const file = this.download(item.photo.id);
        if (canonical(file.metadata) !== canonical(item.photo) || !imagePreviewType(file.bytes, 512 * 512)) throw new Fault(409, 'attachment_changed', 'This contact photo could not be verified. Choose it again.');
      }
    }
    if (kind === 'contact' && !sourceAdmission && canonical((value as Contact).mailSources) !== canonical((current?.value as Contact | undefined)?.mailSources)) throw new Fault(409, 'source_changed', 'Keep the original email links. Add another from its sender in Inbox.');
    if (kind === 'contact' && !sourceAdmission && ((current?.value as Contact | undefined)?.mergedInto || canonical((value as Contact).mergedInto) !== canonical((current?.value as Contact | undefined)?.mergedInto))) throw new Fault(409, 'contact_merged', 'Open the combined contact or restore this one as a separate contact.');
    if (kind === 'profile' && id !== 'profile:owner') throw new Fault(400, 'invalid_target', 'The personal profile has one workspace identity.');
    if ('projectId' in value && value.projectId && !this.get('project', value.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
    if (!current && Number(this.db.prepare('SELECT count(*) AS count FROM entities WHERE kind=?').get(kind)?.count) >= 2000) throw new Fault(507, 'record_quota', 'This module has reached its saved-record limit. Existing work is kept.');
    if (kind === 'content') {
      const item = value as Content, prior = current?.value as Content | undefined;
      if(item.collection===undefined&&prior?.collection!==undefined)item.collection=prior.collection;
      if(item.tags===undefined&&prior?.tags!==undefined)item.tags=prior.tags;
      if(item.brandId===undefined&&prior?.brandId!==undefined)item.brandId=prior.brandId;
      if (!sourceAdmission && canonical(item.source) !== canonical(prior?.source)) throw new Fault(409, 'source_changed', 'Keep the original source of this draft. Start from a saved output to link its exact version.');
      for (const file of item.assets ?? []) if (canonical(this.blobMetadata(file.id)) !== canonical(file)) throw new Fault(409, 'attachment_changed', 'A linked Content file could not be verified.');
      if (item.source && !item.assets?.some(file => file.id === item.source!.fileId && file.sha256 === item.source!.sha256)) throw new Fault(409, 'attachment_changed', 'Keep the original source file with this draft.');
    }
    if (kind === 'assignment') {
      const plan = value as Assignment, prior = current?.value as Assignment | undefined;
      const agent = this.get('agent', plan.agentId);
      if (!agent) throw new Fault(409, 'missing_agent', 'Choose a saved agent design.');
      if ((!prior || plan.agentId !== prior.agentId || plan.agentRevision !== prior.agentRevision) && (agent.value.archived || agent.revision !== plan.agentRevision)) throw new Fault(409, 'agent_changed', 'The agent design changed. Review its current version before choosing it.');
      for (const source of plan.sources ?? []) {
        if (prior?.sources?.some(s => canonical(s) === canonical(source))) continue;
        const record = this.get(source.kind, source.id);
        if (!record || record.value.archived || record.revision !== source.revision) throw new Fault(409, 'assignment_source_changed', 'A selected source changed. Review its saved version before choosing it.');
      }
    }
  }
  taskHistory(raw: unknown) {
    const input = taskHistorySchema.parse(raw);
    if (!this.get('task', input.taskId)) throw new Fault(404, 'task_missing', 'This task is unavailable.');
    const rows = this.db.prepare('SELECT revision,payload FROM history WHERE entity_id=? AND revision<? ORDER BY revision DESC LIMIT 25').all(input.taskId, input.beforeRevision ?? Number.MAX_SAFE_INTEGER) as { revision: number; payload: Uint8Array }[];
    return { versions: rows.map(row => this.open(`history:${input.taskId}:${row.revision}`, row.payload) as Entity<Task>), beforeRevision: rows.length === 25 ? rows.at(-1)!.revision : null };
  }
  recordHistory(raw: unknown) {
    const input = recordHistorySchema.parse(raw);
    if (!this.get(input.kind, input.id)) throw new Fault(404, 'record_missing', 'This saved record is unavailable.');
    const rows = this.db.prepare('SELECT revision,payload FROM history WHERE entity_id=? AND revision<? ORDER BY revision DESC LIMIT 50').all(input.id, input.beforeRevision ?? Number.MAX_SAFE_INTEGER) as { revision: number; payload: Uint8Array }[];
    return { versions: rows.map(row => this.open(`history:${input.id}:${row.revision}`, row.payload) as Entity<RecordValue>), beforeRevision: rows.length === 50 ? rows.at(-1)!.revision : null };
  }
  createContentFromOutput(device: string, raw: unknown): Entity<Content> {
    const input = contentFromOutputSchema.parse(raw);
    return this.admit(device, input, { type: 'content.from-output', ...input }, () => {
      const output = this.internalRead<AssistantOutput>(`assistant:output:${input.outputId}`);
      if (!output || output.state !== 'ready' || output.version !== input.version || output.file?.sha256 !== input.sha256) throw new Fault(409, 'output_source_changed', 'Open the exact saved output before starting a Content draft.');
      const file = this.download(output.file.id);
      if (canonical(file.metadata) !== canonical(output.file)) throw new Fault(409, 'attachment_changed', 'The saved output file changed. Its draft was not created.');
      let body = '', importedText = false;
      if (!output.artifactId || output.mimeType === 'text/plain' || output.mimeType === 'text/markdown') {
        try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); if (text.length <= 100000) { body = text; importedText = true; } } catch { /* Retain the original bytes; never silently replace invalid UTF-8. */ }
      }
      const value = contentSchema.parse({ ...blankRecord('content', 'UTC'),
        title: (output.name.replace(/\.(md|txt)$/i, '').trim() || output.name).slice(0, 240), stage: 'drafting', body,
        format: output.mimeType === 'text/plain' || /\.txt$/i.test(output.name) ? 'text' : 'markdown', projectId: output.projectId,
        assets: [file.metadata], source: { outputId: output.id, version: output.version, sha256: file.metadata.sha256, conversationId: output.conversationId, nativeId: output.nativeId, messageId: output.messageId, messageHash: output.messageHash, fileId: file.metadata.id, name: output.name, importedText },
      });
      const id = `content:${randomUUID()}`;
      this.validateRecord('content', id, value, undefined, true);
      const record = this.write('content', id, device, value, 1);
      this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id, file.metadata.id);
      return record;
    }).value;
  }
  createContentFromAssignment(device: string, raw: unknown): Entity<Content> {
    const input = contentFromAssignmentSchema.parse(raw);
    return this.admit(device, input, { type: 'content.from-assignment', ...input }, () => {
      const attempt = this.internalRead<AssignmentAttempt>(`assignments:attempt:${input.attemptId}`);
      if (!attempt || attempt.epoch !== this.epoch || attempt.state !== 'returned' || attempt.terminal?.status !== 'ok' || !attempt.runId || !attempt.nativeSessionId || attempt.result?.disposition !== 'visible' || attempt.result.file.sha256 !== input.sha256) throw new Fault(409, 'assignment_result_changed', 'Choose an exact returned assignment result before starting a Content draft.');
      const file = this.download(attempt.result.file.id);
      if (canonical(file.metadata) !== canonical(attempt.result.file)) throw new Fault(409, 'attachment_changed', 'The saved assignment result file changed. No draft was created.');
      // Native replies are UTF-8; reject corrupt bytes rather than substituting
      // replacement characters. Larger results remain attached in full.
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
      catch { throw new Fault(409, 'assignment_result_changed', 'The result text could not be verified. Download the original file before continuing.'); }
      if (!text.trim()) throw new Fault(409, 'assignment_result_empty', 'This assignment returned no draft text. Its saved attempt is kept.');
      const importedText = text.length <= 100000;
      const value = contentSchema.parse({ ...blankRecord('content', 'UTC'), title: attempt.title, stage: 'drafting', body: importedText ? text : '', projectId: attempt.projectId,
        assets: [file.metadata], source: { kind: 'assignment', attemptId: attempt.id, version: 1, assignmentId: attempt.assignmentId, assignmentRevision: attempt.assignmentRevision, agentId: attempt.agentId, agentRevision: attempt.agentRevision, runId: attempt.runId, nativeId: attempt.nativeSessionId, turnId: attempt.terminal.turnId, sha256: file.metadata.sha256, fileId: file.metadata.id, name: file.metadata.name, importedText },
      });
      const id = `content:${randomUUID()}`;
      this.validateRecord('content', id, value, undefined, true);
      const record = this.write('content', id, device, value, 1);
      this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id, file.metadata.id);
      return record;
    }).value;
  }
  linkMailContact(device: string, raw: unknown, check: (review: MailContactReview) => void): Entity<Contact> {
    const input = mailContactLinkSchema.parse(raw);
    return this.admit(device, input, { type: 'mail.link-contact', ...input }, () => {
      const review = this.internalRead<MailContactReview>('mail:contact-review:' + input.reviewId);
      if (!review) throw new Fault(409, 'mail_contact_review', 'Review the original sender before linking a Contact.');
      check(review);
      const matches = this.list('contact').filter(item => !item.value.mergedInto && contactEmails(item.value).includes(contactEmailKey(review.source.sender)));
      const current = input.target.kind === 'existing' ? this.get('contact', input.target.id) : undefined;
      if (input.target.kind === 'new' && matches.length) throw new Fault(409, 'contact_matches_changed', 'A Contact with this email already exists. Review the matches before creating another.');
      if (input.target.kind === 'existing' && (!current || current.revision !== input.target.revision || current.value.archived || current.value.mergedInto || !contactEmails(current.value).includes(contactEmailKey(review.source.sender)))) throw new Fault(409, 'contact_matches_changed', 'This Contact changed. Review the matches before linking the email.');
      if (current?.value.mailSources?.some(source => mailContactSourceKey(source) === mailContactSourceKey(review.source))) return current;
      const id = current?.id ?? `contact:${randomUUID()}`;
      const base = current?.value ?? { ...blankRecord('contact', this.get('layout', 'layout')!.value.timezone), name: input.target.kind === 'new' ? input.target.name : review.name, email: review.source.sender };
      const value = contactSchema.parse({ ...base, mailSources: [...(current?.value.mailSources ?? []), review.source] });
      this.validateRecord('contact', id, value, current, true);
      return this.write('contact', id, device, value, (current?.revision ?? 0) + 1);
    }).value;
  }
  mergeContacts(device: string, raw: unknown): Entity<Contact> {
    const input = contactMergeSchema.parse(raw);
    return this.admit(device, input, { type: 'contacts.merge', ...input }, () => {
      const keep = this.get('contact', input.keep.id), other = this.get('contact', input.other.id);
      if (!keep || !other || keep.value.archived || other.value.archived || keep.value.mergedInto || other.value.mergedInto) throw new Fault(409, 'contact_changed', 'Choose two active, separate contacts.');
      if (keep.revision !== input.keep.revision || other.revision !== input.other.revision) throw new Fault(409, 'contact_changed', 'A contact changed. Review both current versions before combining.');
      const value = mergedContactValue(keep.value, other.value, input);
      if (value.relationships) value.relationships = value.relationships.filter(r => r.contactId !== keep.id && r.contactId !== other.id);
      this.validateRecord('contact', keep.id, value, keep, true);
      const result = this.write('contact', keep.id, keep.deviceId, value, keep.revision + 1);
      this.write('contact', other.id, other.deviceId, { ...other.value, archived: true, mergedInto: keep.id }, other.revision + 1);
      return result;
    }).value;
  }
  restoreContact(device: string, raw: unknown): Entity<Contact> {
    const input = contactRestoreSchema.parse(raw);
    return this.admit(device, input, { type: 'contacts.restore', ...input }, () => {
      const current = this.get('contact', input.contact.id);
      if (!current || current.revision !== input.contact.revision || !current.value.mergedInto) throw new Fault(409, 'contact_changed', 'Review the current combined contact before restoring it.');
      const { mergedInto: _target, ...value } = current.value;
      // Restore the retained original without removing information from the combined contact.
      return this.write('contact', current.id, current.deviceId, { ...value, archived: false }, current.revision + 1);
    }).value;
  }
  createRecordTask(device: string, raw: unknown): Entity<Task> {
    const input = recordTaskSchema.parse(raw);
    return this.admit(device, input, { type: 'record-follow-up', ...input }, () => {
      const origin = this.get(input.origin.kind, input.origin.id);
      if (!origin || origin.value.archived) throw new Fault(409, 'record_missing', 'Open an active saved record before creating a follow-up.');
      if (origin.revision !== input.origin.revision) throw new Fault(409, 'source_changed', 'The source changed. Review it before creating this follow-up.', origin);
      const id = `task:${randomUUID()}`;
      const value: Task = { title: input.title, notes: '', status: 'open', planned: '', due: '', bucket: 'capture', projectId: origin.value.projectId, origin: input.origin };
      this.validateTask(id, value);
      const task = this.write('task', id, device, value, 1);
      this.recordTask(task); this.syncReminder(task);
      return task;
    }).value;
  }
  private validateTask(id: string, task: Task, current?: Entity<Task>) {
    if (task.parentTaskId) {
      const seen = new Set([id]);
      let parentId: string | null | undefined = task.parentTaskId;
      while (parentId) {
        const parent: Entity<Task> | undefined = this.get('task', parentId);
        if (!parent || seen.has(parentId) || (!task.trashed && parent.value.trashed)) throw new Fault(409, 'invalid_parent', 'Choose an available parent task outside this task’s own children.');
        seen.add(parentId); parentId = parent.value.parentTaskId;
      }
    }
    if (current && canonical(task.origin) !== canonical(current.value.origin)) throw new Fault(409, 'source_changed', 'Keep this task linked to its original source.');
    if (!current && task.origin) {
      const source = this.get(task.origin.kind, task.origin.id);
      if (!source || source.value.archived || source.revision !== task.origin.revision) throw new Fault(409, 'source_changed', 'Review the current source before linking a new task.');
    }
    if (task.trashed || current?.value.trashed) {
      if (!current) throw new Fault(409, 'task_trashed', 'Save a task before moving it to Trash.');
      const { trashed: before, ...original } = current.value, { trashed: after, ...proposal } = task;
      if (canonical(original) !== canonical(proposal) || before === after) throw new Fault(409, 'task_trashed', 'Restore this task before editing it.');
      if (after && this.list('task').some(t => !t.value.trashed && t.value.dependencies?.includes(id))) throw new Fault(409, 'task_required', 'Another task needs this prerequisite. Remove that dependency before moving it to Trash.');
      if (after && this.list('task').some(t => !t.value.trashed && t.value.parentTaskId === id)) throw new Fault(409, 'task_has_children', 'Move or trash this task’s children before moving their parent to Trash.');
      return;
    }
    const occurrence = this.internalRead<Occurrence>(`tasks:occurrence:${id}`);
    if ((!current && id.startsWith('task:occ:')) || (task.status === 'skipped' && !occurrence)) throw new Fault(400, 'invalid_occurrence', 'Skip belongs to a recurring occurrence.');
    if ((task.plannedTime && !task.planned) || (task.dueTime && !task.due)) throw new Fault(400, 'invalid_time', 'Choose a date before adding a time.');
    if ((task.plannedTime || task.dueTime) && !task.timezone) throw new Fault(400, 'invalid_time', 'Choose a timezone for this time.');
    if (task.reminder && canonical(task.reminder) !== canonical(current?.value.reminder)) { if (['done', 'skipped'].includes(task.status)) throw new Fault(400, 'invalid_reminder_time', 'Reopen this task before adding a new reminder.'); const time = reminderInstant(task.reminder); if (time.instant === null) throw new Fault(400, 'invalid_reminder_time', time.problem === 'gap' ? 'This reminder time does not exist in its timezone. Choose another time.' : 'This reminder time occurs twice. Choose the earlier or later occurrence.'); }
    if (task.projectId && !this.get('project', task.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
    const reaches = (next: string, visited = new Set<string>()): boolean => {
      if (next === id) return true;
      if (visited.has(next)) return false;
      visited.add(next); return (this.get('task', next)?.value.dependencies ?? []).some(child => reaches(child, visited));
    };
    for (const dependency of task.dependencies ?? []) {
      const other = this.get('task', dependency);
      if (!other || other.value.trashed || reaches(dependency)) throw new Fault(409, 'invalid_dependency', 'Dependencies must exist and cannot form a loop.');
      if (['active', 'done'].includes(task.status) && other.value.status !== 'done') throw new Fault(409, 'dependency_open', 'Complete the prerequisite first, or keep this task blocked.');
    }
    if (task.status === 'done' && task.checklist?.some(item => !item.done)) throw new Fault(409, 'checklist_open', 'Finish the checklist before completing this task.');
  }
  private recordTask(task: Entity<Task>, previous?: Entity<Task>) {
    const trashChanged = !!task.value.trashed !== !!previous?.value.trashed;
    if (task.value.status === previous?.value.status && !trashChanged) return;
    const done = task.value.status === 'done';
    const earned = this.internalRead<{ credited: boolean }>(`tasks:credit:${task.id}`)?.credited ?? false;
    // Earlier completions already belong to the predecessor's separate XP ledger.
    const legacyCompletion = this.internalRead(`tasks:legacy-completion:${task.id}`) !== undefined;
    const xpDelta = legacyCompletion ? 0 : done && !earned ? 10 : !done && earned ? -10 : 0;
    this.internalWrite(`tasks:credit:${task.id}`, { credited: done });
    const event: TaskEvent = { id: `${task.id}:${task.revision}`, taskId: task.id, at: new Date(this.now()).toISOString(), from: previous?.value.status ?? null, to: task.value.status, xpDelta, ...(trashChanged ? { action: task.value.trashed ? 'trash' as const : 'restore' as const } : {}) };
    this.internalWrite(`tasks:event:${event.id}`, event);
    if (task.value.status !== 'active' || task.value.trashed) {
      const focus = this.internalRead<Focus>(`tasks:focus:${task.id}`);
      if (focus?.running) this.internalWrite(`tasks:focus:${task.id}`, { ...focus, running: false, elapsedMs: focusElapsed(focus, this.now()), lastPulse: this.now(), revision: focus.revision + 1 });
    }
  }
  private validateRoutine(id: string, routine: Routine, current?: Entity<Routine>) {
    const today = dayInZone(routine.timezone, this.now());
    if (!/^routine:[0-9a-f-]{36}$/i.test(id)) throw new Fault(400, 'invalid_routine', 'Invalid recurring series identity.');
    if (routine.projectId && !this.get('project', routine.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
    if (current) {
      if (routine.startsOn !== current.value.startsOn || routine.timezone !== current.value.timezone || routine.kind !== current.value.kind) throw new Fault(409, 'routine_identity', 'Start date, timezone and type identify this series. Create a new series to change them.');
      this.materializeRoutine(current);
      if ((this.internalRead<{ next: string }>(`tasks:schedule:${id}`)?.next ?? routine.startsOn) <= today) throw new Fault(409, 'schedule_catching_up', 'Open Tasks to finish reviewing the missed occurrences before editing this series.');
    } else {
      if (routine.startsOn < today) throw new Fault(400, 'routine_past', 'Start a new series today or later. Existing missed occurrences stay in Review.');
      if (this.list('routine').length >= 100) throw new Fault(409, 'routine_limit', 'This workspace supports 100 recurring series.');
    }
  }
  private materializeRoutines() { for (const routine of this.list('routine')) this.materializeRoutine(routine); }
  private materializeRoutine(entity: Entity<Routine>) {
    const routine = entity.value, today = dayInZone(routine.timezone, this.now());
    let cursor = this.internalRead<{ next: string }>(`tasks:schedule:${entity.id}`)?.next ?? routine.startsOn;
    // Bounded catch-up, with the cursor preserved for the next read. No missed day is moved to today.
    let count = 0;
    for (; cursor <= today && count < 366; cursor = nextDay(cursor), count++) {
      if (routine.state !== 'active' || !scheduled(routine, cursor)) continue;
      const taskId = `task:occ:${entity.id.slice('routine:'.length)}:${cursor}`;
      if (this.get('task', taskId)) continue;
      const task = this.write('task', taskId, 'scheduler', { title: routine.title, notes: routine.notes, status: 'open', planned: cursor, due: '', plannedTime: routine.plannedTime, timezone: routine.timezone, projectId: routine.projectId, priority: routine.priority, estimateMinutes: routine.estimateMinutes, bucket: 'anytime', ...(routine.reminderTime ? { reminder: { date: cursor, time: routine.reminderTime, timezone: routine.timezone, ...(routine.reminderOverlap ? { overlap: routine.reminderOverlap } : {}) } } : {}) }, 1);
      this.internalWrite(`tasks:occurrence:${taskId}`, { taskId, routineId: entity.id, templateRevision: entity.revision, date: cursor, timezone: routine.timezone, kind: routine.kind } satisfies Occurrence);
      this.recordTask(task); this.syncReminder(task);
    }
    if (count) this.internalWrite(`tasks:schedule:${entity.id}`, { next: cursor });
  }
  profileProgress() {
    return this.transaction(() => {
      const carried = this.internalRead('profile:imported-progress');
      return buildProfileProgress(this.list('task'), this.internalList<TaskEvent>('tasks:event:'), this.internalList<PersonalQuest>('profile:quest:'), this.get('layout', 'layout')!.value.timezone, this.now(), this.epoch, carried ? importedProgressSchema.parse(carried) : undefined);
    });
  }
  profileHistory(before?: string) {
    const events = this.internalList<TaskEvent>('tasks:event:');
    if (before && !events.some(e => e.id === before && e.xpDelta !== 0)) throw new Fault(409, 'history_changed', 'Reload earned history before continuing.');
    return progressHistory(this.list('task'), events, before);
  }
  saveQuest(device: string, raw: unknown): PersonalQuest {
    const input = questCommandSchema.parse(raw);
    return this.admit(device, input, { operation: 'profile.quest', ...input }, () => {
      const id = input.action === 'save' ? input.quest.id : input.id, key = `profile:quest:${id}`;
      const previous = this.internalRead<PersonalQuest>(key);
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'quest_changed', 'This quest changed in another window. Review your kept edits against the current quest.', previous);
      const at = new Date(this.now()).toISOString();
      if (input.action === 'archive') {
        if (!previous) throw new Fault(404, 'quest_missing', 'This quest is unavailable.');
        return this.internalWrite(key, { ...previous, archived: input.archived, revision: previous.revision + 1, updatedAt: at });
      }
      if (previous?.archived) throw new Fault(409, 'quest_archived', 'Restore this quest before editing its steps.', previous);
      if (!previous && this.internalList<PersonalQuest>('profile:quest:').length >= 200) throw new Fault(409, 'quest_limit', 'This workspace has 200 saved quests. Reuse an existing quest.');
      const draft = input.quest;
      if (draft.projectId && !this.get('project', draft.projectId)) throw new Fault(409, 'quest_project', 'Choose an available Project.');
      const steps = draft.steps.map(step => {
        const old = previous?.steps.find(s => s.id === step.id);
        if (old && old.taskId !== step.taskId) throw new Fault(409, 'quest_step_changed', 'Remove the old step before linking a different Task.');
        if (step.taskId) {
          const task = this.get('task', step.taskId);
          if (!task || task.value.trashed && !old) throw new Fault(409, 'quest_task_missing', 'Choose an available Task. Existing links to Trash are kept.');
          return { id: step.id, taskId: step.taskId };
        }
        const taskId = `task:quest:${id}:${step.id}`;
        if (this.get('task', taskId)) throw new Fault(409, 'quest_task_exists', 'This step already has a Task. Link that Task instead.');
        const task = this.write('task', taskId, device, { title: step.title, notes: '', status: 'open', planned: '', due: '', bucket: 'anytime', projectId: draft.projectId, timezone: this.get('layout', 'layout')!.value.timezone }, 1);
        this.recordTask(task); this.syncReminder(task);
        return { id: step.id, taskId };
      });
      if (new Set(steps.map(s => s.taskId)).size !== steps.length) throw new Fault(400, 'quest_duplicate_task', 'Link each Task only once in a quest.');
      return this.internalWrite(key, { ...draft, steps, revision: (previous?.revision ?? 0) + 1, archived: false, createdAt: previous?.createdAt ?? at, updatedAt: at } satisfies PersonalQuest);
    }).value;
  }
  private taskState(): TaskState {
    const events = this.internalList<TaskEvent>('tasks:event:');
    return { occurrences: this.internalList<Occurrence>('tasks:occurrence:'), events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500), routineEvents: this.internalList<RoutineEvent>('tasks:routine-event:').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200), focus: this.internalList<Focus>('tasks:focus:'), earnedXp: events.reduce((total, event) => total + event.xpDelta, 0), orders: this.internalList<DailyOrder>('tasks:order:'), reminders: this.reminders(), reminderAttempts: this.internalList<NotificationAttempt>('reminders:attempt:').sort((a, b) => b.at - a.at) };
  }
  orderTasks(device: string, raw: unknown): DailyOrder {
    const cmd = dailyOrderSchema.parse(raw);
    return this.admit(device, cmd, { type: 'task-order', ...cmd }, () => {
      const key = `tasks:order:${JSON.stringify([cmd.date, cmd.timezone])}`;
      const current = this.internalRead<DailyOrder>(key);
      if ((current?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'order_changed', 'Another window changed this day’s order. Your proposal is kept.', current);
      const eligible = this.list('task').filter(t => inTaskDestination(t, 'Today', cmd.date, cmd.timezone)).map(t => t.id);
      if (eligible.length !== cmd.taskIds.length || eligible.some(id => !cmd.taskIds.includes(id))) throw new Fault(409, 'order_membership', 'The day’s tasks changed. Review the kept order with the current tasks.');
      return this.internalWrite(key, { date: cmd.date, timezone: cmd.timezone, revision: (current?.revision ?? 0) + 1, taskIds: cmd.taskIds });
    }).value;
  }
  private reminders() { return this.internalList<Reminder>('reminders:item:'); }
  private putReminder(reminder: Reminder) { if (reminder.notification) this.internalWrite(`reminders:attempt:${reminder.notification.attemptId}`, { ...reminder.notification, reminderId: reminder.id, taskId: reminder.taskId, dueAt: reminder.dueAt, snoozes: reminder.snoozes } satisfies NotificationAttempt); return this.internalWrite(`reminders:item:${reminder.id}`, JSON.parse(JSON.stringify(reminder)) as Reminder); }
  private syncReminder(task: Entity<Task>, previous?: Entity<Task>) {
    const oldId = this.internalRead<string>(`reminders:task:${task.id}`), old = oldId && this.internalRead<Reminder>(`reminders:item:${oldId}`);
    const changed = canonical(task.value.reminder) !== canonical(previous?.value.reminder);
    const finished = task.value.trashed || ['done', 'skipped'].includes(task.value.status);
    if (old && (changed || finished) && !['dismissed', 'cancelled'].includes(old.state)) this.putReminder({ ...old, state: 'cancelled', revision: old.revision + 1 });
    if (!changed || !task.value.reminder || finished) return;
    const resolved = reminderInstant(task.value.reminder), reminder: Reminder = { id: randomUUID(), taskId: task.id, taskRevision: task.revision, revision: 1, spec: task.value.reminder, dueAt: resolved.instant, state: resolved.instant === null ? 'unavailable' : 'scheduled', ...(resolved.instant === null ? { reason: resolved.problem === 'gap' ? 'This recurring time does not exist today. Choose a new reminder time for this occurrence.' : 'This recurring time occurs twice. Choose which occurrence to use.' } : {}), snoozes: 0 };
    this.putReminder(reminder); this.internalWrite(`reminders:task:${task.id}`, reminder.id);
  }
  private sweepReminders() {
    const now = this.now();
    for (const original of this.reminders()) {
      let item = original;
      if (item.state === 'scheduled' && item.dueAt !== null && item.dueAt <= now) item = { ...item, state: 'ready' };
      if (item.state === 'ready' && item.dueAt !== null && now - item.dueAt > reminderWindowMs && !item.seenAt && item.notification?.state !== 'shown') item = { ...item, state: 'missed' };
      if (item.notification?.state === 'claimed' && now - item.notification.at > 20000) item = { ...item, notification: { ...item.notification, state: 'unknown' } };
      if (item !== original) this.putReminder({ ...item, revision: original.revision + 1 });
    }
    for (const attempt of this.internalList<NotificationAttempt>('reminders:attempt:')) if (attempt.state === 'claimed' && now - attempt.at > 20000) this.internalWrite(`reminders:attempt:${attempt.attemptId}`, { ...attempt, state: 'unknown' });
  }
  tickTasks() { if(this.updateMaintenanceHeld)return;this.transaction(() => { this.materializeRoutines(); this.sweepReminders(); }); }
  actOnReminder(device: string, raw: unknown): Reminder {
    const cmd = reminderActionSchema.parse(raw);
    return this.admit(device, cmd, { type: 'reminder-action', ...cmd }, () => {
      this.sweepReminders(); const item = this.internalRead<Reminder>(`reminders:item:${cmd.reminderId}`);
      if (!item || item.revision !== cmd.expectedRevision) throw new Fault(409, 'reminder_changed', 'This reminder changed. Review its current state.', item);
      if (['cancelled', 'dismissed'].includes(item.state)) throw new Fault(409, 'reminder_closed', 'This reminder is already closed.');
      if (cmd.action === 'seen' && !['ready', 'missed', 'unavailable'].includes(item.state)) throw new Fault(409, 'reminder_not_due', 'This reminder is not ready to display.');
      if (cmd.action === 'seen' && item.seenAt) return item;
      return this.putReminder({ ...item, revision: item.revision + 1, ...(cmd.action === 'seen' ? { seenAt: this.now() } : cmd.action === 'dismiss' ? { state: 'dismissed' as const } : { state: 'scheduled' as const, dueAt: this.now() + cmd.minutes! * 60000, seenAt: undefined, reason: undefined, notification: undefined, snoozes: item.snoozes + 1 }) });
    }).value;
  }
  deliverReminder(device: string, raw: unknown): Reminder {
    const cmd = reminderDeliverySchema.parse(raw);
    return this.admit(device, cmd, { type: 'reminder-delivery', ...cmd }, () => {
      this.sweepReminders(); const item = this.internalRead<Reminder>(`reminders:item:${cmd.reminderId}`);
      if (!item) throw new Fault(404, 'reminder_missing', 'This reminder is no longer available.');
      if (cmd.action === 'claim') {
        if (item.state !== 'ready' || item.notification) throw new Fault(409, 'reminder_claimed', 'A notification attempt already exists, or this reminder needs in-app review.');
        return this.putReminder({ ...item, revision: item.revision + 1, notification: { attemptId: randomUUID(), clientId: cmd.clientId, deviceId: device, at: this.now(), state: 'claimed' } });
      }
      const attempt = this.internalRead<NotificationAttempt>(`reminders:attempt:${cmd.attemptId}`);
      if (!attempt || attempt.reminderId !== item.id || attempt.clientId !== cmd.clientId || attempt.deviceId !== device) throw new Fault(409, 'reminder_attempt_changed', 'This notification belongs to a different attempt.');
      const state = attempt.state === 'shown' ? 'shown' : cmd.action;
      this.internalWrite(`reminders:attempt:${attempt.attemptId}`, { ...attempt, state });
      // A late observation updates its original attempt only, never a later snooze or closed reminder.
      if (item.notification?.attemptId !== attempt.attemptId) return item;
      return this.putReminder({ ...item, revision: item.revision + 1, notification: { ...item.notification, state } });
    }).value;
  }
  focus(device: string, raw: unknown): Focus {
    const cmd = focusSchema.parse(raw);
    return this.admit(device, cmd, { type: 'task-focus', ...cmd }, () => {
      const task = this.get('task', cmd.taskId);
      if (!task || task.value.trashed) throw new Fault(404, 'task_missing', 'This task is unavailable.');
      const current = this.internalRead<Focus>(`tasks:focus:${cmd.taskId}`);
      if ((current?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'focus_changed', 'Focus changed in another window. Review its current state.');
      const now = this.now(), live = (focus: Focus) => focus.running && now < focus.lastPulse + focusLeaseMs;
      if (cmd.action === 'start') {
        if (task.value.status !== 'active') throw new Fault(409, 'task_not_active', 'Start this task before focusing on it.');
        this.validateTask(task.id, task.value, task);
        if (this.internalList<Focus>('tasks:focus:').some(f => live(f) && (f.taskId !== task.id || f.clientId !== cmd.clientId || f.deviceId !== device))) throw new Fault(409, 'focus_busy', 'Another focus session is running. Pause it in its window or wait for it to disconnect.');
      } else if (!current || current.deviceId !== device || current.clientId !== cmd.clientId) throw new Fault(409, 'focus_owner', 'Only the window that started this focus session can update it.');
      if (cmd.action === 'pulse' && (!current || !live(current) || task.value.status !== 'active')) throw new Fault(409, 'focus_expired', 'Focus paused after an interruption. Resume explicitly when you are ready.');
      const value: Focus = { taskId: task.id, deviceId: device, clientId: cmd.clientId, revision: (current?.revision ?? 0) + 1, running: cmd.action !== 'pause', elapsedMs: current ? focusElapsed(current, now) : 0, lastPulse: now };
      return this.internalWrite(`tasks:focus:${task.id}`, value);
    }).value;
  }
  /** Internal service records are encrypted and never exposed by the generic client snapshot. */
  internalRead<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM service_records WHERE id=?').get(id) as { payload: Uint8Array } | undefined;
    return row ? this.open(`service:${id}`, row.payload) as T : undefined;
  }
  internalList<T>(prefix: string): T[] {
    const rows = this.db.prepare('SELECT id,payload FROM service_records WHERE substr(id,1,?)=? ORDER BY id').all(prefix.length, prefix) as { id: string; payload: Uint8Array }[];
    return rows.map(row => this.open(`service:${row.id}`, row.payload) as T);
  }
  internalWrite<T>(id: string, value: T): T {
    this.db.prepare('INSERT INTO service_records VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,payload=excluded.payload').run(id, this.seal(`service:${id}`, value));
    return value;
  }
  /** Called inside the removal transaction. Saved outputs, memories and shared files are separate records. */
  removeConversationData(conversationId: string) {
    const drafts = this.list('draft').filter(draft => draft.value.conversationId === conversationId);
    for (const draft of drafts) this.removeDraftData(draft);
    const ownedReceipts = new Set<string>();
    const prefixes = ['assistant:plan:', 'assistant:operation:', 'assistant:queue:', 'assistant:message-pin:', 'assistant:approval:', 'assistant:question:', 'assistant:edit:', 'assistant:continuation:', 'assistant:research-progress:'];
    for (const prefix of prefixes) {
      let after = '';
      for (;;) {
        const page = this.internalPage<{ conversationId?: string }>(prefix, after, 100);
        for (const row of page) if (row.value.conversationId === conversationId) { ownedReceipts.add(row.id.slice(prefix.length)); this.internalDelete(row.id); }
        if (page.length < 100) break; after = page[page.length - 1].id;
      }
    }
    for (const call of this.internalList<{ id: string; target: { conversation: { id: string } } }>('voice:attempt:').filter(call => call.target.conversation.id === conversationId)) {
      for (const row of this.internalPage(`voice:consult-intent:${call.id}:`, '', 500)) this.internalDelete(row.id);
      this.internalDelete(`voice:attempt:${call.id}`);
    }
    this.clearReceipts(value => !!(value?.id === conversationId && value.nativeKey || value?.conversationId === conversationId && (ownedReceipts.has(value.id) || ownedReceipts.has(value.requestId)) || value?.target?.conversation?.id === conversationId), 'conversation');
    this.advanceCursor();
    this.internalDelete(`assistant:history:${conversationId}`);
    this.internalDelete(`assistant:retained-history:${conversationId}`);
    for (;;) {
      const page = this.internalPage(`assistant:transcript:${conversationId}:`, '', 100);
      for (const row of page) this.internalDelete(row.id);
      if (page.length < 100) break;
    }
    this.internalDelete(`assistant:transcript-state:${conversationId}`);
    this.internalDelete(`assistant:conversation:${conversationId}`);
  }
  internalDelete(id: string) { this.db.prepare('DELETE FROM service_records WHERE id=?').run(id); }
  /** Bounded reads let large private indexes yield between encrypted pages. */
  internalPage<T>(prefix: string, after = '', limit = 100): { id: string; value: T }[] {
    if (!prefix || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid internal page.');
    const rows = this.db.prepare('SELECT id,payload FROM service_records WHERE id>=? AND id<? AND id>? ORDER BY id LIMIT ?')
      .all(prefix, prefix + '\uffff', after, limit) as { id: string; payload: Uint8Array }[];
    return rows.map(row => ({ id: row.id, value: this.open(`service:${row.id}`, row.payload) as T }));
  }
  /** One provider page and its resume position must survive together. */
  internalBatch(entries: { id: string; value: unknown }[], remove: string[] = []) {
    this.transaction(() => { for (const entry of entries) this.internalWrite(entry.id, entry.value); for (const id of remove) this.internalDelete(id); });
  }
  /** Transcript observations share an enclosing admission's commit or rollback. */
  internalBatchJoined(entries: { id: string; value: unknown }[], remove: string[] = []) {
    if (!this.db.isTransaction) return this.internalBatch(entries, remove);
    for (const entry of entries) this.internalWrite(entry.id, entry.value);
    for (const id of remove) this.internalDelete(id);
  }
  /** Atomic service-owned state transitions; callers must not nest this inside admission. */
  internalAtomic<T>(work: () => T): T { return this.transaction(work); }
  readEntity<K extends Kind>(kind: K, id: string): Entity<Values[K]> | undefined { return this.get(kind, id); }
  /** Content service calls inside admission, keeping entity/history/blob references atomic. */
  reviseContent(device:string,id:string,payload:Content,expectedRevision:number):Entity<Content>{
    const current=this.get('content',id);
    if((current?.revision??0)!==expectedRevision)throw new Fault(409,'content_changed','This Content item changed. Review its latest saved version.',current);
    const value=contentSchema.parse(JSON.parse(JSON.stringify(payload)));this.validateRecord('content',id,value,current);
    const result=this.write('content',id,current?.deviceId??device,value,expectedRevision+1);
    this.db.prepare('DELETE FROM blob_refs WHERE entity_id=?').run(id);
    for(const attachment of value.assets??[])this.db.prepare('INSERT INTO blob_refs VALUES (?,?)').run(id,attachment.id);
    return result;
  }
  createContentPlan(device:string,id:string,payload:Assignment):Entity<Assignment>{
    if(this.get('assignment',id))throw new Fault(409,'content_plan_exists','This work plan already exists.');
    const value=recordSchemas.assignment.parse(payload);this.validateRecord('assignment',id,value);
    return this.write('assignment',id,device,value,1);
  }
  /** Trusted CRM services call inside admission/atomic blocks, preserving the same entity/history authority. */
  reviseContact(device: string, id: string, payload: Contact, expectedRevision: number): Entity<Contact> {
    const current = this.get('contact', id);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Fault(409, 'contact_changed', 'This contact changed. Review the current details.');
    const value = contactSchema.parse(payload); this.validateRecord('contact', id, value, current);
    return this.write('contact', id, current?.deviceId ?? device, value, expectedRevision + 1);
  }
  reviseCrmTask(device: string, id: string, payload: Task): Entity<Task> {
    const current = this.get('task', id), value = taskSchema.parse(payload);
    this.validateTask(id, value, current);
    const result = this.write('task', id, current?.deviceId ?? device, value, (current?.revision ?? 0) + 1);
    this.recordTask(result, current); this.syncReminder(result, current); return result;
  }
  listEntities<K extends Kind>(kind: K): Entity<Values[K]>[] { return this.list(kind); }
  get entityCursor(): number { return Math.max(Number(this.db.prepare("SELECT value FROM meta WHERE key='workspace-cursor'").get()?.value ?? 0), Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='history'").get()?.seq ?? 0)); }
  private advanceCursor(prior = this.entityCursor) { const next = Math.max(prior + 1, this.entityCursor); this.db.prepare("INSERT INTO meta (key,value) VALUES ('workspace-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next)); }
  /** Resolve an exact saved version only within its current canonical kind. */
  readEntityVersion<K extends Kind>(kind: K, id: string, revision: number): Entity<Values[K]> | undefined {
    const current = this.get(kind, id);
    if (!current || !Number.isInteger(revision) || revision < 1) return undefined;
    if (current.revision === revision) return current;
    const row = this.db.prepare('SELECT payload FROM history WHERE entity_id=? AND revision=?').get(id, revision) as { payload: Uint8Array } | undefined;
    return row ? this.open(`history:${id}:${revision}`, row.payload) as Entity<Values[K]> : undefined;
  }
  /** Capture one immutable effect intent and its receipt atomically, before any external await. */
  replayAdmission<T>(device: string, input: { requestId: string; epoch: string }, intent: unknown): T | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Fault(400, 'invalid_request', 'Invalid request identity.');
    if (input.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Review the original work before continuing.');
    return this.replay(input.requestId, hash(canonical(intent)), device) as T | undefined;
  }
  admit<T>(device: string, input: { requestId: string; epoch: string }, intent: unknown, prepare: () => T): { value: T; fresh: boolean } {
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) throw new Fault(400, 'invalid_request', 'Invalid request identity.');
    const digest = hash(canonical(intent));
    return this.transaction(() => {
      if (input.epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Review the original work before continuing.');
      const original = this.replay(input.requestId, digest, device);
      if (original !== undefined) return { value: original as T, fresh: false };
      const result = prepare(); this.receipt(input.requestId, digest, device, result);
      return { value: result, fresh: true };
    });
  }
  upload(device: string, requestId: string, epoch: string, name: string, base64: string): Attachment {
    if (!/^[a-z0-9-]{36}$/i.test(requestId) || !name || name.length > 200 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Fault(400, 'invalid_upload', 'Invalid attachment.');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > 8 * 1024 * 1024) throw new Fault(413, 'file_too_large', 'Choose a file smaller than 8 MB.');
    const digest = hash(canonical({ epoch, name, sha256: hash(bytes), requestId }));
    return this.transaction(() => {
      if (epoch !== this.epoch) throw new Fault(409, 'epoch_changed', 'Review this attachment after host recovery.');
      const previous = this.replay(requestId, digest, device); if (previous) return previous as Attachment;
      const total = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM blobs').get() as { total: number }).total;
      if (total + Buffer.byteLength(base64) + 30 > 256 * 1024 * 1024) throw new Fault(507, 'quota', 'This preview’s attachment storage is full. Existing files are kept.');
      const metadata = attachmentSchema.parse({ id: randomUUID(), name: name.replace(/[\x00-\x1f/\\]/g, '_'), size: bytes.length, sha256: hash(bytes) });
      const file = join(this.directory, 'blobs', metadata.id);
      const temporary = `${file}.tmp`;
      const handle = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(handle, this.seal(`blob:${metadata.id}`, base64)); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temporary, file);
      if (process.platform !== 'win32') { const folder = openSync(join(this.directory, 'blobs'), 'r'); try { fsyncSync(folder); } finally { closeSync(folder); } }
      this.db.prepare('INSERT INTO blobs VALUES (?,?,?,?)').run(metadata.id, device, statSync(file).size, this.seal(`blob-meta:${metadata.id}`, metadata));
      this.receipt(requestId, digest, device, metadata);
      return metadata;
    });
  }
  blobMetadata(id: string): Attachment {
    const row = this.db.prepare('SELECT payload FROM blobs WHERE id=?').get(id) as { payload: Uint8Array } | undefined;
    if (!row) throw new Fault(404, 'attachment_missing', 'This attachment is unavailable.');
    return this.open(`blob-meta:${id}`, row.payload);
  }
  download(id: string): { metadata: Attachment; bytes: Buffer } {
    const metadata = this.blobMetadata(id); // Validate authoritative identity before constructing a path.
    const bytes = Buffer.from(this.open(`blob:${id}`, readFileSync(join(this.directory, 'blobs', metadata.id))), 'base64');
    if (hash(bytes) !== metadata.sha256 || bytes.length !== metadata.size) throw new Fault(409, 'attachment_corrupt', 'Attachment integrity check failed.');
    return { metadata, bytes };
  }
}
