import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCandidate } from './candidate.mjs';
import { desktopHealth } from './desktop-health.mjs';
import policy from '../apps/desktop/launch-policy.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'nova-dream-edition-3') throw new Error('This is not the Edition 3 workspace.');
const options = policy.launchOptions(process.argv.slice(2), root);
const candidate = stageCandidate(root), expected = policy.expectedCandidate(candidate.manifest, candidate.id);
const binary = process.platform === 'darwin' ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : process.platform === 'win32' ? join(root, 'node_modules/electron/dist/electron.exe') : join(root, 'node_modules/electron/dist/electron');
if (!lstatSync(binary).isFile()) throw new Error('Install the workspace dependencies before opening the desktop preview.');
const logs = join(root, '.launcher', 'logs'); mkdirSync(logs, { recursive: true, mode: 0o700 });
async function detached(command, args, env, name, cwd) {
  const log = openSync(join(logs, name), 'a', 0o600);
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log, log], shell: false, windowsHide: true });
    await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    child.unref();
  } finally { closeSync(log); }
  return child;
}
if (!await desktopHealth(options.address, expected)) {
  const directory = options.dataDirectory ?? (options.qa ? join(root, '.tmp-qa', 'desktop-workspaces', options.profile) : join(root, '.data'));
  if (options.qa) policy.prepareQaDirectory(directory, root);
  const child = await detached(process.execPath, [join(candidate.root, 'dist/service/apps/service/main.js')], { ...process.env, E3_PORT: String(options.port), E3_DATA_DIR: directory, E3_CANDIDATE_ID: candidate.id }, options.qa ? `service-${options.profile}.log` : 'service.log', candidate.root);
  const deadline = Date.now() + 30000;
  while (!await desktopHealth(options.address, expected)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Edition 3 did not become ready. Review its local service log.');
    await new Promise(r => setTimeout(r, 200));
  }
}
await detached(binary, [join(candidate.root, 'dist/desktop/main.cjs'), ...process.argv.slice(2)], { ...process.env, E3_DESKTOP_WORKSPACE: root, E3_DESKTOP_CANDIDATE: candidate.id }, options.qa ? `desktop-${options.profile}.log` : 'desktop.log', candidate.root);
console.log(`Nova Dream ${expected.version} · ${expected.buildVersion} opened at ${options.address}${options.qa ? ` (${options.profile})` : ''}.`);
