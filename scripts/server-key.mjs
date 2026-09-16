import { randomBytes } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
const args = process.argv.slice(2);
if (args.length !== 1 || !args[0].startsWith('--file=') || !isAbsolute(args[0].slice(7))) throw new Error('Use --file=<absolute-private-credential-path>. The parent directory must already exist.');
const file = args[0].slice(7), key = randomBytes(32);
// Never overwrite a credential: doing so could make the workspace unreadable.
const fd = openSync(file, 'wx', 0o600);
try { writeFileSync(fd, key); fsyncSync(fd); } finally { key.fill(0); closeSync(fd); }
const parent = openSync(dirname(file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
console.log('Created the private server credential. Keep a separate protected copy before storing important work.');
