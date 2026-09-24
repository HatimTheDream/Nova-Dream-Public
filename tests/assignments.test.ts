import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { AssignmentService } from '../apps/service/assignments.js';
import { WorkerTransport } from './fixtures/assignment-worker.js';
import { blankRecord, type Assignment, type AgentDesign, type Content } from '../packages/domain/workspace-records.js';
import type { AssignmentAttempt } from '../packages/domain/assignments.js';
import { sourcePdf } from './fixtures/source-files.js';
import { officeEntries, officeZip } from './fixtures/office-files.js';

const tick = () => new Promise<void>(ok => setTimeout(ok, 5));
async function fixture(run: (f: { store: Store; service: AssignmentService; gateway: WorkerTransport; device: string; input: any; directory: string; plan: any; agent: any; source: any; update: (kind: any, record: any, patch: any) => any; replaceService: () => Promise<AssignmentService>; advance: (ms: number) => void }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-assignments-')), store = new Store(directory), gateway = new WorkerTransport(directory, store.epoch), device = store.session().deviceId;
  let now = Date.now(), service = new AssignmentService(store, gateway, () => now);
  const create = (kind: any, payload: any) => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind, entityId: `${kind}:${randomUUID()}`, expectedRevision: 0, payload });
  const update = (kind: any, record: any, patch: any) => store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind, entityId: record.id, expectedRevision: record.revision, payload: { ...record.value, ...patch } });
  const project = create('project', { name: 'Shared Project', purpose: 'Exact project objective' });
  const agent = create('agent', { ...blankRecord('agent', 'UTC'), name: 'Lynx', position: 'Editor', instructions: 'Original design sentinel' } as AgentDesign);
  const source = create('content', { ...blankRecord('content', 'UTC'), title: 'Source draft', body: 'Original source sentinel', projectId: project.id } as Content);
  const plan = create('assignment', { ...blankRecord('assignment', 'UTC'), title: 'Review draft', agentId: agent.id, agentRevision: agent.revision, projectId: project.id, brief: 'Read the source and return suggested edits.', sources: [{ kind: 'content', id: source.id, revision: source.revision }], maxMinutes: 1 } as Assignment);
  const input = { requestId: randomUUID(), epoch: store.epoch, assignmentId: plan.id, revision: plan.revision, projectRevision: project.revision };
  try { await run({ store, service, gateway, device, input, directory, plan, agent, source, update, replaceService: async () => { await service.close(); service = new AssignmentService(store, gateway, () => now); return service; }, advance: ms => { now += ms; } }); }
  finally { await service.close(); gateway.stopJournal?.(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
async function settle(service: AssignmentService, id: string, state: AssignmentAttempt['state']) {
  for (let n = 0; n < 100; n++) { const result = service.detail(id).attempt; if (result.state === state) return result; await tick(); }
  assert.fail(`Expected ${state}, got ${JSON.stringify(service.detail(id).attempt)}`);
}

test('settled provider limit is explained durably without a retry or exposing the raw error',()=>fixture(async f=>{
  const started=f.service.start(f.device,f.input); await settle(f.service,started.id,'running');
  f.gateway.observation={status:'error',endedAt:123,error:"You've reached your Codex subscription usage limit. private-provider-sentinel"};
  const failed=await f.service.reconcile(started.id);
  assert.equal(failed.state,'failed'); assert.equal(failed.failedExecution?.endedAt,123); assert.match(failed.message,/usage limit.*reset/);
  assert.equal(failed.result,undefined); assert.equal(f.service.state().canStart,true);
  const restarted=await f.replaceService(); assert.deepEqual(restarted.detail(started.id).attempt,failed);
  assert.equal(restarted.start(f.device,f.input).id,started.id); assert.equal(f.gateway.nativeCalls.length,1);
  assert.equal(JSON.stringify(restarted.detail(started.id)).includes('private-provider-sentinel'),false);
  assert.equal(JSON.stringify(f.store.internalList('assignments:attempt:')).includes('private-provider-sentinel'),false);
}));
test('pending quota failures do not release work, and owner stop keeps precedence over provider failure',()=>fixture(async f=>{
  const started=f.service.start(f.device,f.input); await settle(f.service,started.id,'running');
  f.gateway.observation={status:'error',endedAt:123,pendingError:true,error:'insufficient_quota'};
  const pending=await f.service.reconcile(started.id); assert.notEqual(pending.state,'failed'); assert.equal(f.service.state().canStart,false);
  f.service.stop(f.device,{requestId:randomUUID(),epoch:f.store.epoch,attemptId:started.id});
  f.gateway.observation={status:'error',endedAt:123,error:'insufficient_quota'};
  const stopped=await f.service.reconcile(started.id); assert.equal(stopped.state,'cancelled'); assert.match(stopped.message,/stop request/);
  assert.equal(f.gateway.nativeCalls.length,1);
}));

test('workspace tool unavailability is a preflight failure with no native identity or dispatch',()=>fixture(async f=>{
 const agent=f.update('agent',f.agent,{access:{tasks:'read'}}),plan=f.update('assignment',f.plan,{agentRevision:agent.revision});
 const original=f.gateway.request.bind(f.gateway);
 f.gateway.request=async <T>(method:string,params:any):Promise<T>=>{const result=await original<any>(method,params);return method==='e3.assignments.capabilities'?{...result,tools:'none'}:result;};
 const started=f.service.start(f.device,{...f.input,revision:plan.revision});
 const failed=await settle(f.service,started.id,'failed');
 assert.match(failed.message,/Nothing was dispatched/);assert.equal(failed.runId,undefined);assert.equal(f.gateway.nativeCalls.length,0);
}));

test('saved assignment captures exact design/source/Project versions, invokes the real adapter once and retains complete result bytes', () => fixture(async f => {
  f.update('agent', f.agent, { instructions: 'New design must not leak into old plan' });
  f.update('content', f.source, { body: 'New source must not leak into old plan' });
  const started = f.service.start(f.device, f.input);
  const replay = f.service.start(f.device, f.input); assert.equal(started.id, replay.id);
  await settle(f.service, started.id, 'running');
  const native = f.gateway.nativeCalls[0]; assert.equal(f.gateway.nativeCalls.length, 1);
  assert.equal(native.disableTools, true); assert.equal(native.deliver, false);
  assert.match(native.message, /Original design sentinel/); assert.match(native.message, /Original source sentinel/); assert.doesNotMatch(native.message, /must not leak/);
  assert.equal(f.service.detail(started.id).capture.agent.revision, 1);
  assert.equal(f.service.state().canStart, false);
  const full = '\uFEFF' + 'Complete Unicode result 🐾\r\n'.repeat(600);
  f.gateway.finish(full); const result = await f.service.reconcile(started.id);
  assert.equal(result.state, 'returned'); assert.equal(result.result?.previewTruncated, true);
  assert.equal(f.store.download(result.result!.file.id).bytes.toString('utf8'), full);
  assert.equal(f.store.snapshot(f.device).tasks.length, 0); assert.equal(f.service.state().canStart, true);
  assert.equal(JSON.stringify(f.service.state()).includes('Original source sentinel'), false);
  assert.equal(readFileSync(join(f.directory, 'workspace.sqlite')).includes(Buffer.from('Original source sentinel')), false);
  f.gateway.available = false;
  assert.equal(f.service.start(f.device, f.input).id, started.id); assert.equal(f.gateway.nativeCalls.length, 1);
}));
test('assignment source files are captured in full once, with exact bytes retained after later source edits', () => fixture(async f => {
  const text = '\uFEFFFile-only sentinel 🐾\r\n' + 'Line of supplied context\n'.repeat(250);
  const file = f.store.upload(f.device, randomUUID(), f.store.epoch, 'research.md', Buffer.from(text).toString('base64'));
  const source = f.update('content', f.source, { assets: [file] });
  const project = f.store.readEntity('project', f.plan.value.projectId)!;
  const updatedProject = f.update('project', project, { attachments: [file] });
  const plan = f.update('assignment', f.plan, { sources: [{ kind: 'content', id: source.id, revision: source.revision }] });
  const started = f.service.start(f.device, { ...f.input, revision: plan.revision, projectRevision: updatedProject.revision });
  f.update('content', source, { assets: [], body: 'Later source edits' });
  await settle(f.service, started.id, 'running');
  const capture = f.service.detail(started.id).capture;
  assert.equal(capture.files?.length, 1); assert.equal(capture.files[0].text, text); assert.equal(capture.files[0].origins.length, 2);
  assert.match(f.gateway.nativeCalls[0].message, /File-only sentinel/); assert.equal(f.gateway.nativeCalls[0].disableTools, true);
  assert.equal(f.store.download(file.id).bytes.toString('utf8'), text);
  const restored = await f.replaceService(); assert.equal(restored.detail(started.id).capture.files?.[0].text, text);
}));
test('unsupported, oversized and non-UTF-8 assignment files fail before a native run or durable attempt', () => fixture(async f => {
  let source = f.source, plan = f.plan;
  for (const [name, bytes] of [['brief.docm', Buffer.from('unsupported document')], ['large.txt', Buffer.alloc(65537, 65)], ['binary.txt', Buffer.from([0xff, 0xfe, 0])]] as const) {
    const file = f.store.upload(f.device, randomUUID(), f.store.epoch, name, bytes.toString('base64'));
    source = f.update('content', source, { assets: [file] }); plan = f.update('assignment', plan, { sources: [{ kind: 'content', id: source.id, revision: source.revision }] });
    assert.throws(() => f.service.start(f.device, { ...f.input, requestId: randomUUID(), revision: plan.revision }), /supported text source|Nothing was truncated|complete UTF-8/);
    assert.equal(f.gateway.nativeCalls.length, 0); assert.equal(f.service.state().attempts.length, 0);
  }
}));
for (const format of ['pdf', 'docx'] as const) test(`${format} assignment sources keep exact captured identities and remain subject to live source grants`,()=>fixture(async f=>{
  const bytes = format === 'pdf' ? sourcePdf() : officeZip(officeEntries('docx'));
  const file=f.store.upload(f.device,randomUUID(),f.store.epoch,'source.' + format,bytes.toString('base64'));
  const source=f.update('content',f.source,{assets:[file]});
  let plan=f.update('assignment',f.plan,{sources:[{kind:'content',id:source.id,revision:source.revision}]});
  assert.throws(()=>f.service.start(f.device,{...f.input,revision:plan.revision}),/read access/);assert.equal(f.service.state().attempts.length,0);
  const unrelated=f.update('agent',f.agent,{access:{projects:'read'}});plan=f.update('assignment',plan,{agentRevision:unrelated.revision});
  assert.throws(()=>f.service.start(f.device,{...f.input,requestId:randomUUID(),revision:plan.revision}),/read access/);assert.equal(f.gateway.nativeCalls.length,0);
  const agent=f.update('agent',unrelated,{access:{content:'read',projects:'read'}});plan=f.update('assignment',plan,{agentRevision:agent.revision});
  const started=f.service.start(f.device,{...f.input,requestId:randomUUID(),revision:plan.revision});await settle(f.service,started.id,'running');
  f.update('content',source,{assets:[]});
  assert.deepEqual(f.service.detail(started.id).capture.binaryFiles?.[0].file,file);assert.deepEqual(f.service.sourceFiles(started.id)[0].file,file);
  assert.doesNotMatch(f.gateway.nativeCalls[0].message,/ORCHID 27|Alpha quantity: 4/);assert.match(f.gateway.nativeCalls[0].message,/sources.read/);
  if (format === 'docx') assert.match(f.gateway.nativeCalls[0].message, /DOCX, XLSX and PPTX support text view/);
  f.update('agent',agent,{access:{}});assert.deepEqual(f.service.sourceFiles(started.id),[]);
}));
test('stale plan/Project, archived sources and foreign kinds fail before dispatch', () => fixture(async f => {
  assert.throws(() => f.service.start(f.device, { ...f.input, revision: 99 }), /current active assignment/);
  assert.throws(() => f.service.start(f.device, { ...f.input, projectRevision: 99 }), /current Project/);
  assert.equal(f.store.readEntityVersion('contact', f.source.id, 1), undefined);
  f.update('content', f.source, { archived: true }); assert.throws(() => f.service.start(f.device, f.input), /source is unavailable or archived/);
  assert.equal(f.gateway.nativeCalls.length, 0); assert.equal(f.service.state().attempts.length, 0);
}));
test('oversized selected text is rejected intact, and admission rollback leaves no orphan attempt', () => fixture(async f => {
  const source2 = f.store.mutate(f.device, { requestId: randomUUID(), epoch: f.store.epoch, kind: 'content', entityId: `content:${randomUUID()}`, expectedRevision: 0, payload: { ...blankRecord('content', 'UTC'), title: 'Large second source', body: 'b'.repeat(100000) } });
  const source1 = f.update('content', f.source, { body: 'a'.repeat(100000) });
  const plan = f.update('assignment', f.plan, { sources: [{ kind: 'content', id: source1.id, revision: source1.revision }, { kind: 'content', id: source2.id, revision: source2.revision }] });
  assert.throws(() => f.service.start(f.device, { ...f.input, revision: plan.revision }), /nothing was truncated/);
  assert.equal(f.service.state().attempts.length, 0); assert.equal(f.gateway.nativeCalls.length, 0);
  const write = f.store.internalWrite.bind(f.store);
  f.store.internalWrite = (id, value) => { const saved = write(id, value); if (id.startsWith('assignments:summary:')) throw new Error('Injected admission failure'); return saved; };
  const shortPlan = f.update('assignment', plan, { sources: [] });
  assert.throws(() => f.service.start(f.device, { ...f.input, revision: shortPlan.revision }), /Injected/);
  f.store.internalWrite = write;
  assert.equal(f.store.internalList('assignments:attempt:').length, 0); assert.equal(f.service.state().attempts.length, 0); assert.equal(f.store.internalRead('assignments:active'), undefined);
}));
test('new attempts cannot replace an unresolved run; lost native acknowledgment reconciles after restart without redispatch', () => fixture(async f => {
  f.gateway.loseAck = true; const started = f.service.start(f.device, f.input);
  await settle(f.service, started.id, 'unknown');
  assert.throws(() => f.service.start(f.device, { ...f.input, requestId: randomUUID() }), /Finish or reconcile/);
  const service = await f.replaceService();
  assert.equal(service.start(f.device, f.input).id, started.id);
  f.gateway.finish('Recovered exact result');
  assert.equal((await service.reconcile(started.id)).state, 'returned'); assert.equal(f.gateway.nativeCalls.length, 1);
}));
test('stop before capabilities return is durable and prevents a late first dispatch', () => fixture(async f => {
  let release!: () => void; f.gateway.holdCapabilities = new Promise<void>(ok => { release = ok; });
  const started = f.service.start(f.device, f.input);
  const command = { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id };
  assert.equal(f.service.stop(f.device, command).state, 'cancelled'); release(); await tick();
  assert.equal(f.service.stop(f.device, command).state, 'cancelled'); assert.equal(f.gateway.nativeCalls.length, 0);
}));
test('stop during native admission targets the original run and waits for terminal evidence', () => fixture(async f => {
  let release!: () => void; f.gateway.holdAdmission = new Promise<void>(ok => { release = ok; });
  const started = f.service.start(f.device, f.input);
  for (let n = 0; !f.gateway.nativeCalls.length && n < 50; n++) await tick();
  f.service.stop(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id });
  await f.service.reconcile(started.id);
  assert.equal(f.service.detail(started.id).attempt.state, 'stopping');
  const abort = f.gateway.calls.find(c => c.method === 'chat.abort')!;
  assert.equal(abort.params.runId, f.gateway.nativeCalls[0].idempotencyKey); assert.equal(abort.params.preserveSideRuns, true);
  release(); await tick(); f.gateway.finish('Partial result at stop', 'error');
  const result = await f.service.reconcile(started.id); assert.equal(result.state, 'cancelled'); assert.match(result.result!.preview, /Partial result/);
}));
test('deadline requests stop but a wait timeout never becomes fake completion', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  f.advance(61000); const pending = await f.service.reconcile(started.id);
  assert.equal(pending.state, 'stopping'); assert.equal(pending.stopReason, 'deadline'); assert.equal(f.service.state().canStart, false);
  f.gateway.finish('Completed while stop was in flight'); assert.equal((await f.service.reconcile(started.id)).state, 'returned');
}));
test('explicit unresolved review preserves the original attempt and never creates a replacement run', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  const review = { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id, understandUnconfirmed: true };
  assert.throws(() => f.service.acknowledgeUnresolved(f.device, review), /Request stop/);
  f.gateway.available = false;
  f.service.stop(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id });
  await f.service.reconcile(started.id);
  assert.throws(() => f.service.acknowledgeUnresolved(f.device, { ...review, understandUnconfirmed: false }));
  const kept = f.service.acknowledgeUnresolved(f.device, review);
  assert.equal(kept.state, 'stopping'); assert.equal(kept.result, undefined); assert.equal(kept.terminal, undefined);
  assert.equal(kept.unresolvedReview?.deviceId, f.device); assert.equal(f.gateway.nativeCalls.length, 1);
  assert.equal(f.store.internalRead('assignments:active'), null);
  const service = await f.replaceService(); f.gateway.available = true;
  assert.equal(service.state().canStart, true);
  assert.deepEqual(service.acknowledgeUnresolved(f.device, review).unresolvedReview, kept.unresolvedReview);
  assert.equal(service.start(f.device, f.input).id, started.id); assert.equal(f.gateway.nativeCalls.length, 1);
  const next = service.start(f.device, { ...f.input, requestId: randomUUID() }); await settle(service, next.id, 'running');
  await service.reconcile(started.id);
  assert.equal(f.store.internalRead('assignments:active'), next.id, 'Checking reviewed uncertainty cannot steal the new active slot');
  f.gateway.finish('Late result from the original assignment');
  const late = await service.reconcile(started.id);
  assert.equal(late.state, 'returned'); assert.equal(late.id, started.id); assert.equal(late.runId, kept.runId);
  assert.equal(late.result?.preview, 'Late result from the original assignment');
  assert.equal(f.store.internalRead('assignments:active'), next.id);
  assert.equal(service.state().canStart, false); assert.equal(f.gateway.nativeCalls.length, 2);
}));
test('a completed outcome winning the unresolved-review race is kept without changing its terminal proof', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  f.service.stop(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id });
  await f.service.reconcile(started.id); f.gateway.finish('Complete original output');
  const returned = await f.service.reconcile(started.id);
  const kept = f.service.acknowledgeUnresolved(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id, understandUnconfirmed: true });
  assert.deepEqual(kept, returned); assert.equal(kept.unresolvedReview, undefined); assert.equal(f.service.state().canStart, true);
}));
test('native settled errors without a completion receipt end stopped work, while pending errors and bare timeouts do not', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  f.service.stop(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id }); await f.service.reconcile(started.id);
  f.gateway.observation = { status: 'error', endedAt: Date.now(), pendingError: true, stopReason: 'rpc' };
  assert.equal((await f.service.reconcile(started.id)).state, 'stopping');
  f.gateway.observation = { status: 'timeout', endedAt: Date.now(), stopReason: 'rpc' };
  assert.equal((await f.service.reconcile(started.id)).state, 'stopping');
  f.gateway.observation = { status: 'error', endedAt: Date.now(), stopReason: 'rpc' };
  const result = await f.service.reconcile(started.id); assert.equal(result.state, 'cancelled'); assert.equal(result.terminal, undefined); assert.equal(result.result, undefined); assert.equal(result.failedExecution?.stopReason, 'rpc');
  assert.equal(f.service.state().canStart, true);
}));
test('replacement runtime, mismatched terminal run and mismatched session cannot adopt another result', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  f.gateway.finish(); const original = f.gateway.generation; f.gateway.generation = randomUUID();
  const count = f.gateway.calls.length; assert.equal((await f.service.reconcile(started.id)).state, 'unknown'); assert.equal(f.gateway.calls.length, count);
  f.gateway.generation = original; f.gateway.foreignReceipt = true; assert.equal((await f.service.reconcile(started.id)).state, 'unknown');
  f.gateway.foreignReceipt = false; f.gateway.foreignSession = true; assert.equal((await f.service.reconcile(started.id)).state, 'unknown');
  f.gateway.foreignSession = false; assert.equal((await f.service.reconcile(started.id)).state, 'returned');
}));
test('tool use or external delivery in a native terminal receipt is rejected as assignment output', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  f.gateway.finish(); f.gateway.observation.terminalReceipt.successfulToolNames = ['exec'];
  const result = await f.service.reconcile(started.id); assert.equal(result.state, 'failed'); assert.equal(result.result, undefined);
}));
test('file-save failure retains the entire native reply and resumes with the same upload receipt', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running'); f.gateway.finish('Durable native reply');
  const upload = f.store.upload.bind(f.store); let fail = true; let requestId: string | undefined;
  f.store.upload = (...args) => { if (requestId) assert.equal(args[1], requestId); requestId = args[1]; const file = upload(...args); if (fail) throw new Error('Crash after durable upload'); return file; };
  assert.equal((await f.service.reconcile(started.id)).state, 'unknown'); fail = false;
  const before = f.gateway.calls.length; const result = await f.service.reconcile(started.id);
  assert.equal(result.state, 'returned'); assert.equal(f.gateway.calls.length, before); assert.equal(f.store.download(result.result!.file.id).bytes.toString(), 'Durable native reply');
}));
test('older assignment attempts remain reachable without exposing full captured inputs in the history page', () => fixture(async f => {
  const ids: string[] = [];
  for (let n = 0; n < 103; n++) {
    const attempt = f.service.start(f.device, { ...f.input, requestId: randomUUID() }); ids.push(attempt.id);
    f.service.stop(f.device, { requestId: randomUUID(), epoch: f.store.epoch, attemptId: attempt.id }); f.advance(1);
  }
  const first = f.service.state(f.plan.id), second = f.service.state(f.plan.id, first.nextCursor!);
  assert.equal(first.attempts.length, 100); assert.equal(second.attempts.length, 3); assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.attempts, ...second.attempts].map(attempt => attempt.id)), new Set(ids));
  assert.equal(JSON.stringify(second).includes('Original source sentinel'), false);
  const source = f.service.detail(second.attempts[0].id).capture.sources[0].record.value;
  assert.ok('body' in source); assert.equal(source.body, 'Original source sentinel');
  assert.throws(() => f.service.state(f.plan.id, randomUUID()), /Reload assignment history/);
}));
test('returned assignment becomes Content with exact native/source/file identities and original Project, independently of later plan edits', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  const text = '\uFEFF# Review 🐾\r\n' + 'Complete result beyond the preview.\r\n'.repeat(300);
  f.gateway.finish(text); const result = await f.service.reconcile(started.id);
  f.update('assignment', f.plan, { title: 'Changed plan', brief: 'New instructions', archived: true });
  const input = { requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id, sha256: result.result!.file.sha256 };
  const content = f.store.createContentFromAssignment(f.device, input);
  assert.equal(content.value.body, text); assert.equal(content.value.title, 'Review draft'); assert.equal(content.value.projectId, started.projectId);
  const source = content.value.source!; assert.equal(source.kind, 'assignment'); assert.ok(source.kind === 'assignment');
  assert.equal(source.attemptId, started.id); assert.equal(source.assignmentRevision, 1); assert.equal(source.agentRevision, 1); assert.equal(source.runId, result.runId); assert.equal(source.nativeId, result.nativeSessionId); assert.equal(source.turnId, result.terminal!.turnId);
  assert.deepEqual(content.value.assets, [result.result!.file]);
  f.update('content', content, { body: 'Independently edited Content', archived: true });
  assert.equal(f.store.download(source.fileId).bytes.toString('utf8'), text);
  const reopened = new Store(f.directory);
  try { assert.deepEqual(reopened.createContentFromAssignment(f.device, input), content); assert.equal(reopened.snapshot(f.device).records!.content.length, 2); }
  finally { reopened.close(); }
  assert.throws(() => f.store.createContentFromAssignment('another-device', input), /different work/);
  assert.throws(() => f.store.createContentFromAssignment(f.device, { ...input, sha256: 'f'.repeat(64) }), /different work/);
}));
test('worker Content admission rejects unfinished/error/empty outcomes, mismatched files and forged provenance', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  const command = () => ({ requestId: randomUUID(), epoch: f.store.epoch, attemptId: started.id, sha256: 'f'.repeat(64) });
  assert.throws(() => f.store.createContentFromAssignment(f.device, command()), /exact returned assignment/);
  f.gateway.finish('Working result'); const result = await f.service.reconcile(started.id);
  assert.throws(() => f.store.createContentFromAssignment(f.device, command()), /exact returned assignment/);
  const content = f.store.createContentFromAssignment(f.device, { ...command(), sha256: result.result!.file.sha256 });
  assert.throws(() => f.update('content', content, { source: { ...content.value.source, attemptId: randomUUID() } }), /original source/);
  assert.throws(() => f.update('content', content, { assets: [] }), /original source file/);
  const task = f.store.createRecordTask(f.device, { requestId: randomUUID(), epoch: f.store.epoch, origin: { kind: 'content', id: content.id, revision: content.revision }, title: 'Review the returned draft' });
  assert.equal(task.value.projectId, started.projectId); assert.equal(task.value.origin?.id, content.id);
  const second = f.service.start(f.device, { ...f.input, requestId: randomUUID() }); await settle(f.service, second.id, 'running'); f.gateway.finish('Partial failure', 'error');
  const failed = await f.service.reconcile(second.id); assert.throws(() => f.store.createContentFromAssignment(f.device, { ...command(), attemptId: failed.id, sha256: failed.result!.file.sha256 }), /exact returned assignment/);
  const empty = f.service.start(f.device, { ...f.input, requestId: randomUUID() }); await settle(f.service, empty.id, 'running'); f.gateway.finish('');
  const emptyResult = await f.service.reconcile(empty.id); assert.throws(() => f.store.createContentFromAssignment(f.device, { ...command(), attemptId: empty.id, sha256: emptyResult.result!.file.sha256 }), /no draft text/);
}));
test('large worker results remain attached in full and a reference-write failure rolls admission back', () => fixture(async f => {
  const started = f.service.start(f.device, f.input); await settle(f.service, started.id, 'running');
  const text = 'x'.repeat(100001); f.gateway.finish(text); const result = await f.service.reconcile(started.id);
  const command = { requestId: randomUUID(), epoch: f.store.epoch, attemptId: result.id, sha256: result.result!.file.sha256 };
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(f.directory, 'workspace.sqlite'));
  try {
    db.exec("CREATE TRIGGER fixture_assignment_ref BEFORE INSERT ON blob_refs BEGIN SELECT RAISE(ABORT,'Fixture assignment reference failure'); END;");
    assert.throws(() => f.store.createContentFromAssignment(f.device, command), /Fixture assignment reference/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM receipts WHERE request_id=?').get(command.requestId)?.n, 0);
    assert.equal(f.store.snapshot(f.device).records!.content.length, 1);
    db.exec('DROP TRIGGER fixture_assignment_ref');
    const content = f.store.createContentFromAssignment(f.device, command);
    assert.equal(content.value.body, ''); assert.equal(content.value.source?.importedText, false);
    assert.equal(f.store.download(content.value.source!.fileId).bytes.toString('utf8'), text);
    assert.equal(db.prepare('SELECT blob_id FROM blob_refs WHERE entity_id=?').get(content.id)?.blob_id, result.result!.file.id);
  } finally { db.close(); }
}));
