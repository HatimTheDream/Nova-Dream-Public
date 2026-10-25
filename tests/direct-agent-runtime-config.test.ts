import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDirectWorkspace, assertDirectWorkspace, prepareGroupWorkspace, assertGroupWorkspace, groupRuntimePaths,
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
  prepareDirectWorkspace(root);
  const config = withDirectAgentPlugin(original, randomUUID(), root, join(service, 'direct-agent-plugin'),
    { url: 'http://127.0.0.1:49122/workspace', token: 'a'.repeat(64) });
  const rehash = () => { config.plugins.entries[directPluginId].config.policySha256 = directConfigurationHash(config); };
  return { root, service, original, config, rehash };
}
test('controlled startup adds only the exact dedicated case and preserves original configuration', t => {
  const f = fixture(t);
  assert.equal((f.original.agents as any).entries, undefined);
  assert.deepEqual(readdirSync(join(f.root, 'direct-workspace')), []);
  assert.equal(qualifyDirectRuntimeConfiguration(f.config, f.root, f.service, '2026.9.8'), true);
  assert.deepEqual(qualifyNativeUpdateStartup(f.root, f.service, f.config, '2026.9.8'), []);
  assert.equal(qualifyNativeUpdateStartup(f.root, f.service, f.config, '2026.9.6').length, 1);
  const before = JSON.stringify(f.config);
  assertDirectConfiguration(f.config, f.config.plugins.entries[directPluginId].config.policySha256);
  assert.equal(JSON.stringify(f.config), before);
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
  const f = fixture(t), path = join(f.root, 'direct-workspace', 'AGENTS.md');
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
