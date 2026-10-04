/** Read-only Linux host snapshot. Not an atomic snapshot, controller admission,
 * heartbeat acknowledgement, capacity qualification, or acceptance proof. */
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, statfsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get } from 'node:http';

export const HOST_OBSERVATION_LIMITS = Object.freeze({ configBytes: 65536, packageBytes: 262144, journalBytes: 16 * 1024 ** 2, leaseBytes: 8192, responseBytes: 65536, jobs: 32, journalJobs: 2048, timeoutMs: 3000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
const digest = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
const version = v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,64})?$/.test(v) ? v : null;
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const pickEnum = (v, values) => values.includes(v) ? v : null;
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const { dirname, join } = posix;
const identity = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.uid].join(':');
const canonicalPath = p => typeof p === 'string' && p.length <= 4096 && !p.includes('\0') && posix.isAbsolute(p) && posix.resolve(p) === p;

/** Configuration/journals cannot redirect root into arbitrary files. Runtime
 * selectors are resolved explicitly before using this same protected reader. */
export function readProtectedFile(path, maximum) {
  if (!canonicalPath(path)) throw Error('unsafe-path');
  for (let part = path; ; part = dirname(part)) {
    const s = lstatSync(part);
    if (s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o022 || (part !== path && !s.isDirectory())) throw Error('unsafe-file');
    if (dirname(part) === part) break;
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maximum) throw Error('unsafe-file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (identity(opened) !== identity(before)) throw Error('changed-file');
    const buffer = Buffer.alloc(Math.min(maximum + 1, opened.size + 1)); let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    if (length > maximum || identity(opened) !== identity(fstatSync(fd)) || identity(before) !== identity(lstatSync(path))) throw Error('changed-file');
    return { bytes: buffer.subarray(0, length), mtimeMs: before.mtimeMs };
  } finally { closeSync(fd); }
}

/** Fixed loopback GET only: no configured URL, redirects, auth or request body. */
export function readLoopbackJson(path) {
  if (!['/api/health', '/api/access/context'].includes(path)) throw Error('unsupported-endpoint');
  return new Promise((resolveJson, reject) => {
    const request = get({ hostname: '127.0.0.1', port: 4383, path, agent: false, headers: { Accept: 'application/json', Connection: 'close' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('unavailable-endpoint')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > HOST_OBSERVATION_LIMITS.responseBytes) request.destroy(Error('oversized-response')); else chunks.push(chunk); });
      response.on('end', () => { try { resolveJson(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('invalid-response')); } });
      response.on('error', () => reject(Error('unavailable-endpoint')));
    });
    const timeout = setTimeout(() => request.destroy(Error('endpoint-timeout')), HOST_OBSERVATION_LIMITS.timeoutMs);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', () => reject(Error('unavailable-endpoint')));
  });
}

export const hostObserverDependencies = Object.freeze({
  readFile: readProtectedFile, realpath: realpathSync, now: Date.now, getJson: readLoopbackJson,
  disk: path => { const s = statfsSync(path, { bigint: true }); const bytes = v => { const n = Number(v); if (!Number.isSafeInteger(n)) throw Error('disk-overflow'); return n; };
    return { totalBytes: bytes(s.blocks * s.bsize), freeBytes: bytes(s.bavail * s.bsize), usedBytes: bytes((s.blocks - s.bfree) * s.bsize) }; },
});

const healthView = v => ({ status: pickEnum(v.status, ['ready', 'starting', 'degraded', 'updating', 'error']), version: version(v.version), buildVersion: version(v.buildVersion), schemaVersion: integer(v.schemaVersion), apiVersion: integer(v.apiVersion), candidateId: digest(v.candidateId) });
const jobView = v => ({ id: uuid(v.id), state: pickEnum(v.state, ['waiting', 'downloading', 'verifying', 'preparing', 'installing', 'restarting', 'checking', 'completed', 'restored', 'failed', 'cancelled']), hold: typeof v.hold === 'boolean' ? v.hold : null, candidateId: digest(v.candidateId), fromCandidateId: digest(v.fromCandidateId), releaseId: digest(v.releaseId), epoch: uuid(v.epoch) });
const leaseView = v => ({ id: uuid(v.id), phase: pickEnum(v.phase, ['entered', 'held', 'stopping', 'stopped', 'snapshot', 'restore', 'checking', 'releasing', 'released', 'cancelled', 'failed']), releaseKind: pickEnum(v.releaseKind, ['rehearsed', 'unchanged', 'aborted', 'cancelled']), candidateId: digest(v.candidateId), workspaceEpoch: uuid(v.workspaceEpoch), stopMarked: typeof v.stopMarked === 'boolean' ? v.stopMarked : null });

export async function observeReleaseHost({ configPath = '/etc/nova-update/config.json' } = {}, dependencies = hostObserverDependencies) {
  const d = dependencies, observedAtMilliseconds = d.now(), sources = [], diagnostics = [], tracked = [];
  const failed = code => { if (!diagnostics.includes(code)) diagnostics.push(code); };
  const read = (name, path, maximum) => {
    try { const file = d.readFile(path, maximum); if (!Buffer.isBuffer(file.bytes) || file.bytes.length > maximum) throw Error();
      const value = object(JSON.parse(file.bytes.toString('utf8'))); const sha256 = hash(file.bytes);
      sources.push({ name, sha256, mtimeMs: integer(Math.floor(file.mtimeMs)) }); tracked.push({ name, path, maximum, sha256 }); return value;
    } catch { failed(`${name}-unavailable`); return null; }
  };
  const live = async () => {
    let health = null, workspaceEpoch = null;
    try { health = healthView(object(await d.getJson('/api/health'))); if (!health.candidateId || !health.status || !health.version) failed('health-incomplete'); } catch { failed('health-unavailable'); }
    try { workspaceEpoch = uuid(object(await d.getJson('/api/access/context')).workspaceEpoch); if (!workspaceEpoch) failed('workspace-epoch-unavailable'); } catch { failed('workspace-epoch-unavailable'); }
    return { health, workspaceEpoch };
  };
  const before = await live();
  const config = read('controller-config', configPath, HOST_OBSERVATION_LIMITS.configBytes);
  let runtime = null, disk = null, journal = null, operatorLease = null, agentDirectory = null;
  if (config) {
    if (![config.agentDirectory, config.agentNodePath, config.stateDirectory, config.workspaceDirectory].every(canonicalPath)) failed('configured-paths-invalid');
    else {
      try {
        agentDirectory = d.realpath(config.agentDirectory);
        const pkg = read('runtime-package', join(agentDirectory, 'package.json'), HOST_OBSERVATION_LIMITS.packageBytes);
        if (pkg?.name !== 'openclaw' || !version(pkg.version)) throw Error();
        runtime = { name: 'openclaw', version: pkg.version, agentVersion: pkg.version, resolvedDirectory: agentDirectory, nodePath: d.realpath(config.agentNodePath) };
      } catch { failed('runtime-unavailable'); }
      try { disk = d.disk(config.workspaceDirectory); if (!['totalBytes', 'usedBytes', 'freeBytes'].every(k => integer(disk[k]) !== null)) throw Error(); disk = { totalBytes: disk.totalBytes, usedBytes: disk.usedBytes, freeBytes: disk.freeBytes }; } catch { disk = null; failed('disk-unavailable'); }
      const saved = read('update-journal', join(config.stateDirectory, 'jobs/journal.json'), HOST_OBSERVATION_LIMITS.journalBytes);
      if (saved) {
        if (saved.format !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > HOST_OBSERVATION_LIMITS.journalJobs || !(saved.currentId === null || uuid(saved.currentId))) failed('update-journal-invalid');
        else {
          const matches = saved.jobs.filter(j => object(j).id === saved.currentId);
          const jobs = saved.jobs.slice(-HOST_OBSERVATION_LIMITS.jobs).map(j => jobView(object(j)));
          const currentJob = matches.length === 1 ? jobView(matches[0]) : null;
          if (saved.currentId !== null && matches.length !== 1 || [...jobs, ...(currentJob ? [currentJob] : [])].some(j => !j.id || !j.state || j.hold === null)) failed('update-journal-invalid');
          else journal = { currentId: saved.currentId, currentJob, latestRecordedJob: jobs.at(-1) ?? null, totalJobs: saved.jobs.length, truncated: saved.jobs.length > jobs.length, jobs };
        }
      }
      const lease = read('operator-lease', join(config.stateDirectory, 'operator-maintenance/current.json'), HOST_OBSERVATION_LIMITS.leaseBytes);
      if (lease) { operatorLease = leaseView(lease); if (!operatorLease.id || !operatorLease.phase || !operatorLease.candidateId || !operatorLease.workspaceEpoch) failed('operator-lease-invalid'); }
    }
  }
  for (const item of tracked) {
    try { if (hash(d.readFile(item.path, item.maximum).bytes) !== item.sha256) failed(`${item.name}-changed`); } catch { failed(`${item.name}-changed`); }
  }
  if (runtime) try { if (d.realpath(config.agentDirectory) !== agentDirectory || d.realpath(config.agentNodePath) !== runtime.nodePath) failed('runtime-selector-changed'); } catch { failed('runtime-selector-changed'); }
  const after = await live(), completedAtMilliseconds = d.now();
  const identityStable = !!before.workspaceEpoch && !!before.health?.candidateId && before.workspaceEpoch === after.workspaceEpoch && before.health.candidateId === after.health?.candidateId;
  if (!identityStable) failed('live-identity-changed-or-unknown');
  if (completedAtMilliseconds < observedAtMilliseconds || completedAtMilliseconds - observedAtMilliseconds > 300_000) failed('observation-time-invalid');
  return { format: 1, kind: 'nova-host-observation', readOnly: true, observedAtMilliseconds, completedAtMilliseconds,
    status: diagnostics.length ? 'unknown' : 'observed', atomic: false, identityStable,
    health: after.health, workspaceEpoch: identityStable ? after.workspaceEpoch : null, runtime, disk, journal, operatorLease,
    controller: { status: 'not-observed', holdFor: null, heartbeatAcknowledged: false },
    freshness: { maximumAgeMilliseconds: 300_000, sourceHashesRechecked: true }, sources, diagnostics,
    capacity: { status: 'unknown', reason: 'fresh-lifecycle-measurements-required', authoritativeAdmission: false },
    deliveryQualification: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.argv.length > 3) { process.stderr.write('Use Linux root: node scripts/release-observe-host.mjs [/etc/nova-update/config.json]\n'); process.exitCode = 1; }
  else { try { process.stdout.write(JSON.stringify(await observeReleaseHost({ configPath: process.argv[2] ?? '/etc/nova-update/config.json' }), null, 2) + '\n'); } catch { process.stderr.write('Host observation unavailable.\n'); process.exitCode = 1; } }
}
