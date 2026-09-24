import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';

// systemd holds /run/nova-update/host.lock using flock for this entire process.
// Keep this frozen updater installation outside the application release pointer.
if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Use the provisioned Linux update service.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (let path = root;; path = dirname(path)) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw Error('The updater installation must be protected by root.');
  if (path === dirname(path)) break;
}
const configuration = process.argv[2];
if (!configuration || process.argv.length !== 3) throw Error('Pass the provisioned update configuration file.');
const visited = new Set();
function protectedTree(path) {
  const info = lstatSync(path);
  if (info.uid !== 0 || !info.isSymbolicLink() && (info.mode & 0o022)) throw Error('Updater code must be owned and writable only by root.');
  if (info.isSymbolicLink()) { const target = realpathSync(path); if (!target.startsWith(root + '/')) throw Error('Updater dependencies cannot leave the frozen installation.'); protectedTree(target); return; }
  if (visited.has(path)) return; visited.add(path);
  if (info.isDirectory()) for (const name of readdirSync(path)) protectedTree(join(path, name));
  else if (!info.isFile()) throw Error('Updater code must use ordinary files.');
}
// Validate before importing root-executed modules, including their dependencies.
for (const path of ['scripts', 'dist/service', 'node_modules', 'package.json']) protectedTree(join(root, path));
const { verifyCandidate } = await import('./candidate.mjs');
const { startUpdateHost } = await import(pathToFileURL(join(root, 'dist/service/apps/service/update-host.js')).href);
const host = await startUpdateHost(configuration, verifyCandidate);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (stopping) return; stopping = true; void host.close().then(() => process.exit(0), () => process.exit(1)); });
