import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptAccount, readChatGptAccount } from '../apps/service/chatgpt-account.js';
import { Store } from '../apps/service/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { emptyChatGptUsage } from '../packages/domain/chatgpt-accounts.js';

const payload = { agentId: 'main', provider: 'openai', agentDir: '/private/agent', authStatePath: '/private/auth', profiles: [{ id: 'openai:edition3-voice', provider: 'openai', type: 'oauth', email: 'owner@example.com', access_token: 'PRIVATE_TOKEN', label: 'arbitrary provider text' }] };
const command = { file: process.execPath, args: ['fixture'], cwd: process.cwd(), env: { PATH: process.env.PATH } };

test('saved account metadata is strictly scoped and excludes paths, tokens and provider text',()=>{
  const read=readChatGptAccount(JSON.stringify(payload));assert.equal(read.state,'available');assert.deepEqual(read.emails,['owner@example.com']);assert.equal(read.profileCount,1);
  assert(!JSON.stringify(read).includes('PRIVATE'));assert(!JSON.stringify(read).includes('/private'));assert(!JSON.stringify(read).includes('arbitrary'));
  assert.throws(()=>readChatGptAccount(JSON.stringify({...payload,agentId:'other'})));
  assert.throws(()=>readChatGptAccount(JSON.stringify({...payload,profiles:[...payload.profiles,...payload.profiles]})));
  assert.throws(()=>readChatGptAccount('noise '+JSON.stringify(payload)));
  const mixed=readChatGptAccount(JSON.stringify({...payload,profiles:[...payload.profiles,{id:'openai:api',provider:'openai',type:'api_key',email:'not-chatgpt@example.com'},{id:'openai:unknown',provider:'openai',type:'oauth'}]}));
  assert.equal(mixed.profileCount,2);assert.deepEqual(mixed.emails,['owner@example.com']);
  assert.equal(readChatGptAccount(JSON.stringify({...payload,profiles:[]})).state,'empty');
});

test('account reads coalesce and cache; explicit checks and host changes cannot retain an old identity',async()=>{
  let allowed=true,count=0,now=0,release!:(s:string)=>void;
  const service=new ChatGptAccount({accountCommand:()=>{if(!allowed)throw Error('Other host');return command;}},async()=>{count++;return new Promise<string>(r=>release=r);},()=>now);
  const first=service.read(),second=service.read(true);assert.equal(count,1);release(JSON.stringify(payload));assert.deepEqual(await first,await second);
  await service.read();assert.equal(count,1);now=30001;
  const refreshing=service.read();assert.equal(count,2);allowed=false;release(JSON.stringify(payload));assert.equal((await refreshing).state,'unavailable');assert.equal((await service.read()).emails.length,0);
  allowed=true;const explicit=service.read(true);assert.equal(count,3);release(JSON.stringify({...payload,profiles:[]}));assert.equal((await explicit).state,'empty');await service.close();
});

test('account failure hides raw output and close cancels an owned pending read',async()=>{
  const failed=new ChatGptAccount({accountCommand:()=>command},async()=>{throw Error('PRIVATE_TOKEN /private/auth');});
  assert.equal((await failed.read()).state,'unavailable');assert(!JSON.stringify(await failed.read()).includes('PRIVATE'));await failed.close();
  let aborted=false;
  const pending=new ChatGptAccount({accountCommand:()=>command},async(_command,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('Stopped'));},{once:true})));
  const result=pending.read();await pending.close();assert(aborted);assert.equal((await result).state,'unavailable');assert.equal((await pending.read()).state,'unavailable');
});

async function managed(run: (fixture: { service: ChatGptAccount; store: Store; device: string; status: any; snapshot: any; counts: { writes: number; lastParams?: any }; loseReply(): void; setOrder(ids: string[]): void }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-accounts-')), store = new Store(directory);
  const status = { state: 'ready', generation: randomUUID(), url: 'ws://127.0.0.1:49999', methods: ['e3.accounts.snapshot', 'models.authOrderSet'], grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true, message: '' };
  const make = (profileId: string, hash: string, used: number) => ({ profileId, identityKey: hash.repeat(64), email: `${hash}@example.com`, health: 'ready', cooldownUntil: null, expiresAt: 900000, usage: { state: 'ready', checkedAt: 1000, reportedAt: 1000, windows: [{ label: '5h', usedPercent: used, resetAt: 999999 }], plan: 'plus', credits: null } });
  const snapshot = { epoch: store.epoch, checkedAt: 1000, order: ['openai:a', 'openai:b'], accounts: [make('openai:a', 'a', 19), make('openai:b', 'b', 73)] };
  let order = [...snapshot.order], lost = false; const counts = { writes: 0, lastParams: undefined as any };
  const gateway = { status: () => status, async request(_method: string, params: unknown) { counts.lastParams = params; return structuredClone(snapshot); } } as unknown as AssistantTransport;
  const service = new ChatGptAccount({ accountCommand: () => command, accountOrderCommand: () => ({ ...command, args: ['order'] }) }, async cmd => cmd.args[0] === 'order' ? JSON.stringify({ agentId: 'main', provider: 'openai', order }) : JSON.stringify({ agentId: 'main', provider: 'openai', profiles: snapshot.accounts.map((a: any) => ({ id: a.profileId, email: a.email, provider: 'openai', type: 'oauth' })) }), () => 1000, { store, gateway, control: { async request<T>(_method: string, raw: unknown) { const input = raw as any; counts.writes++; order = [...input.profileIds]; snapshot.order = [...order]; if (lost) { lost = false; throw Error('Lost reply'); } return { provider: 'openai', profileIds: [...order] } as T; } } });
  try { await run({ service, store, device: store.session().deviceId, status, snapshot, counts, loseReply: () => { lost = true; }, setOrder: ids => { order = [...ids]; snapshot.order = [...ids]; } }); }
  finally { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('accounts expose independent usage and mark duplicate identities without inventing extra allowances', () => managed(async f => {
  let read = await f.service.read(); assert.equal(read.canManage, true); assert.deepEqual(read.accounts!.map(a => a.usage.windows[0].usedPercent), [19, 73]);
  f.snapshot.accounts[1].identityKey = f.snapshot.accounts[0].identityKey;
  read = await f.service.read(true); assert.equal(read.accounts![1].duplicateOf, 'openai:a');
  await assert.rejects(f.service.validatePreference('openai:b'), /same account/);
  f.snapshot.accounts[0].health = 'reconnect'; await f.service.validatePreference('openai:a');
}));

test('preferred routing skips native cooldown and exhausted quota, deduplicates allowance and never triggers a quota fetch', () => managed(async f => {
  assert.equal((await f.service.route({ model: 'openai/gpt-5.6-sol' }))?.profileId, 'openai:a');
  assert.equal(f.counts.lastParams.includeUsage, false);
  f.snapshot.accounts[0].health = 'cooldown'; f.snapshot.accounts[0].cooldownUntil = 800000;
  assert.deepEqual((await f.service.route({ preferredProfileId: 'openai:a' }))?.reason, 'backup');
  f.snapshot.accounts[0].health = 'ready'; f.snapshot.accounts[0].cooldownUntil = null; f.snapshot.accounts[0].usage.windows[0].usedPercent = 100;
  assert.equal((await f.service.route())?.profileId, 'openai:b');
  f.snapshot.accounts[1].identityKey = f.snapshot.accounts[0].identityKey;
  await assert.rejects(f.service.route(), /No connected account/);
  f.snapshot.accounts[0].usage = emptyChatGptUsage();
  assert.equal((await f.service.route())?.profileId, 'openai:a', 'unknown usage is not an exhausted account');
  assert.equal(await f.service.route({ model: 'other/model' }), undefined); assert.equal(f.counts.writes, 0);
}));

test('account order receipt reconciles a lost successful reply and never sends its mutation twice', () => managed(async f => {
  const input = { requestId: randomUUID(), epoch: f.store.epoch, profileIds: ['openai:b', 'openai:a'] };
  f.loseReply(); await assert.rejects(f.service.configureOrder(f.device, input), /not confirmed/); assert.equal(f.counts.writes, 1);
  await assert.rejects(f.service.configureOrder(f.device, { ...input, requestId: randomUUID() }), /earlier account change/);
  const read = await f.service.configureOrder(f.device, input); assert.deepEqual(read.order, input.profileIds); assert.equal(read.preferredProfileId, 'openai:b'); assert.equal(f.counts.writes, 1);
  await f.service.configureOrder(f.device, input); assert.equal(f.counts.writes, 1);
}));

test('incomplete account order and foreign epoch are rejected before native mutation', () => managed(async f => {
  await assert.rejects(f.service.configureOrder(f.device, { requestId: randomUUID(), epoch: f.store.epoch, profileIds: ['openai:a'] }), /saved accounts changed/);
  await assert.rejects(f.service.configureOrder(f.device, { requestId: randomUUID(), epoch: randomUUID(), profileIds: ['openai:a', 'openai:b'] }));
  assert.equal(f.counts.writes, 0);
}));
