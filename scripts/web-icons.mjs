import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Approved artwork stays byte-for-byte intact. Platform exports only resize it
// and, for launchers that do not provide a mask, apply the in-app corner shape.
const root = new URL('../', import.meta.url);
const publicRoot = new URL('apps/client/public/', root);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = [
  { id: 'red', source: 'assets/brand/nova-dream-red-source-v4.png', sha256: '8f596a1cdbf2fc99df918df646981b497f6b3a580c1ea9fc66993cbbdba515f4' },
  { id: 'cream', source: 'assets/brand/nova-dream-cream-source-v4.png', sha256: '4e77a44610ea2a9082104c0a27d7afad8427011591529be610996d4ae4978a1a' },
];

// Match buttons.css: border-radius:50%; corner-shape:squircle. CSS defines
// squircle as superellipse(2), hence |x|^4 + |y|^4 <= 1 in the unit square.
// https://www.w3.org/TR/css-borders-4/#corner-shape
// Sample only boundary pixels for smooth alpha without borders or padding.
const launcherShape = { borderRadius: '50%', cornerShape: 'squircle', exponent: 4 };
const alphaMasks = new Map();
function squircleAlpha(size) {
  if (alphaMasks.has(size)) return alphaMasks.get(size);
  const samples = 16, radius = size / 2, alpha = Buffer.alloc(size * size);
  const distances = Array.from({ length: size }, (_, pixel) => {
    const edges = [Math.abs((pixel - radius) / radius), Math.abs((pixel + 1 - radius) / radius)];
    return {
      near: Math.min(...edges) ** 4, far: Math.max(...edges) ** 4,
      samples: Array.from({ length: samples }, (_, sample) => Math.abs((pixel + (sample + .5) / samples - radius) / radius) ** 4),
    };
  });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = distances[x], dy = distances[y];
      if (dx.far + dy.far <= 1) alpha[y * size + x] = 255;
      else if (dx.near + dy.near < 1) {
        let covered = 0;
        for (const sx of dx.samples) for (const sy of dy.samples) if (sx + sy <= 1) covered++;
        alpha[y * size + x] = Math.round(255 * covered / (samples * samples));
      }
    }
  }
  alphaMasks.set(size, alpha);
  return alpha;
}
async function launcherIcon(source, size) {
  // Attach alpha directly so every RGB pixel matches the unmasked resize,
  // including the partially transparent edge; compositing can alter those RGBs.
  const rgb = await sharp(source).resize(size, size).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
    .joinChannel(squircleAlpha(size), { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
}

const files = [];
await mkdir(new URL('icons/', publicRoot), { recursive: true });
const emit = async (file, bytes, extra = {}) => {
  await writeFile(new URL(file, publicRoot), bytes);
  files.push({ file, sha256: digest(bytes), ...extra });
};
for (const variant of variants) {
  const source = await readFile(new URL(variant.source, root));
  if (digest(source) !== variant.sha256) throw new Error('Approved ' + variant.id + ' artwork changed; review its provenance first.');
  // Full-bleed square marks; CSS owns the in-app corner shape.
  const brand = await sharp(source).resize(192, 192).removeAlpha().png().toBuffer();
  await emit('icons/nova-dream-' + variant.id + '-brand-192-v4.png', brand, { variant: variant.id, size: 192, purpose: 'in-app' });
  // Preserve opaque Apple touch exports and the old v4 launcher URLs for
  // existing clients. Apple supplies its own mask; in-app marks use CSS.
  for (const size of [180, 192, 512, 1024]) {
    const bytes = await sharp(source).resize(size, size).removeAlpha().png().toBuffer();
    const file = size === 180 ? 'icons/apple-touch-icon-' + variant.id + '-v4.png' : 'icons/nova-dream-' + variant.id + '-' + size + '-v4.png';
    await emit(file, bytes, { variant: variant.id, size, purpose: size === 180 ? 'apple-touch' : 'legacy-launcher' });
    if (variant.id === 'red' && size === 180) await emit('apple-touch-icon.png', bytes, { variant: 'red', size, purpose: 'legacy-fallback' });
  }
  for (const size of [192, 512]) {
    await emit('icons/nova-dream-' + variant.id + '-' + size + '-v5.png', await launcherIcon(source, size),
      { variant: variant.id, size, purpose: 'launcher', shape: launcherShape });
  }
  const manifest = {
    id: '/', name: 'Nova Dream', short_name: 'Nova Dream', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#f7f6f2', theme_color: '#f7f6f2',
    // Ordinary desktop/PWA icons carry the same transparent squircle as the app.
    icons: [192, 512].map(size => ({ src: '/icons/nova-dream-' + variant.id + '-' + size + '-v5.png', sizes: size + 'x' + size, type: 'image/png', purpose: 'any' })),
  };
  await writeFile(new URL('nova-dream-' + variant.id + '.webmanifest', publicRoot), JSON.stringify(manifest, null, 2) + '\n');
  if (variant.id === 'red') {
    await writeFile(new URL('nova-dream.webmanifest', publicRoot), JSON.stringify(manifest, null, 2) + '\n');
    const desktop = await launcherIcon(source, 512);
    await writeFile(new URL('apps/desktop/lynx-mark.png', root), desktop);
    const sizes = [16, 32, 48, 64, 128, 256];
    const pngs = await Promise.all(sizes.map(size => launcherIcon(source, size)));
    const header = Buffer.alloc(6 + 16 * pngs.length);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
    let offset = header.length;
    pngs.forEach((png, index) => {
      const entry = 6 + index * 16;
      header[entry] = sizes[index] % 256; header[entry + 1] = sizes[index] % 256;
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
      offset += png.length;
    });
    const ico = Buffer.concat([header, ...pngs]);
    await writeFile(new URL('apps/desktop/nova-dream.ico', root), ico);
    await writeFile(new URL('apps/desktop/lynx-mark.provenance.json', root), JSON.stringify({ source: variant.source, sourceSha256: variant.sha256,
      output: 'apps/desktop/lynx-mark.png', outputSha256: digest(desktop), conversion: 'Proportional resize of approved Red artwork with the in-app squircle alpha mask; no redraw, border, padding or recoloring', shape: launcherShape,
      windowsIcon: { file: 'apps/desktop/nova-dream.ico', sizes, sha256: digest(ico), conversion: 'PNG sizes in a standard ICO container' },
    }, null, 2) + '\n');
  }
}
await writeFile(new URL('icons/provenance.json', publicRoot), JSON.stringify({ sources: variants,
  conversion: 'node scripts/web-icons.mjs; approved source pixels retained, proportional resizing; desktop and v5 launchers use the in-app squircle alpha mask; no border, padding or recoloring', files,
}, null, 2) + '\n');
console.log('Generated Red and Cream Nova Dream app icons.');
