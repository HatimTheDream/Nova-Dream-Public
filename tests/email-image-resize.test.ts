import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fitEmailImage, MAX_EMAIL_IMAGE_BYTES } from '../apps/service/email-image-resize.js';
import { emailImageType } from '../apps/service/email-image-fetch.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('a newsletter-sized 39 megapixel image becomes a complete lossless high-resolution preview', async () => {
  const original = await sharp({ create: { width: 7201, height: 5401, channels: 3, background: { r: 47, g: 107, b: 207 } } }).png().toBuffer();
  assert.equal(emailImageType(original), undefined);
  const result = await fitEmailImage(original, AbortSignal.timeout(8000));
  assert.equal(emailImageType(result), 'image/png'); assert.ok(result.length < MAX_EMAIL_IMAGE_BYTES);
  const decoded = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 2048); assert.equal(decoded.info.height, 1536);
  assert.deepEqual([...decoded.data.subarray(0, 3)], [47, 107, 207]);
});

test('ordinary images keep their original bytes and oversized or active formats are refused', async () => {
  assert.equal(await fitEmailImage(pixel, new AbortController().signal), pixel);
  for (const bytes of [Buffer.from('<svg onload="bad()"/>'), Buffer.alloc(MAX_EMAIL_IMAGE_BYTES + 1)]) {
    await assert.rejects(fitEmailImage(bytes, new AbortController().signal));
  }
  const giant = Buffer.from(pixel); giant.writeUInt32BE(9000, 16);
  await assert.rejects(fitEmailImage(giant, new AbortController().signal), /Unsupported image/);
});

test('cancelled and corrupt large images fail without holding the following conversion', async () => {
  const corrupt = Buffer.from(pixel); corrupt.writeUInt32BE(7201, 16); corrupt.writeUInt32BE(5401, 20);
  await assert.rejects(fitEmailImage(corrupt, AbortSignal.abort()));
  await assert.rejects(fitEmailImage(corrupt, new AbortController().signal), /preparation/);
  const source = await sharp({ create: { width: 8192, height: 2049, channels: 4, background: '#cc884488' } }).png().toBuffer();
  const abort = new AbortController();
  const cancelled = fitEmailImage(source, abort.signal); setTimeout(() => abort.abort(), 20);
  await assert.rejects(cancelled, /cancelled/);
  const result = await fitEmailImage(source, AbortSignal.timeout(8000));
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.width, 2048); assert.equal(metadata.height, 512); assert.equal(metadata.hasAlpha, true);
});
