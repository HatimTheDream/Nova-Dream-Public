import { z } from 'zod';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, chmodSync, readFileSync, realpathSync, openSync, closeSync, fstatSync, constants, unlinkSync } from 'node:fs';
import { dirname, basename, isAbsolute, join } from 'node:path';
import { canonical } from '../../../packages/domain/contracts.js';
import { sourcePluginId, sourceTransferVersion, sourceTransferLimit, sourceStageSchema, sourceMime, type SourceReference } from '../../../packages/domain/source-transfer.js';

// Public OpenClaw 2026.9.2 SDK subset. This stages bytes only; it cannot
// execute an agent, change session settings, or write native registry tables.
export type SourcePluginApi = {
  registrationMode: string; pluginConfig?: Record<string, unknown>;
  runtime: {
    version: string;
    agent: { session: { getSessionEntry(params: { agentId: string; sessionKey: string; readConsistency: 'latest' }): { sessionId?: string } | undefined } };
    state: { resolveStateDir(): string };
    channel: { media: { saveMediaBuffer(bytes: Buffer, mime: string, subdir: string, maxBytes: number, filename: string): Promise<{ id: string; path: string; size: number; contentType?: string }> } };
  };
  registerGatewayMethod(name: string, handler: (options: { params: unknown; respond(ok: boolean, value?: unknown, error?: { code: string; message: string }): void }) => Promise<void>, options: { scope: 'operator.write' }): void;
  registerService(service: { id: string; start(): void; stop(): Promise<void> }): void;
};
type Cached = { file: SourceReference['file']; mimeType: string; mediaId: string; path: string };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function registerSourceTransfer(api: SourcePluginApi) {
  if (api.registrationMode !== 'full') return;
  const config = z.object({ epoch: z.string().uuid(), bundlePath: z.string().min(1), cacheDirectory: z.string().min(1) }).strict().parse(api.pluginConfig);
  let db: DatabaseSync | undefined, closing = false, reservedBytes = 0, reservedEntries = 0;
  const flights = new Map<string, { digest: string; promise: Promise<SourceReference> }>();
  const cache = () => {
    if (closing) throw new Error('The source connection is stopping.');
    if (db) return db;
    if (!isAbsolute(config.cacheDirectory)) throw new Error('Source cache must use owned local storage.');
    mkdirSync(config.cacheDirectory, { recursive: true, mode: 0o700 });
    const path = join(config.cacheDirectory, 'sources.sqlite');
    if (lstatSync(config.cacheDirectory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink())) throw new Error('Source cache must use owned local storage.');
    const opened = new DatabaseSync(path);
    try {
      const version = Number(opened.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1 || (version === 0 && Number(opened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n))) throw new Error('This source cache needs its original compatible adapter.');
      opened.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1;');
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      db = opened; return db;
    } catch (error) { opened.close(); throw error; }
  };
  const verify = (value: Cached) => {
    const root = realpathSync(join(api.runtime.state.resolveStateDir(), 'media', 'inbound'));
    if (!isAbsolute(value.path) || basename(value.path) !== value.mediaId || realpathSync(dirname(value.path)) !== root || lstatSync(value.path).isSymbolicLink()) throw new Error('The staged source is outside the native media store.');
    const file = openSync(value.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size !== value.file.size || stat.size > sourceTransferLimit || sha(readFileSync(file)) !== value.file.sha256) throw new Error('The staged source bytes no longer match their original.');
    } finally { closeSync(file); }
  };
  api.registerGatewayMethod('e3.sources.stage', async ({ params, respond }) => {
    try {
      const input = sourceStageSchema.parse(params), mimeType = sourceMime(input.file.name);
      const current = () => {
        if (closing || api.runtime.version !== sourceTransferVersion || input.epoch !== config.epoch) throw new Error('Reconnect this source to its original Nova Dream runtime.');
        if (api.runtime.agent.session.getSessionEntry({ agentId: 'main', sessionKey: input.nativeKey, readConsistency: 'latest' })?.sessionId !== input.nativeId) throw new Error('The original source conversation changed.');
      };
      current();
      const bytes = Buffer.from(input.content, 'base64');
      if (!mimeType || bytes.length > sourceTransferLimit || bytes.length !== input.file.size || sha(bytes) !== input.file.sha256) throw new Error('The source format, length or hash could not be verified.');
      const id = `${input.epoch}:${input.file.id}`, digest = canonical(input.file), running = flights.get(id);
      if (running && running.digest !== digest) throw new Error('This source identity belongs to different bytes.');
      const stage = async (): Promise<SourceReference> => {
        const database = cache(), row = database.prepare('SELECT payload FROM sources WHERE id=?').get(id);
        const previous: Cached | undefined = row ? JSON.parse(String(row.payload)) : undefined;
        if (previous && canonical(previous.file) !== digest) throw new Error('This source identity belongs to different bytes.');
        if (previous && existsSync(previous.path)) {
          verify(previous); current();
          return { epoch: input.epoch, nativeKey: input.nativeKey, nativeId: input.nativeId, ...previous };
        }
        const used = database.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM sources').get()!;
        const additionalBytes = previous ? 0 : bytes.length, additionalEntries = previous ? 0 : 1;
        if (Number(used.count) + reservedEntries + additionalEntries > 10000 || Number(used.bytes) + reservedBytes + additionalBytes > 256 * 1024 * 1024) throw new Error('The native source cache is full. Existing saved files are kept.');
        reservedBytes += additionalBytes; reservedEntries += additionalEntries;
        try {
          const saved = await api.runtime.channel.media.saveMediaBuffer(bytes, mimeType, 'inbound', sourceTransferLimit, `source-${input.file.id}.${input.file.name.split('.').pop()!.toLowerCase()}`);
          const value: Cached = { file: input.file, mimeType, mediaId: saved.id, path: saved.path };
          try {
            verify(value); current();
            database.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,payload=excluded.payload').run(id, bytes.length, JSON.stringify(value));
          } catch (error) {
            // This path was just created by this exact SDK call, never a cached
            // or owner-selected path. Remove only our unadmitted copy.
            try {
              if (isAbsolute(saved.path) && basename(saved.path) === saved.id && realpathSync(dirname(saved.path)) === realpathSync(join(api.runtime.state.resolveStateDir(), 'media', 'inbound'))) unlinkSync(saved.path);
            } catch { /* Preserve the original failure. */ }
            throw error;
          }
          return { epoch: input.epoch, nativeKey: input.nativeKey, nativeId: input.nativeId, ...value };
        } finally { reservedBytes -= additionalBytes; reservedEntries -= additionalEntries; }
      };
      let work = running?.promise;
      if (!work) { work = Promise.resolve().then(stage); flights.set(id, { digest, promise: work }); work.finally(() => flights.delete(id)).catch(() => undefined); }
      const value = await work; current();
      // Concurrent users of the same bytes receive their own exact target.
      respond(true, { ...value, nativeKey: input.nativeKey, nativeId: input.nativeId });
    } catch (error) { respond(false, undefined, { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Source transfer could not be verified.' }); }
  }, { scope: 'operator.write' });
  api.registerService({ id: sourcePluginId, start() {}, async stop() { closing = true; await Promise.allSettled([...flights.values()].map(flight => flight.promise)); db?.close(); db = undefined; } });
}

export default { id: sourcePluginId, name: 'Nova Dream source transfer', description: 'Verified source files in the native managed media store.', register: registerSourceTransfer };
