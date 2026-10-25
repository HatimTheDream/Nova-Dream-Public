import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../apps/service/store.js';
import { ManagedRuntime } from '../apps/service/runtime.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';

test('native commands forward only the exact host system-CA opt-in and keep unsafe environment overrides excluded', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-system-ca-'));
  const entry = join(directory, 'openclaw.mjs');
  const filtered = ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENAI_API_KEY'] as const;
  const observedKeys = ['NODE_USE_SYSTEM_CA', ...filtered];
  const saved = new Map(['E3_OPENCLAW_ENTRY', ...observedKeys].map(key => [key, process.env[key]]));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  // This synthetic CLI reports only the named test variables; it performs no TLS or account access.
  writeFileSync(entry, `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync('observed-environment.json', JSON.stringify(Object.fromEntries(${JSON.stringify(observedKeys)}.map(key => [key, process.env[key] ?? null]))));
const server = createServer((_request, response) => { response.end('ready'); });
server.listen(Number(process.env.OPENCLAW_GATEWAY_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const store = new Store(join(directory, 'workspace'));
  let connection: AssistantConnection = { state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false };
  const gateway = {
    status: () => connection,
    configure: async (url: string): Promise<AssistantConnection> => (connection = { ...connection, state: 'ready', url }),
  };
  const runtime = new ManagedRuntime(store, gateway);
  try {
    process.env.E3_OPENCLAW_ENTRY = entry;
    process.env.NODE_USE_SYSTEM_CA = '1';
    process.env.NODE_OPTIONS = '--not-an-allowed-native-option';
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.NODE_EXTRA_CA_CERTS = join(directory, 'not-read.pem');
    process.env.SSL_CERT_FILE = join(directory, 'not-read.crt');
    process.env.SSL_CERT_DIR = join(directory, 'not-read-certificates');
    process.env.OPENAI_API_KEY = 'synthetic-must-not-be-forwarded';
    assert.equal((await runtime.start()).state, 'running');
    const gatewayEnvironment = JSON.parse(readFileSync(join(store.directory, 'openclaw-runtime/observed-environment.json'), 'utf8'));
    assert.deepEqual(gatewayEnvironment, Object.fromEntries(observedKeys.map(key => [key, key === 'NODE_USE_SYSTEM_CA' ? '1' : null])));

    for (const value of [undefined, '0', 'true', ' 1', '1']) {
      if (value === undefined) delete process.env.NODE_USE_SYSTEM_CA;
      else process.env.NODE_USE_SYSTEM_CA = value;
      const backup = runtime.backupCommand(['create', '--output', join(directory, 'not-executed.backup')]);
      assert(backup);
      const commands = [runtime.signInCommand(), runtime.signInCommand('browser'), runtime.accountCommand(), runtime.accountOrderCommand(), backup];
      for (const command of commands) {
        assert.equal(command.env.NODE_USE_SYSTEM_CA, value === '1' ? '1' : undefined);
        for (const key of filtered) assert.equal(command.env[key], undefined, key + ' must remain excluded');
        assert.deepEqual(command.args.slice(0, 3), [entry, '--profile', 'edition3'], 'Trust forwarding must not shift native CLI arguments');
      }
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await runtime.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
