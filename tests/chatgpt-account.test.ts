import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptAccount, readChatGptAccount } from '../apps/service/chatgpt-account.js';

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
