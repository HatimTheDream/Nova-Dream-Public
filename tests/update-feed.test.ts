import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { UpdateFeed, updateFeedLimits, updateManifestSchema, type UpdateCurrentCandidate, type UpdateFeedInstalled, type UpdateFeedOptions, type UpdateManifest, type UpdateRelease } from '../apps/service/update-feed.js';
import { updateInstallRequestSchema } from '../packages/domain/software-update.js';
import { OpenClawUpdateFeed } from '../apps/service/openclaw-update-feed.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const keys = generateKeyPairSync('ed25519');
const hostId = 'a'.repeat(64), candidateId = 'b'.repeat(64);
const installed: UpdateFeedInstalled = { candidateId: hostId, novaVersion: '1.12.11', agentVersion: '2026.9.2', platform: 'linux', arch: 'x64', nodeMajor: 24, schemaVersion: 55, protocolVersion: 4 };
const target: UpdateRelease = {
  candidateId, novaVersion: '1.13.0', agentVersion: '2026.9.2', fromCandidateId: hostId, platform: 'linux', arch: 'x64', nodeMajor: 24,
  notes: ['A reviewed compatible update.'],
  compatibility: { reviewed: true, gatewayProtocol: 4, fromNovaVersion: '1.12.11', fromAgentVersion: '2026.9.2', fromSchemaVersion: 55, toSchemaVersion: 55, pluginVersion: '1.13.0' },
  recovery: { pairedSnapshot: true, independentRestore: true, readinessTimeoutSeconds: 120 },
  bundle: { url: 'https://updates.example.test/bundles/reviewed.tar.gz', bytes: 8192, sha256: 'c'.repeat(64), runnerSha256: 'd'.repeat(64) },
};

function fixture() {
  let now = Date.parse('2026-09-24T12:00:00Z'), state: unknown, calls = 0;
  let host = structuredClone(installed);
  let respond: (init?: RequestInit) => Response | Promise<Response> = () => response(defaultManifest);
  const manifest = (releases: UpdateRelease[] = [target], sequence = 1): UpdateManifest => ({ format: 1, channel: 'stable', sequence, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * DAY).toISOString(), releases: structuredClone(releases) });
  const defaultManifest = manifest();
  const envelope = (value: unknown, privateKey = keys.privateKey) => {
    const payload = Buffer.from(JSON.stringify(value));
    return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  };
  const response = (value: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(envelope(value)), { status: 200, headers });
  const options: UpdateFeedOptions = {
    store: { read: () => state, write: value => { state = structuredClone(value); } },
    installed: () => host,
    trust: { url: 'https://updates.example.test/stable.json', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), channel: 'stable', artifactOrigins: ['https://updates.example.test'] },
    now: () => now, random: () => 0.5,
    fetch: (async (url, init) => { calls++; assert.equal(url, 'https://updates.example.test/stable.json'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); return respond(init); }) as typeof fetch,
  };
  const feed = new UpdateFeed(options);
  return { feed, options, manifest, envelope, response, calls: () => calls, advance: (ms: number) => { now += ms; }, setResponder: (next: typeof respond) => { respond = next; }, state: () => structuredClone(state) as Record<string, unknown>, setState: (next: unknown) => { state = next; }, setHost: (next: UpdateFeedInstalled) => { host = next; } };
}

test('one host check coalesces tabs, verifies the pair and returns only bounded public release details', async () => {
  const f = fixture(); let release!: (response: Response) => void;
  f.setResponder(() => new Promise(resolve => { release = resolve; }));
  const first = f.feed.check(), second = f.feed.check(true);
  assert.equal(f.feed.status().availability, 'checking'); assert.equal(f.calls(), 1);
  release(f.response(f.manifest()));
  assert.equal((await first).availability, 'available'); assert.equal((await second).availability, 'available');
  const status = f.feed.status();
  assert.deepEqual(status.release, { candidateId, releaseId: target.bundle.sha256, novaVersion: target.novaVersion, agentVersion: target.agentVersion, notes: target.notes, downloadBytes: 8192 });
  assert(!JSON.stringify(status).includes('https:')); assert(!JSON.stringify(status).includes('runner'));
  assert.equal(f.feed.verifiedRelease(candidateId)?.bundle.sha256, target.bundle.sha256);
  assert.equal(f.feed.verifiedRelease(hostId), undefined);
  const copy = f.feed.verifiedRelease(candidateId)!; copy.bundle.sha256 = '0'.repeat(64);
  assert.equal(f.feed.verifiedRelease(candidateId)?.bundle.sha256, target.bundle.sha256);
});

test('an independently discovered engine update is never reported as fully up to date', async () => {
  const f=fixture();let cached:unknown;
  const agentFeed=new OpenClawUpdateFeed({installed:()=>installed.agentVersion,read:()=>cached,write:value=>{cached=value;},fetch:(async()=>new Response(JSON.stringify({tag_name:'v2026.9.6',draft:false,prerelease:false,html_url:'https://github.com/openclaw/openclaw/releases/tag/v2026.9.6'}))) as typeof fetch});
  const current={...installed,agentVersion:installed.agentVersion!,protocolVersion:4};
  f.setResponder(()=>f.response({...f.manifest([]),currentCandidates:[current]}));
  const feed=new UpdateFeed({...f.options,agentFeed});
  const status=await feed.check();
  assert.equal(status.availability,'available');assert.equal(status.agentUpdate?.version,'2026.9.6');assert.equal(status.release,undefined,'Upstream discovery cannot authorize an unsigned installation.');
  feed.stop();
});

test('an engine-only release retains app identity and captures its distinct exact package',async()=>{
  const f=fixture();
  const engine={...structuredClone(target),candidateId:hostId,novaVersion:installed.novaVersion,agentVersion:'2026.9.6',compatibility:{...target.compatibility,pluginVersion:installed.novaVersion},runtimeBundle:{url:'https://updates.example.test/runtime.tgz',bytes:12345,sha256:'e'.repeat(64)}};
  f.setResponder(()=>f.response(f.manifest([engine])));
  await f.feed.check();assert.equal(f.feed.status().release?.releaseId,engine.bundle.sha256);assert.equal(f.feed.status().release?.downloadBytes,8192+12345);
  assert.equal(f.feed.verifiedRelease(hostId)?.agentVersion,'2026.9.6');
  f.setHost({...installed,agentVersion:'2026.9.6'});assert.equal(f.feed.verifiedRelease(hostId),undefined,'An installed engine cannot be admitted again.');
});

test('a signed runtime asset outside configured artifact origins cannot be installed',async()=>{
  const f=fixture();f.setResponder(()=>f.response(f.manifest([{...target,agentVersion:'2026.9.6',runtimeBundle:{url:'https://other.example.test/runtime.tgz',bytes:100,sha256:'e'.repeat(64)}}])));
  await f.feed.check();assert.equal(f.feed.status().availability,'error');assert.equal(f.feed.verifiedRelease(candidateId),undefined);
});

test('automatic checks and manual checks remain bounded through service restart', async () => {
  const f = fixture(); await f.feed.check();
  await f.feed.check(true); await f.feed.check(); assert.equal(f.calls(), 1);
  f.advance(updateFeedLimits.manualIntervalMs); await f.feed.check(true); assert.equal(f.calls(), 2);
  const restored = new UpdateFeed(f.options); assert.equal(restored.status().availability, 'available');
  f.advance(DAY); await restored.check(); assert.equal(f.calls(), 2);
  f.advance(HOUR); await restored.check(); assert.equal(f.calls(), 3);
});

test('notification and dismissal identities persist across tabs and restarts', async () => {
  const f = fixture(); await f.feed.check();
  assert.equal(f.feed.notification()?.candidateId, candidateId); assert.equal(f.feed.notification(), undefined);
  assert.equal(new UpdateFeed(f.options).notification(), undefined);
  const second = fixture(); await second.feed.check(); second.feed.dismiss(candidateId);
  assert.equal(new UpdateFeed(second.options).notification(), undefined);
  assert.equal(second.feed.status().availability, 'available');
});

test('a signed empty or incompatible feed never claims up to date', async () => {
  const f = fixture(); f.setResponder(() => f.response(f.manifest([])));
  assert.equal((await f.feed.check()).availability, 'unavailable');
  for (const host of [{ ...installed, agentVersion: undefined }, { ...installed, agentVersion: '2026.9.3' }, { ...installed, platform: 'win32' }, { ...installed, arch: 'arm64' }, { ...installed, nodeMajor: 22 }, { ...installed, schemaVersion: 54 }, { ...installed, protocolVersion: 3 }, { ...installed, candidateId: 'e'.repeat(64) }]) {
    const incompatible = fixture(); incompatible.setHost(host); await incompatible.feed.check();
    assert.equal(incompatible.feed.status().availability, 'unavailable'); assert.equal(incompatible.feed.verifiedRelease(candidateId), undefined);
  }
  const current = fixture(); current.setHost({ ...installed, candidateId, novaVersion: target.novaVersion });
  assert.equal((await current.feed.check()).availability, 'current');
});

test('a signed current-pair record establishes exact installed status without authorizing a bundle', async () => {
  const record = { ...installed } as UpdateCurrentCandidate;
  const f = fixture(); f.setResponder(() => f.response({ ...f.manifest([]), currentCandidates: [record] }));
  assert.equal((await f.feed.check()).availability, 'current');
  assert.equal(f.feed.status().release, undefined); assert.equal(f.feed.verifiedRelease(hostId), undefined);
  assert.equal(new UpdateFeed(f.options).status().availability, 'current');
  for (const patch of [{ candidateId }, { novaVersion: '1.13.0' }, { agentVersion: undefined }, { agentVersion: '2026.9.3' }, { platform: 'win32' }, { arch: 'arm64' }, { nodeMajor: 22 }, { schemaVersion: 54 }, { protocolVersion: 3 }]) {
    f.setHost({ ...installed, ...patch }); assert.equal(f.feed.status().availability, 'unavailable');
  }
  f.setHost(installed); f.advance(updateFeedLimits.manualIntervalMs);
  f.setResponder(() => { throw Error('synthetic network failure'); });
  assert.equal((await f.feed.check(true)).availability, 'error');
  assert.equal(new UpdateFeed(f.options).status().availability, 'error');
});

test('current-pair records are signed, bounded, unique and cannot mask a reviewed successor', async () => {
  const record = { ...installed } as UpdateCurrentCandidate;
  for (const currentCandidates of [[{ ...record, arbitrary: true }], [{ ...record, protocolVersion: 3 }], [{ ...record, candidateId: 'latest' }], [{ ...record, agentVersion: undefined }], [record, record], Array.from({ length: 33 }, (_, index) => ({ ...record, candidateId: index.toString(16).padStart(64, '0') }))]) {
    assert.equal(updateManifestSchema.safeParse({ ...fixture().manifest([]), currentCandidates }).success, false);
  }
  assert.equal(updateManifestSchema.safeParse({ ...fixture().manifest(), currentCandidates: [{ ...record, candidateId }] }).success, false);
  const f = fixture(); f.setResponder(() => f.response({ ...f.manifest(), currentCandidates: [record] }));
  assert.equal((await f.feed.check()).availability, 'available');
  const tampered = fixture(), envelope = tampered.envelope({ ...tampered.manifest([]), currentCandidates: [record] });
  envelope.payload = Buffer.from(JSON.stringify({ ...tampered.manifest([]), currentCandidates: [{ ...record, candidateId }] })).toString('base64');
  tampered.setResponder(() => new Response(JSON.stringify(envelope)));
  assert.equal((await tampered.feed.check()).availability, 'error');
  const expired = fixture(); expired.setResponder(() => expired.response({ ...expired.manifest([]), currentCandidates: [record], expiresAt: '2026-09-24T13:00:00Z' }));
  assert.equal((await expired.feed.check()).availability, 'current'); expired.advance(HOUR);
  assert.equal(expired.feed.status().availability, 'unavailable');
});

test('tampering, another signing key, unsupported review and untrusted artifact addresses are rejected', async () => {
  for (const modify of [
    (f: ReturnType<typeof fixture>) => { const envelope = f.envelope(f.manifest()); envelope.payload = Buffer.from(JSON.stringify({ ...f.manifest(), sequence: 2 })).toString('base64'); return new Response(JSON.stringify(envelope)); },
    (f: ReturnType<typeof fixture>) => new Response(JSON.stringify(f.envelope(f.manifest(), generateKeyPairSync('ed25519').privateKey))),
    (f: ReturnType<typeof fixture>) => f.response({ ...f.manifest(), channel: 'preview' }),
    (f: ReturnType<typeof fixture>) => f.response(f.manifest([{ ...target, compatibility: { ...target.compatibility, reviewed: false } } as unknown as UpdateRelease])),
    (f: ReturnType<typeof fixture>) => f.response(f.manifest([{ ...target, compatibility: { ...target.compatibility, pluginVersion: '1.99.0' } }])),
    (f: ReturnType<typeof fixture>) => f.response(f.manifest([{ ...target, bundle: { ...target.bundle, url: 'https://untrusted.example.test/bundle' } }])),
    (f: ReturnType<typeof fixture>) => f.response(f.manifest([{ ...target, bundle: { ...target.bundle, url: 'https://user:secret@updates.example.test/bundle' } }])),
    (f: ReturnType<typeof fixture>) => f.response(f.manifest([{ ...target, bundle: { ...target.bundle, url: 'http://updates.example.test/bundle' } }])),
    (f: ReturnType<typeof fixture>) => f.response(f.manifest([{ ...target, notes: ['x'.repeat(241)] }])),
  ]) {
    const f = fixture(); f.setResponder(() => modify(f));
    assert.equal((await f.feed.check()).availability, 'error'); assert.equal(f.feed.verifiedRelease(candidateId), undefined);
  }
});

test('feed freshness, expiry and future creation cannot authorize installation', async () => {
  const f = fixture(); await f.feed.check(); f.advance(updateFeedLimits.freshnessMs + 1);
  assert.equal(f.feed.status().availability, 'unavailable'); assert.equal(f.feed.verifiedRelease(candidateId), undefined);
  for (const patch of [{ expiresAt: '2026-09-24T11:00:00Z' }, { createdAt: '2026-09-25T11:00:00Z' }, { expiresAt: '2027-09-24T11:00:00Z' }]) {
    const invalid = fixture(); invalid.setResponder(() => invalid.response({ ...invalid.manifest(), ...patch }));
    assert.equal((await invalid.feed.check()).availability, 'error');
  }
});

test('a failed refresh retains signed last-good metadata but disables current and install with persisted backoff', async () => {
  const f = fixture(); await f.feed.check(); const original = f.state().envelope;
  f.advance(updateFeedLimits.manualIntervalMs); f.setResponder(() => { throw Error('private path and secret must stay private'); });
  const failed = await f.feed.check(true); assert.equal(failed.availability, 'error'); assert.equal(failed.release, undefined);
  assert(!JSON.stringify(failed).includes('private')); assert.deepEqual(f.state().envelope, original); assert.equal(f.feed.verifiedRelease(candidateId), undefined);
  const restarted = new UpdateFeed(f.options); assert.equal(restarted.status().availability, 'error');
  await restarted.check(true); assert.equal(f.calls(), 2);
  f.advance(updateFeedLimits.manualIntervalMs); await restarted.check(true); assert.equal(f.calls(), 3);
  f.advance(updateFeedLimits.manualIntervalMs); await restarted.check(true); assert.equal(f.calls(), 3);
});

test('sequence rollback and equal-sequence payload replacement fail after a restart', async () => {
  const f = fixture(); const original = f.manifest([target], 5); f.setResponder(() => f.response(original)); await f.feed.check();
  for (const next of [f.manifest([target], 4), { ...original, releases: [{ ...target, notes: ['Changed under the same sequence.'] }] }]) {
    f.advance(10 * 60_000); const restarted = new UpdateFeed(f.options); f.setResponder(() => f.response(next));
    assert.equal((await restarted.check(true)).availability, 'error'); assert.equal(f.state().highestSequence, 5);
  }
  f.advance(HOUR); const restarted = new UpdateFeed(f.options); f.setResponder(() => f.response(f.manifest([target], 6)));
  assert.equal((await restarted.check(true)).availability, 'available'); assert.equal(f.state().highestSequence, 6);
});

test('conditional fetch revalidates the original signed bytes and cannot extend manifest expiry', async () => {
  const f = fixture(); const original = { ...f.manifest(), expiresAt: '2026-09-24T13:00:00Z' };
  f.setResponder(() => f.response(original, { etag: '"review-1"' })); await f.feed.check();
  f.advance(updateFeedLimits.manualIntervalMs);
  f.setResponder(init => { assert.equal((init?.headers as Record<string, string>)['If-None-Match'], '"review-1"'); return new Response(null, { status: 304 }); });
  assert.equal((await f.feed.check(true)).availability, 'available');
  f.advance(HOUR); assert.equal((await f.feed.check(true)).availability, 'error'); assert.equal(f.feed.verifiedRelease(candidateId), undefined);
});

test('both declared and streamed feed sizes are bounded and redirects are rejected', async () => {
  for (const respond of [
    () => new Response('{}', { headers: { 'content-length': String(updateFeedLimits.maxBytes + 1) } }),
    () => new Response('x'.repeat(updateFeedLimits.maxBytes + 1)),
    () => new Response(null, { status: 302, headers: { location: 'https://updates.example.test/elsewhere' } }),
  ]) {
    const f = fixture(); f.setResponder(respond); assert.equal((await f.feed.check()).availability, 'error');
  }
});

test('the request timeout aborts a pending download and persists a safe failure', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.setResponder(init => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }));
  const pending = f.feed.check(); context.mock.timers.tick(updateFeedLimits.timeoutMs);
  assert.equal((await pending).availability, 'error'); assert.equal(f.calls(), 1);
});

test('missing or invalid trust performs no network check and storage failure cannot authorize a release', async () => {
  for (const trust of [undefined, { ...fixture().options.trust!, url: 'http://updates.example.test/stable.json' }, { ...fixture().options.trust!, publicKey: 'invalid' }]) {
    const f = fixture(); const feed = new UpdateFeed({ ...f.options, trust });
    assert.equal((await feed.check(true)).availability, 'unavailable'); assert.equal(f.calls(), 0);
  }
  const f = fixture(); const feed = new UpdateFeed({ ...f.options, store: { read: () => undefined, write: () => { throw Error('disk full'); } } });
  assert.equal((await feed.check()).availability, 'error'); assert.equal(f.calls(), 0); assert.equal(feed.verifiedRelease(candidateId), undefined);
});

test('changing installed identity invalidates an already checked exact candidate', async () => {
  const f = fixture(); await f.feed.check(); f.setHost({ ...installed, candidateId: 'f'.repeat(64) });
  assert.equal(f.feed.status().availability, 'unavailable'); assert.equal(f.feed.verifiedRelease(candidateId), undefined);
});

test('cached signatures are reverified and malformed persisted state cannot reset sequence protection', async () => {
  const f = fixture(); await f.feed.check();
  const saved = f.state(), envelope = saved.envelope as { payload: string; signature: string };
  envelope.payload = Buffer.from(JSON.stringify(f.manifest([target], 100))).toString('base64'); f.setState(saved);
  assert.equal(new UpdateFeed(f.options).status().availability, 'unavailable');
  saved.highestSequence = 'damaged'; f.setState(saved); f.advance(DAY);
  const damaged = new UpdateFeed(f.options);
  assert.equal((await damaged.check(true)).availability, 'error'); assert.equal(f.calls(), 1);
  assert.equal(damaged.verifiedRelease(candidateId), undefined);
});

test('install command admits only an exact candidate, workspace epoch and idempotency receipt', () => {
  const input = { epoch: '7953e745-a1fc-46b5-ab48-3c4c91f96e8a', candidateId, idempotencyKey: '69984165-92ce-4656-8d3b-132e60e1cfd8', when: 'idle' };
  assert(updateInstallRequestSchema.safeParse(input).success);
  assert(!updateInstallRequestSchema.safeParse({ ...input, candidateId: 'latest' }).success);
  assert(!updateInstallRequestSchema.safeParse({ ...input, command: 'shell' }).success);
});
