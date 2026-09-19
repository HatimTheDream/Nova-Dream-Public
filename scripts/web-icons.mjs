import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Approved artwork stays byte-for-byte intact. This only packages platform sizes.
const root = new URL('../', import.meta.url);
const publicRoot = new URL('apps/client/public/', root);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = [
  { id: 'red', source: 'assets/brand/nova-dream-red-source-v4.png', sha256: '8f596a1cdbf2fc99df918df646981b497f6b3a580c1ea9fc66993cbbdba515f4' },
  { id: 'cream', source: 'assets/brand/nova-dream-cream-source-v4.png', sha256: '4e77a44610ea2a9082104c0a27d7afad8427011591529be610996d4ae4978a1a' },
];

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
  // Launcher exports retain full-bleed opaque artwork;
  // the OS owns their outer mask. No border or padding is baked in.
  for (const size of [180, 192, 512, 1024]) {
    const bytes = await sharp(source).resize(size, size).removeAlpha().png().toBuffer();
    const file = size === 180 ? 'icons/apple-touch-icon-' + variant.id + '-v4.png' : 'icons/nova-dream-' + variant.id + '-' + size + '-v4.png';
    await emit(file, bytes, { variant: variant.id, size, purpose: 'launcher' });
    if (variant.id === 'red' && size === 180) await emit('apple-touch-icon.png', bytes, { variant: 'red', size, purpose: 'legacy-fallback' });
  }
  const manifest = {
    id: '/', name: 'Nova Dream', short_name: 'Nova Dream', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#f7f6f2', theme_color: '#f7f6f2',
    // Ordinary icons preserve face/ear framing under platform-controlled shapes.
    icons: [192, 512].map(size => ({ src: '/icons/nova-dream-' + variant.id + '-' + size + '-v4.png', sizes: size + 'x' + size, type: 'image/png', purpose: 'any' })),
  };
  await writeFile(new URL('nova-dream-' + variant.id + '.webmanifest', publicRoot), JSON.stringify(manifest, null, 2) + '\n');
  if (variant.id === 'red') {
    await writeFile(new URL('nova-dream.webmanifest', publicRoot), JSON.stringify(manifest, null, 2) + '\n');
    const desktop = await sharp(source).resize(512, 512).removeAlpha().png().toBuffer();
    await writeFile(new URL('apps/desktop/lynx-mark.png', root), desktop);
    const sizes = [16, 32, 48, 64, 128, 256];
    const pngs = await Promise.all(sizes.map(size => sharp(source).resize(size, size).removeAlpha().png().toBuffer()));
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
      output: 'apps/desktop/lynx-mark.png', outputSha256: digest(desktop), conversion: 'Proportional resize of approved Red artwork; no redraw',
      windowsIcon: { file: 'apps/desktop/nova-dream.ico', sizes, sha256: digest(ico), conversion: 'PNG sizes in a standard ICO container' },
    }, null, 2) + '\n');
  }
}
await writeFile(new URL('icons/provenance.json', publicRoot), JSON.stringify({ sources: variants,
  conversion: 'node scripts/web-icons.mjs; approved borderless source pixels retained, proportional resizing, no padding or recoloring', files,
}, null, 2) + '\n');
console.log('Generated Red and Cream Nova Dream app icons.');
