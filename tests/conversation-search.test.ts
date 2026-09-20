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
import type { AssistantConnection, Conversation } from '../packages/domain/assistant.js';

const conversation = (generation: string, patch: Partial<Conversation> = {}): Conversation => ({ id: randomUUID(), revision: 1, title: 'Fixture conversation', projectId: null, archived: false, model: null, thinking: null, createdAt: '', updatedAt: '', connectionGeneration: generation, nativeKey: `e3:${randomUUID()}`, nativeId: randomUUID(), state: 'ready', ...patch });
async function fixture(run: (f: { store: Store; service: ConversationSearch; rows: Conversation[]; status: AssistantConnection; calls: {method: string;params: any}[]; reply: { value: (params: any) => Promise<any> } }) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), 'edition3-search-')), store = new Store(path);
  const status: AssistantConnection = { state: 'ready', generation: randomUUID(), methods: ['sessions.search'], grantedScopes: ['operator.read'], modelAuthReady: false, message: 'Fixture' };
  const rows: Conversation[] = [], calls: {method:string;params:any}[] = [];
  const reply = { value: async (_params: any): Promise<any> => ({ results: [], indexing: false, truncated: false }) };
  const gateway: AssistantTransport = { status: () => structuredClone(status), request: async (method, params) => { calls.push({method,params}); return reply.value(params); }, subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}) };
  try { await run({store, rows, status, calls, reply, service:new ConversationSearch(store,gateway,()=>rows)}); } finally { store.close(); rmSync(path,{recursive:true,force:true}); }
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
