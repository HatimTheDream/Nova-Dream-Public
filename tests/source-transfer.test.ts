import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSourceTransfer, type SourcePluginApi } from '../apps/service/source-plugin/index.js';
import { withSourcePlugin } from '../apps/service/source-runtime-config.js';
import { sourceTransferLimit, type SourceReference } from '../packages/domain/source-transfer.js';

const cleanup: (() => Promise<void>)[] = [];
after(async () => { for (const close of cleanup) await close(); });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'e3-native-sources-')), nativeRoot = join(directory, 'native'), inbound = join(nativeRoot, 'media', 'inbound'), cacheDirectory = join(directory, 'cache'), epoch = randomUUID(), nativeKey = `e3:${randomUUID()}`, nativeId = randomUUID();
  mkdirSync(inbound, { recursive: true });
  const sessions = new Map([[nativeKey, nativeId]]), methods = new Map<string, Parameters<SourcePluginApi['registerGatewayMethod']>[1]>();
  const calls: { bytes: Buffer; mime: string }[] = [];
  let stop: () => Promise<void> = async () => {}, hold: Promise<void> | undefined, outside = false;
  const api: SourcePluginApi = { registrationMode: 'full', pluginConfig: { epoch, cacheDirectory, bundlePath: '/fixture/source-plugin' }, runtime: { version: '2026.9.2', agent: { session: { getSessionEntry: params => ({ sessionId: sessions.get(params.sessionKey) }) } }, state: { resolveStateDir: () => nativeRoot }, channel: { media: { saveMediaBuffer: async (bytes, mime) => {
    calls.push({ bytes, mime }); await hold;
    const id = `${randomUUID()}.file`, path = join(outside ? directory : inbound, id); writeFileSync(path, bytes); return { id, path, size: bytes.length, contentType: mime };
  } } } }, registerGatewayMethod(name, handler, options) { assert.equal(options.scope, 'operator.write'); methods.set(name, handler); }, registerService(service) { stop = service.stop; } };
  registerSourceTransfer(api);
  cleanup.push(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  const input = (text = 'Whole source bytes', name = 'reference.txt') => { const bytes = Buffer.from(text); return { epoch, nativeKey, nativeId, file: { id: randomUUID(), name, size: bytes.length, sha256: digest(bytes) }, content: bytes.toString('base64') }; };
  const invoke = async (params: unknown) => {
    let result: unknown, error: string | undefined;
    await methods.get('e3.sources.stage')!({ params, respond(ok, value, failure) { if (ok) result = value; else error = failure?.message; } });
    if (error) throw new Error(error); return result as SourceReference;
  };
  return { directory, inbound, cacheDirectory, api, sessions, calls, methods, input, invoke, hold(value: Promise<void> | undefined) { hold = value; }, outside(value: boolean) { outside = value; }, async stop() { await stop(); }, async reload() { await stop(); methods.clear(); registerSourceTransfer(api); } };
}

test('source discovery and disabled adapters leave persistent state and existing choices alone', () => {
  const f = fixture(); assert.equal(existsSync(f.cacheDirectory), false);
  f.api.registrationMode = 'discovery'; f.methods.clear(); registerSourceTransfer(f.api); assert.equal(f.methods.size, 0);
  const config = { agents: { defaults: { model: 'owner-choice' } }, plugins: { allow: ['owner-plugin'], entries: { 'edition3-sources': { enabled: false } } } };
  assert.deepEqual(withSourcePlugin(config, randomUUID(), '/source', '/cache'), config);
});

test('whole-file staging joins concurrent identical transfers and reuses verified bytes after restart', async () => {
  const f = fixture(), input = f.input('Whole UTF-8 café 🦊 source.');
  const [first, second] = await Promise.all([f.invoke(input), f.invoke(input)]);
  assert.equal(f.calls.length, 1); assert.deepEqual(first, second); assert.equal(readFileSync(first.path).toString(), 'Whole UTF-8 café 🦊 source.');
  await f.reload(); const reopened = await f.invoke(input); assert.equal(reopened.path, first.path); assert.equal(f.calls.length, 1);
  assert.equal(reopened.nativeId, input.nativeId);
});

test('same source bytes can be reused only with a currently matching native conversation receipt', async () => {
  const f = fixture(), input = f.input(); const secondKey = `agent:main:e3:${randomUUID()}`, secondId = randomUUID(); f.sessions.set(secondKey, secondId);
  const [a, b] = await Promise.all([f.invoke(input), f.invoke({ ...input, nativeKey: secondKey, nativeId: secondId })]);
  assert.equal(a.path, b.path); assert.equal(b.nativeKey, secondKey); assert.equal(b.nativeId, secondId); assert.equal(f.calls.length, 1);
  f.sessions.set(secondKey, randomUUID()); await assert.rejects(f.invoke({ ...input, nativeKey: secondKey, nativeId: secondId }), /conversation changed/);
});

test('epoch, native identity, file format, byte length and hash are checked before any native write', async () => {
  const f = fixture(), input = f.input();
  await assert.rejects(f.invoke({ ...input, epoch: randomUUID() }), /original Nova Dream runtime/);
  await assert.rejects(f.invoke({ ...input, nativeId: randomUUID() }), /conversation changed/);
  await assert.rejects(f.invoke({ ...input, file: { ...input.file, size: input.file.size + 1 } }), /length or hash/);
  await assert.rejects(f.invoke({ ...input, file: { ...input.file, sha256: 'f'.repeat(64) } }), /length or hash/);
  await assert.rejects(f.invoke({ ...input, file: { ...input.file, name: 'run.exe' } }), /format/);
  await assert.rejects(f.invoke({ ...input, nativeKey: '../outside' }));
  f.api.runtime.version = 'future'; await assert.rejects(f.invoke(input), /original Nova Dream runtime/);
  assert.equal(f.calls.length, 0);
});

test('reusing a source identity with different metadata or altered cached bytes never overwrites the saved file', async () => {
  const f = fixture(), input = f.input(), staged = await f.invoke(input);
  await assert.rejects(f.invoke({ ...input, file: { ...input.file, name: 'different.md' } }), /different bytes/);
  writeFileSync(staged.path, 'changed native copy');
  await assert.rejects(f.invoke(input), /no longer match/);
  assert.equal(readFileSync(staged.path).toString(), 'changed native copy'); assert.equal(f.calls.length, 1);
});

test('a native target replaced during upload discards only the newly created unadmitted copy', async () => {
  const f = fixture(), input = f.input(); let release!: () => void; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.invoke(input); await Promise.resolve(); await Promise.resolve(); f.sessions.set(input.nativeKey, randomUUID()); release();
  await assert.rejects(pending, /conversation changed/); assert.equal(readdirSync(f.inbound).length, 0);
});

test('a stopping adapter waits for its upload and never admits a late source', async () => {
  const f = fixture(), input = f.input(); let release!: () => void; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.invoke(input); await Promise.resolve(); await Promise.resolve(); const stopped = f.stop(); release();
  await assert.rejects(pending, /original Nova Dream runtime/); await stopped; assert.equal(readdirSync(f.inbound).length, 0);
});

test('unexpected native paths and symlinked cache files are rejected without deleting unrelated files', async () => {
  const f = fixture(); f.outside(true); await assert.rejects(f.invoke(f.input()), /outside the native media store/);
  assert.ok(readdirSync(f.directory).some(name => name.endsWith('.file')));
  const other = fixture(), input = other.input(), staged = await other.invoke(input), ownerPath = join(other.directory, 'owner.txt');
  writeFileSync(ownerPath, Buffer.from(input.content, 'base64')); rmSync(staged.path); symlinkSync(ownerPath, staged.path);
  await assert.rejects(other.invoke(input)); assert.equal(readFileSync(ownerPath).toString(), 'Whole source bytes');
});

test('files exceeding the full attachment limit are rejected without a native write', async () => {
  const f = fixture(), input = f.input('x'.repeat(sourceTransferLimit + 1));
  await assert.rejects(f.invoke(input)); assert.equal(f.calls.length, 0);
});

test('source adapter configuration updates its own path and preserves unrelated plugins and disabled extraction', () => {
  const epoch = randomUUID(), original = { auth: { owner: 'kept' }, plugins: { allow: ['openai', 'edition3-sources'], load: { paths: ['/other', '/old/source'] }, entries: { 'document-extract': { enabled: false }, 'edition3-sources': { enabled: true, config: { bundlePath: '/old/source' } } } } };
  const updated = withSourcePlugin(original, epoch, '/new/source', '/cache');
  assert.deepEqual(updated.auth, original.auth); assert.deepEqual(updated.plugins?.load?.paths, ['/other', '/new/source']); assert.deepEqual(updated.plugins?.entries?.['document-extract'], { enabled: false });
  assert.deepEqual(withSourcePlugin(updated, epoch, '/new/source', '/cache'), updated);
});


test('automatically named dashboard chats keep source transfer bound to their exact native session', async () => {
  const f = fixture(), input = f.input(), nativeKey = `agent:main:dashboard:e3-${randomUUID()}`;
  f.sessions.set(nativeKey, input.nativeId);
  const saved = await f.invoke({ ...input, nativeKey }); assert.equal(saved.nativeKey, nativeKey);
  await assert.rejects(f.invoke({ ...input, nativeKey, nativeId: randomUUID() }), /session|conversation/i);
  await assert.rejects(f.invoke({ ...input, nativeKey: 'agent:other:dashboard:e3-' + randomUUID() }));
});
