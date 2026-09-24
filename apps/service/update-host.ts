import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { UpdateFeed, type UpdateFeedInstalled } from './update-feed.js';
import { UpdateAdmissionError, UpdateSupervisor } from './update-supervisor.js';
import { ManagedUpdateInstaller } from './update-installer.js';
import { FileUpdateJournal, guardedUpdatePath, readUpdateJson, writeUpdateJson } from './update-storage.js';
import { updateHeartbeatSchema } from './update-host-client.js';

export const updateHostSocket = '/run/nova-update/control.sock';
const absolute = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value, 'Use a canonical absolute path.');
export const updateHostConfigSchema = z.object({
  format: z.literal(1), socketGroup: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('nova'),
  stateDirectory: absolute, workspaceDirectory: absolute, releaseDirectory: absolute, runtimeDirectory: absolute,
  appCurrent: absolute, agentDirectory: absolute,
  feed: z.object({ url: z.string().url().max(2048), publicKeyFile: absolute, channel: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), artifactOrigins: z.array(z.string().url().max(2048)).min(1).max(8) }).strict(),
}).strict();
export type UpdateHostConfig = z.infer<typeof updateHostConfigSchema>;
type CandidateVerifier = (directory: string) => { id: string; manifest: { version: string; schemaVersion: number }; bytes: Map<string, unknown> };
const within = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);

/** Root reads the actual selected app pointer and protected runtime package. No workspace or account files are read. */
export function installedUpdateIdentity(config: UpdateHostConfig, verifyCandidate: CandidateVerifier): UpdateFeedInstalled {
  guardedUpdatePath(dirname(config.appCurrent), true);
  const link = lstatSync(config.appCurrent);
  if (!link.isSymbolicLink() || link.uid !== 0) throw Error('The current application pointer must be a root-owned symlink.');
  const selected = resolve(dirname(config.appCurrent), readlinkSync(config.appCurrent));
  if (realpathSync(config.appCurrent) !== selected || !within(selected, config.releaseDirectory) || selected === config.releaseDirectory) throw Error('The selected application must be a direct immutable release.');
  guardedUpdatePath(selected, true);
  guardedUpdatePath(config.agentDirectory, true);
  if (!within(config.agentDirectory, config.runtimeDirectory)) throw Error('The managed agent package is outside its protected runtime.');
  guardedUpdatePath(join(selected, 'package.json'), false); guardedUpdatePath(join(selected, 'dist/candidate.json'), false);
  const candidate = verifyCandidate(selected);
  for (const path of candidate.bytes.keys()) guardedUpdatePath(join(selected, path), false);
  const packageFile = join(config.agentDirectory, 'package.json');
  guardedUpdatePath(packageFile, false); guardedUpdatePath(join(config.agentDirectory, 'openclaw.mjs'), false);
  const agent = z.object({ name: z.literal('openclaw'), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/) }).passthrough().parse(readUpdateJson(packageFile, 256 * 1024));
  return { candidateId: candidate.id, novaVersion: candidate.manifest.version, agentVersion: agent.version, schemaVersion: candidate.manifest.schemaVersion, platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), protocolVersion: 4 };
}

type HostController = Pick<UpdateSupervisor, 'view' | 'check' | 'request' | 'cancel' | 'beat'>;
export function updateHostRequestHandler(supervisor: HostController) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      const bytes = Buffer.from(JSON.stringify(body));
      if (bytes.length > 65536) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"message":"The update state needs host review."}'); return; }
      response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', Connection: 'close' }); response.end(bytes);
    };
    if (request.method !== 'POST' || !/^\/v1\/(status|check|install|cancel|heartbeat)$/.test(request.url ?? '') || request.headers.origin || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) { send(400, { message: 'Invalid local update request.' }); request.resume(); return; }
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65536)) { send(413, { message: 'The update request is too large.' }); request.resume(); return; }
    try {
      const parts: Buffer[] = []; let size = 0;
      for await (const part of request) { size += part.length; if (size > 65536) { send(413, { message: 'The update request is too large.' }); return; } parts.push(part); }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
      switch (request.url) {
        case '/v1/status': z.object({}).strict().parse(value); send(200, supervisor.view()); break;
        case '/v1/check': z.object({}).strict().parse(value); send(200, await supervisor.check()); break;
        case '/v1/install': send(200, await supervisor.request(value)); break;
        case '/v1/cancel': send(200, supervisor.cancel(value)); break;
        case '/v1/heartbeat': send(200, supervisor.beat(updateHeartbeatSchema.parse(value))); break;
      }
    } catch (error) {
      if (error instanceof UpdateAdmissionError || error instanceof z.ZodError) send(409, { message: error instanceof UpdateAdmissionError ? error.message : 'The host could not accept this update request. Refresh Software Update and try again.' });
      else send(500, { message: 'The update outcome needs reconciliation. Refresh Software Update before trying again.' });
    }
  };
}

async function clearAbandonedSocket(gid: number) {
  if (!existsSync(updateHostSocket)) return;
  const info = lstatSync(updateHostSocket);
  if (!info.isSocket() || info.uid !== 0 || info.gid !== gid) throw Error('The update socket needs operator review.');
  await new Promise<void>((accept, reject) => {
    const socket = connect(updateHostSocket);
    socket.once('connect', () => { socket.destroy(); reject(Error('An update host is already running.')); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(Error('The update socket state is uncertain.')); });
    socket.once('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNREFUSED') { reject(error); return; } const current = lstatSync(updateHostSocket); if (current.ino !== info.ino || current.dev !== info.dev) { reject(Error('The update socket changed.')); return; } unlinkSync(updateHostSocket); accept(); });
  });
}

/** Called by the root service launcher, never by the workspace process. */
export async function startUpdateHost(configurationPath: string, verifyCandidate: CandidateVerifier) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('The managed update host requires its provisioned Linux root service.');
  guardedUpdatePath(configurationPath, false);
  const config = updateHostConfigSchema.parse(readUpdateJson(configurationPath, 64 * 1024));
  for (const path of [config.stateDirectory, config.releaseDirectory, config.runtimeDirectory]) guardedUpdatePath(path, true);
  const checkSavedPermissions = (directory: string) => {
    for (const name of readdirSync(directory)) { const path = join(directory, name), info = lstatSync(path); guardedUpdatePath(path, info.isDirectory()); if (info.isDirectory()) checkSavedPermissions(path); }
  };
  checkSavedPermissions(config.stateDirectory);
  // The app user owns workspace records. Only validate its canonical location; do not read them.
  if (realpathSync(config.workspaceDirectory) !== config.workspaceDirectory) throw Error('Use the actual durable workspace directory.');
  for (const path of [config.stateDirectory, configurationPath, config.feed.publicKeyFile]) if (within(path, config.workspaceDirectory) || within(path, config.releaseDirectory) || within(path, config.runtimeDirectory)) throw Error('Update trust and journals must remain outside workspace and release replacement.');
  if (within(config.workspaceDirectory, config.stateDirectory) || within(config.releaseDirectory, config.stateDirectory) || within(config.runtimeDirectory, config.stateDirectory)) throw Error('Update journals cannot contain application or workspace data.');
  guardedUpdatePath(config.feed.publicKeyFile, false); guardedUpdatePath(dirname(updateHostSocket), true);
  const publicKeyInfo = lstatSync(config.feed.publicKeyFile); if (publicKeyInfo.size > 16 * 1024) throw Error('Invalid update verification key.');
  const groupText = readFileSync('/etc/group', 'utf8'); if (groupText.length > 1024 * 1024) throw Error('Invalid system group registry.');
  const group = groupText.split('\n').find(line => line.startsWith(config.socketGroup + ':'))?.split(':');
  if (!group || !/^\d+$/.test(group[2])) throw Error('Provision the update socket group first.');
  const gid = Number(group[2]);
  let installed = installedUpdateIdentity(config, verifyCandidate), observedAt = Date.now();
  const current = () => {
    // Root-protected candidates are immutable. Recheck the complete bytes after a pointer change or each minute.
    if (Date.now() - observedAt > 60_000 || realpathSync(config.appCurrent) !== selectedPath) { installed = installedUpdateIdentity(config, verifyCandidate); selectedPath = realpathSync(config.appCurrent); observedAt = Date.now(); }
    return installed;
  };
  let selectedPath = realpathSync(config.appCurrent);
  const cacheFile = join(config.stateDirectory, 'feed.json');
  const feed = new UpdateFeed({ store: { read: () => existsSync(cacheFile) ? readUpdateJson(cacheFile, 256 * 1024) : undefined, write: value => writeUpdateJson(cacheFile, value) }, installed: current,
    trust: { url: config.feed.url, channel: config.feed.channel, artifactOrigins: config.feed.artifactOrigins, publicKey: readFileSync(config.feed.publicKeyFile, 'utf8') } });
  for (const path of [join(config.stateDirectory, 'jobs'), join(config.stateDirectory, 'staging')]) { mkdirSync(path, { recursive: true, mode: 0o700 }); guardedUpdatePath(path, true); }
  const supervisor = new UpdateSupervisor(feed, new FileUpdateJournal(join(config.stateDirectory, 'jobs')), new ManagedUpdateInstaller(join(config.stateDirectory, 'staging'), configurationPath), () => current().candidateId);
  await clearAbandonedSocket(gid);
  const server = createServer(updateHostRequestHandler(supervisor)); server.requestTimeout = 15_000; server.headersTimeout = 5_000; server.maxConnections = 32;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(updateHostSocket, () => { server.removeListener('error', reject); accept(); }); });
  chownSync(updateHostSocket, 0, gid); chmodSync(updateHostSocket, 0o660);
  feed.start();
  const poll = setInterval(() => { try { supervisor.poll(); } catch { /* Keep the durable hold; a failed observation cannot authorize work. */ } }, 2000); poll.unref();
  supervisor.poll();
  return { config, supervisor, async close() { clearInterval(poll); feed.stop(); supervisor.stop(); await new Promise<void>(accept => server.close(() => accept())); } };
}
