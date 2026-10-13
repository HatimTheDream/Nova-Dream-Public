import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FrontendDelivery, frontendHtml, frontendManifestSchema } from '../apps/service/frontend-delivery.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const boundedFixtureReader = (path: string, limit: number) => { const info = lstatSync(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit); return readFileSync(path); };
const write = (path: string, bytes: Buffer | string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nova-frontend-delivery-')), keyPair = generateKeyPairSync('ed25519'), key = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKeyFile = join(directory, 'public.pem'); write(publicKeyFile, key);
  const options = { directory, publicKeyFile, publicKeySha256: digest(key), candidateId: 'a'.repeat(64), serviceInputsSha256: 'b'.repeat(64), apiVersion: 1 as const, schemaVersion: 55, version: '2.3.0', buildVersion: '1.0.287' };
  const loader = new FrontendDelivery(options, 0, boundedFixtureReader);
  const install = (text: string, sequence = 1, overrides: Record<string, unknown> = {}) => {
    const assets = new Map<string, string>([['.vite/manifest.json', '{}'], ['assets/lazy.js', `export const text = ${JSON.stringify(text)};`], ['index.html', '<html><head><link rel="stylesheet" href="./assets/style.css"></head><body><script src="./assets/lazy.js"></script></body></html>'], ['assets/style.css', `body { color: ${text} }`]]);
    const files = [...assets].map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })).sort((a, b) => a.path < b.path ? -1 : 1), frontendId = digest(JSON.stringify(files));
    const manifest = { format: 1, kind: 'frontend', channel: 'frontend-stable', sequence, createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-08T00:00:00.000Z', frontendId, frontendVersion: `2.3.${sequence}`, frontendBuildVersion: `1.0.${287 + sequence}`, sourceRevision: 'c'.repeat(40), base: { candidateId: options.candidateId, serviceInputsSha256: options.serviceInputsSha256, apiVersion: 1, schemaVersion: 55 }, artifact: { url: 'https://example.invalid/frontend.tgz', bytes: 512, sha256: 'd'.repeat(64) }, files, ...overrides };
    const raw = Buffer.from(JSON.stringify(manifest) + '\n'), signature = sign(null, raw, keyPair.privateKey), manifestSha256 = digest(raw), root = join(directory, 'releases', frontendId);
    for (const [path, bytes] of assets) write(join(root, path), bytes);
    write(join(root, '.frontend-manifest.json'), raw); write(join(root, '.frontend-manifest.sig'), signature);
    const manifestPath = join(directory, 'manifests', manifestSha256 + '.json'), signaturePath = join(directory, 'manifests', manifestSha256 + '.sig'); write(manifestPath, raw); write(signaturePath, signature);
    const selector = { format: 1, frontendId, manifestSha256, manifestPath, signaturePath, operationId: randomUUID() };
    return { manifest, frontendId, raw, signature, root, select: () => write(join(directory, 'selector.json'), JSON.stringify(selector) + '\n') };
  };
  return { directory, keyPair, loader, options, install, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('selected signed UI keeps service identity; old namespaces and expired admitted assets remain available', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.loader.selected().identity, { id: f.options.candidateId, version: f.options.version, buildVersion: f.options.buildVersion, source: 'bundled' });
    const old = f.install('red'); old.select(); assert.equal(f.loader.selected().identity.id, old.frontendId);
    const current = f.install('blue', 2); current.select(); assert.equal(f.loader.selected().identity.id, current.frontendId);
    assert.match(f.loader.read(old.frontendId, 'assets/lazy.js').toString(), /red/); assert.match(f.loader.read(current.frontendId, 'assets/lazy.js').toString(), /blue/);
    const html = frontendHtml(f.loader.read(current.frontendId, 'index.html'), f.options.candidateId, f.loader.selected().identity, `/__frontend/${current.frontendId}/`);
    assert.ok(html.includes(`name="e3-candidate" content="${f.options.candidateId}"`)); assert.ok(html.includes(`name="e3-frontend" content="${current.frontendId}"`)); assert.ok(html.includes(`src="/__frontend/${current.frontendId}/assets/lazy.js"`)); assert.equal(/<base\b/i.test(html), false);
    old.select(); assert.equal(f.loader.selected().identity.id, old.frontendId); assert.match(f.loader.read(current.frontendId, 'assets/lazy.js').toString(), /blue/);
  } finally { f.close(); }
});

test('changed asset bytes and internal/unsafe paths are refused without a saved-work mutation', () => {
  const f = fixture();
  try {
    const ui = f.install('red'); ui.select(); write(join(ui.root, 'assets/lazy.js'), 'different'); assert.throws(() => f.loader.read(ui.frontendId, 'assets/lazy.js'), /changed|assertion/i);
    for (const path of ['.vite/manifest.json', 'icons/provenance.json', '../public.pem', '/api/private', 'other.html', 'secret.json', 'assets/source.map']) assert.throws(() => f.loader.read(ui.frontendId, path));
    assert.equal(f.loader.selected().identity.id, ui.frontendId);
  } finally { f.close(); }
});

test('invalid selector, signature, compatibility and provisioned key fall back to bundled UI with a concrete error', () => {
  for (const variant of ['selector', 'signature', 'candidate', 'compatibility', 'key']) {
    const f = fixture();
    try {
      const overrides = variant === 'candidate' ? { base: { candidateId: 'f'.repeat(64), serviceInputsSha256: f.options.serviceInputsSha256, apiVersion: 1, schemaVersion: 55 } } : variant === 'compatibility' ? { base: { candidateId: f.options.candidateId, serviceInputsSha256: 'e'.repeat(64), apiVersion: 1, schemaVersion: 55 } } : {};
      const ui = f.install('red', 1, overrides); ui.select();
      if (variant === 'selector') write(join(f.directory, 'selector.json'), '{"invalid":true}');
      if (variant === 'signature') { write(join(ui.root, '.frontend-manifest.sig'), Buffer.alloc(64)); write(join(f.directory, 'manifests', digest(ui.raw) + '.sig'), Buffer.alloc(64)); }
      if (variant === 'key') write(f.options.publicKeyFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString());
      const result = f.loader.selected(); assert.equal(result.identity.source, 'bundled', variant); assert.equal(result.error, true, variant);
    } finally { f.close(); }
  }
});

test('loader schema uses producer limits, exact canonical file identity and bounded validity', () => {
  const f = fixture();
  try {
    const valid = f.install('red').manifest; assert.equal(frontendManifestSchema.parse(valid).frontendId, valid.frontendId);
    for (const changed of [
      { createdAt: Date.parse(valid.createdAt) }, { expiresAt: '2026-11-01T00:00:00.000Z' }, { frontendVersion: '02.3.1' }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { unknown: true },
      { artifact: { ...valid.artifact, url: 'https://user:secret@example.invalid/frontend.tgz' } }, { artifact: { ...valid.artifact, url: 'https://example.invalid/file?token=secret' } },
      { files: [...valid.files].reverse() }, { files: valid.files.map(file => file.path === 'index.html' ? { ...file, path: 'other.html' } : file) }, { frontendId: 'e'.repeat(64) },
    ]) assert.throws(() => frontendManifestSchema.parse({ ...valid, ...changed }));
  } finally { f.close(); }
});
