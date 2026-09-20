import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptPosition, transcriptPositionKey } from '../apps/client/src/transcript-position.js';
import type { Conversation } from '../packages/domain/assistant.js';
test('saved reading anchors reject invalid or unbounded projections', () => {
  const valid = { version: 1, following: false, anchor: { id: 'native:message:42', role: 'assistant', offset: -73.5 }, savedAt: 100 };
  assert.deepEqual(parseTranscriptPosition(valid), valid);
  for (const value of [null, { ...valid, version: 2 }, { ...valid, anchor: undefined }, { ...valid, anchor: { ...valid.anchor, offset: Infinity } }, { ...valid, anchor: { ...valid.anchor, role: 'unknown' } }, { ...valid, anchor: { ...valid.anchor, offset: 200000 } }]) assert.equal(parseTranscriptPosition(value), undefined);
  assert.ok(parseTranscriptPosition({ version: 1, following: true, savedAt: 200 }));
});
test('reading identity separates owners and workspaces while surviving account and native session replacements', () => {
  const conversation = { id: 'one', nativeId: 'native-one', connectionGeneration: 'host-one' } as Conversation;
  const keys = [transcriptPositionKey('epoch-one', 'device-one', conversation), transcriptPositionKey('epoch-two', 'device-one', conversation), transcriptPositionKey('epoch-one', 'device-two', conversation), transcriptPositionKey('epoch-one', 'device-one', { ...conversation, nativeId: 'replacement' }), transcriptPositionKey('epoch-one', 'device-one', { ...conversation, connectionGeneration: 'host-two' })];
  assert.equal(new Set(keys.slice(0, 3)).size, 3); assert.equal(keys[0], keys[3]); assert.equal(keys[0], keys[4]); assert.equal(transcriptPositionKey('epoch', 'device', undefined), undefined);
});

test('offline cache keeps a bounded neighborhood around the actual message and drops invalid sliced cursors', async () => {
  const { cacheTranscriptWindow } = await import('../apps/client/src/transcript-position.js');
  const history = { conversationId: 'chat', nativeId: 'native', hasMore: true, nextOffset: 500, offset: 0, activeRunIds: [], messages: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), role: 'assistant' as const, text: String(i), textHash: String(i), attachments: [] })) };
  const saved = cacheTranscriptWindow(history, { version: 1, following: false, anchor: { id: '150', role: 'assistant', offset: -100 }, savedAt: 1 });
  assert.equal(saved.messages.length, 100); assert.equal(saved.messages[35].id, '150'); assert.equal(saved.offset, undefined); assert.equal(saved.nextOffset, undefined); assert.equal(saved.hasMore, false); assert.equal(saved.hasNewer, true);
  assert.equal(cacheTranscriptWindow(history).messages.at(-1)?.id, '999');
});

test('large offline messages stay contiguous around the anchor within the cache text budget', async () => {
 const {cacheTranscriptWindow}=await import('../apps/client/src/transcript-position.js');
 const history={conversationId:'chat',nativeId:'native',hasMore:false,activeRunIds:[],messages:Array.from({length:100},(_,i)=>({id:String(i),role:'assistant' as const,text:'x'.repeat(10000),textHash:String(i),attachments:[]}))};
 const kept=cacheTranscriptWindow(history,{version:1,following:false,anchor:{id:'40',role:'assistant',offset:-25},savedAt:1});
 assert.ok(kept.messages.some(m=>m.id==='40'));assert.ok(JSON.stringify(kept.messages).length<300000);assert.ok(kept.messages.length<100);
 for(let i=1;i<kept.messages.length;i++)assert.equal(Number(kept.messages[i].id),Number(kept.messages[i-1].id)+1);
});
