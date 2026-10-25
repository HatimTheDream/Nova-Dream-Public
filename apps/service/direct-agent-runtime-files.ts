import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The installed application package owns these compiled plugin entrypoints.
 * Recheck exact bytes within the original runtime lifetime before admission. */
export function directPluginFiles(serviceDirectory: string): string {
  const hash = createHash('sha256');
  for (const name of ['direct-agent-plugin/index.js', 'direct-agent-plugin/package.json',
    'direct-agent-plugin/openclaw.plugin.json', 'direct-agent-tool-calls.js', 'direct-agent-runtime-policy.js', 'group-runtime-policy.js',
    'account-plugin/index.js', 'account-plugin/openclaw.plugin.json', 'account-plugin/package.json']) {
    const path = join(serviceDirectory, name), before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024 || realpathSync(path) !== resolve(path))
      throw Error('The installed direct-agent plugin is unavailable.');
    const bytes = readFileSync(path), after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size)
      throw Error('The installed direct-agent plugin changed during admission.');
    hash.update(name + '\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}
