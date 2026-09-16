import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { KeyProtector } from './workspace-keys.js';

const aad = Buffer.from('Nova Dream workspace key / server-secret / v1');
export function readServerCredential(path: string, workspace: string) {
  if (!isAbsolute(path) || !isAbsolute(workspace)) throw new Error('Use absolute server credential and workspace paths.');
  const file = realpathSync(path), directory = realpathSync(workspace);
  if (file === directory || file.startsWith(directory + sep)) throw new Error('Keep the server credential outside workspace data and use its direct path.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), uid = process.getuid?.();
    if (!stat.isFile() || stat.size !== 32 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || uid !== undefined && stat.uid !== uid && stat.uid !== 0) throw new Error('The server credential must be a private, owner-readable 32-byte regular file.');
    const key = readFileSync(fd); if (key.length !== 32) throw new Error('The server credential changed while reading.'); return key;
  } finally { closeSync(fd); }
}
/** A separately provisioned host credential wraps the workspace key. It is
 * never generated on retry, copied into a backup, or sent to a browser. */
export class ServerKeyProtector implements KeyProtector {
  readonly provider = 'server-secret' as const;
  constructor(private file: string, private directory: string) {
    if (!isAbsolute(file)) throw new Error('Use an absolute server credential file.');
  }
  private key() {
    return readServerCredential(this.file, this.directory);
  }
  async wrap(value: Buffer) {
    if (value.length !== 32) throw new Error('Invalid workspace key.');
    const key = this.key();
    try {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
    } finally { key.fill(0); }
  }
  async unwrap(value: Buffer) {
    if (value.length !== 61 || value[0] !== 1) throw new Error('Invalid server key wrapper.');
    const key = this.key();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13)); decipher.setAAD(aad); decipher.setAuthTag(value.subarray(13, 29));
      return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]);
    } finally { key.fill(0); }
  }
}
