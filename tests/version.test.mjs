import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('release promotion synchronizes metadata and preserves the independent build/schema identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'edition3-version-'));
  const pkg = { name: 'nova-dream-edition-3', private: true, version: '0.75.1', edition3: { buildVersion: '1.0.139', schemaVersion: 53, apiVersion: 1, appId: 'private.novadream.edition3.preview' } };
  const lock = { version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version }, 'node_modules/example': { version: '2.3.4', integrity: 'preserved' } } };
  const run = kind => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/version.mjs', import.meta.url)), kind], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
    writeFileSync(join(root, 'README.md'), '![version](https://img.shields.io/badge/Version-0.75.1-blue)\nOwner documentation stays.\n');
    writeFileSync(join(root, 'release.json'), JSON.stringify({ version: pkg.version, ...pkg.edition3, channel: 'local-preview', publishing: false, installation: false }));
    for (const [kind, version, buildVersion] of [['major', '1.0.0', '1.0.140'], ['patch', '1.0.1', '1.0.141'], ['minor', '1.1.0', '1.0.142']]) {
      const result = run(kind);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(read('package.json'), { ...pkg, version, edition3: { ...pkg.edition3, buildVersion } });
      assert.deepEqual(read('package-lock.json'), { ...lock, version, packages: { ...lock.packages, '': { ...lock.packages[''], version } } });
      assert.deepEqual(read('release.json'), { version, ...pkg.edition3, buildVersion, channel: 'local-preview', publishing: false, installation: false });
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), `![version](https://img.shields.io/badge/Version-${version}-blue)\nOwner documentation stays.\n`);
    }
    const names = ['package.json', 'package-lock.json', 'README.md', 'release.json'];
    const before = names.map(name => readFileSync(join(root, name), 'utf8'));
    assert.notEqual(run('invalid').status, 0);
    assert.deepEqual(names.map(name => readFileSync(join(root, name), 'utf8')), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
