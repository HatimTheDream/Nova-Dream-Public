import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('release validation accepts the current schema and refuses old or mismatched metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'nova-release-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['package.json', 'package-lock.json', 'release.json', 'README.md', 'CHANGELOG.md', 'apps/desktop/main.cjs']) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, readFileSync(new URL(`../${name}`, import.meta.url)));
  }
  const original = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url))],
    { cwd: root, shell: false, windowsHide: true, encoding: 'utf8' });
  assert.equal(original.schemaVersion, 60);
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const schemaVersion of [55, 58, 59, 61]) {
    writeFileSync(join(root, 'release.json'), JSON.stringify({ ...original, schemaVersion }));
    assert.notEqual(run().status, 0, `unsupported schema ${schemaVersion} passed`);
  }
  writeFileSync(join(root, 'release.json'), JSON.stringify(original));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, edition3: { ...pkg.edition3, schemaVersion: 58 } }));
  assert.notEqual(run().status, 0, 'mismatched package schema passed');
});
