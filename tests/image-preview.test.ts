import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imagePreviewType } from '../apps/service/image-preview.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
test('image preview admits a bounded PNG but rejects oversized dimensions and active document formats', () => {
  assert.equal(imagePreviewType(png), 'image/png');
  const oversized = Buffer.from(png); oversized.writeUInt32BE(100000, 16);
  assert.equal(imagePreviewType(oversized), undefined);
  assert.equal(imagePreviewType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), undefined);
  assert.equal(imagePreviewType(Buffer.from('<!doctype html><img src="https://foreign.invalid">')), undefined);
  assert.equal(imagePreviewType(png.subarray(0, 20)), undefined);
  assert.equal(imagePreviewType(png.subarray(0, 33)), undefined);
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
  assert.equal(imagePreviewType(Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)])), undefined);
});

test('JPEG frame dimensions are checked and truncated or excessive frames stay download-only', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 24, 0, 32, 1]);
  assert.equal(imagePreviewType(jpeg), 'image/jpeg');
  const oversized = Buffer.from(jpeg); oversized.writeUInt16BE(20000, 9);
  assert.equal(imagePreviewType(oversized), undefined);
  assert.equal(imagePreviewType(jpeg.subarray(0, 10)), undefined);
});

test('animated or oversized WebP stays download-only while bounded still images can be previewed', () => {
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
  webp.writeUIntLE(1023, 24, 3); webp.writeUIntLE(1023, 27, 3);
  assert.equal(imagePreviewType(webp), 'image/webp');
  webp[20] = 2; assert.equal(imagePreviewType(webp), undefined);
  webp[20] = 0; webp.writeUIntLE(16000, 24, 3); assert.equal(imagePreviewType(webp), undefined);
});
