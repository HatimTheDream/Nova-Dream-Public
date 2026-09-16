import { existsSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { startServer } from './http.js';
import { Store } from './store.js';
import { WorkspaceKeys } from './workspace-keys.js';

export interface RecoveryHost {
  status(): { active: boolean; switching: boolean; error?: string };
  switchTo(directory?: string, restart?: boolean): void;
}
const selectionSchema = z.object({ format: z.literal(1), recoveryId: z.string().uuid() }).strict();
/** Changes the selected copy only after its service has stopped. Both directories
 * remain intact. Selection is durable; a failed launch rolls back to its origin. */
export async function startWorkspaceHost(options: Parameters<typeof startServer>[0]) {
  const root = resolve(options.directory), selection = join(root, 'workspace-selection.json');
  const recoveryPath = (id: string) => {
    z.string().uuid().parse(id);
    const directory = join(root, 'recovered-workspaces', id);
    for (const path of [root, dirname(directory), directory, join(directory, 'recovery-complete.json')]) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (path.endsWith('recovery-complete.json') ? !stat.isFile() : !stat.isDirectory())) throw new Error('Invalid recovery identity');
    }
    const proof = JSON.parse(readFileSync(join(directory, 'recovery-complete.json'), 'utf8'));
    if (proof.jobId !== id || !/^[a-f0-9]{64}$/.test(proof.sourceHash)) throw new Error('Unverified recovery');
    return directory;
  };
  const readSelection = () => {
    if (!existsSync(selection)) return root;
    const stat = lstatSync(selection); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid workspace selection');
    return recoveryPath(selectionSchema.parse(JSON.parse(readFileSync(selection, 'utf8'))).recoveryId);
  };
  const writeSelection = (directory: string) => {
    if (directory === root) { if (existsSync(selection)) unlinkSync(selection); }
    else {
      const id = relative(join(root, 'recovered-workspaces'), directory); recoveryPath(id);
      const temporary = selection + '.' + randomUUID();
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ format: 1, recoveryId: id })); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, selection);
    }
    if (process.platform !== 'win32') { const fd = openSync(root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  };
  let directory = readSelection(), port = options.port, error: string | undefined;
  let work: Promise<void> | undefined, closed = false;
  let service: Awaited<ReturnType<typeof startServer>>;
  const launch = (path: string) => startServer({ ...options, directory: path, port, recoveryHost: control });
  const control: RecoveryHost = {
    status: () => ({ active: directory !== root, switching: !!work, ...(error ? { error } : {}) }),
    switchTo(target, restart = false) {
      if (closed || work) throw new Error('A workspace switch is already in progress.');
      const destination = target ? recoveryPath(relative(join(root, 'recovered-workspaces'), resolve(target))) : root;
      if (destination === directory && !restart) return;
      error = undefined;
      // Let the accepted response leave the old HTTP service before draining it.
      work = new Promise<void>(ok => setTimeout(ok, 150)).then(async () => {
        const previous = directory;
        await service.close();
        try {
          if (destination !== root) {
            const keys = new WorkspaceKeys(destination, options.keyProtector), key = await keys.readProtected();
            let recovered: Store;
            try { recovered = new Store(destination, undefined, key); } finally { key?.fill(0); }
            try { recovered.activateRecoveredLocal(); } finally { recovered.close(); }
          }
          writeSelection(destination); directory = destination;
          if (!closed) service = await launch(directory);
        } catch {
          writeSelection(previous); directory = previous;
          error = 'The recovered workspace could not open. Your previous workspace was kept and reopened.';
          if (!closed) service = await launch(previous);
        }
      }).finally(() => { work = undefined; });
      // The status endpoint reports recoverable failures. A failed fallback is
      // surfaced by waitForSwitch/close instead of an unhandled rejection.
      void work.catch(() => { error = 'The workspace service could not restart. Both saved copies are kept.'; });
    },
  };
  try { service = await launch(directory); }
  catch (failure) {
    if (directory === root) throw failure;
    writeSelection(root); directory = root; error = 'The selected recovered copy could not open. The original workspace was reopened.';
    service = await launch(root);
  }
  port = Number(new URL(service.origin).port);
  return {
    get origin() { return service.origin; }, get current() { return service; },
    status: control.status,
    async waitForSwitch() { await work; },
    async close() { closed = true; try { await work; } finally { await service.close(); } },
  };
}
