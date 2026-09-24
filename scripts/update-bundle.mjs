import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const maximum = 128 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['bundle.json', 'request.json', 'result.json', 'runner.log']);
function writeExclusive(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Packages only an explicitly reviewed flat directory. It does not build a runner or publish files. */
export function packageUpdateBundle(source, output) {
  const input = resolve(source), destination = resolve(output), info = lstatSync(input);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(input) !== input) throw Error('Select the actual reviewed bundle directory.');
  const names = readdirSync(input).sort();
  if (!names.includes('install.py') || !names.length || names.length > 64) throw Error('The reviewed bundle needs install.py and at most 64 flat files.');
  let total = 0;
  const files = names.map(name => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name) || excluded.has(name)) throw Error('Unsupported or reserved update file name.');
    const path = join(input, name), metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum) throw Error('Reviewed bundle entries must be independent regular files.');
    total += metadata.size; if (total > maximum) throw Error('The reviewed bundle is too large.');
    const bytes = readFileSync(path); return { name, data: bytes.toString('base64'), sha256: sha(bytes) };
  });
  const bytes = Buffer.from(JSON.stringify({ format: 1, files }));
  if (bytes.length > maximum) throw Error('The encoded update bundle exceeds 128 MiB.');
  const metadata = { bytes: bytes.length, sha256: sha(bytes), runnerSha256: files.find(file => file.name === 'install.py').sha256 };
  writeExclusive(destination, bytes); writeExclusive(destination + '.metadata.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: node scripts/update-bundle.mjs REVIEWED_DIRECTORY OUTPUT_BUNDLE_JSON');
  console.log(JSON.stringify(packageUpdateBundle(process.argv[2], process.argv[3])));
}
