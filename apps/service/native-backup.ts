import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagedRuntime } from './runtime.js';
import { Fault } from './store.js';
import type { BackupSnapshot } from '../../packages/domain/workspace-backup.js';

export interface NativeBackup {
  capture(directory: string): Promise<BackupSnapshot['native']>;
  restore(archive: string, directory: string): Promise<void>;
}
export class ManagedNativeBackup implements NativeBackup {
  constructor(private runtime: ManagedRuntime) {}
  private async run(args: string[]) {
    const command = this.runtime.backupCommand(args);
    if (!command) throw new Fault(409, 'native_backup_unavailable', 'The managed Assistant is not configured on this host.');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 125000);
      child.once('error', () => { clearTimeout(timer); clearTimeout(kill); reject(new Fault(503, 'native_backup_failed', 'The Assistant backup tool could not start.')); });
      child.once('close', code => { clearTimeout(timer); clearTimeout(kill); code === 0 && !timedOut ? resolve() : reject(new Fault(503, 'native_backup_failed', 'The Assistant archive did not complete verification. No complete backup was reported.')); });
    });
  }
  async capture(directory: string): Promise<BackupSnapshot['native']> {
    if (!this.runtime.backupCommand(['create', '--dry-run', '--json'])) return { status: 'not-configured', notes: ['No managed Assistant workspace is configured.'] };
    // The native owner snapshots its databases and validates its own schemas.
    // External Work folders are independent source checkouts, not app data.
    await this.run(['create', '--output', directory, '--no-include-workspace', '--verify', '--json']);
    const names = (await readdir(directory)).filter(n => n.endsWith('.tar.gz'));
    if (names.length !== 1) throw new Fault(503, 'native_backup_missing', 'The Assistant did not return one verified archive.');
    const path = join(directory, names[0]);
    if ((await stat(path)).size > 192 * 1024 * 1024) throw new Fault(413, 'native_backup_large', 'The Assistant archive exceeds the supported backup size.');
    const bytes = await readFile(path);
    return { status: 'included', archive: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, notes: ['Assistant state is captured through OpenClaw’s verified backup tool. Its manifest records omitted volatile/plugin files.', 'External Work folders and native workspace files are separate. Saved Nova Dream outputs and uploaded attachments are included.', 'Assistant and workspace snapshots are consecutive. Their pending operations require review after recovery.'] };
  }
  async restore(archive: string, directory: string) { await this.run(['restore', archive, '--target', directory, '--json']); }
}
