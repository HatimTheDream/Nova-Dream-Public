import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const { canOpenExternal } = createRequire(import.meta.url)('../apps/desktop/external.cjs');
import type { IPty } from 'node-pty';
import { Store } from '../apps/service/store.js';
import { ChatGptSignIn, deviceCodeNote, signInProgress, browserSignInNote } from '../apps/service/sign-in.js';

const note = '│ URL: https://auth.openai.com/codex/device │\n│ Code: TEST-CODE │\n';
class Terminal implements Pick<IPty, 'pid' | 'onData' | 'onExit' | 'kill'> {
  pid = 1073741824;
  private data = new Set<(data: string) => void>();
  private exits = new Set<(event: { exitCode: number; signal?: number }) => void>();
  kills: string[] = [];
  onData = (listener: (data: string) => void) => { this.data.add(listener); return { dispose: () => { this.data.delete(listener); } }; };
  onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener); } }; };
  emit(text: string) { for (const listener of this.data) listener(text); }
  exit(exitCode = 0) { for (const listener of this.exits) listener({ exitCode }); }
  kill(signal = 'SIGTERM') { this.kills.push(signal); this.exit(1); }
}
async function fixture(run: (f: { store: Store; service: ChatGptSignIn; terminals: Terminal[]; command: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }; device: string }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-signin-'));
  const store = new Store(directory), terminals: Terminal[] = [];
  const command = { file: process.execPath, args: ['fixture'], cwd: directory, env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) } };
  const service = new ChatGptSignIn(store, { signInCommand: () => command }, () => { const terminal = new Terminal(); terminals.push(terminal); return terminal; });
  try { await run({ store, service, terminals, command, device: store.session().deviceId }); }
  finally { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const request = (store: Store) => ({ requestId: randomUUID(), epoch: store.epoch });

test('only the supported OpenAI code note is exposed; arbitrary URLs and token-like output are rejected', () => {
  assert.deepEqual(deviceCodeNote('\u001b[32m'+note+'\u001b[0m'), { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' });
  assert.equal(deviceCodeNote(note.replace('auth.openai.com', 'example.com')), undefined);
  assert.equal(deviceCodeNote(note.replace('/codex/device', '/codex/device.other-site')), undefined);
  assert.equal(deviceCodeNote(note.replace('TEST-CODE', 'TEST-CODES'))?.userCode, 'TEST-CODES');
  assert.equal(deviceCodeNote(note.replaceAll('│', '|'))?.userCode, 'TEST-CODE');
  assert.equal(deviceCodeNote(note.replace('TEST-CODE', 'secret-token-material-that-is-not-a-device-code')), undefined);
  assert.equal(signInProgress('OpenAI device code request failed: private error detail'), 'OpenAI could not issue a sign-in code. Review its account setup before trying again.');
});

test('split code output stays ephemeral, exact retry starts one process, and an old receipt cannot select a newer code', () => fixture(async f => {
  const input = request(f.store), first = f.service.start(f.device, input);
  f.terminals[0].emit(note.slice(0,22)); f.terminals[0].emit(note.slice(22));
  f.terminals[0].emit('access_token=FIXTURE_SECRET_VALUE\n');
  assert.equal(f.service.status().userCode, 'TEST-CODE');
  assert.equal(f.service.start(f.device, input).id, first.id); assert.equal(f.terminals.length, 1);
  assert.throws(() => f.service.start(f.device, request(f.store)), /already waiting/);
  const persisted = JSON.stringify(f.store.internalList('signin:chatgpt:'));
  assert(!persisted.includes('TEST-CODE')); assert(!persisted.includes('FIXTURE_SECRET_VALUE'));
  assert(!JSON.stringify(f.service.status()).includes('FIXTURE_SECRET_VALUE'));
  f.terminals[0].exit(); assert.equal(f.service.status().state, 'completed'); assert.equal(f.service.status().userCode, undefined);
  const second = f.service.start(f.device, request(f.store)); f.terminals[1].emit(note.replace('TEST-CODE','NEXT-CODE'));
  const retry = f.service.start(f.device, input);
  assert.equal(retry.id, first.id); assert.equal(retry.state, 'completed'); assert.equal(retry.userCode, undefined);
  f.terminals[0].exit(1); f.terminals[0].emit(note);
  assert.equal(f.service.status().id, second.id); assert.equal(f.service.status().userCode, 'NEXT-CODE');
}));

test('cancellation targets the exact owned sign-in and retains uncertainty about account completion', () => fixture(async f => {
  const first = f.service.start(f.device, request(f.store)); f.terminals[0].emit(note);
  await assert.rejects(f.service.cancel(f.device, { ...request(f.store), attemptId: randomUUID() }), /different sign-in/);
  assert.equal(f.terminals[0].kills.length, 0);
  const input = { ...request(f.store), attemptId: first.id };
  await f.service.cancel(f.device, input); await f.service.cancel(f.device, input);
  assert.deepEqual(f.terminals[0].kills, ['SIGTERM']);
  assert.equal(f.service.status().state, 'interrupted'); assert.equal(f.service.status().userCode, undefined);
  assert.match(f.service.status().message, /already completed/);
}));

test('restart does not replay sign-in or allow another attempt while the previous process is still present', () => fixture(async f => {
  const input = request(f.store); f.service.start(f.device, input);
  const id = f.service.status().id!;
  const record = f.store.internalRead<any>(`signin:chatgpt:${id}`);
  f.store.internalWrite(`signin:chatgpt:${id}`, { ...record, pid: process.pid });
  let spawned = 0;
  const restored = new ChatGptSignIn(f.store, { signInCommand: () => f.command }, () => { spawned++; return new Terminal(); });
  try {
    assert.equal(restored.status().state, 'interrupted');
    assert.equal(restored.start(f.device, input).id, id);
    assert.throws(() => restored.start(f.device, request(f.store)), /still present/);
    assert.equal(spawned, 0);
  } finally { await restored.close(); }
}));

test('real PTY code note is read without exposing the terminal stream', async () => {
  // ConPTY's synchronous pipe startup must not inherit tsx/test-runner worker
  // hooks. Run the native smoke in a plain Node process, as in the packaged app.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/sign-in-pty.mjs', import.meta.url))], { env, timeout: 15000, windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout), { state: 'waiting', userCode: 'TEST-CODE' });
});

const authorization = new URL('https://auth.openai.com/oauth/authorize');
for (const [key, value] of Object.entries({response_type:'code',client_id:'fixture-client',redirect_uri:'http://localhost:1455/auth/callback',code_challenge_method:'S256',code_challenge:'a'.repeat(43),state:'b'.repeat(32)})) authorization.searchParams.set(key,value);
const browserNote = `Open: ${authorization.href}\n`;
const headlessBrowserNote = `\nOpen this URL in your LOCAL browser:\n\n${authorization.href}\n`;

test('browser login only exposes a complete pinned OpenAI PKCE authorization URL',()=>{
  assert.deepEqual(browserSignInNote('\u001b[32m'+browserNote+'\u001b[0m'),{authorizationUrl:authorization.href});
  assert.equal(canOpenExternal(authorization.href),true);
  assert.equal(browserSignInNote(browserNote.trimEnd()),undefined); // A split chunk is not a complete URL.
  for (const change of [
    (u:URL)=>u.hostname='example.com', (u:URL)=>u.hostname='auth.openai.com.example.com',
    (u:URL)=>u.username='private', (u:URL)=>u.port='8443', (u:URL)=>u.protocol='http:',
    (u:URL)=>u.pathname='/oauth/authorize/other', (u:URL)=>u.hash='secret',
    (u:URL)=>u.searchParams.set('redirect_uri','http://example.com/auth/callback'),
    (u:URL)=>u.searchParams.set('redirect_uri','http://localhost:1455/other'),
    (u:URL)=>u.searchParams.set('response_type','token'), (u:URL)=>u.searchParams.set('code_challenge_method','plain'),
    (u:URL)=>u.searchParams.set('code_challenge','short'), (u:URL)=>u.searchParams.delete('state'),
    (u:URL)=>u.searchParams.append('state','duplicate'), (u:URL)=>u.searchParams.set('access_token','private'),
  ]){const bad=new URL(authorization);change(bad);assert.equal(browserSignInNote(`Open: ${bad.href}\n`),undefined,bad.origin);assert.equal(canOpenExternal(bad.href),false);}
  assert.equal(browserSignInNote(`Provider error: ${authorization.href}\n`),undefined);
});

test('headless OAuth output uses the same complete-URL guard and stays ephemeral across chunks',()=>fixture(async f=>{
  assert.deepEqual(browserSignInNote(headlessBrowserNote),{authorizationUrl:authorization.href});
  assert.deepEqual(browserSignInNote(headlessBrowserNote.replaceAll('\n','\r\n')),{authorizationUrl:authorization.href});
  assert.equal(browserSignInNote(headlessBrowserNote.trimEnd()),undefined);
  assert.equal(browserSignInNote(headlessBrowserNote.replace('auth.openai.com','example.com')),undefined);
  assert.equal(browserSignInNote(headlessBrowserNote.replace('\n\n','\nProvider error:\n')),undefined);
  assert.equal(browserSignInNote(headlessBrowserNote.replace('response_type=code','response_type=token')),undefined);
  assert.equal(browserSignInNote(headlessBrowserNote.replace('Open this URL in your LOCAL browser:','An arbitrary link:')),undefined);
  const first=f.service.start(f.device,{...request(f.store),method:'browser'});
  f.terminals[0].emit(headlessBrowserNote.slice(0,-1));assert.equal(f.service.status().state,'starting');
  f.terminals[0].emit('\n');assert.equal(f.service.status().state,'waiting');assert.equal(f.service.status().authorizationUrl,authorization.href);
  const saved=JSON.stringify(f.store.internalList('signin:chatgpt:'));assert(!saved.includes(authorization.href));assert(!saved.includes('b'.repeat(32)));
  await f.service.cancel(f.device,{...request(f.store),attemptId:first.id});assert.equal(f.service.status().authorizationUrl,undefined);
}));

test('browser attempts pin the method, keep URL/state ephemeral and ignore late cancelled callbacks',()=>fixture(async f=>{
  const input={...request(f.store),method:'browser'},first=f.service.start(f.device,input);
  assert.equal(first.method,'browser');f.terminals[0].emit(note);assert.equal(f.service.status().state,'starting');
  f.terminals[0].emit(browserNote.slice(0,40));assert.equal(f.service.status().authorizationUrl,undefined);
  f.terminals[0].emit(browserNote.slice(40));assert.equal(f.service.status().authorizationUrl,authorization.href);
  assert.equal(f.service.start(f.device,input).id,first.id);assert.equal(f.terminals.length,1);
  assert.throws(()=>f.service.start(f.device,{...input,method:'device-code'}),/different|reused|identity|payload/i);
  const saved=JSON.stringify(f.store.internalList('signin:chatgpt:'));assert(!saved.includes(authorization.href));assert(!saved.includes('b'.repeat(32)));
  await f.service.cancel(f.device,{...request(f.store),attemptId:first.id});assert.equal(f.service.status().authorizationUrl,undefined);
  const second=f.service.start(f.device,{...request(f.store),method:'browser'});f.terminals[1].emit(browserNote);
  f.terminals[0].exit(0);assert.equal(f.service.status().id,second.id);assert.equal(f.service.status().state,'waiting');
  f.terminals[1].exit(0);assert.equal(f.service.status().state,'completed');assert.equal(f.service.status().authorizationUrl,undefined);
  assert.equal(f.service.start(f.device,input).id,first.id);assert.equal(f.service.start(f.device,input).authorizationUrl,undefined);assert.equal(f.terminals.length,2);
}));

test('browser restart retains an interrupted attempt without restoring its link or spawning again',()=>fixture(async f=>{
  const input={...request(f.store),method:'browser'},first=f.service.start(f.device,input);f.terminals[0].emit(browserNote);
  const restored=new ChatGptSignIn(f.store,{signInCommand:()=>f.command},()=>{throw Error('Must not spawn');});
  try{assert.equal(restored.status().state,'interrupted');assert.equal(restored.status().method,'browser');assert.equal(restored.status().authorizationUrl,undefined);assert.equal(restored.start(f.device,input).id,first.id);}finally{await restored.close();}
}));

test('completed sign-in receipts remain readable when the original local runtime is unavailable',()=>fixture(async f=>{
  const input={...request(f.store),method:'browser'},first=f.service.start(f.device,input);f.terminals[0].exit(0);
  await f.service.close();
  const unavailable=new ChatGptSignIn(f.store,{signInCommand:()=>{throw Error('Runtime unavailable');}},()=>{throw Error('Unexpected child');});
  try{assert.equal(unavailable.start(f.device,input).id,first.id);assert.equal(unavailable.start(f.device,input).state,'completed');assert.throws(()=>unavailable.start(f.device,{...request(f.store),method:'browser'}),/Runtime unavailable/);assert.equal(f.store.internalList('signin:chatgpt:').length,2);}finally{await unavailable.close();}
}));
