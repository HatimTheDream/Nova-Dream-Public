import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { appIconAssets } from '../apps/client/src/app-icon';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = 'apps/client/public/';
const read = (path: string) => readFileSync(join(root, path));
const json = <T>(path: string): T => JSON.parse(read(path).toString('utf8'));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Source = { id: 'red' | 'cream'; source: string; sha256: string };
type Export = { file: string; sha256: string; variant: Source['id']; size: number; purpose: string };
type Manifest = { id: string; name: string; short_name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };
const provenance = json<{ sources: Source[]; files: Export[] }>(publicRoot + 'icons/provenance.json');
const desktop = json<{ source: string; sourceSha256: string; output: string; outputSha256: string; windowsIcon: { file: string; sizes: number[]; sha256: string } }>('apps/desktop/lynx-mark.provenance.json');

async function assertOpaqueSquare(bytes: Buffer, label: string, size?: number) {
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'png', label);
  assert.ok(metadata.width && metadata.width === metadata.height, label + ' must remain square');
  if (size !== undefined) assert.deepEqual([metadata.width, metadata.height], [size, size], label);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 3; index < data.length; index += 4) assert.equal(data[index], 255, label + ' must have no baked transparent corners or internal holes');
}

test('Approved icon sources and exports match their provenance and remain opaque edge-to-edge squares', async () => {
  assert.deepEqual(provenance.sources.map(source => source.id).sort(), ['cream', 'red']);
  for (const source of provenance.sources) {
    const bytes = read(source.source);
    assert.equal(hash(bytes), source.sha256, source.source);
    await assertOpaqueSquare(bytes, source.source);
  }
  assert.equal(new Set(provenance.files.map(file => file.file)).size, provenance.files.length);
  for (const file of provenance.files) {
    const bytes = read(publicRoot + file.file);
    assert.equal(hash(bytes), file.sha256, file.file);
    await assertOpaqueSquare(bytes, file.file, file.size);
  }
});

test('Both selectable manifests retain one installed-app identity and point to complete launcher exports', async () => {
  const manifests = provenance.sources.map(source => json<Manifest>(publicRoot + appIconAssets(source.id).manifest.slice(1)));
  const identity = ({ id, name, short_name, start_url, scope, display }: Manifest) => ({ id, name, short_name, start_url, scope, display });
  assert.deepEqual(identity(manifests[0]), { id: '/', name: 'Nova Dream', short_name: 'Nova Dream', start_url: '/', scope: '/', display: 'standalone' });
  assert.deepEqual(identity(manifests[1]), identity(manifests[0]));
  for (const source of provenance.sources) {
    const assets = appIconAssets(source.id), manifest = json<Manifest>(publicRoot + assets.manifest.slice(1));
    assert.deepEqual(manifest.icons.map(icon => icon.src).sort(), [assets.launcher, assets.launcherLarge].sort());
    for (const icon of manifest.icons) {
      assert.equal(icon.purpose, 'any', 'Alternative platform crops require their own reviewed exports');
      assert.equal(icon.type, 'image/png');
      const { width, height, hasAlpha } = await sharp(read(publicRoot + icon.src.slice(1))).metadata();
      assert.equal(icon.sizes, `${width}x${height}`);
      assert.equal(hasAlpha, false);
    }
    for (const [url, size] of [[assets.brand, 192], [assets.touch, 180]] as const) {
      const metadata = await sharp(read(publicRoot + url.slice(1))).metadata();
      assert.deepEqual([metadata.width, metadata.height], [size, size]);
    }
  }
  assert.deepEqual(json<Manifest>(publicRoot + 'nova-dream.webmanifest'), json<Manifest>(publicRoot + appIconAssets('red').manifest.slice(1)));
  assert.deepEqual(read(publicRoot + 'apple-touch-icon.png'), read(publicRoot + appIconAssets('red').touch.slice(1)));
});

test('Desktop defaults use the approved Red source and a complete six-resolution Windows icon', async () => {
  const red = provenance.sources.find(source => source.id === 'red')!;
  assert.equal(desktop.source, red.source);
  assert.equal(desktop.sourceSha256, red.sha256);
  assert.equal(hash(read(desktop.output)), desktop.outputSha256);
  await assertOpaqueSquare(read(desktop.output), desktop.output, 512);
  const ico = read(desktop.windowsIcon.file);
  assert.equal(hash(ico), desktop.windowsIcon.sha256);
  assert.deepEqual(desktop.windowsIcon.sizes, [16, 32, 48, 64, 128, 256]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), desktop.windowsIcon.sizes.length);
  let nextOffset = 6 + desktop.windowsIcon.sizes.length * 16;
  for (const [index, size] of desktop.windowsIcon.sizes.entries()) {
    const entry = 6 + index * 16, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.deepEqual([ico[entry] || 256, ico[entry + 1] || 256], [size, size]);
    assert.equal(ico.readUInt16LE(entry + 4), 1);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    assert.equal(offset, nextOffset, 'ICO image entries must not overlap or leave unmapped bytes');
    assert.ok(length > 0 && offset + length <= ico.length);
    await assertOpaqueSquare(ico.subarray(offset, offset + length), `${desktop.windowsIcon.file}: ${size}px`, size);
    nextOffset = offset + length;
  }
  assert.equal(nextOffset, ico.length);
});

test('The icon generator reproduces committed platform files in an isolated directory', t => {
  const parent = join(root, '.tmp-qa');
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(join(parent, 'icon-exports-'));
  const owned = realpathSync(fixture);
  t.after(() => {
    assert.equal(realpathSync(fixture), owned);
    assert.equal(dirname(owned), realpathSync(parent));
    rmSync(owned, { recursive: true, force: true });
  });
  for (const path of ['scripts/web-icons.mjs', ...provenance.sources.map(source => source.source)]) {
    const target = join(fixture, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  mkdirSync(join(fixture, 'apps/desktop'), { recursive: true });
  execFileSync(process.execPath, [join(fixture, 'scripts/web-icons.mjs')], { cwd: fixture, stdio: 'pipe' });
  const outputs = [...provenance.files.map(file => publicRoot + file.file),
    ...provenance.sources.map(source => publicRoot + appIconAssets(source.id).manifest.slice(1)),
    publicRoot + 'nova-dream.webmanifest', publicRoot + 'icons/provenance.json',
    desktop.output, desktop.windowsIcon.file, 'apps/desktop/lynx-mark.provenance.json'];
  for (const path of outputs) assert.deepEqual(readFileSync(join(fixture, path)), read(path), path + ' changed on regeneration');
});
