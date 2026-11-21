import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPublicationLocalPath } from '../scripts/release-publication-local-inputs.mjs';

test('a Windows child accepts only the drive-qualified rendering of its original Linux reference', () => {
  const source = '/mnt/nova-data/qualified-pack/app-dependencies.tgz';
  const local = String.raw`C:\mnt\nova-data\qualified-pack\app-dependencies.tgz`;
  assert.doesNotThrow(() => verifyPublicationLocalPath(source, local));
  for (const altered of [source, 'C:' + source, local.replace('qualified-pack', 'another-pack'), String.raw`\\server\share\app-dependencies.tgz`]) {
    assert.throws(() => verifyPublicationLocalPath(source, altered), /canonical-path/);
  }
  for (const logical of ['/tmp/qualified-pack/app.tgz', '/mnt/nova-data/../app.tgz', '/mnt/nova-data/qualified-pack/..', '/mnt/nova-data/qualified-pack/a/b.tgz']) {
    assert.throws(() => verifyPublicationLocalPath(logical, local), /canonical-path/);
  }
});
