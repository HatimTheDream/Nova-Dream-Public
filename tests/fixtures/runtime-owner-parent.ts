import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ManagedRuntime } from '../../apps/service/runtime.js';
import { Store } from '../../apps/service/store.js';
import type { AssistantConnection } from '../../packages/domain/assistant.js';

const directory = process.argv[2]!;
process.env.E3_OPENCLAW_ENTRY = join(directory, 'openclaw.mjs');
const store = new Store(join(directory, 'workspace'));
let connection: AssistantConnection = { state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false };
const gateway = { status: () => connection, configure: async (url: string) => connection = { ...connection, state: 'ready', url } };
const runtime = new ManagedRuntime(store, gateway);
const status = await runtime.start();
process.send?.({ status, native: JSON.parse(readFileSync(join(directory, 'workspace/openclaw-runtime/native.json'), 'utf8')) });
process.on('message', () => void runtime.stop().then(() => { store.close(); process.exit(0); }));
