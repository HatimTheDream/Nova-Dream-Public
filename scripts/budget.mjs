import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { measureClient } from './client-budget.mjs';
function files(root) { return readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(root, item.name)) : [join(root, item.name)]); }
const assets = files('dist/client');
const sizes = new Map(assets.filter(file => file.endsWith('.js')).map(file => [relative('dist/client', file).split(sep).join('/'), gzipSync(readFileSync(file)).length]));
const budget = measureClient(JSON.parse(readFileSync('dist/client/.vite/manifest.json', 'utf8')), sizes);
const release = JSON.parse(readFileSync('release.json', 'utf8'));
const artifacts = [...assets, ...files('dist/service'), ...files('dist/desktop')].map(file => ({ path: file.split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }));
writeFileSync('dist/candidate.json', JSON.stringify({ ...release, desktopFormat: 1, clientJavaScriptGzipBytes: budget.totalGzipBytes, clientBudget: budget, artifacts }, null, 2) + '\n');
console.log(`Client JS: ${budget.startupGzipBytes} startup / ${budget.totalGzipBytes} total gzip bytes; paired desktop/client/service hashes recorded in dist/candidate.json.`);
