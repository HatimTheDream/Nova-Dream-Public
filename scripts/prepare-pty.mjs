import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// node-pty 1.1.0's published macOS prebuild omits the helper executable bit.
// Upstream issue: https://github.com/microsoft/node-pty/issues/919
// Repair only these pinned, local dependency files during installation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'nova-dream-edition-3') throw new Error('Unexpected workspace.');
if (process.platform === 'darwin') {
  const dependency = join(root, 'node_modules/node-pty');
  if (JSON.parse(readFileSync(join(dependency, 'package.json'), 'utf8')).version !== '1.1.0') throw new Error('Review the PTY preparation step for the new dependency version.');
  for (const arch of ['arm64', 'x64']) {
    const helper = join(dependency, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (!existsSync(helper)) continue;
    if (!lstatSync(helper).isFile() || !realpathSync(helper).startsWith(realpathSync(dependency) + sep)) throw new Error('Unexpected PTY helper location.');
    chmodSync(helper, 0o755);
  }
}
