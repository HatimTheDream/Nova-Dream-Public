import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChatGptAccount } from '../apps/service/chatgpt-account.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Store } from '../apps/service/store.js';
import { emptyChatGptUsage } from '../packages/domain/chatgpt-accounts.js';

const command = { file: process.execPath, args: ['metadata'], cwd: process.cwd(), env: { PATH: process.env.PATH } };
function fixture() {
  let now = 100000;
  const workspace = { epoch: randomUUID(), updateMaintenanceHeld: false };
  const status = { state: 'ready', generation: randomUUID(), url: 'ws://127.0.0.1:49999', methods: ['e3.accounts.snapshot', 'models.authOrderSet'] };
  const account = (profileId: string, email?: string) => ({ profileId, ...(email ? { email } : {}), identityKey: 'a'.repeat(64),
    health: 'ready', cooldownUntil: null, expiresAt: 200000, usage: emptyChatGptUsage() });
  const snapshot = { epoch: workspace.epoch, checkedAt: now, order: ['openai:b', 'openai:a'], accounts: [account('openai:a', 'a@example.com'), account('openai:b', 'b@example.com')] };
  const calls = { rpc: 0, cli: [] as string[], params: [] as unknown[] };
  let response: () => Promise<unknown> = async () => structuredClone(snapshot);
  const gateway = { status: () => status, request: async (_method: string, params: unknown) => { calls.rpc++; calls.params.push(params); return response(); } } as unknown as AssistantTransport;
  const service = new ChatGptAccount({ accountCommand: () => command, accountOrderCommand: () => ({ ...command, args: ['order'] }) }, async current => {
    calls.cli.push(current.args[0]!);
    return current.args[0] === 'order' ? JSON.stringify({ agentId: 'main', provider: 'openai', order: ['openai:b', 'openai:a'] })
      : JSON.stringify({ agentId: 'main', provider: 'openai', profiles: snapshot.accounts.map(value => ({ id: value.profileId, provider: 'openai', type: 'oauth', email: value.email })) });
  }, () => now, { store: workspace as unknown as Store, gateway, control: { async request<T>(): Promise<T> { throw Error('No mutation is admitted by a read fixture'); } } });
  return { service, workspace, status, snapshot, calls, setTime: (value: number) => { now = value; }, reply: (value: () => Promise<unknown>) => { response = value; } };
}

test('ready account snapshots coalesce and cache without CLI while preserving order, duplicates and sanitized metadata', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.reply(() => new Promise(resolve => { release = resolve; }));
  try {
    const first = f.service.read(), second = f.service.read(true);
    assert.equal(f.calls.rpc, 1); assert.deepEqual(f.calls.cli, []);
    release({ ...f.snapshot, secret: 'PRIVATE_TOP_TOKEN', accounts: f.snapshot.accounts.map(account => ({ ...account, access_token: 'PRIVATE_ACCOUNT_TOKEN', authPath: '/private/auth' })) });
    const result = await first; assert.deepEqual(result, await second);
    assert.equal(result.state, 'available'); assert.deepEqual(result.order, ['openai:b', 'openai:a']); assert.equal(result.preferredProfileId, 'openai:b');
    assert.equal(result.accounts![1]!.duplicateOf, 'openai:b'); assert.equal(result.canManage, true); assert.equal(result.profileCount, 2);
    assert.deepEqual(result.emails, ['a@example.com', 'b@example.com']); assert.equal(result.checkedAt, 100000);
    assert(!JSON.stringify(result).includes('PRIVATE')); assert(!JSON.stringify(result).includes('/private'));
    assert.deepEqual(await f.service.read(), result); assert.equal(f.calls.rpc, 1); assert.deepEqual(f.calls.cli, []);
    f.reply(async () => ({ ...f.snapshot, checkedAt: 130001 })); f.setTime(130001);
    assert.equal((await f.service.read()).state, 'available'); assert.equal(f.calls.rpc, 2); assert.deepEqual(f.calls.cli, []);
    assert.deepEqual(f.calls.params[0], { epoch: f.workspace.epoch, refresh: false });
  } finally { await f.service.close(); }
});

test('advertised snapshot failure or invalid authority never falls back to CLI or exposes a previous cached identity', async () => {
  for (const kind of ['rejected', 'malformed', 'wrong-epoch', 'stale', 'future', 'duplicate-account', 'duplicate-order', 'missing-order-member'] as const) {
    const f = fixture();
    try {
      assert.equal((await f.service.read()).state, 'available');
      const bad: any = structuredClone(f.snapshot);
      if (kind === 'malformed') bad.accounts = 'PRIVATE_INVALID';
      else if (kind === 'wrong-epoch') bad.epoch = randomUUID();
      else if (kind === 'stale') bad.checkedAt = 70000;
      else if (kind === 'future') bad.checkedAt = 100001;
      else if (kind === 'duplicate-account') bad.accounts.push(structuredClone(bad.accounts[0]));
      else if (kind === 'duplicate-order') bad.order.push(bad.order[0]);
      else if (kind === 'missing-order-member') bad.order.push('openai:missing');
      f.reply(async () => { if (kind === 'rejected') throw Error('PRIVATE_PROVIDER_FAILURE'); return bad; });
      const result = await f.service.read(true); assert.equal(result.state, 'unavailable', kind); assert.deepEqual(result.emails, []);
      assert(!JSON.stringify(result).includes('PRIVATE')); assert.deepEqual(f.calls.cli, []);
      assert.equal((await f.service.read()).state, 'unavailable', 'a failed refresh cannot retain its old cache');
      assert.equal(f.calls.rpc, 3);
    } finally { await f.service.close(); }
  }
});

test('snapshot status rejects host and workspace changes during a request and cache entries belong to their epoch', async () => {
  for (const kind of ['generation', 'url', 'readiness', 'capability', 'epoch'] as const) {
    const f = fixture(); let release!: (value: unknown) => void;
    f.reply(() => new Promise(resolve => { release = resolve; }));
    try {
      const pending = f.service.read();
      if (kind === 'generation') f.status.generation = randomUUID();
      else if (kind === 'url') f.status.url = 'ws://127.0.0.1:49998';
      else if (kind === 'readiness') f.status.state = 'disconnected';
      else if (kind === 'capability') f.status.methods = [];
      else f.workspace.epoch = randomUUID();
      release(structuredClone(f.snapshot)); assert.equal((await pending).state, 'unavailable', kind); assert.deepEqual(f.calls.cli, []);
    } finally { await f.service.close(); }
  }
  for (const kind of ['readiness', 'snapshot-capability', 'order-capability'] as const) {
    const cached = fixture();
    try {
      assert.equal((await cached.service.read()).canManage, true);
      if (kind === 'readiness') cached.status.state = 'disconnected';
      else if (kind === 'snapshot-capability') cached.status.methods = ['models.authOrderSet'];
      else cached.status.methods = ['e3.accounts.snapshot'];
      const next = await cached.service.read();
      assert.equal(next.state, 'available');
      assert.equal(next.canManage, kind === 'snapshot-capability');
      if (kind === 'order-capability') {
        assert.equal(cached.calls.rpc, 2, 'capability changes invalidate the cached snapshot'); assert.deepEqual(cached.calls.cli, []);
      } else {
        assert.equal(cached.calls.rpc, 1); assert.deepEqual(cached.calls.cli, ['metadata', 'order'], 'changed readiness/capability uses a current compatibility read');
        assert.equal(next.accounts![1]!.duplicateOf, undefined, 'old snapshot metadata must not escape through its cache');
      }
    } finally { await cached.service.close(); }
  }
  const f = fixture();
  try {
    assert.equal((await f.service.read()).state, 'available');
    f.workspace.epoch = randomUUID(); f.snapshot.epoch = f.workspace.epoch;
    assert.equal((await f.service.read()).state, 'available'); assert.equal(f.calls.rpc, 2, 'new epoch cannot reuse the previous cache');
  } finally { await f.service.close(); }
});

test('snapshot cache cannot extend an already aged observation and absent capability retains sequential CLI compatibility', async () => {
  const f = fixture();
  try {
    f.snapshot.checkedAt = 75000;
    assert.equal((await f.service.read()).state, 'available');
    f.setTime(105001); f.snapshot.checkedAt = 105001;
    assert.equal((await f.service.read()).state, 'available'); assert.equal(f.calls.rpc, 2);
  } finally { await f.service.close(); }
  for (const ready of [true, false]) {
    const legacy = fixture();
    if (ready) legacy.status.methods = ['models.authOrderSet']; else legacy.status.state = 'disconnected';
    try {
      const result = await legacy.service.read(); assert.equal(result.state, 'available');
      assert.deepEqual(legacy.calls.cli, ['metadata', 'order']); assert.equal(legacy.calls.rpc, 0);
      assert.deepEqual(result.order, ['openai:b', 'openai:a']); assert.equal(result.canManage, ready);
    } finally { await legacy.service.close(); }
  }
});

test('maintenance and close suppress or discard pending snapshot results without launching CLI', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.reply(() => new Promise(resolve => { release = resolve; }));
  try {
    f.workspace.updateMaintenanceHeld = true;
    assert.equal((await f.service.read()).state, 'unavailable'); assert.equal(f.calls.rpc, 0);
    f.workspace.updateMaintenanceHeld = false;
    const crossing = f.service.read(); f.workspace.updateMaintenanceHeld = true;
    release(structuredClone(f.snapshot)); assert.equal((await crossing).state, 'unavailable');
    f.workspace.updateMaintenanceHeld = false;
    const closingRead = f.service.read(); const closed = f.service.close();
    release(structuredClone(f.snapshot)); assert.equal((await closingRead).state, 'unavailable'); await closed;
    assert.equal((await f.service.read()).state, 'unavailable'); assert.equal(f.calls.rpc, 2); assert.deepEqual(f.calls.cli, []);
  } finally { await f.service.close(); }
});
