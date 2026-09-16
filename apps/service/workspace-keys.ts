import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerKeyProtector } from './server-key.js';

export interface KeyProtector { readonly provider?: 'server-secret'; wrap(key: Buffer): Promise<Buffer>; unwrap(wrapped: Buffer): Promise<Buffer> }
const unavailable = () => new Error('The operating system could not unlock this workspace key. Your saved data was not replaced.');
export class OsKeyProtector implements KeyProtector {
  private async command(operation: 'wrap' | 'unwrap', bytes: Buffer): Promise<Buffer> {
    const binary = createRequire(import.meta.url)('electron') as string;
    const helper = join(dirname(fileURLToPath(import.meta.url)), 'key-vault.cjs');
    return new Promise((accept, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(binary, [helper], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = []; let size = 0, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 18000);
      child.stdout.on('data', bytes => { size += bytes.length; if (size > 16384) { timedOut = true; child.kill('SIGTERM'); } else chunks.push(bytes); });
      child.on('error', () => { clearTimeout(timer); reject(unavailable()); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          if (code !== 0 || timedOut) throw unavailable();
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof data.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.value)) throw unavailable();
          const result = Buffer.from(data.value, 'base64');
          if (operation === 'unwrap' ? result.length !== 32 : !result.length || result.length > 8192) throw unavailable();
          accept(result);
        } catch { reject(unavailable()); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ operation, value: bytes.toString('base64') }));
    });
  }
  wrap(key: Buffer) { return this.command('wrap', key); }
  unwrap(wrapped: Buffer) { return this.command('unwrap', wrapped); }
}

type Wrapper = { format: 1; application: 'private.novadream.edition3.preview'; provider: 'macos-keychain' | 'windows-dpapi' | 'server-secret'; wrapped: string };
export class WorkspaceKeys {
  private pending?: Promise<void>;
  private verified = false;
  constructor(private directory: string, private protector: KeyProtector = process.env.E3_SERVER_KEY_FILE ? new ServerKeyProtector(process.env.E3_SERVER_KEY_FILE, directory) : new OsKeyProtector(), private platform: NodeJS.Platform = process.platform) {}
  private get provider() { return this.protector.provider ?? (this.platform === 'darwin' ? 'macos-keychain' : this.platform === 'win32' ? 'windows-dpapi' : undefined); }
  private get wrapperPath() { return join(this.directory, 'workspace-key.json'); }
  private get legacyPath() { return join(this.directory, 'preview.key'); }
  private read(path: string, max: number): Buffer {
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw unavailable();
    return readFileSync(path);
  }
  private syncDirectory() {
    if (this.platform === 'win32') return;
    const fd = openSync(this.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  status() {
    const protectedCopy = existsSync(this.wrapperPath), legacy = existsSync(this.legacyPath);
    return { protection: protectedCopy && !legacy ? this.provider === 'server-secret' ? 'server' : 'os' : 'file', protectedCopy, verified: this.verified,
      provider: this.provider ?? 'unavailable' };
  }
  async readProtected(): Promise<Buffer | undefined> {
    try { lstatSync(this.wrapperPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw unavailable(); }
    if (readFileSync(join(this.directory, 'edition3.identity'), 'utf8') !== 'private.novadream.edition3.preview\n') throw unavailable();
    try {
      const wrapper = JSON.parse(this.read(this.wrapperPath, 16384).toString()) as Wrapper;
      const provider = this.provider;
      if (wrapper.format !== 1 || wrapper.application !== 'private.novadream.edition3.preview' || !provider || wrapper.provider !== provider || typeof wrapper.wrapped !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(wrapper.wrapped)) throw unavailable();
      const key = await this.protector.unwrap(Buffer.from(wrapper.wrapped, 'base64'));
      if (key.length !== 32) throw unavailable();
      this.verified = true; return key;
    } catch { throw unavailable(); }
  }
  /** Caller verifies against its already authenticated open Store. An existing
   * wrapper is authoritative; unwrap failure never falls back to a key file. */
  protect(matchesOpenStore: (key: Buffer) => boolean): Promise<void> {
    if (this.pending) return this.pending;
    const job = (async () => {
      if (!this.provider) throw unavailable();
      let key = await this.readProtected();
      if (!key) key = this.read(this.legacyPath, 32);
      try {
        if (key.length !== 32 || !matchesOpenStore(key)) throw unavailable();
        if (!existsSync(this.wrapperPath)) {
          const wrapped = await this.protector.wrap(key), check = await this.protector.unwrap(wrapped);
          if (check.length !== 32 || !timingSafeEqual(key, check)) throw unavailable();
          check.fill(0);
          const wrapper: Wrapper = { format: 1, application: 'private.novadream.edition3.preview', provider: this.provider!, wrapped: wrapped.toString('base64') };
          const temporary = this.wrapperPath + '.' + randomUUID() + '.tmp';
          const fd = openSync(temporary, 'wx', 0o600);
          try { writeFileSync(fd, JSON.stringify(wrapper) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(temporary, this.wrapperPath); this.syncDirectory();
          // Verify the durable bytes through the OS before removing the original.
          const durable = await this.readProtected();
          if (!durable || !timingSafeEqual(key, durable)) throw unavailable();
          durable.fill(0);
        }
        if (existsSync(this.legacyPath)) {
          const legacy = this.read(this.legacyPath, 32);
          if (legacy.length !== 32 || !timingSafeEqual(key, legacy)) throw unavailable();
          legacy.fill(0); unlinkSync(this.legacyPath); this.syncDirectory();
        }
        this.verified = true;
      } finally { key.fill(0); }
    })();
    this.pending = job;
    void job.finally(() => { if (this.pending === job) this.pending = undefined; }).catch(() => {});
    return job;
  }
}
