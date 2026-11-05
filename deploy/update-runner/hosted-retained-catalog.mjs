// Derive catalog facts with the physically pinned official 2026.9.8 implementation.
// This process receives complete private database-family copies, never live state.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bytes = readFileSync(0);
assert(bytes.length <= 36 * 1024 * 1024);
const input = JSON.parse(bytes);
assert.deepEqual(Object.keys(input).sort(), ['runtime', 'sides'].sort());
assert.equal(realpathSync(input.runtime), input.runtime);
assert.equal(input.sides.length, 2);
const load = (name) => import(pathToFileURL(join(input.runtime, 'dist', name)).href);
const native = await load('installed-plugin-index-CrJ6zmAL.mjs');
const discovery = await load('discovery-BePzXbRd.mjs');
const policy = await load('config-state-D-KaEbbt.mjs');
const defaults = await load('default-enablement-CEIbpabL.mjs');
const result = [];
for (const side of input.sides) {
  assert.equal(realpathSync(side.stateRoot), side.stateRoot);
  assert(statSync(join(side.stateRoot, 'state', 'openclaw.sqlite')).isFile());
  const env = { HOME: side.stateRoot, OPENCLAW_HOME: side.stateRoot,
    OPENCLAW_STATE_DIR: side.stateRoot, OPENCLAW_COMPATIBILITY_HOST_VERSION: '2026.9.8' };
  assert(Array.isArray(side.paths) && side.paths.length >= 4 && side.paths.length <= 5);
  assert(side.paths.every((path) => side.config.plugins.load.paths.includes(path)));
  // The registry only uses load.paths to identify manifestless configured files.
  // Each selected application plugin has its own verified manifest. Restricting
  // discovery to these roots avoids even stat() on unrelated workspace plugins.
  const config = structuredClone(side.config);
  config.plugins.load.paths = [...side.paths];
  const found = discovery.t({ loadPaths: side.paths, env, ownershipUid: side.uid });
  const derived = native.a({ config, env, candidates: found.candidates,
    diagnostics: found.diagnostics, installRecords: side.installRecords,
    artifactPreservingReadOnly: true, now: () => new Date(side.generatedAtMs) });
  const compatible = native.g({ config: side.config, env,
    pluginIds: side.bundled.filter((record) => native.h({ origin: record.origin,
      providers: record.contributions.providers, contracts: record.contributions.contracts }))
      .map((record) => record.pluginId), activation: 'defaults', artifactPreservingReadOnly: true });
  const memory = side.memory;
  assert.equal(memory.pluginId, 'memory-core');
  const enabled = policy.u({ id: memory.pluginId, origin: memory.origin,
    channelIds: memory.contributions.channels, config: policy.l(compatible.plugins),
    rootConfig: compatible, enabledByDefault: defaults.t(memory) }).enabled;
  result.push({ index: derived.index,
    policyHash: native.y(side.config, env, { artifactPreservingReadOnly: true }),
    memoryEnabled: enabled });
}
process.stdout.write(JSON.stringify({ format: 1, nativeVersion: '2026.9.8', sides: result }));
