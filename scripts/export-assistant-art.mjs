import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const provenanceUrl = new URL('assets/brand/assistant/provenance.json', root);
const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const entry of provenance.entries) {
  const source = await readFile(new URL(entry.source, provenanceUrl));
  const original = await readFile(new URL(entry.editTarget, provenanceUrl));
  const metadata = await sharp(source).metadata();
  if (metadata.width !== metadata.height) throw new Error(`Expected a square: ${entry.source}`);
  const output = await sharp(source).resize(256, 256, { fit: 'fill', kernel: 'lanczos3' }).webp({ lossless: true }).toBuffer();
  await writeFile(new URL(entry.output, provenanceUrl), output);
  entry.sourceSha256 = sha256(source);
  entry.editTargetSha256 = sha256(original);
  entry.outputSha256 = sha256(output);
  entry.outputBytes = output.length;
  console.log(`${entry.variant} ${entry.expression}: ${output.length} bytes`);
}
await writeFile(provenanceUrl, JSON.stringify(provenance, null, 2) + '\n');
