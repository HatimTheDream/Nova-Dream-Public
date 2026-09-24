import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startWorkspaceHost } from './workspace-host.js';
import { privateWebOptions } from './private-web.js';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (pkg.name !== 'nova-dream-edition-3') throw new Error('Start the service from the edition3 directory.');
const port = Number(process.env.E3_PORT ?? 4383);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an unprivileged Nova Dream port.');
const candidateId = process.env.E3_CANDIDATE_ID;
if (candidateId && candidateId !== createHash('sha256').update(Buffer.concat([readFileSync(resolve(root, 'package.json')), readFileSync(resolve(root, 'dist/candidate.json'))])).digest('hex')) throw new Error('The service candidate identity does not match its frozen build.');
const service = await startWorkspaceHost({ directory: resolve(process.env.E3_DATA_DIR ?? resolve(root, '.data')), port, privateWeb: privateWebOptions(), clientDirectory: resolve(root, 'dist/client'), development: process.argv.includes('--dev'), developmentOrigin: process.env.E3_DEV_ORIGIN, version: pkg.version, buildVersion: pkg.edition3.buildVersion, schemaVersion: pkg.edition3.schemaVersion, candidateId, updateSocket: process.env.E3_UPDATE_SOCKET });
console.log(`Nova Dream ${pkg.version} ready at ${service.origin}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void service.close().then(() => process.exit(0)); } });
