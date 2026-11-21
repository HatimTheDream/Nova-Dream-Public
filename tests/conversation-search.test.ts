import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { ConversationSearch } from '../apps/service/conversation-search.js';
import { SavedHistory } from '../apps/service/saved-history.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { AssistantConnection, Conversation, ConversationHistory } from '../packages/domain/assistant.js';

const conversation = (generation: string, patch: Partial<Conversation> = {}): Conversation => ({ id: randomUUID(), revision: 1, title: 'Fixture conversation', projectId: null, archived: false, model: null, thinking: null, createdAt: '', updatedAt: '', connectionGeneration: generation, nativeKey: `e3:${randomUUID()}`, nativeId: randomUUID(), state: 'ready', ...patch });
async function fixture(run: (f: { store: Store; service: ConversationSearch; rows: Conversation[]; history: { read: (c: Conversation, offset: number) => Promise<ConversationHistory> }; status: AssistantConnection; calls: {method: string;params: any}[]; reply: { value: (params: any) => Promise<any> } }) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), 'edition3-search-')), store = new Store(path);
  const status: AssistantConnection = { state: 'ready', generation: randomUUID(), methods: ['sessions.search'], grantedScopes: ['operator.read'], modelAuthReady: false, message: 'Fixture' };
  const rows: Conversation[] = [], calls: {method:string;params:any}[] = [];
  const reply = { value: async (_params: any): Promise<any> => ({ results: [], indexing: false, truncated: false }) };
  const gateway: AssistantTransport = { status: () => structuredClone(status), request: async (method, params) => { calls.push({method,params}); return reply.value(params); }, subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}) };
  const history = { read: async (_c: Conversation, _offset: number): Promise<ConversationHistory> => { throw Error('Unexpected history read'); } };
  try { await run({store, rows, status, calls, reply, history, service:new ConversationSearch(store,gateway,()=>rows,undefined,(c, offset) => history.read(c, offset))}); } finally { store.close(); rmSync(path,{recursive:true,force:true}); }
}
const hit = (c: Conversation, patch = {}) => ({ sessionKey:c.nativeKey, sessionId:c.nativeId!, messageId:randomUUID(), role:'assistant', timestamp:1234, snippet:'An exact fixture phrase',score:1,...patch });
test('search limits native scope to matching app conversations and rejects foreign hits', () => fixture(async f => {
  const active=conversation(f.status.generation!), archived=conversation(f.status.generation!,{archived:true,projectId:'project:a'}), other=conversation(f.status.generation!,{archived:true,projectId:'project:b'});f.rows.push(active,archived,other);
  f.reply.value=async()=>({results:[hit(archived),hit(active),hit(other)],indexing:false,truncated:false});
  const result=await f.service.search({epoch:f.store.epoch,query:'fixture phrase',scope:'archived',projectId:'project:a'});
  assert.deepEqual(f.calls[0],{method:'sessions.search',params:{query:'fixture phrase',sessionKeys:[archived.nativeKey],limit:25}});
  assert.equal(result.results.length,1);assert.equal(result.results[0].conversationId,archived.id);assert.equal(result.changedDuringSearch,true);
}));
test('native search batches every selected session without broadening visibility and reports incomplete indexing', () => fixture(async f => {
  for(let i=0;i<201;i++)f.rows.push(conversation(f.status.generation!));
  f.reply.value=async params=>({results:[hit(f.rows.find(c=>c.nativeKey===params.sessionKeys[0])!)],indexing:true,truncated:true});
  const result=await f.service.search({epoch:f.store.epoch,query:'fixture',scope:'all'});
  assert.deepEqual(f.calls.map(c=>c.params.sessionKeys.length),[200,1]); assert.equal(new Set(f.calls.flatMap(c=>c.params.sessionKeys)).size,201); assert.equal(result.searchedConversations,201);assert.equal(result.indexing,true);assert.equal(result.limited,true);
}));
test('search keeps exact reset-history identity and unknown coverage without inventing completeness', () => fixture(async f => {
  const c=conversation(f.status.generation!),oldNativeId=randomUUID(),messageId=randomUUID();f.rows.push(c,conversation('old-host'),conversation(f.status.generation!,{nativeId:null,state:'unknown'}));
  f.reply.value=async()=>({results:[hit(c,{sessionId:oldNativeId,messageId}),hit(c,{sessionId:oldNativeId,messageId})]});
  const result=await f.service.search({epoch:f.store.epoch,query:'exact phrase',scope:'all'});
  assert.equal(result.results.length,1);assert.equal(result.results[0].nativeId,oldNativeId);assert.equal(result.results[0].messageId,messageId);assert.equal(result.indexing,null);assert.equal(result.excludedConversations,2);
}));
test('host changes fence late search replies and changed archive scope drops stale results', () => fixture(async f => {
  const c=conversation(f.status.generation!);f.rows.push(c);f.reply.value=async()=>{f.status.generation=randomUUID();return{results:[hit(c)]};};
  await assert.rejects(f.service.search({epoch:f.store.epoch,query:'phrase',scope:'active'}),/connection changed/);
  f.status.generation=c.connectionGeneration;f.reply.value=async()=>{c.archived=true;return{results:[hit(c)],indexing:false};};
  const result=await f.service.search({epoch:f.store.epoch,query:'phrase',scope:'active'});assert.equal(result.results.length,0);assert.equal(result.changedDuringSearch,true);
}));
test('unsupported native search reports missing coverage; invalid epochs and oversized output still fail clearly', () => fixture(async f => {
  f.rows.push(conversation(f.status.generation!));f.status.methods=[];
  const local = await f.service.search({epoch:f.store.epoch,query:'phrase',scope:'all'}); assert.equal(local.indexing, null); assert.equal(local.excludedConversations, 1);
  assert.equal(f.calls.length,0);f.status.methods=['sessions.search'];
  await assert.rejects(f.service.search({epoch:randomUUID(),query:'phrase',scope:'all'}),/workspace changed/);
  f.reply.value=async()=>({results:Array.from({length:26},()=>hit(f.rows[0]))});
  await assert.rejects(f.service.search({epoch:f.store.epoch,query:'phrase',scope:'all'}),/unsupported search response/);
}));
test('saved messages search without any account or native search capability and preserve old source identity', () => fixture(async f => {
  const c = conversation('old-host'), excluded = conversation('old-host', { archived: true }); f.rows.push(c, excluded);
  const saved = new SavedHistory(f.store);
  for (const row of f.rows) saved.observe(row, { conversationId: row.id, nativeId: row.nativeId!, messages: [{ id: 'local-message', role: 'user', text: 'Native envelope hidden', authoredText: 'A saved exact phrase', textHash: 'a'.repeat(64), attachments: [] }], hasMore: false, activeRunIds: [] }, { complete: true });
  f.status.state = 'unconfigured'; f.status.methods = []; f.status.grantedScopes = [];
  const result = await f.service.search({ epoch: f.store.epoch, query: '"exact phrase"', scope: 'active' });
  assert.equal(f.calls.length, 0); assert.equal(result.results.length, 1); assert.equal(result.results[0].nativeId, c.nativeId); assert.equal(result.results[0].snippet, 'A saved exact phrase'); assert.equal(result.indexing, false);
}));
test('a failed runtime search retains local results with unknown wider coverage', () => fixture(async f => {
  const c = conversation(f.status.generation!); f.rows.push(c);
  new SavedHistory(f.store).observe(c, { conversationId: c.id, nativeId: c.nativeId!, messages: [{ id: 'local-message', role: 'assistant', text: 'Saved phrase', textHash: 'a'.repeat(64), attachments: [] }], hasMore: true, activeRunIds: [] });
  f.reply.value = async () => { throw Error('Disconnected'); };
  const result = await f.service.search({ epoch: f.store.epoch, query: 'phrase', scope: 'all' });
  assert.equal(result.results.length, 1); assert.equal(result.indexing, null); assert.equal(result.searchedConversations, 1);
}));

const savedMessages = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `message-${String(index).padStart(3, '0')}`, role: 'user' as const, text: `Needle ${index}`, textHash: 'a'.repeat(64), attachments: [],
  createdAt: '2026-01-01T01:23:45Z',
}));
test('saved search traverses several windows offline, preserves tied identities and stops at the final page', () => fixture(async f => {
  const chats = [conversation('old'), conversation('old')], saved = new SavedHistory(f.store);
  f.rows.push(...chats); f.status.state = 'unconfigured'; delete f.status.generation;
  for (const chat of chats) saved.observe(chat, { conversationId: chat.id, nativeId: chat.nativeId!, messages: savedMessages(68), hasMore: false, activeRunIds: [] }, { complete: true });
  const input = { epoch: f.store.epoch, space: 'chat', scope: 'all', query: 'needle' };
  let page = await f.service.search(input);
  const hits = [...page.results], lengths = [hits.length]; assert.ok(page.nextCursor);
  await assert.rejects(f.service.search({ ...input, query: 'different', cursor: page.nextCursor }), /filters changed/);
  while (page.nextCursor) {
    assert.ok(lengths.length < 7, 'pages must progress');
    page = await f.service.search({ ...input, cursor: page.nextCursor });
    hits.push(...page.results); lengths.push(page.results.length);
  }
  assert.deepEqual(lengths, [25,25,25,25,25,11]); assert.equal(page.limited, false);
  assert.equal(new Set(hits.map(h => JSON.stringify([h.conversationId, h.messageId]))).size, 136);
  assert.equal(f.calls.length, 0);
  const match = hits[111], chat = chats.find(c => c.id === match.conversationId)!;
  assert.ok(saved.read(chat, { nativeId: match.nativeId, messageId: match.messageId })?.messages.some(m => m.id === match.messageId && m.role === match.role));
}));
test('a capped native index continues one exact current history at a time without duplicate index hits', () => fixture(async f => {
  const c = conversation(f.status.generation!), other = conversation(f.status.generation!, { archived: true });
  f.rows.push(c, other); f.status.methods.push('chat.history');
  const messages = savedMessages(61), calls: number[] = [];
  f.reply.value = async () => ({ results: messages.slice(0,25).map(m => hit(c, { messageId: m.id, role: m.role })), indexing: false, truncated: true });
  f.history.read = async (row, offset) => {
    assert.equal(row.id, c.id); calls.push(offset);
    return { conversationId: c.id, nativeId: c.nativeId!, messages: messages.slice(offset, offset + 50), hasMore: offset === 0, nextOffset: offset === 0 ? 50 : undefined, offset, totalMessages: 61, activeRunIds: [] };
  };
  const input = { epoch: f.store.epoch, query: 'needle', scope: 'active', space: 'chat' };
  const first = await f.service.search(input);
  assert.deepEqual(calls, []); assert.equal(first.results.length, 25);
  const second = await f.service.search({ ...input, cursor: first.nextCursor });
  const third = await f.service.search({ ...input, cursor: second.nextCursor });
  assert.equal(f.calls.length, 1); assert.deepEqual(calls, [0,50]);
  assert.deepEqual([second.results.length, third.results.length], [25,11]);
  assert.equal(new Set([...first.results, ...second.results, ...third.results].map(h => h.messageId)).size, 61);
  assert.equal(third.nextCursor, null); assert.equal(third.nativeLimited, true);
  f.status.grantedScopes = [];
  await assert.rejects(f.service.search({ ...input, cursor: first.nextCursor }), /connection changed/);
  f.status.grantedScopes = ['operator.read']; c.archived = true;
  await assert.rejects(f.service.search({ ...input, cursor: first.nextCursor }), /conversations in this search changed/);
  assert.deepEqual(calls, [0,50]);
}));
test('removal between saved pages invalidates the token before a cached snippet can be returned', () => fixture(async f => {
  const c = conversation(f.status.generation!); f.rows.push(c);
  new SavedHistory(f.store).observe(c, { conversationId: c.id, nativeId: c.nativeId!, messages: savedMessages(30), hasMore: false, activeRunIds: [] }, { complete: true });
  const input = { epoch: f.store.epoch, query: 'needle', scope: 'active' };
  const first = await f.service.search(input); assert.ok(first.nextCursor);
  f.store.internalWrite(`assistant:removed:${c.id}`, true);
  await assert.rejects(f.service.search({ ...input, cursor: first.nextCursor }), /conversations in this search changed/);
}));
