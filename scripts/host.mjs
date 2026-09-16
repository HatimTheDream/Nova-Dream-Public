import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { verifyCandidate } from './candidate.mjs';

// Immutable release code and a separately provisioned, durable server workspace.
// This command does not install services, change routes or copy owner data.
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const directory = process.env.E3_DATA_DIR, credential = process.env.E3_SERVER_KEY_FILE;
if (!directory || !isAbsolute(directory) || !credential || !isAbsolute(credential)) throw new Error('Server startup needs absolute E3_DATA_DIR and E3_SERVER_KEY_FILE paths.');
const data = existsSync(directory) ? realpathSync(directory) : join(realpathSync(dirname(directory)), basename(directory));
if (data === root || data.startsWith(root + sep)) throw new Error('Server workspace data must be outside the application release.');
const keyFile = realpathSync(credential);
if (keyFile === root || keyFile.startsWith(root + sep)) throw new Error('Keep the server credential outside the application release.');
if (process.env.E3_WEB_PROXY_KEY_FILE) {
  if (!isAbsolute(process.env.E3_WEB_PROXY_KEY_FILE)) throw new Error('Use an absolute proxy credential path.');
  const proxyKey = realpathSync(process.env.E3_WEB_PROXY_KEY_FILE);
  if (proxyKey === root || proxyKey.startsWith(root + sep)) throw new Error('Keep the proxy credential outside the application release.');
}
const candidate = verifyCandidate(root);
process.env.E3_CANDIDATE_ID = candidate.id;
process.env.E3_DATA_DIR = data;
process.chdir(root);
await import(pathToFileURL(join(root, 'dist/service/apps/service/main.js')).href);
