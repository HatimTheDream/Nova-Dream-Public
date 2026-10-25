import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startServer } from '../apps/service/http';
import type { AssistantTransport } from '../apps/service/gateway';
import type { Attachment, Command, Entity } from '../packages/domain/contracts';
import { blankRecord, type Content } from '../packages/domain/workspace-records';
import type { ContentWorkspaceCommand, ContentWorkspaceReceipt } from '../packages/domain/content-workspace';

type Server = Awaited<ReturnType<typeof startServer>>;
type Session = { cookie: string; deviceId: string };
type Snapshot = { epoch: string; deviceId: string; records?: { content: Entity<Content>[] } };
type History = { versions: Entity<Content>[]; beforeRevision: number | null };

// This file is portable to an isolated application's tests/ directory. It does
// not read or write Store directly and never manufactures a saved response.
test('Content saves, conflicts, restore receipts and historical ZIP assets survive graceful HTTP restarts',
  { timeout: 90_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'nova-content-http-persistence-'));
    const forbiddenDispatches: string[] = [], forbiddenFetches: string[] = [], serviceOrigins: string[] = [];
    const gateway: AssistantTransport = {
      status: () => ({ state: 'unconfigured', message: 'Content persistence only', methods: [], grantedScopes: [], modelAuthReady: false }),
      subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
      request: async <T>(method: string): Promise<T> => {
        forbiddenDispatches.push(method);
        throw new Error(`Native/provider dispatch forbidden in Content persistence test: ${method}`);
      },
    };
    const realFetch = globalThis.fetch;
    // Prevent an accidental background fetch from turning this local journey
    // into external network activity. The disconnected transport also prevents
    // the maintained server from constructing its managed native runtime.
    const fetchGuard = t.mock.method(globalThis, 'fetch', ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
        forbiddenFetches.push(url.origin);
        return Promise.reject(new Error('Only loopback HTTP is permitted by this test'));
      }
      return realFetch(input, { ...init, redirect: 'error' });
    }) as typeof fetch);

    let server: Server | undefined;
    let failure: unknown;
    const open = async () => {
      assert.equal(server, undefined, 'The prior service must finish its maintained close before reopening');
      server = await startServer({ directory, port: 0, version: 'content-persistence-test', gateway });
      serviceOrigins.push(server.origin);
      assert.equal(server.runtime, undefined, 'The fixture must not create a managed native runtime');
    };
    const close = async () => {
      if (!server) return;
      const original = server;
      await original.close();
      server = undefined;
    };
    const request = (path: string, session?: Session, body?: unknown) => {
      assert(server);
      return fetch(server.origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Edition3-Client': '1',
          ...(session ? { Cookie: session.cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]),
      });
    };
    const json = async <T>(path: string, session?: Session, body?: unknown, status = 200): Promise<T> => {
      const response = await request(path, session, body);
      const text = await response.text();
      assert.equal(response.status, status, `${path}: ${text.slice(0, 500)}`);
      return JSON.parse(text) as T;
    };
    const createSession = async (): Promise<Session> => {
      const response = await request('/api/session', undefined, {});
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert(cookie, 'A fresh independent session must receive its own cookie');
      const value = await response.json() as { deviceId: string };
      return { cookie, deviceId: value.deviceId };
    };
    const discardAcknowledgement = async (path: string, session: Session, body: unknown) => {
      const response = await request(path, session, body);
      assert.equal(response.status, 200);
      // Deliberately discard the real server result without parsing or using it.
      // This models loss at the client's acknowledgement boundary, not a forced
      // TCP failure. Completion is recovered from the same original request.
      await response.arrayBuffer();
    };
    const snapshot = (session: Session) => json<Snapshot>('/api/snapshot', session);
    const history = (session: Session, id: string) => json<History>('/api/records/history', session, { kind: 'content', id });
    const onlyContent = (value: Snapshot, id: string) => {
      assert.equal(value.records?.content.length, 1, 'Replay must not create duplicate Content');
      const content = value.records!.content[0];
      assert.equal(content.id, id);
      return content;
    };

    try {
      await open();
      const first = await createSession(), second = await createSession();
      assert.notEqual(first.deviceId, second.deviceId);
      assert.notEqual(first.cookie, second.cookie);
      const initial = await snapshot(first), epoch = initial.epoch;
      assert.equal(initial.records?.content.length, 0);
      const originalAsset = Buffer.from([0, 255, 23, 91, 3, 13, 10]);
      const asset = await json<Attachment>('/api/attachments', first, {
        requestId: randomUUID(), epoch, name: 'Original Café.bin', base64: originalAsset.toString('base64'),
      });
      assert.equal(asset.sha256, createHash('sha256').update(originalAsset).digest('hex'));
      const originalBody = `\ufeff# Café 猫 🐾\r\n\r\nExact original writing.\n[Original asset](/api/attachments/${asset.id})\r\n`;
      const id = 'content:' + randomUUID();
      const originalCommand: Command = {
        requestId: randomUUID(), epoch, kind: 'content', entityId: id, expectedRevision: 0,
        payload: { ...blankRecord('content', 'UTC') as Content, title: 'Retained Writing',
          brief: 'Keep every character and original file.', body: originalBody, stage: 'drafting', assets: [asset] },
      };
      await discardAcknowledgement('/api/commands', first, originalCommand);
      await close();
      await open();

      // Both original cookie identities and the workspace epoch survive a real
      // close/reopen of the same isolated database; no session is reseeded.
      for (const session of [first, second]) {
        const resumed = await json<{ deviceId: string }>('/api/session', session, {});
        assert.equal(resumed.deviceId, session.deviceId);
        const current = await snapshot(session);
        assert.equal(current.epoch, epoch);
        assert.equal(current.deviceId, session.deviceId);
        assert.equal(onlyContent(current, id).value.body, originalBody);
      }
      const original = onlyContent(await snapshot(first), id);
      assert.equal(original.revision, 1);
      assert.deepEqual(original.value.assets, [asset]);
      const recoveredAck = await json<Entity<Content>>('/api/commands', first, originalCommand);
      assert.deepEqual(recoveredAck, original, 'The original acknowledgement must replay exactly');
      assert.deepEqual((await history(first, id)).versions, [original]);
      await json('/api/commands', first, { ...originalCommand, payload: { ...original.value, body: 'Changed request identity' } }, 409);

      // The second session can save newer work. The stale first window cannot
      // overwrite it, and both complete historical versions remain readable.
      const laterAssetBytes = Buffer.from('Later attachment\r\n猫\n');
      const laterAsset = await json<Attachment>('/api/attachments', second, {
        requestId: randomUUID(), epoch, name: 'Later.txt', base64: laterAssetBytes.toString('base64'),
      });
      const newer = await json<Entity<Content>>('/api/commands', second, {
        requestId: randomUUID(), epoch, kind: 'content', entityId: id, expectedRevision: 1,
        payload: { ...original.value, body: 'Newer published writing\r\n猫\n', assets: [asset, laterAsset],
          stage: 'published', publication: { kind: 'manual', date: '2026-10-24', note: 'Local fixture publication record' } },
      });
      assert.equal(newer.revision, 2);
      const conflict = await json<{ code: string }>('/api/commands', first, {
        requestId: randomUUID(), epoch, kind: 'content', entityId: id, expectedRevision: 1,
        payload: { ...original.value, body: 'Stale first-window writing must not replace version 2' },
      }, 409);
      assert.equal(conflict.code, 'revision_conflict');
      assert.deepEqual(onlyContent(await snapshot(first), id), newer);
      assert.deepEqual((await history(second, id)).versions, [newer, original]);

      const restore: ContentWorkspaceCommand = {
        type: 'restore', requestId: randomUUID(), epoch, contentId: id, expectedRevision: 2, revision: 1,
      };
      const unknown = await json<ContentWorkspaceReceipt>('/api/content/workspace/receipt', first, restore);
      assert.equal(unknown.state, 'unknown');
      assert.deepEqual((await history(first, id)).versions, [newer, original], 'Receipt reads must not restore');
      await discardAcknowledgement('/api/content/workspace', first, restore);
      const beforeRestartReceipt = await json<ContentWorkspaceReceipt>('/api/content/workspace/receipt', first, restore);
      assert.equal(beforeRestartReceipt.state, 'recorded');
      assert.deepEqual(beforeRestartReceipt.command, restore);
      assert('result' in beforeRestartReceipt);
      assert.deepEqual(beforeRestartReceipt.result, { id, revision: 3 });
      await close();
      await open();

      const receipt = await json<ContentWorkspaceReceipt>('/api/content/workspace/receipt', first, restore);
      assert.deepEqual(receipt, beforeRestartReceipt, 'The original Content receipt survives another restart');
      const restored = onlyContent(await snapshot(second), id);
      assert.equal(restored.revision, 3);
      assert.equal(restored.value.body, originalBody);
      assert.equal(restored.value.stage, 'drafting');
      assert.equal(restored.value.publication, null);
      assert.deepEqual(restored.value.assets, [asset]);
      assert.deepEqual(await json('/api/content/workspace', first, restore), restored);
      assert.deepEqual(await json('/api/commands', first, originalCommand), original,
        'Even after later edits/restore, the original save returns its own acknowledgement');
      assert.deepEqual((await history(second, id)).versions, [restored, newer, original]);
      assert.deepEqual(onlyContent(await snapshot(first), id), restored, 'Replays cannot roll the current head backward');

      // Export a historical version, not the restored current head. Parse the
      // maintained uncompressed ZIP and verify exact saved body and asset bytes.
      const response = await request(`/api/content/package?id=${encodeURIComponent(id)}&revision=2`, second);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/zip');
      const zip = Buffer.from(await response.arrayBuffer());
      const entries = new Map<string, Buffer>();
      let at = 0;
      while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
        assert.equal(zip.readUInt16LE(at + 8), 0, 'The maintained package uses stored entries');
        const size = zip.readUInt32LE(at + 18), nameLength = zip.readUInt16LE(at + 26), extra = zip.readUInt16LE(at + 28);
        const start = at + 30 + nameLength + extra, end = start + size;
        assert(end <= zip.length);
        const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
        assert(!entries.has(name)); assert(!name.includes('..')); assert(!name.startsWith('/'));
        entries.set(name, zip.subarray(start, end));
        at = end;
      }
      assert.equal(zip.readUInt32LE(at), 0x02014b50);
      assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
      const manifestBytes = entries.get('manifest.json'); assert(manifestBytes);
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
        contentId: string; revision: number; stage: string; draft: string;
        assets: (Attachment & { path: string })[]; files: { path: string; size: number; sha256: string }[];
      };
      assert.equal(manifest.contentId, id); assert.equal(manifest.revision, 2); assert.equal(manifest.stage, 'published');
      assert.deepEqual(entries.get(manifest.draft), Buffer.from(newer.value.body, 'utf8'));
      assert.deepEqual(manifest.assets.map(({ path: _path, ...file }) => file), [asset, laterAsset]);
      assert.deepEqual(entries.get(manifest.assets[0].path), originalAsset);
      assert.deepEqual(entries.get(manifest.assets[1].path), laterAssetBytes);
      for (const file of manifest.files) {
        const bytes = entries.get(file.path); assert(bytes);
        assert.equal(bytes.length, file.size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      }
      assert.deepEqual((await history(first, id)).versions, [restored, newer, original], 'Export is read-only');
    } catch (error) {
      failure = error;
    } finally {
      const retainCleanupFailure = (error: unknown, message: string) => {
        failure = failure === undefined ? error : new AggregateError([failure, error], message);
      };
      // Record exact owned paths/ports before any cleanup can fail. Never log
      // cookies or tokens, and never let diagnostic cleanup replace the journey.
      try { t.diagnostic(`Content persistence fixture: ${directory}; owned service origins: ${JSON.stringify(serviceOrigins)}`); }
      catch (error) { retainCleanupFailure(error, 'Journey and fixture diagnostic both failed'); }
      try { await close(); }
      catch (error) { retainCleanupFailure(error, 'Journey and graceful close both failed'); }
      try { fetchGuard.mock.restore(); }
      catch (error) { retainCleanupFailure(error, 'Journey and fetch mock restoration both failed'); }
      try { t.diagnostic(`All maintained Content service closes completed: ${server === undefined}`); }
      catch (error) { retainCleanupFailure(error, 'Journey and close diagnostic both failed'); }
      if (forbiddenDispatches.length || forbiddenFetches.length) {
        const error = new Error(`Forbidden effects: ${JSON.stringify({ forbiddenDispatches, forbiddenFetches })}`);
        retainCleanupFailure(error, 'Journey and effect boundary failed');
      }
      if (failure !== undefined || server || t.signal.aborted) {
        try { t.diagnostic(`Preserved Content persistence fixture: ${directory}`); }
        catch (error) { retainCleanupFailure(error, 'Journey and preservation diagnostic both failed'); }
      } else {
        try {
          assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
          assert(basename(directory).startsWith('nova-content-http-persistence-'));
          rmSync(directory, { recursive: true, force: true });
        } catch (error) { retainCleanupFailure(error, 'Successful journey fixture cleanup failed'); }
      }
    }
    if (failure !== undefined) throw failure;
  });
