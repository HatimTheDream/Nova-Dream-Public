import { copyFileSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const names = ['companion-main.cjs', 'companion-client.cjs', 'companion-access.cjs', 'companion-mcp.cjs', 'companion-preload.cjs', 'companion-controls-preload.cjs', 'companion-controls.js', 'companion.html', 'companion.css', 'main.cjs', 'preload.cjs', 'external.cjs', 'launch-policy.cjs', 'lynx-mark.png', 'lynx-mark.provenance.json'];
for (const name of names) {
  const stat = lstatSync(join('apps/desktop', name));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Desktop artifact must be a regular file: ${name}`);
}
rmSync('dist/desktop', { recursive: true, force: true });
mkdirSync('dist/desktop', { recursive: true });
for (const name of names) copyFileSync(join('apps/desktop', name), join('dist/desktop', name));

copyFileSync('apps/client/public/icons/nova-dream-red-512-v4.png', 'dist/desktop/companion-icon.png');
