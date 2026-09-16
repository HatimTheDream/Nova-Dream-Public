import assert from 'node:assert/strict';
import test from 'node:test';
import { changelogEntries, releaseNotes } from '../scripts/github-release.mjs';

test('release notes select one numbered entry, retain its formatting and reject duplicate versions', () => {
  const entries = changelogEntries('## [1.2.0] — Today\n\n- New feature.\n\n## [1.1.0] — Yesterday\n\n- Earlier feature.\n');
  assert.equal(entries.get('1.2.0').body, '- New feature.');
  assert.equal(entries.get('1.1.0').body, '- Earlier feature.');
  assert.throws(() => changelogEntries('## [1.0.0]\nOne\n## [1.0.0]\nTwo'), /Duplicate/);
});

test('each release audience gets its own setup path and valid source identity', () => {
  const input = { version: '1.5.7', entry: { body: '- Clear loading progress.' }, repository: 'example/nova', sha: 'a'.repeat(40) };
  const publicNotes = releaseNotes({ ...input, audience: 'public' });
  assert.match(publicNotes, /VPS hosting is optional/); assert.doesNotMatch(publicNotes, /edition3\/README/);
  const privateNotes = releaseNotes({ ...input, audience: 'private' });
  assert.match(privateNotes, /edition3\/README/); assert.match(privateNotes, /Private Nova Dream source release/);
  assert.throws(() => releaseNotes({ ...input, audience: 'unknown' }));
  assert.throws(() => releaseNotes({ ...input, audience: 'public', entry: undefined }));
  assert.throws(() => releaseNotes({ ...input, audience: 'public', sha: 'main' }));
});
