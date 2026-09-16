import sharp from 'sharp';
import { imagePreviewType } from './image-preview.js';
import { EMAIL_IMAGE_EDGE, MAX_EMAIL_IMAGE_BYTES, MAX_EMAIL_SOURCE_PIXELS } from './email-image-resize.js';

// No URLs, paths or credentials cross this boundary, only already fetched bytes.
sharp.cache(false); sharp.concurrency(1);
try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_EMAIL_IMAGE_BYTES) throw Error('Image too large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!imagePreviewType(bytes, MAX_EMAIL_SOURCE_PIXELS)) throw Error('Unsupported image');
  const output = await sharp(bytes, { limitInputPixels: MAX_EMAIL_SOURCE_PIXELS, sequentialRead: true, failOn: 'warning' })
    .resize({ width: EMAIL_IMAGE_EDGE, height: EMAIL_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
    .png().timeout({ seconds: 5 }).toBuffer();
  if (output.length > MAX_EMAIL_IMAGE_BYTES || !imagePreviewType(output)) throw Error('Prepared image too large');
  process.stdout.write(output);
} catch { process.exitCode = 1; }
