import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageCandidate } from './candidate.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = stageCandidate(workspace);
// Resolve data before changing cwd. The frozen build never becomes a new workspace.
process.env.E3_DATA_DIR = resolve(process.env.E3_DATA_DIR ?? join(workspace, '.data'));
process.env.E3_CANDIDATE_ID = candidate.id;
process.chdir(candidate.root);
await import(pathToFileURL(join(candidate.root, 'dist/service/apps/service/main.js')).href);
