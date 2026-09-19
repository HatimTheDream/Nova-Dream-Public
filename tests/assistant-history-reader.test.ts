import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantHistoryReader, type HistoryReadOptions } from '../apps/client/src/assistant-history-reader';
import { historyAfterReadFailure, mergeHistoryPage } from '../apps/client/src/assistant-history';
import type { ConversationHistory } from '../packages/domain/assistant';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const page = (first: number, last: number, total = 300): ConversationHistory => ({
  conversationId: 'chat', nativeId: 'native', activeRunIds: [], totalMessages: total,
  offset: total - last, nextOffset: first > 1 ? total - first + 1 : undefined,
  hasMore: first > 1, hasNewer: last < total,
  messages: Array.from({ length: last - first + 1 }, (_, i) => ({ id: String(first + i), role: 'assistant', sequence: first + i, text: `Message ${first + i}`, textHash: String(first + i), attachments: [] })),
});

function fixture() {
  let identity = 'workspace-a', history: ConversationHistory | undefined = page(201, 300);
  const reads: { id: string; options?: HistoryReadOptions; signal: AbortSignal; resolve: (value: ConversationHistory) => void; reject: (reason: Error) => void }[] = [];
  const errors: string[] = [];
  const reader = new AssistantHistoryReader({
    identity: () => identity,
    read: async (id, options, signal) => {
      const original = identity;
      try {
        const value = await new Promise<ConversationHistory>((resolve, reject) => reads.push({ id, options, signal, resolve, reject }));
        if (signal.aborted || original !== identity) return;
        history = options?.latest || options?.messageId ? value : mergeHistoryPage(history, value, options?.newer ? 'newer' : options?.offset !== undefined);
      } catch (error) { if (!signal.aborted && original === identity) errors.push((error as Error).message); }
    },
  });
  return { reader, reads, errors, history: () => history, scope: (value: string) => { identity = value; } };
}

test('background updates preserve an in-flight earlier page and coalesce to one head read', async () => {
  const f = fixture(), done = f.reader.load('chat', { offset: 100 }); await flush();
  for (let i = 0; i < 20; i++) assert.equal(f.reader.poll('chat'), done);
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].signal.aborted, false);
  f.reads[0].resolve(page(101, 200)); await flush();
  assert.equal(f.history()!.messages.length, 200); assert.equal(f.history()!.messages[0].id, '101');
  assert.equal(f.reads.length, 2); assert.equal(f.reads[1].options, undefined);
  f.reads[1].resolve(page(202, 301, 301)); await done;
  assert.equal(f.history()!.messages.length, 201); assert.equal(f.history()!.messages[0].id, '101');
  assert.equal(f.history()!.messages.at(-1)!.id, '301');
});

test('slow automatic history responses publish before another background observation', async () => {
  const f = fixture(), done = f.reader.poll('chat'); await flush();
  f.reader.poll('chat'); f.reader.poll('chat'); f.reads[0].resolve(page(202, 301, 301)); await flush();
  assert.equal(f.history()!.messages.at(-1)!.id, '301'); assert.equal(f.reads.length, 2);
  f.reader.poll('chat'); f.reads[1].resolve(page(203, 302, 302)); await flush();
  assert.equal(f.history()!.messages.at(-1)!.id, '302');
  f.reads[2].resolve(page(204, 303, 303)); await done;
  assert.equal(f.history()!.messages.at(-1)!.id, '303');
});

test('an explicit Latest jump supersedes an older page without applying its late response', async () => {
  const f = fixture(), older = f.reader.load('chat', { offset: 100 }); await flush();
  f.reader.poll('chat');
  const latest = f.reader.load('chat', { latest: true }); await flush();
  assert.equal(f.reads[0].signal.aborted, true);
  f.reads[1].resolve(page(401, 500, 500)); await latest;
  f.reads[0].resolve(page(101, 200)); await older;
  assert.equal(f.history()!.messages.length, 100); assert.equal(f.history()!.messages[0].id, '401');
  assert.equal(f.reads.length, 2);
});

test('cleanup and workspace replacement discard queued observations and late failures', async () => {
  const f = fixture(), old = f.reader.poll('chat'); await flush(); f.reader.poll('chat'); f.reader.cancel();
  assert.equal(f.reads[0].signal.aborted, true);
  f.scope('workspace-b'); const next = f.reader.poll('chat'); await flush();
  f.reads[0].reject(Error('Old workspace disconnected')); await old;
  assert.deepEqual(f.errors, []); assert.equal(f.reads.length, 2);
  f.reads[1].resolve(page(501, 600, 600)); await next;
  const pending = f.reader.poll('chat'); await flush(); f.reader.poll('chat'); f.scope('workspace-c');
  f.reads[2].resolve(page(601, 700, 700)); await pending;
  assert.equal(f.reads.length, 3);
});

test('a failed earlier-page read retains the complete loaded window instead of its smaller cache', () => {
  const displayed = page(101, 300), cached = page(201, 300);
  assert.equal(historyAfterReadFailure(displayed, cached, 'chat', 'native'), displayed);
  assert.equal(historyAfterReadFailure(undefined, cached, 'chat', 'native'), cached);
  assert.equal(historyAfterReadFailure(displayed, cached, 'chat', 'replacement'), undefined);
  assert.equal(historyAfterReadFailure(displayed, cached, 'another-chat', 'native'), undefined);
});
