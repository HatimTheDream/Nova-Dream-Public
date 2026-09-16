import test from 'node:test';
import assert from 'node:assert/strict';
import { isBase64 } from '../packages/domain/base64';

test('base64 keeps alphabet, padding and length validation without a recursive regex', () => {
  for (const value of ['', 'YQ==', 'YWI=', 'YWJj', '+/8=', 'AAAA']) assert(isBase64(value), value);
  for (const value of ['A', 'YQ', 'YWJj\n', 'YW Jj', 'AA=A', '====', 'A===', '_AAA', '-AAA', '🦁AA', '\0AAA']) assert(!isBase64(value), value);
  const large = Buffer.alloc(8 * 1024 * 1024, 173).toString('base64');
  assert(isBase64(large));
  assert(!isBase64(large.slice(0, -4) + '!AAA'));
});
