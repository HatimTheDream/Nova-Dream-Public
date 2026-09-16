import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Preserve the original red-outline app icon, including its frame and shadow.
// Opaque backgrounds avoid black transparency on iPhone home-screen icons.
const publicRoot = new URL('../apps/client/public/', import.meta.url);
const sourcePath = 'assets/brand/nova-dream-red-outline-source-v1.png';
const source = await readFile(new URL('../' + sourcePath, import.meta.url));
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== 'bc60ec2202b0ce564fc28975ffba163a5e50c968937ae6589d5c5ab602019f47') throw new Error('The approved red-outline source changed. Review its provenance before regenerating.');
const background = '#f6f3ed';
await mkdir(new URL('icons/', publicRoot), { recursive: true });
const outputs = [
  ['apple-touch-icon.png', 180, 0.96],
  ['icons/nova-dream-192-v2.png', 192, 0.96],
  ['icons/nova-dream-512-v2.png', 512, 0.96],
  // A square at 56% fits fully inside the maskable 80%-diameter safe circle.
  ['icons/nova-dream-maskable-512-v2.png', 512, 0.56],
];
const files = [];
// The navigation logo keeps the original transparent outer corners so its
// red frame sits cleanly on both light and dark navigation surfaces.
const brandFile = 'icons/nova-dream-brand-192-v2.png';
const brandBytes = await sharp(source).resize(192, 192, { fit: 'inside' }).png().toBuffer();
await writeFile(new URL(brandFile, publicRoot), brandBytes);
files.push({ file: brandFile, size: 192, scale: 1, sha256: createHash('sha256').update(brandBytes).digest('hex') });
for (const [file, size, scale] of outputs) {
  const inset = Math.floor(size * scale);
  const logo = await sharp(source).resize(inset, inset, { fit: 'inside' }).png().toBuffer();
  const bytes = await sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: logo, gravity: 'centre' }]).removeAlpha().png().toBuffer();
  await writeFile(new URL(file, publicRoot), bytes);
  files.push({ file, size, scale, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(new URL('icons/provenance.json', publicRoot), JSON.stringify({
  source: sourcePath, sourceSha256, background,
  original: { commit: '368bfd7', path: 'apps/web/public/nova-mark-512.png', note: 'Original Nova red-outline application icon, copied unchanged.' },
  conversion: 'node scripts/web-icons.mjs; proportional resize and opaque background; original red frame, shadow and lynx preserved', files,
}, null, 2) + '\n');
console.log('Generated Nova Dream home-screen icons from the accepted logo.');
