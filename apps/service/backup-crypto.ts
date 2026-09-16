import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { backupMaxBytes, backupPlainMaxBytes, type BackupSnapshot } from '../../packages/domain/workspace-backup.js';
import { Fault, Store } from './store.js';

const compress = promisify(gzip), decompress = promisify(gunzip);
const magic = Buffer.from('NOVA-BACKUP-1\n');
// Fixed versioned costs prevent attacker-controlled KDF work factors.
const derive = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
const checkPassword = (password: string) => { if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Fault(400, 'backup_password', 'Use a backup password between 12 and 256 characters.'); };
export async function encryptBackup(snapshot: BackupSnapshot, password: string): Promise<Buffer> {
  checkPassword(password);
  const plain = Buffer.from(JSON.stringify(snapshot));
  if (plain.length > backupPlainMaxBytes) throw new Fault(413, 'backup_large', 'The backup exceeds this build’s size limit. Existing work is kept.');
  let compressed: Buffer | undefined, key: Buffer | undefined;
  try {
    compressed = await compress(plain); const salt = randomBytes(32), iv = randomBytes(12), header = Buffer.concat([magic, salt, iv]);
    key = await derive(password, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const result = Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
    if (result.length > backupMaxBytes) throw new Fault(413, 'backup_large', 'The encrypted backup exceeds this build’s size limit.');
    return result;
  } finally { key?.fill(0); plain.fill(0); compressed?.fill(0); }
}
export async function decryptBackup(bytes: Buffer, password: string): Promise<BackupSnapshot> {
  checkPassword(password);
  const headerSize = magic.length + 44;
  if (bytes.length <= headerSize + 16 || bytes.length > backupMaxBytes || !bytes.subarray(0, magic.length).equals(magic)) throw new Fault(400, 'backup_format', 'Choose a supported Nova Dream .novabackup file.');
  const key = await derive(password, bytes.subarray(magic.length, magic.length + 32));
  let compressed: Buffer | undefined, plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(magic.length + 32, headerSize));
    decipher.setAAD(bytes.subarray(0, headerSize)); decipher.setAuthTag(bytes.subarray(headerSize, headerSize + 16));
    compressed = Buffer.concat([decipher.update(bytes.subarray(headerSize + 16)), decipher.final()]);
    plain = await decompress(compressed, { maxOutputLength: backupPlainMaxBytes });
    return Store.verifyBackup(JSON.parse(plain.toString('utf8')));
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(400, 'backup_unlock', 'The password is incorrect, or this backup is damaged or unsupported. Nothing was restored.');
  } finally { key.fill(0); compressed?.fill(0); plain?.fill(0); }
}
