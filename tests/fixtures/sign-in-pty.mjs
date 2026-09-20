import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synchronous built-in transforms avoid async loader workers: ConPTY waits for
// its own pipe worker while blocking the thread that would service a TS loader.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(source))) return next(source.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const loaded = next(url, context);
    return url.endsWith('.ts') ? { ...loaded, format: 'module', source: stripTypeScriptTypes(String(loaded.source), { mode: 'transform', sourceUrl: url }) } : loaded;
  },
});
const { Store } = await import('../../apps/service/store.ts');
const { ChatGptSignIn } = await import('../../apps/service/sign-in.ts');
hooks.deregister();
const directory = mkdtempSync(join(tmpdir(), 'edition3-signin-pty-'));
const store = new Store(directory);
const note = '│ URL: https://auth.openai.com/codex/device │\n│ Code: TEST-CODE │\n';
const service = new ChatGptSignIn(store, { signInCommand: () => ({
  file: process.execPath,
  args: ['-e', `console.log(${JSON.stringify(note)}); setTimeout(()=>{},2000);`],
  cwd: directory,
  env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
}) });
try {
  await service.start(store.session().deviceId, { requestId: randomUUID(), epoch: store.epoch });
  const deadline = Date.now() + 4000;
  while (service.status().state === 'starting' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const { state, userCode } = service.status();
  assert.equal(state, 'waiting'); assert.equal(userCode, 'TEST-CODE');
  console.log(JSON.stringify({ state, userCode }));
} finally {
  await service.close();
  store.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
