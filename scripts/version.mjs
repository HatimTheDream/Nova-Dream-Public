import { readFileSync, writeFileSync } from 'node:fs';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const pkg = read('package.json'); const lock = read('package-lock.json');
const kind = process.argv[2];
if (!['patch', 'minor', 'major'].includes(kind)) throw new Error('Use npm run version:bump -- patch|minor|major');
const version = pkg.version.split('.').map(Number);
if (kind === 'major') { version[0]++; version[1] = 0; version[2] = 0; }
else if (kind === 'minor') { version[1]++; version[2] = 0; } else version[2]++;
pkg.version = version.join('.');
const build = pkg.edition3.buildVersion.split('.').map(Number); build[2]++; pkg.edition3.buildVersion = build.join('.');
lock.version = pkg.version; lock.packages[''].version = pkg.version;
for (const [file, value] of [['package.json', pkg], ['package-lock.json', lock]]) writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
writeFileSync('README.md', readFileSync('README.md', 'utf8').replace(/Version-\d+\.\d+\.\d+-blue/, `Version-${pkg.version}-blue`));
writeFileSync('release.json', JSON.stringify({ version: pkg.version, ...pkg.edition3, channel: 'local-preview', publishing: false, installation: false }, null, 2) + '\n');
console.log(`Nova Dream ${pkg.version} · build ${pkg.edition3.buildVersion}`);
