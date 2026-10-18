import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = existsSync(resolve(applicationRoot, '..', '.github/workflows/nova-release.yml'))
  ? resolve(applicationRoot, '..') : applicationRoot;
const workflows = resolve(repositoryRoot, '.github/workflows');
const canonical = readFileSync(resolve(workflows,
  repositoryRoot === applicationRoot ? 'quality.yml' : 'nova-release.yml'), 'utf8').replaceAll('\r\n', '\n');
const measurement = readFileSync(resolve(workflows, 'ci-two-runner-measurement.yml'), 'utf8').replaceAll('\r\n', '\n');

function canonicalRecovery(source) {
  return source.split('      - name: Verify Linux update recovery\n')[1]
    .split('        run: |\n')[1]
    .split('      - name: Retain the canonical hosted build\n')[0].trimEnd();
}

function measuredRecovery(source) {
  return source.split('          # BEGIN exact maintained Linux recovery commands\n')[1]
    .split('          # END exact maintained Linux recovery commands\n')[0].trimEnd();
}

test('two-runner measurement preserves every canonical Linux recovery command in order', () => {
  assert.equal(measuredRecovery(measurement), canonicalRecovery(canonical));
  assert.match(measurement, /id: recovery\n        if: matrix\.shard == 1\n        timeout-minutes: 30/);
});

test('two-runner measurement runs exactly two independent shards without hiding failures', () => {
  assert.deepEqual([...measurement.matchAll(/^  ([a-z][a-z_-]+):$/gm)]
    .filter(match => measurement.indexOf(match[0]) > measurement.indexOf('jobs:'))
    .map(match => match[1]), ['measure']);
  assert.match(measurement, /fail-fast: false\n      matrix:\n        shard: \[1, 2\]/);
  assert.match(measurement, /node scripts\/ci-test-shard\.mjs --shard=\$\{\{ matrix\.shard \}\}\/2/);
  assert.match(measurement, /if \[ "\$\{\{ matrix\.shard \}\}" = "1" \]; then quality_args\+=\(--with-quality\); fi/);
  assert.doesNotMatch(measurement, /continue-on-error|needs:|fail-fast: true|allow-failure/);
  assert.match(measurement, /id: install\n        run: npm ci/);
  assert.match(measurement, /id: gateway\n        if: matrix\.shard == 1\n        run: npm ci --prefix deploy\/vercel/);
});

test('measurement retains exact builds and failure evidence without publishing a release', () => {
  assert.match(measurement, /permissions:\n  contents: read/);
  assert.doesNotMatch(measurement, /contents: write|github-release\.mjs|release:deliver|release:coordinate/);
  assert.match(measurement, /branches: \[perf\/frontend-verification-pass\]/);
  assert.match(measurement, /workflow_dispatch:/);
  assert.match(measurement, /python3 -B scripts\/retain-ci-candidate\.py/);
  assert.match(measurement, /name: nova-ci-measurement-build-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(measurement, /name: Preserve measurement receipts and logs\n        if: always\(\)/);
  assert.match(measurement, /'canonicalCi': False, 'deliveryQualification': False/);
  assert.match(measurement, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
});
