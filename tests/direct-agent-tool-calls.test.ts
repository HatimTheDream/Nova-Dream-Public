import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DirectAgentToolCalls, directReadInput, directRuntimeAgent, directReadTool,
  type DirectReadOrigin, type TrustedDirectCall,
} from '../apps/service/direct-agent-tool-calls.js';

const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const epoch = randomUUID(), conversationId = randomUUID(), controller = new AbortController();
  const policySha256 = 'a'.repeat(64), read = { operation: 'records.read' as const, input: { kind: 'task', id: 'task:one' } };
  const context: TrustedDirectCall = { agentId: directRuntimeAgent, sessionKey: `agent:edition3-direct:e3:${conversationId}`,
    sessionId: randomUUID(), runId: randomUUID(), toolCallId: 'call-one', toolName: directReadTool, abortSignal: controller.signal };
  let current = true, clock = 100;
  const calls = new DirectAgentToolCalls({ epoch, policySha256 }, () => { if (!current) throw Error('owner changed'); }, () => clock);
  const origin = (): DirectReadOrigin => ({ epoch, policySha256, agentId: directRuntimeAgent, conversationId,
    sessionKey: context.sessionKey!, sessionId: context.sessionId!, runId: context.runId!, toolCallId: context.toolCallId!,
    requestId: context.runId!, operationId: randomUUID(), generation: 'original-generation', accountId: 'original-account',
    inputSha256: directReadInput(read).inputSha256 });
  const execution = { ...context, assertInvocationCurrent: () => { if (!current) throw Error('invocation changed'); } };
  return { calls, read, context, origin, execution, controller, revoke: () => { current = false; }, late: () => { clock += 5001; } };
}
test('host-bound call consumes exactly once and carries original service identity, not model authority', async () => {
  const f = fixture(), original = f.origin(); let reads = 0;
  await f.calls.authorize(f.context, f.read, async request => {
    assert.deepEqual(Object.keys(request).sort(), ['epoch', 'policySha256', 'agentId', 'sessionKey', 'sessionId', 'runId', 'toolCallId', 'inputSha256', 'read'].sort());
    assert.equal(request.runId, f.context.runId); return original;
  });
  assert.deepEqual(await f.calls.consume(f.execution, 'call-one', f.read, undefined, async (origin, input) => {
    reads++; assert.deepEqual(origin, original); assert.deepEqual(input, f.read); return { title: 'Original result' };
  }), { title: 'Original result' });
  await assert.rejects(f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => { reads++; }), /unused/);
  await assert.rejects(f.calls.authorize(f.context, f.read, async () => original), /cannot be admitted/);
  assert.equal(reads, 1);
});
test('missing or contradictory origin refuses without reading and cannot reuse the failed call', async () => {
  for (const field of ['epoch', 'sessionKey', 'sessionId', 'runId', 'toolCallId', 'requestId', 'conversationId', 'policySha256', 'inputSha256']) {
    const f = fixture(), origin = f.origin();
    await assert.rejects(f.calls.authorize(f.context, f.read, async () => ({ ...origin, [field]: field.endsWith('Sha256') ? 'b'.repeat(64) : randomUUID() })));
    await assert.rejects(f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => assert.fail('must not read')));
  }
});
test('interleaved runs and reused tool IDs cannot borrow or replace another authorization', async () => {
  const f = fixture(), first = defer<unknown>(), one = f.calls.authorize(f.context, f.read, () => first.promise);
  const other = { ...f.context, runId: randomUUID() };
  await assert.rejects(f.calls.authorize(other, f.read, async () => f.origin()), /cannot be admitted/);
  const secondContext = { ...other, toolCallId: 'call-two' }, secondOrigin = { ...f.origin(), runId: other.runId!, requestId: other.runId!, toolCallId: 'call-two' };
  await f.calls.authorize(secondContext, f.read, async () => secondOrigin);
  first.resolve(f.origin()); await one;
  assert.equal(await f.calls.consume(f.execution, 'call-two', f.read, undefined, async origin => origin.runId), other.runId);
  assert.equal(await f.calls.consume(f.execution, 'call-one', f.read, undefined, async origin => origin.runId), f.context.runId);
});
test('a late policy response cannot revive an aborted, finished, ended, expired or disposed call', async () => {
  for (const stop of ['abort', 'finish', 'end', 'late', 'dispose'] as const) {
    const f = fixture(), reply = defer<unknown>();
    const pending = f.calls.authorize(f.context, f.read, () => reply.promise);
    if (stop === 'abort') f.controller.abort();
    if (stop === 'finish') f.calls.finish(f.context);
    if (stop === 'end') f.calls.endRun(f.context.runId!);
    if (stop === 'late') f.late();
    if (stop === 'dispose') f.calls.dispose();
    reply.resolve(f.origin()); await assert.rejects(pending);
    await assert.rejects(f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => assert.fail('must not read')));
  }
});
test('later input rewrite consumes and refuses the original token; failed read cannot be resent', async () => {
  const f = fixture(); await f.calls.authorize(f.context, f.read, async () => f.origin());
  await assert.rejects(f.calls.consume(f.execution, 'call-one', { ...f.read, input: { kind: 'contact' } }, undefined, async () => assert.fail('must not read')), /input changed/);
  await assert.rejects(f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => assert.fail('must not read')), /unused/);
  const g = fixture(); await g.calls.authorize(g.context, g.read, async () => g.origin());
  await assert.rejects(g.calls.consume(g.execution, 'call-one', g.read, undefined, async () => { throw Error('lost read'); }), /lost read/);
  await assert.rejects(g.calls.consume(g.execution, 'call-one', g.read, undefined, async () => assert.fail('must not read')), /unused/);
});
test('current invocation, configuration and cancellation are checked before and after asynchronous reads', async () => {
  for (const revoke of ['owner', 'signal', 'cleanup'] as const) {
    const f = fixture(), result = defer<string>(); let reads = 0;
    await f.calls.authorize(f.context, f.read, async () => f.origin());
    const pending = f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => { reads++; return result.promise; });
    if (revoke === 'owner') f.revoke();
    if (revoke === 'signal') f.controller.abort();
    if (revoke === 'cleanup') f.calls.cleanup({ sessionKey: f.context.sessionKey });
    result.resolve('must not escape'); await assert.rejects(pending); assert.equal(reads, 1);
  }
  const f = fixture(); await f.calls.authorize(f.context, f.read, async () => f.origin()); f.revoke();
  await assert.rejects(f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => assert.fail('must not read')));
});
test('foreign cleanup cannot cancel the original call; exact terminal run cannot acquire new calls', async () => {
  const f = fixture(); await f.calls.authorize(f.context, f.read, async () => f.origin());
  f.calls.finish({ ...f.context, runId: randomUUID() });
  f.calls.cleanup({ sessionKey: 'agent:other' });
  assert.equal(await f.calls.consume(f.execution, 'call-one', f.read, undefined, async () => 'kept'), 'kept');
  f.calls.endRun(f.context.runId!);
  await assert.rejects(f.calls.authorize({ ...f.context, toolCallId: 'new-call' }, f.read, async () => f.origin()), /cannot be admitted/);
});
test('no model-provided authority, arbitrary tool or oversized input enters the read boundary', async () => {
  const f = fixture();
  for (const raw of [{ ...f.read, runId: f.context.runId }, { operation: 'records.save', input: {} }, { ...f.read, input: { text: 'x'.repeat(32769) } }])
    await assert.rejects(f.calls.authorize(f.context, raw, async () => assert.fail('must not authorize')));
  for (const patch of [{ agentId: 'main' }, { toolName: 'nova_write' }, { abortSignal: undefined }, { runId: undefined }])
    await assert.rejects(f.calls.authorize({ ...f.context, ...patch }, f.read, async () => assert.fail('must not authorize')));
});
