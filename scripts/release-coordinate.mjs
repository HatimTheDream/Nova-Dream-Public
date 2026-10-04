/** Durable local coordination around the maintained installer, never an installer.
 * A committed reservation is never permission to retry: every later resume only
 * observes its original idempotency key, including a crash before dispatch.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { planRelease, readEvidenceFile, releaseOperationIdentity, releasePlanInputSchema, sha256 } from './release-plan.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.uuid();
const reference = z.object({ path: z.string().min(1).max(4096), sha256: hash }).strict();
const adapterReferences = z.object({ transport: reference, installSpec: reference }).strict();
export const releaseCoordinatorDescriptorSchema = z.object({ format: z.literal(1), input: releasePlanInputSchema, adapter: adapterReferences }).strict();
export const installObservationSchema = z.object({ state: z.enum(['running', 'completed', 'failed', 'uncertain']), externalJobId: uuid.nullable(),
  observation: reference.nullable(), reasonCode: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/), candidateId: hash, priorCandidateId: hash,
  workspaceEpoch: uuid, idempotencyKey: uuid }).strict();
const MAX_RECORD = 2 * 1024 ** 2, MAX_EVENTS = 10_000, APPLICATION_ID = 0x4e56524c;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const requireThat = (condition, code) => { if (!condition) throw new Error(code); };
const at = value => { requireThat(Number.isSafeInteger(value) && value >= 0, 'invalid-clock'); return value; };
function encode(value) { const text = canonical(value); requireThat(Buffer.byteLength(text) <= MAX_RECORD, 'journal-record-too-large'); return { text, hash: sha256(text) }; }
function decode(text, expected) { requireThat(typeof text === 'string' && Buffer.byteLength(text) <= MAX_RECORD && sha256(text) === expected, 'journal-record-hash-mismatch'); return JSON.parse(text); }

/** No input controls a script or executable. This fixed ACL operation only
 * protects a newly created directory, or reads an existing directory's ACL.
 */
const windowsAclScript = `$ErrorActionPreference='Stop'
$target=$env:NOVA_RELEASE_DIRECTORY
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($owner.Value,'S-1-5-18','S-1-5-32-544')
$acl=[IO.Directory]::GetAccessControl($target)
if($env:NOVA_RELEASE_ACL_CREATE -eq '1') {
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($rule)}
  $acl.SetOwner($owner)
  foreach($id in $allowed) {
    $sid=[Security.Principal.SecurityIdentifier]::new($id)
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    [void]$acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($target,$acl)
  $acl=[IO.Directory]::GetAccessControl($target)
}
if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'unprotected-directory'}
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -eq 0){throw 'empty-permissions'}
foreach($rule in $rules){if($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow'){throw 'unexpected-directory-access'}}
if(-not ($rules | Where-Object {$_.IdentityReference.Value -eq $owner.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl})){throw 'owner-access-missing'}
[Console]::Out.WriteLine('protected')
`;
function protectDirectory(path, newlyCreated = false) {
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsAclScript, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024,
      env: { ...process.env, NOVA_RELEASE_DIRECTORY: path, NOVA_RELEASE_ACL_CREATE: newlyCreated ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    requireThat(output.toString().trim() === 'protected', 'unprotected-journal-directory');
  } else {
    const info = lstatSync(path); requireThat(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'unprotected-journal-directory');
  }
}
export function validateJournalDirectory(raw, { create = false } = {}) {
  requireThat(typeof raw === 'string' && isAbsolute(raw) && !raw.includes('\0'), 'absolute-journal-directory-required');
  const directory = resolve(raw), missing = [];
  requireThat(directory !== parse(directory).root, 'journal-root-not-allowed');
  for (let part = directory; ; part = dirname(part)) {
    requireThat(!/^onedrive(?:\s*-.*)?$/i.test(parse(part).base), 'synced-journal-directory-not-allowed');
    for (const root of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean)) {
      const normalized = resolve(root).toLowerCase(), current = directory.toLowerCase();
      requireThat(current !== normalized && !current.startsWith(normalized + '/') && !current.startsWith(normalized + '\\'), 'synced-journal-directory-not-allowed');
    }
    requireThat(!existsSync(join(part, '.git')), 'repository-journal-directory-not-allowed');
    if (existsSync(part)) { const info = lstatSync(part); requireThat(info.isDirectory() && !info.isSymbolicLink(), 'redirected-journal-directory'); }
    else missing.push(part);
    if (dirname(part) === part) break;
  }
  requireThat(create || missing.length === 0, 'journal-directory-missing');
  for (const part of missing.reverse()) { mkdirSync(part, { mode: 0o700 }); protectDirectory(part, true); }
  requireThat(resolve(realpathSync(directory)) === directory, 'redirected-journal-directory');
  protectDirectory(directory);
  return directory;
}
export function normalizePlanInput(raw, baseDirectory) {
  const input = releasePlanInputSchema.parse(raw);
  requireThat(input.operation.stage === 'frozen', 'coordinator-requires-frozen-operation');
  requireThat(!input.previousReport, 'coordinator-owns-resume-history');
  for (const files of Object.values(input.evidence)) for (const ref of Object.values(files)) ref.path = resolve(baseDirectory, ref.path);
  return input;
}
export function normalizeCoordinatorDescriptor(raw, baseDirectory = process.cwd()) {
  const descriptor = releaseCoordinatorDescriptorSchema.parse(raw);
  descriptor.input = normalizePlanInput(descriptor.input, baseDirectory);
  for (const ref of Object.values(descriptor.adapter)) ref.path = resolve(baseDirectory, ref.path);
  return descriptor;
}

export class ReleaseJournal {
  constructor(rawDirectory, { create = false, readOnly = false } = {}) {
    requireThat(!(create && readOnly), 'invalid-journal-open-mode');
    this.directory = validateJournalDirectory(rawDirectory, { create }); this.readOnly = readOnly;
    const path = join(this.directory, 'release.sqlite'), existed = existsSync(path);
    requireThat(create || existed, 'release-journal-missing');
    if (!existed) {
      requireThat(readdirSync(this.directory).length === 0, 'new-journal-directory-not-empty');
      const fd = openSync(path, 'wx', 0o600); closeSync(fd);
    }
    for (const file of [path, path + '-wal', path + '-shm'].filter(existsSync)) {
      const info = lstatSync(file); requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'unsafe-journal-file');
      if (process.platform !== 'win32') requireThat(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'unprotected-journal-file');
    }
    this.db = new DatabaseSync(path, { readOnly });
    try {
      // Opening schema metadata can contend with another process before any
      // transaction begins. Install the bounded wait before the first read.
      this.db.exec('PRAGMA busy_timeout=5000;');
      if (!existed) {
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA max_page_count=8192;
          BEGIN IMMEDIATE;
          CREATE TABLE operations(id TEXT PRIMARY KEY,identity TEXT NOT NULL,adapter_json TEXT NOT NULL,adapter_hash TEXT NOT NULL,descriptor_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES operations(id),at_ms INTEGER NOT NULL,input_json TEXT NOT NULL,input_hash TEXT NOT NULL,report_json TEXT NOT NULL,report_hash TEXT NOT NULL);
          CREATE INDEX checkpoint_operation ON checkpoints(operation_id,id);
          CREATE TABLE intents(operation_id TEXT PRIMARY KEY REFERENCES operations(id),id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),input_hash TEXT NOT NULL,transport_identity TEXT NOT NULL,state TEXT NOT NULL,external_job_id TEXT,observation_json TEXT,observation_hash TEXT);
          CREATE UNIQUE INDEX active_transport ON intents(transport_identity) WHERE state IN ('reserved','running','uncertain');
          CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES operations(id),at_ms INTEGER NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL);
          CREATE TRIGGER checkpoints_immutable_update BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT,'immutable-checkpoint'); END;
          CREATE TRIGGER checkpoints_immutable_delete BEFORE DELETE ON checkpoints BEGIN SELECT RAISE(ABORT,'immutable-checkpoint'); END;
          CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable-event'); END;
          CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable-event'); END;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
      } else {
        requireThat(this.db.prepare('PRAGMA application_id').get().application_id === APPLICATION_ID && this.db.prepare('PRAGMA user_version').get().user_version === 1, 'unrecognized-release-journal');
        this.db.exec('PRAGMA foreign_keys=ON;');
        if (!readOnly) this.db.exec('PRAGMA synchronous=FULL;');
        requireThat(this.db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal', 'journal-durability-mode-changed');
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  transaction(fn) {
    requireThat(!this.readOnly, 'readonly-journal'); this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(operationId, kind, payload, nowMs) {
    const latest = this.db.prepare('SELECT at_ms FROM events WHERE operation_id=? ORDER BY id DESC LIMIT 1').get(operationId);
    requireThat(!latest || at(nowMs) >= latest.at_ms, 'journal-clock-moved-backwards');
    requireThat(this.db.prepare('SELECT count(*) AS count FROM events').get().count < MAX_EVENTS, 'release-journal-event-limit');
    const value = encode(payload); this.db.prepare('INSERT INTO events(operation_id,at_ms,kind,payload_json,payload_hash) VALUES(?,?,?,?,?)').run(operationId, at(nowMs), kind, value.text, value.hash);
  }
  saveCheckpoint(operationId, input, report, nowMs) {
    const source = encode(input), result = encode(report);
    const inserted = this.db.prepare('INSERT INTO checkpoints(operation_id,at_ms,input_json,input_hash,report_json,report_hash) VALUES(?,?,?,?,?,?)').run(operationId, at(nowMs), source.text, source.hash, result.text, result.hash);
    return { id: Number(inserted.lastInsertRowid), inputSha256: source.hash, reportSha256: result.hash };
  }
  initialize(descriptor, adapterDescription, nowMs = Date.now()) {
    const parsed = normalizeCoordinatorDescriptor(descriptor), input = parsed.input, operationId = input.operation.id, identity = releaseOperationIdentity(input.operation);
    const { identity: adapterIdentity, scopeIdentity } = z.object({ identity: hash, scopeIdentity: hash }).strict().parse(adapterDescription);
    const adapter = encode({ ...parsed.adapter, identity: adapterIdentity, scopeIdentity }), full = encode(parsed);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT descriptor_hash FROM operations WHERE id=?').get(operationId);
      if (existing) { requireThat(existing.descriptor_hash === full.hash, 'existing-operation-input-changed'); return this.status(operationId); }
      const report = planRelease(input, { nowMs });
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(operationId, identity, adapter.text, adapter.hash, full.hash, at(nowMs));
      const checkpoint = this.saveCheckpoint(operationId, input, report, nowMs);
      this.event(operationId, 'initialized', { operationIdentity: identity, adapterIdentity, ...checkpoint }, nowMs);
      return this.status(operationId);
    });
  }
  load(operationId, checkpointId) {
    uuid.parse(operationId); const operation = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId); requireThat(operation, 'operation-not-found');
    const checkpoint = checkpointId === undefined
      ? this.db.prepare('SELECT * FROM checkpoints WHERE operation_id=? ORDER BY id DESC LIMIT 1').get(operationId)
      : this.db.prepare('SELECT * FROM checkpoints WHERE operation_id=? AND id=?').get(operationId, checkpointId);
    requireThat(checkpoint, 'operation-checkpoint-missing');
    const input = normalizePlanInput(decode(checkpoint.input_json, checkpoint.input_hash), this.directory), report = decode(checkpoint.report_json, checkpoint.report_hash);
    requireThat(releaseOperationIdentity(input.operation) === operation.identity, 'stored-operation-identity-changed');
    const adapter = decode(operation.adapter_json, operation.adapter_hash); hash.parse(adapter.identity); hash.parse(adapter.scopeIdentity); adapterReferences.parse({ transport: adapter.transport, installSpec: adapter.installSpec });
    return { operation, checkpoint, input, report, adapter };
  }
  intent(operationId) {
    const row = this.db.prepare('SELECT * FROM intents WHERE operation_id=?').get(operationId); if (!row) return null;
    return { id: row.id, idempotencyKey: row.idempotency_key, createdAtMs: row.created_at, inputSha256: row.input_hash,
      checkpointId: row.checkpoint_id, state: row.state, externalJobId: row.external_job_id,
      lastObservation: row.observation_json ? installObservationSchema.parse(decode(row.observation_json, row.observation_hash)) : null };
  }
  status(operationId) {
    const current = this.load(operationId), events = this.db.prepare('SELECT * FROM events WHERE operation_id=? ORDER BY id DESC LIMIT 20').all(operationId);
    return { format: 1, kind: 'nova-release-coordination', readOnly: true, operationId, operationIdentity: current.operation.identity,
      createdAtMs: current.operation.created_at, checkpointAtMs: current.checkpoint.at_ms, inputSha256: current.checkpoint.input_hash,
      adapterIdentity: current.adapter.identity, intent: this.intent(operationId), storedPlan: current.report,
      events: events.reverse().map(event => ({ id: event.id, atMs: event.at_ms, kind: event.kind, payload: decode(event.payload_json, event.payload_hash) })) };
  }
  plan(operationId, nowMs = Date.now()) { const value = this.load(operationId); return planRelease(value.input, { nowMs, previousReport: value.report }); }
  checkpoint(operationId, rawInput, { baseDirectory = process.cwd(), nowMs = Date.now() } = {}) {
    const input = normalizePlanInput(rawInput, baseDirectory);
    return this.transaction(() => {
      const current = this.load(operationId); requireThat(releaseOperationIdentity(input.operation) === current.operation.identity, 'checkpoint-operation-changed');
      requireThat(at(nowMs) >= current.checkpoint.at_ms, 'journal-clock-moved-backwards');
      const report = planRelease(input, { nowMs, previousReport: current.report });
      const checkpoint = this.saveCheckpoint(operationId, input, report, nowMs); this.event(operationId, 'checkpoint', checkpoint, nowMs);
      return report;
    });
  }
  reserveInstall(operationId, nowMs = Date.now()) {
    return this.transaction(() => {
      const existing = this.intent(operationId); if (existing) return { newlyReserved: false, intent: existing };
      const current = this.load(operationId), report = planRelease(current.input, { nowMs, previousReport: current.report });
      requireThat(!report.operationComplete, 'operation-already-completed');
      requireThat(['private-ci', 'public-ci', 'package', 'capacity', 'recovery', 'publication'].every(id => report.phases.find(p => p.id === id)?.state === 'passed'), 'install-prerequisites-unverified');
      requireThat(report.eta.dueReviews.length === 0 && report.eta.suspendNewAttemptsFor.length === 0, 'install-overrun-review-required');
      const checkpoint = this.saveCheckpoint(operationId, current.input, report, nowMs);
      const intent = { id: randomUUID(), idempotencyKey: randomUUID(), createdAtMs: at(nowMs), inputSha256: checkpoint.inputSha256 };
      this.db.prepare('INSERT INTO intents(operation_id,id,idempotency_key,created_at,checkpoint_id,input_hash,transport_identity,state) VALUES(?,?,?,?,?,?,?,?)')
        .run(operationId, intent.id, intent.idempotencyKey, intent.createdAtMs, checkpoint.id, intent.inputSha256, current.adapter.scopeIdentity, 'reserved');
      this.event(operationId, 'install-reserved', intent, nowMs);
      return { newlyReserved: true, intent: this.intent(operationId) };
    });
  }
  context(operationId) {
    const intent = this.intent(operationId); requireThat(intent, 'install-intent-missing');
    const current = this.load(operationId, intent.checkpointId); requireThat(current.checkpoint.input_hash === intent.inputSha256, 'intent-input-changed');
    return { operation: current.input.operation, operationIdentity: current.operation.identity, input: current.input,
      intent: { id: intent.id, idempotencyKey: intent.idempotencyKey, createdAtMs: intent.createdAtMs, inputSha256: intent.inputSha256 }, adapter: current.adapter };
  }
  recordObservation(operationId, raw, nowMs = Date.now()) {
    const value = installObservationSchema.parse(raw);
    return this.transaction(() => {
      const context = this.context(operationId), old = this.intent(operationId);
      requireThat(value.candidateId === context.operation.candidateId && value.priorCandidateId === context.operation.priorCandidateId && value.workspaceEpoch === context.operation.workspaceEpoch && value.idempotencyKey === old.idempotencyKey, 'adapter-observation-identity-changed');
      requireThat(!old.externalJobId || !value.externalJobId || old.externalJobId === value.externalJobId, 'external-job-identity-changed');
      if (value.observation) readEvidenceFile(value.observation);
      const encoded = encode(value), terminal = ['completed', 'failed'].includes(old.state);
      // A delayed poll must never overwrite a later terminal observation.
      if (!terminal) this.db.prepare('UPDATE intents SET state=?,external_job_id=?,observation_json=?,observation_hash=? WHERE operation_id=?')
        .run(value.state, value.externalJobId ?? old.externalJobId, encoded.text, encoded.hash, operationId);
      this.event(operationId, terminal ? 'terminal-observation-retained' : 'install-observed', value, nowMs);
      return this.intent(operationId);
    });
  }
}

async function adapters() { return import('./release-adapters.mjs'); }
export async function initializeRelease(directory, raw, { baseDirectory = process.cwd(), nowMs = Date.now() } = {}) {
  const descriptor = normalizeCoordinatorDescriptor(raw, baseDirectory), fixed = await adapters();
  const described = await fixed.describeInstallAdapter({ ...descriptor.adapter, operation: descriptor.input.operation, input: descriptor.input });
  const journal = new ReleaseJournal(directory, { create: true });
  try { return journal.initialize(descriptor, described, nowMs); } finally { journal.close(); }
}
export async function resumeRelease(directory, operationId, { nowMs = Date.now() } = {}) {
  const journal = new ReleaseJournal(directory);
  try {
    const fixed = await adapters(), current = journal.intent(operationId) ? journal.context(operationId) : journal.load(operationId);
    const described = await fixed.describeInstallAdapter({ transport: current.adapter.transport, installSpec: current.adapter.installSpec, operation: current.input.operation, input: current.input });
    requireThat(described.identity === current.adapter.identity && described.scopeIdentity === current.adapter.scopeIdentity, 'retained-adapter-identity-changed');
    const reservation = journal.reserveInstall(operationId, nowMs), context = journal.context(operationId);
    let observation;
    try { observation = installObservationSchema.parse(await (reservation.newlyReserved ? fixed.dispatchInstall(context) : fixed.observeInstall(context))); }
    catch { observation = { state: 'uncertain', externalJobId: null, observation: null, reasonCode: 'adapter-response-unavailable', candidateId: context.operation.candidateId, priorCandidateId: context.operation.priorCandidateId, workspaceEpoch: context.operation.workspaceEpoch, idempotencyKey: context.intent.idempotencyKey }; }
    journal.recordObservation(operationId, observation, Date.now());
    return { ...journal.status(operationId), readOnly: false, dispatchAttempted: reservation.newlyReserved, observeOnly: !reservation.newlyReserved };
  } finally { journal.close(); }
}

function readInput(path) {
  const fd = openSync(path, 'r'); let bytes;
  try {
    const before = fstatSync(fd); requireThat(before.isFile() && before.size <= 256 * 1024, 'invalid-input-file');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    bytes = buffer.subarray(0, length); requireThat(bytes.length === before.size, 'input-file-changed');
  } finally { closeSync(fd); }
  return JSON.parse(readEvidenceFile({ path, sha256: sha256(bytes) }, { maximum: 256 * 1024 }));
}
async function main(args) {
  const [command, directory, value, extra] = args;
  requireThat(['init', 'status', 'plan', 'checkpoint', 'resume'].includes(command) && directory && value && (command === 'checkpoint' ? !!extra && args.length === 4 : args.length === 3), 'invalid-coordinator-command');
  if (command === 'init') {
    const path = resolve(value);
    return initializeRelease(directory, readInput(path), { baseDirectory: dirname(path) });
  }
  if (command === 'resume') return resumeRelease(directory, uuid.parse(value));
  const journal = new ReleaseJournal(directory, { readOnly: command !== 'checkpoint' });
  try {
    if (command === 'status') return journal.status(uuid.parse(value));
    if (command === 'plan') return journal.plan(uuid.parse(value));
    const path = resolve(extra);
    return journal.checkpoint(uuid.parse(value), readInput(path), { baseDirectory: dirname(path) });
  } finally { journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ format: 1, kind: 'nova-release-coordination-error', reason: /^[a-z][a-z0-9-]{1,99}$/.test(error.message) ? error.message : 'coordinator-input-storage-or-evidence-rejected', automaticReplayPermitted: false }) + '\n'); process.exitCode = 1; }
}
