import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, lstatSync, existsSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDirectWorkspace, assertDirectWorkspace, prepareGroupWorkspace, assertGroupWorkspace, groupRuntimePaths, directRuntimePaths, directWorkspaceMarker,
  withDirectAgentPlugin, qualifyDirectRuntimeConfiguration } from '../apps/service/direct-agent-runtime-config.js';
import { directConfigurationHash, directPluginId, assertDirectConfiguration } from '../apps/service/direct-agent-runtime-policy.js';
import { directPluginFiles } from '../apps/service/direct-agent-runtime-files.js';
import { qualifyNativeUpdateStartup } from '../apps/service/update-native-startup.js';

function fixture(_t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nova-direct-config-')), service = join(root, 'compiled');
  mkdirSync(service); mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'edition3-runtime.identity'), 'edition3-owned-gateway\n');
  for (const name of ['direct-agent-plugin', 'account-plugin']) {
    mkdirSync(join(service, name));
    writeFileSync(join(service, name, 'index.js'), '// Synthetic source fixture; never imported.\n');
    writeFileSync(join(service, name, 'package.json'), JSON.stringify({ openclaw: { extensions: ['./index.js'] } }));
    writeFileSync(join(service, name, 'openclaw.plugin.json'), JSON.stringify({ id: name === 'direct-agent-plugin' ? directPluginId : 'edition3-accounts' }));
  }
  for (const name of ['direct-agent-tool-calls.js', 'direct-agent-runtime-policy.js', 'group-runtime-policy.js'])
    writeFileSync(join(service, name), '// Synthetic source fixture; never imported.\n');
  const original = {
    gateway: { bind: 'loopback', controlUi: { enabled: false } },
    agents: { defaults: { heartbeat: { every: '0m' } } }, plugins: { enabled: true, allow: ['openai', 'codex'],
      entries: { openai: { enabled: true }, codex: { enabled: true } } },
    cron: { enabled: false }, update: { checkOnStart: false, auto: { enabled: false } }, models: { catalogRefresh: { enabled: false } },
  };
  prepareDirectWorkspace(root, original);
  const config = withDirectAgentPlugin(original, randomUUID(), root, join(service, 'direct-agent-plugin'),
    { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) });
  const rehash = () => { config.plugins.entries[directPluginId].config.policySha256 = directConfigurationHash(config); };
  return { root, service, original, config, rehash };
}
test('controlled startup adds only the exact dedicated case and preserves original configuration', t => {
  const f = fixture(t);
  assert.equal((f.original.agents as any).entries, undefined);
  assert.deepEqual(readdirSync(directRuntimePaths(f.root).workspace), []);
  assert.equal(qualifyDirectRuntimeConfiguration(f.config, f.root, f.service, '2026.9.8'), true);
  assert.deepEqual(qualifyNativeUpdateStartup(f.root, f.service, f.config, '2026.9.8'), []);
  assert.equal(qualifyNativeUpdateStartup(f.root, f.service, f.config, '2026.9.6').length, 1);
  const before = JSON.stringify(f.config);
  assertDirectConfiguration(f.config, f.config.plugins.entries[directPluginId].config.policySha256);
  assert.equal(JSON.stringify(f.config), before);
});

test('owned preparation disables native bootstrap creation while preserving other defaults and agents', t => {
  const f = fixture(t), original = structuredClone(f.original) as any;
  original.agents.defaults = { ...original.agents.defaults, skipBootstrap: false,
    model: { primary: 'openai/preserved-model' }, models: { 'openai/preserved-model': {} }, maxConcurrent: 2 };
  original.agents.entries = { main: { name: 'Existing agent', skills: ['preserved-skill'] } };
  const before = structuredClone(original);
  const config = withDirectAgentPlugin(original, f.config.plugins.entries[directPluginId].config.epoch, f.root,
    join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) });
  assert.deepEqual(original, before);
  assert.deepEqual(config.agents.defaults, { ...before.agents.defaults, skipBootstrap: true });
  assert.deepEqual(config.agents.entries.main, before.agents.entries.main);
  assert.equal(config.agents.entries['edition3-direct'].contextInjection, 'never');
  assert.equal(qualifyDirectRuntimeConfiguration(config, f.root, f.service, '2026.9.8'), true);
});

test('missing or disabled native bootstrap protection is refused even with a matching digest', t => {
  for (const value of [undefined, false]) {
    const f = fixture(t);
    if (value === undefined) delete f.config.agents.defaults.skipBootstrap;
    else f.config.agents.defaults.skipBootstrap = value;
    f.rehash();
    assert.throws(() => assertDirectConfiguration(f.config, f.config.plugins.entries[directPluginId].config.policySha256));
    assert.throws(() => qualifyDirectRuntimeConfiguration(f.config, f.root, f.service, '2026.9.8'));
    assert.equal(qualifyNativeUpdateStartup(f.root, f.service, f.config, '2026.9.8').length, 1);
  }
});

test('one plugin owns separate empty Group and Direct workspaces and one complete configuration digest', t => {
  const f = fixture(t); prepareGroupWorkspace(f.root);
  const config = withDirectAgentPlugin(f.config, f.config.plugins.entries[directPluginId].config.epoch, f.root,
    join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) }, { group: true });
  const entry = config.agents.entries['edition3-group'];
  assert.deepEqual({ workspace: entry.workspace, agentDir: entry.agentDir }, groupRuntimePaths(f.root));
  assert.notEqual(entry.workspace, config.agents.entries['edition3-direct'].workspace);
  assert.deepEqual(entry.tools, { allow: [], deny: ['*'], elevated: { enabled: false } });
  assert.equal(config.plugins.allow.filter((id: string) => id === directPluginId).length, 1);
  assert.equal(config.plugins.entries[directPluginId].config.policySha256, directConfigurationHash(config));
  assert.equal(qualifyDirectRuntimeConfiguration(config, f.root, f.service, '2026.9.8'), true);
  assert.deepEqual(qualifyNativeUpdateStartup(f.root, f.service, config, '2026.9.8'), []);
  const before = directPluginFiles(f.service);
  writeFileSync(join(f.service, 'group-runtime-policy.js'), '// changed Group policy');
  assert.notEqual(directPluginFiles(f.service), before);
  const retained = join(f.root, 'group-workspace', 'AGENTS.md'); writeFileSync(retained, 'Unqualified Group content');
  assert.throws(() => prepareGroupWorkspace(f.root)); assert.throws(() => assertGroupWorkspace(f.root));
  assert.throws(() => qualifyDirectRuntimeConfiguration(config, f.root, f.service, '2026.9.8'));
  assert.equal(readFileSync(retained, 'utf8'), 'Unqualified Group content');
});

test('Group workspace and agent policy cannot adopt shared paths, changed policy or an orphan marker', t => {
  for (const change of ['workspace', 'agentDir', 'tools']) {
    const f = fixture(t); prepareGroupWorkspace(f.root);
    const config = withDirectAgentPlugin(f.config, f.config.plugins.entries[directPluginId].config.epoch, f.root,
      join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) }, { group: true });
    if (change === 'tools') config.agents.entries['edition3-group'].tools.allow.push('nova_direct_read');
    else config.agents.entries['edition3-group'][change] = config.agents.entries['edition3-direct'][change];
    config.plugins.entries[directPluginId].config.policySha256 = directConfigurationHash(config);
    assert.throws(() => qualifyDirectRuntimeConfiguration(config, f.root, f.service, '2026.9.8'));
    assert.throws(() => withDirectAgentPlugin(config, config.plugins.entries[directPluginId].config.epoch, f.root,
      join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) }, { group: true }));
  }
  const root = mkdtempSync(join(tmpdir(), 'nova-group-partial-'));
  writeFileSync(join(root, 'group-workspace.identity'), 'edition3-group-workspace\n');
  assert.throws(() => prepareGroupWorkspace(root));
  assert.deepEqual(readdirSync(root), ['group-workspace.identity']);
});
test('added policy contributors, arbitrary load paths and retargeted workspace are refused even if rehashed', t => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.config.hooks = { unexpected: true }; },
    (f: ReturnType<typeof fixture>) => { f.config.plugins.allow.push('other'); },
    (f: ReturnType<typeof fixture>) => { f.config.plugins.load.paths.push('/unqualified'); },
    (f: ReturnType<typeof fixture>) => { f.config.agents.entries['edition3-direct'].workspace = join(f.root, 'state'); },
    (f: ReturnType<typeof fixture>) => { f.config.agents.entries['edition3-direct'].contextInjection = 'always'; },
    (f: ReturnType<typeof fixture>) => { f.config.cron.enabled = true; },
  ]) {
    const f = fixture(t); mutate(f); f.rehash();
    assert.throws(() => qualifyDirectRuntimeConfiguration(f.config, f.root, f.service, '2026.9.8'));
    assert.equal(qualifyNativeUpdateStartup(f.root, f.service, f.config, '2026.9.8').length, 1);
  }
});
test('preexisting unknown workspace and partial marker state are retained, never cleared or adopted', t => {
  const f = fixture(t), path = join(directRuntimePaths(f.root).workspace, 'AGENTS.md');
  writeFileSync(path, 'Unqualified writing');
  assert.throws(() => prepareDirectWorkspace(f.root)); assert.throws(() => assertDirectWorkspace(f.root));
  assert.equal(readFileSync(path, 'utf8'), 'Unqualified writing');
  const root = mkdtempSync(join(tmpdir(), 'nova-direct-partial-'));
  writeFileSync(join(root, 'direct-workspace.identity'), 'edition3-direct-workspace\n');
  assert.throws(() => prepareDirectWorkspace(root));
  assert.deepEqual(readdirSync(root), ['direct-workspace.identity']);
});
test('packaged direct and exact-profile source closure notices replacement', t => {
  const f = fixture(t), before = directPluginFiles(f.service);
  writeFileSync(join(f.service, 'account-plugin', 'index.js'), '// Replacement fixture\n');
  assert.notEqual(directPluginFiles(f.service), before);
});

function legacyFixture(t: TestContext, group = false) {
  const f = fixture(t), old = join(f.root, 'direct-workspace');
  if (group) {
    prepareGroupWorkspace(f.root);
    Object.assign(f.config, withDirectAgentPlugin(f.config, f.config.plugins.entries[directPluginId].config.epoch,
      f.root, join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) }, { group: true }));
  }
  renameSync(directRuntimePaths(f.root).workspace, old);
  renameSync(join(f.root, 'direct-workspace-v2.identity'), join(f.root, 'direct-workspace.identity'));
  writeFileSync(join(f.root, 'direct-workspace.identity'), 'edition3-direct-workspace\n');
  f.config.agents.entries['edition3-direct'].workspace = old; f.rehash();
  const compose = () => withDirectAgentPlugin(f.config, f.config.plugins.entries[directPluginId].config.epoch,
    f.root, join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) });
  return { ...f, old, compose };
}
test('legacy Direct migration preserves old identities and saved state while selecting one empty new generation', t => {
  const f = legacyFixture(t, true), marker = join(f.root, 'direct-workspace.identity');
  const saved = ['native-attestation.json', 'native-session-history.json', 'account-profile.json'].map(name => join(f.root, 'state', name));
  for (const path of saved) writeFileSync(path, JSON.stringify({ preserved: path, synthetic: true }));
  const protectedPaths = [f.old, marker, groupRuntimePaths(f.root).workspace, join(f.root, 'group-workspace.identity'), ...saved];
  const before = protectedPaths.map(path => ({ path, stat: lstatSync(path), bytes: lstatSync(path).isFile() ? readFileSync(path) : undefined }));
  const original = structuredClone(f.config), updated = f.compose();
  assert.equal(existsSync(directRuntimePaths(f.root).workspace), false, 'config composition cannot create a workspace');
  prepareDirectWorkspace(f.root, f.config);
  assert.deepEqual(f.config, original);
  assert.equal(updated.agents.entries['edition3-direct'].agentDir, original.agents.entries['edition3-direct'].agentDir);
  const expected = structuredClone(original); expected.agents.entries['edition3-direct'].workspace = directRuntimePaths(f.root).workspace;
  expected.plugins.entries[directPluginId].config.policySha256 = directConfigurationHash(expected);
  assert.deepEqual(updated, expected);
  assert.deepEqual(readdirSync(directRuntimePaths(f.root).workspace), []);
  assert.equal(readFileSync(join(f.root, 'direct-workspace-v2.identity'), 'utf8'), directWorkspaceMarker);
  assert.equal(qualifyDirectRuntimeConfiguration(updated, f.root, f.service, '2026.9.8'), true);
  const current = lstatSync(directRuntimePaths(f.root).workspace);
  prepareDirectWorkspace(f.root, updated);
  assert.equal(lstatSync(directRuntimePaths(f.root).workspace).ino, current.ino);
  assert.deepEqual(withDirectAgentPlugin(updated, updated.plugins.entries[directPluginId].config.epoch, f.root,
    join(f.service, 'direct-agent-plugin'), { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) }), updated);
  for (const item of before) {
    const after = lstatSync(item.path);
    assert.equal(after.ino, item.stat.ino); assert.equal(after.dev, item.stat.dev);
    assert.equal(after.mtimeMs, item.stat.mtimeMs); assert.equal(after.ctimeMs, item.stat.ctimeMs);
    if (item.bytes) assert.deepEqual(readFileSync(item.path), item.bytes);
  }
});
test('legacy Direct migration refuses altered config or old content before creating any new path', t => {
  for (const change of ['policy', 'agentDir', 'extra', 'content', 'marker', 'missing-folder', 'missing-marker', 'linked-marker']) {
    const f = legacyFixture(t), marker = join(f.root, 'direct-workspace.identity');
    if (change === 'policy') f.config.agents.entries['edition3-direct'].contextInjection = 'always';
    if (change === 'agentDir') f.config.agents.entries['edition3-direct'].agentDir = join(f.root, 'other-agent');
    if (change === 'extra') f.config.agents.entries['edition3-direct'].unreviewed = true;
    if (change === 'content') writeFileSync(join(f.old, 'AGENTS.md'), 'Preserved unknown content');
    if (change === 'marker') writeFileSync(marker, 'unqualified identity');
    if (change === 'missing-folder') renameSync(f.old, join(f.root, 'kept-original-folder'));
    if (change === 'missing-marker') renameSync(marker, join(f.root, 'kept-original-marker'));
    if (change === 'linked-marker') linkSync(marker, join(f.root, 'kept-marker-link'));
    const before = readdirSync(f.root).sort();
    assert.throws(f.compose, change); assert.throws(() => prepareDirectWorkspace(f.root, f.config), change);
    assert.deepEqual(readdirSync(f.root).sort(), before, change);
    assert.equal(existsSync(directRuntimePaths(f.root).workspace), false, change);
    assert.equal(existsSync(join(f.root, 'direct-workspace-v2.identity')), false, change);
    if (change === 'content') assert.equal(readFileSync(join(f.old, 'AGENTS.md'), 'utf8'), 'Preserved unknown content');
  }
});
test('Direct generation preparation refuses partial migration, orphan target and missing committed generation', t => {
  for (const target of ['folder', 'marker', 'both']) {
    const f = legacyFixture(t);
    if (target !== 'marker') mkdirSync(directRuntimePaths(f.root).workspace);
    if (target !== 'folder') writeFileSync(join(f.root, 'direct-workspace-v2.identity'), directWorkspaceMarker);
    const before = readdirSync(f.root).sort();
    assert.throws(f.compose); assert.throws(() => prepareDirectWorkspace(f.root, f.config));
    assert.deepEqual(readdirSync(f.root).sort(), before);
  }
  const fresh = fixture(t);
  assert.throws(() => prepareDirectWorkspace(fresh.root, fresh.original), 'an uncommitted orphan target is not adopted');
  const current = fixture(t), kept = join(current.root, 'kept-v2');
  renameSync(directRuntimePaths(current.root).workspace, kept);
  assert.throws(() => prepareDirectWorkspace(current.root, current.config));
  assert.equal(existsSync(directRuntimePaths(current.root).workspace), false);
  assert.equal(lstatSync(kept).isDirectory(), true);
  const orphanLegacy = fixture(t);
  writeFileSync(join(orphanLegacy.root, 'direct-workspace.identity'), 'edition3-direct-workspace\n');
  assert.throws(() => prepareDirectWorkspace(orphanLegacy.root, orphanLegacy.config));
});
