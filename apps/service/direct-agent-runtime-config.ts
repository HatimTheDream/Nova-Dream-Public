import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical } from '../../packages/domain/contracts.js';
import { directConfigurationHash, directPluginId, directRuntimePolicy, assertDirectConfigurationShape } from './direct-agent-runtime-policy.js';
import { directRuntimeAgent } from './direct-agent-tool-calls.js';
import { directPluginFiles } from './direct-agent-runtime-files.js';
import { assertGroupConfiguration, groupRuntimeAgent, groupRuntimePolicy } from './group-runtime-policy.js';

const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('The managed direct-agent configuration is unavailable.');
  return value as Record<string, any>;
};
const legacyDirectWorkspaceMarker = 'edition3-direct-workspace\n';
export const directWorkspaceMarker = 'edition3-direct-workspace-v2\n';
export function directRuntimePaths(root: string) {
  return { workspace: join(root, 'direct-workspace-v2'), agentDir: join(root, 'state', 'agents', directRuntimeAgent, 'agent') };
}
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const legacyPaths = (root: string) => ({ ...directRuntimePaths(root), workspace: join(root, 'direct-workspace') });
function assertOwnedEmptyWorkspace(workspace: string, marker: string, markerBytes: string) {
  const folder = lstatSync(workspace), identity = lstatSync(marker);
  if (!folder.isDirectory() || folder.isSymbolicLink() || realpathSync(workspace) !== resolve(workspace)
    || !identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
    || identity.size !== Buffer.byteLength(markerBytes) || readFileSync(marker, 'utf8') !== markerBytes)
    throw Error('The original empty direct-agent workspace changed.');
  if (readdirSync(workspace).length) throw Error('The direct-agent workspace contains unqualified content.');
}
function assertLegacyDirectWorkspace(root: string) {
  assertOwnedEmptyWorkspace(legacyPaths(root).workspace, join(root, 'direct-workspace.identity'), legacyDirectWorkspaceMarker);
}
function directWorkspaceGeneration(raw: unknown, root: string): 'fresh' | 'legacy' | 'current' {
  const existing = raw === undefined ? undefined : object(object(raw).agents).entries?.[directRuntimeAgent];
  if (existing === undefined) return 'fresh';
  if (canonical(existing) === canonical({ ...structuredClone(directRuntimePolicy), ...directRuntimePaths(root) })) return 'current';
  if (canonical(existing) === canonical({ ...structuredClone(directRuntimePolicy), ...legacyPaths(root) })) return 'legacy';
  throw Error('The existing direct-agent configuration must be reviewed before replacement.');
}
function assertFreshDirectTarget(root: string) {
  if (present(directRuntimePaths(root).workspace) || present(join(root, 'direct-workspace-v2.identity')))
    throw Error('The new direct-agent workspace has uncommitted or partial state.');
}
/** Prepare a new owned generation only after validating the exact prior config.
 * Legacy bytes, marker, native attestation and agent/session storage are retained.
 * A partial migration is refused; it is never adopted or silently repaired. */
export function prepareDirectWorkspace(root: string, priorConfig?: unknown) {
  const generation = directWorkspaceGeneration(priorConfig, root);
  if (generation === 'current') { assertDirectWorkspace(root); return; }
  if (generation === 'legacy') assertLegacyDirectWorkspace(root);
  else if (present(legacyPaths(root).workspace) || present(join(root, 'direct-workspace.identity')))
    throw Error('The legacy direct-agent workspace has no matching configuration.');
  assertFreshDirectTarget(root);
  const { workspace } = directRuntimePaths(root);
  mkdirSync(workspace);
  writeFileSync(join(root, 'direct-workspace-v2.identity'), directWorkspaceMarker, { flag: 'wx', mode: 0o600 });
  assertDirectWorkspace(root);
}
export function assertDirectWorkspace(root: string) {
  assertOwnedEmptyWorkspace(directRuntimePaths(root).workspace, join(root, 'direct-workspace-v2.identity'), directWorkspaceMarker);
  if (present(legacyPaths(root).workspace) || present(join(root, 'direct-workspace.identity'))) assertLegacyDirectWorkspace(root);
}
export const groupWorkspaceMarker = 'edition3-group-workspace\n';
export function groupRuntimePaths(root: string) {
  return { workspace: join(root, 'group-workspace'), agentDir: join(root, 'state', 'agents', groupRuntimeAgent, 'agent') };
}
export function prepareGroupWorkspace(root: string) {
  const { workspace } = groupRuntimePaths(root), marker = join(root, 'group-workspace.identity');
  if (!existsSync(workspace)) {
    if (existsSync(marker)) throw Error('The original Group workspace is missing.');
    mkdirSync(workspace);
    writeFileSync(marker, groupWorkspaceMarker, { flag: 'wx', mode: 0o600 });
  }
  assertGroupWorkspace(root);
}
export function assertGroupWorkspace(root: string) {
  const { workspace } = groupRuntimePaths(root), marker = join(root, 'group-workspace.identity');
  const folder = lstatSync(workspace), identity = lstatSync(marker);
  if (!folder.isDirectory() || folder.isSymbolicLink() || realpathSync(workspace) !== resolve(workspace)
    || !identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
    || identity.size !== Buffer.byteLength(groupWorkspaceMarker) || readFileSync(marker, 'utf8') !== groupWorkspaceMarker)
    throw Error('The original empty Group workspace changed.');
  if (readdirSync(workspace).length) throw Error('The Group workspace contains unqualified content.');
}
export function withDirectAgentPlugin(raw: unknown, epoch: string, root: string, bundlePath: string, bridge: { url: string; token: string }, options: { group?: boolean } = {}) {
  const config = structuredClone(object(raw)), plugins = object(config.plugins), agents = object(config.agents);
  const prior = plugins.entries?.[directPluginId], paths = directRuntimePaths(root);
  if (plugins.enabled !== true || prior?.enabled === false || agents.list || config.$include)
    throw Error('The original runtime does not permit the controlled direct-agent plugin.');
  // Native bootstrap creation is separate from workspace context injection.
  agents.defaults = { ...object(agents.defaults), skipBootstrap: true };
  const generation = directWorkspaceGeneration(config, root);
  if (generation === 'legacy') { assertLegacyDirectWorkspace(root); assertFreshDirectTarget(root); }
  else if (generation === 'current') assertDirectWorkspace(root);
  const expectedAgent = { ...structuredClone(directRuntimePolicy), ...paths };
  agents.entries = { ...agents.entries, [directRuntimeAgent]: expectedAgent };
  if (options.group) {
    const expectedGroup = { ...structuredClone(groupRuntimePolicy), ...groupRuntimePaths(root) };
    const priorGroup = agents.entries[groupRuntimeAgent];
    if (priorGroup && canonical(priorGroup) !== canonical(expectedGroup))
      throw Error('The existing Group configuration must be reviewed before replacement.');
    agents.entries[groupRuntimeAgent] = expectedGroup;
  }
  plugins.allow = [...new Set([...(plugins.allow ?? []), directPluginId])];
  plugins.slots = { ...object(plugins.slots ?? {}), memory: 'none' };
  plugins.load = { ...plugins.load, paths: [...new Set([...(plugins.load?.paths ?? []).filter((path: string) => path !== prior?.config?.bundlePath), bundlePath])] };
  plugins.entries = { ...plugins.entries, 'memory-core': { ...object(plugins.entries?.['memory-core'] ?? {}), enabled: false }, [directPluginId]: { enabled: true, config: {
    epoch, bundlePath, url: bridge.url + '/direct', token: bridge.token, policySha256: '',
  } } };
  assertDirectConfigurationShape(config);
  plugins.entries[directPluginId].config.policySha256 = directConfigurationHash(config);
  if (agents.entries[groupRuntimeAgent]) assertGroupConfiguration(config, plugins.entries[directPluginId].config.policySha256);
  return config;
}
/** Additional startup case, not a broader plugin exemption. Original native
 * DB/pending/restart checks still run after this exact read-only configuration,
 * workspace and packaged-source check succeeds. */
export function qualifyDirectRuntimeConfiguration(raw: unknown, root: string, serviceDirectory: string, version: string) {
  const config = object(raw), plugin = config.plugins?.entries?.[directPluginId];
  if (!plugin && !config.plugins?.allow?.includes(directPluginId)
    && !config.agents?.entries?.[directRuntimeAgent]) return false;
  if (version !== '2026.9.8') throw Error('The dedicated runtime version is not qualified.');
  assertDirectConfigurationShape(config);
  const settings = object(object(plugin).config), paths = directRuntimePaths(root);
  const actual = object(config.agents.entries[directRuntimeAgent]);
  if (actual.workspace !== paths.workspace || actual.agentDir !== paths.agentDir
    || settings.bundlePath !== join(serviceDirectory, 'direct-agent-plugin')
    || settings.policySha256 !== directConfigurationHash(config))
    throw Error('The original dedicated paths or policy changed.');
  const allowed = new Set(['worker-plugin', 'module-plugin', 'source-plugin', 'account-plugin', 'direct-agent-plugin']
    .map(name => resolve(serviceDirectory, name)));
  if (!Array.isArray(config.plugins.load?.paths)
    || config.plugins.load.paths.some((path: unknown) => typeof path !== 'string' || !allowed.has(resolve(path)))
    || !config.plugins.load.paths.includes(settings.bundlePath))
    throw Error('The original plugin source selection changed.');
  assertDirectWorkspace(root);
  if (config.agents.entries[groupRuntimeAgent]) {
    assertGroupConfiguration(config, settings.policySha256);
    const group = config.agents.entries[groupRuntimeAgent], expected = groupRuntimePaths(root);
    if (group.workspace !== expected.workspace || group.agentDir !== expected.agentDir)
      throw Error('The original Group paths changed.');
    assertGroupWorkspace(root);
  }
  directPluginFiles(serviceDirectory);
  const manifest = JSON.parse(readFileSync(join(settings.bundlePath, 'openclaw.plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(settings.bundlePath, 'package.json'), 'utf8'));
  if (manifest.id !== directPluginId || canonical(pkg.openclaw?.extensions) !== canonical(['./index.js']))
    throw Error('The exact packaged direct-agent entrypoint changed.');
  return true;
}
