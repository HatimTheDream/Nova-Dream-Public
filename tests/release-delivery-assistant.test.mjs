import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ReleaseJournal } from '../scripts/release-coordinate.mjs';
import { sha256 } from '../scripts/release-plan.mjs';
import { assistantAcceptanceInput, createAssistantAcceptanceAdapter } from '../scripts/release-delivery-assistant.mjs';
import { createDeliveryRegistry, deliveryPhaseIntegrationGaps, deliveryTargetSchema, deliveryAdapterIdentity } from '../scripts/release-delivery-adapters.mjs';
import { frontendExecutionRequest } from '../scripts/release-delivery-frontend-executor.mjs';

const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const schema = readFileSync(new URL('../scripts/release-coordinate.mjs', import.meta.url), 'utf8')
  .match(/this\.db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]+?PRAGMA user_version=1; COMMIT;)`\);/)[1].replace('${APPLICATION_ID}', String(0x4e56524c));
function fixture(t, configure = () => {}) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'nova-m2-assistant-'));
  const journal = Object.create(ReleaseJournal.prototype); journal.directory = root; journal.readOnly = false;
  journal.db = new DatabaseSync(join(root, 'journal.sqlite')); journal.db.exec(schema);
  t.after(() => { journal.close(); assert.equal(dirname(root), parent); assert.ok(root.startsWith(parent + sep)); rmSync(root, { recursive: true, force: true }); });
  const target = join(root, 'target.json'); writeFileSync(target, '{}');
  const now = 1791924000000, id = randomUUID(), epoch = randomUUID(), processIdentity = randomUUID(); let time = now;
  const operation = { id, stage: 'draft', candidateId: null, publicCandidateId: null, priorCandidateId: sha256('prior'), workspaceEpoch: epoch,
    version: '2.3.1', buildVersion: '1.0.288', agentVersion: '2026.9.8', priorAgentVersion: '2026.9.8', sourceCommits: { private: 'a'.repeat(40), public: 'b'.repeat(40) },
    bundleSha256: null, trustedPublicKeySha256: sha256('key'), changeClass: 'application', helperHashes: null };
  const original = { id: randomUUID(), step: 'total', issuedAtMs: now, remainingMs: [600000, 1200000], confidence: 'low', basis: 'Synthetic fixture.', reason: 'Original estimate.', nextCheckpointAtMs: now + 300000 };
  const descriptor = { format: 1, operation, sources: Object.fromEntries(['private', 'public'].map((side, i) => [side, { root: '/' + side, repository: 'Example/' + side,
    commit: operation.sourceCommits[side], baseCommit: (i ? 'd' : 'c').repeat(40), branch: 'main' }])), target: { path: target, sha256: sha256('{}') },
    targetIdentity: sha256('target'), adapterIdentity: sha256('adapter'), observationBudgetMs: 14400000,
    timeline: { startedAtMs: now, original, revisions: [], reviews: [], lastCheckpointAtMs: now } };
  const health = { candidateId: operation.priorCandidateId, epoch, processIdentity, serviceInputsSha256: sha256('service'), frontend: { id: sha256('old'), source: 'bundled' } };
  const prior = { route: { route: 'frontend', serviceInputsSha256: health.serviceInputsSha256 }, sign: { frontendId: sha256('new') }, publication: { frontendId: sha256('new') },
    installation: { state: 'completed', operationId: id, journal: { phase: 'completed', outcome: 'selected', health, frontendId: sha256('new') } } };
  configure({root,descriptor,prior});
  const input = assistantAcceptanceInput({ descriptor, prior }); journal.initializeDelivery(descriptor, now);
  const intent = journal.reserveDeliveryPhase(id, 'assistant', input, now).intent;
  const counts = { gate: 0, create: 0, draft: 0, submit: 0, session: 0, post: [] }, receipts = new Map();
  const deviceId = randomUUID(), generation = randomUUID(), sessionSha256 = sha256('retained-secret-not-a-real-credential');
  const ready = { health: structuredClone(input.installedHealth), access: { workspaceEpoch: epoch, recovery: false, recoveryLocal: false },
    acceptance: { candidateId: health.candidateId, epoch, heldFor: null, maintenanceHeld: false, nativeSuspended: false }, service: { id: 'openclaw', state: 'ready', version: '2026.9.8' },
    state: { connection: { state: 'ready', modelAuthReady: true, grantedScopes: ['operator.read', 'operator.write'], generation }, operations: [], conversations: [] },
    appProcess: { ActiveState: 'active', SubState: 'running', MainPID: '123', NRestarts: '0', ExecMainStartTimestampMonotonic: '123456' },
    runtimeProof: { configurationSha256: sha256('config'), openclawVersion: '2026.9.8', files: { node: { bytes: 100, inode: 1, sha256: sha256('node') }, codex: { bytes: 101, inode: 2, sha256: sha256('codex') } } },
    installationProof: { installationSha256: input.installationSha256 }, fullRuntimeVerified: true };
  let draft, history, loss = null, sessionResult, tombstone = false;
  const transport = {
    validate: async () => {},
    session: async c => { if (c.observeOnly) return structuredClone(sessionResult); counts.session++;
      sessionResult = { deviceId, sessionSha256, sessionReference: { path: '/protected/synthetic-session.json', sha256: sessionSha256 }, ready: structuredClone(ready) }; return structuredClone(sessionResult); },
    readReady: async () => structuredClone(ready), readDraft: async () => structuredClone(draft),
    postExact: async c => {
      const request = c.request, body = JSON.parse(request.bodyBytes), name = request.endpoint.endsWith('/conversations') ? 'create' : request.endpoint.endsWith('/commands') ? 'draft' : 'submit';
      counts.post.push({ name, ...structuredClone(request), continuation: c.effectCapableContinuation });
      assert.equal(request.bodySha256, sha256(request.bodyBytes)); assert.equal(request.requestId, body.requestId);
      assert.equal(request.deviceId, deviceId); assert.equal(request.sessionSha256, sessionSha256); assert.equal(request.epoch, epoch);
      if (loss?.name === name && loss.when === 'before') { loss = null; throw Error('fixture-lost-before-commit'); }
      if (tombstone) throw Object.assign(Error('removed'), { code: 'conversation_removed' });
      let receipt = receipts.get(body.requestId);
      if (receipt) { assert.equal(receipt.digest, request.bodySha256); return structuredClone(receipt.output); }
      counts[name]++;
      let output;
      if (name === 'create') { output = { id: randomUUID(), nativeId: randomUUID(), revision: 1, state: 'ready', permissionMode: 'read-only', projectId: null, connectionGeneration: generation, archived: false }; ready.state.conversations.push(output); }
      if (name === 'draft') { output = { id: body.entityId, deviceId, revision: 1, updatedAt: '2026-10-13T20:35:00.000Z', value: body.payload }; draft = structuredClone(output); }
      if (name === 'submit') { const conversation = ready.state.conversations[0], reply = `Nova verification ${intent.key} passed.`;
        output = { id: randomUUID(), requestId: body.requestId, deviceId, epoch, conversationId: body.conversationId, conversationRevision: 1,
          nativeId: conversation.nativeId, connectionGeneration: generation, state: 'completed', nativeRunId: randomUUID(), text: reply };
        ready.state.operations.push(output); history = { nativeId: conversation.nativeId, activeRunIds: [], messages: [{ id: randomUUID(), role: 'assistant', text: reply, runId: output.nativeRunId }] }; }
      receipts.set(body.requestId, { digest: request.bodySha256, output: structuredClone(output) });
      if (loss?.name === name && loss.when === 'after') { loss = null; throw Error('fixture-lost-after-commit'); }
      return structuredClone(output);
    },
    observeSubmit: async () => ({ ready: structuredClone(ready), operation: structuredClone(ready.state.operations[0]), history: structuredClone(history) }),
  };
  const storeReceipt = (_journal, key, name, bytes) => { const path = join(root, key + '-' + name); if (existsSync(path)) assert.deepEqual(readFileSync(path), bytes); else writeFileSync(path, bytes); return { path, sha256: sha256(bytes) }; };
  const context = { descriptor, prior, journal, intent, input, beforeNewEffect: async () => { counts.gate++; } };
  return { context, ready, counts, receipts, transport, now, root, deviceId, setTime: value => { time = value; }, setLoss: (name, when) => { loss = { name, when }; },
    changeDraft: () => { draft.revision++; draft.value.text = 'User writing must survive.'; }, tombstone: () => { tombstone = true; },
    producer: (actual = transport) => createAssistantAcceptanceAdapter({ transport: actual, storeReceipt, clock: () => time }) };
}

test('real coordinator context supplies retained input at every host validation boundary', async t => {
  const f = fixture(t); delete f.context.input; let validations = 0;
  f.transport.validate = async context => { validations++; assert.deepEqual(context.input, context.intent.input); };
  const result = await f.producer().execute(f.context);
  assert.equal(result.state, 'completed'); assert.ok(validations >= 5); assert.equal(f.counts.submit, 1);
});

test('fixed registry and host wire resume an actual SQLite Assistant chain with separate browser gap', async t => {
  let target, run, paths;
  const f=fixture(t, ({root,descriptor,prior})=>{
    const put=(name,value)=>{const bytes=Buffer.from(JSON.stringify(value)),path=join(root,name);writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};};
    const config=join(root,'ssh.conf');writeFileSync(config,'Host fixed\n HostName example.invalid\n');
    const transport=put('transport.json',{format:1,hostAlias:'fixed',sshConfig:{path:config,sha256:sha256(readFileSync(config))}});
    target={format:1,transport,browserCapability:'unavailable',assistantHost:{startupReview:{path:'/opt/nova-release-tools/actual/checked/startup-review.json',sha256:sha256('review')},hostConfig:{path:'/etc/nova-update/config.json',sha256:sha256('config')}}};
    descriptor.target=put('target.json',target);descriptor.adapterIdentity=deliveryAdapterIdentity();
    const h=prior.installation.journal.health,id=descriptor.operation.id,host='/var/lib/nova-update/frontend/operator-inputs/'+id,ref=(path,label)=>({path,sha256:sha256(label)});
    const planInput={format:1,operationId:id,baseVersion:'2.3.0',baseCandidateId:h.candidateId,serviceInputsSha256:h.serviceInputsSha256,frontendId:prior.sign.frontendId,sourceRevision:descriptor.operation.sourceCommits.private,version:'2.3.1',buildVersion:'1.0.288',worker:{path:'/opt/nova-updater-2.3.0-'+h.candidateId.slice(0,12)+'/deploy/update-runner/frontend.py',sha256:'73ca5399f703f20512a925b0cdb10dde1dfa9b733966d47b5cbdd1f20c34b171'},config:ref('/etc/nova-update/frontend.json','frontend-config'),operation:ref(host+'/operation.json','operation'),assets:{manifest:ref(host+'/frontend.json','manifest'),signature:ref(host+'/frontend.sig','signature'),archive:ref(host+'/frontend.tgz','archive')},processIdentity:h.processIdentity,workspaceEpoch:h.epoch};
    prior.recovery={stagedExecution:{request:frontendExecutionRequest({operationId:id,runId:randomUUID(),planInput,planSha256:sha256('plan'),intentSha256:sha256('intent')})}};
    prior.installation.journalSha256=sha256('installation-journal');paths={put};
  });
  const modes=[];
  run=async(_target,program)=>{
    const wire=JSON.parse(Buffer.from(program.match(/b64decode\('([^']+)'/)[1],'base64'));assert.equal(sha256(Buffer.from(wire.sourceBase64,'base64')),wire.sourceSha256);
    const {mode,binding,common}=wire.value;modes.push(mode);assert.equal(binding.inputSha256,f.context.intent.inputSha256);assert.equal(common.deadlineAtMs,f.now+300000);
    const invoke={session:'session',ready:'readReady',post:'postExact',draft:'readDraft',observe:'observeSubmit'}[mode];
    try{return{exitCode:0,stdout:JSON.stringify({ok:true,value:await f.transport[invoke](common)})};}
    catch(error){return{uncertain:true,stdout:'synthetic lost response',stderr:error.message};}
  };
  const registry=createDeliveryRegistry({run,clock:()=>f.now,command:async()=>assert.fail('No network command'),receiptStore:(_j,key,name,bytes)=>{const path=join(f.root,key+'-'+name);if(existsSync(path))assert.deepEqual(readFileSync(path),bytes);else writeFileSync(path,bytes);return{path,sha256:sha256(bytes)};}});
  assert.deepEqual(await registry.phasePreflight('assistant',f.context.descriptor,f.context.prior),[]);
  assert.ok((await registry.capabilityGaps(f.context.descriptor)).includes('browser-reload-producer-not-integrated'));
  assert.ok(!(await registry.capabilityGaps(f.context.descriptor)).includes('assistant-host-target-not-configured'));
  delete f.context.input;f.setLoss('draft','after');
  let adapter=registry.adapter('assistant',f.context.descriptor,f.context.prior),result=await adapter.execute(f.context);assert.equal(result.state,'uncertain');
  adapter=registry.adapter('assistant',f.context.descriptor,f.context.prior);result=await adapter.observe(f.context);assert.equal(result.state,'completed',JSON.stringify(result));await adapter.verify(result,f.context);
  assert.equal(f.counts.create,1);assert.equal(f.counts.draft,1);assert.equal(f.counts.submit,1);assert.equal(result.output.browserUiVerified,false);assert.equal(result.output.savedReplyAccepted,true);assert.ok(modes.includes('observe'));
  assert.deepEqual(deliveryPhaseIntegrationGaps('assistant',{browserCapability:'available'},f.context.prior),['assistant-host-target-not-configured']);
  assert.deepEqual(deliveryPhaseIntegrationGaps('assistant',target,{route:{route:'full'}}),[]);
  assert.ok(registry.adapter('assistant',f.context.descriptor,{route:{route:'full'}}));
  assert.throws(()=>deliveryTargetSchema.parse({...target,assistantHost:{...target.assistantHost,manualReceipt:{path:'x',sha256:sha256('x')}}}));
});

for (const name of ['create', 'draft']) for (const when of ['before', 'after']) test(`${name} lost ${when} atomic commit continues the exact effect once`, async t => {
  const f = fixture(t); f.setLoss(name, when); assert.equal((await f.producer().execute(f.context)).state, 'uncertain');
  const old = f.context.journal.deliveryPhase(f.context.descriptor.operation.id, 'assistant/' + name);
  f.context.journal.db.close(); f.context.journal.db = new DatabaseSync(join(f.root, 'journal.sqlite'));
  const result = await f.producer().observe(f.context); assert.equal(result.state, 'completed');
  assert.equal(f.counts.create, 1); assert.equal(f.counts.draft, 1); assert.equal(f.counts.submit, 1); assert.equal(f.counts.session, 1);
  const posts = f.counts.post.filter(p => p.name === name); assert.equal(posts.length, 2); assert.equal(posts[1].continuation, true);
  assert.equal(posts[0].bodyBytes, posts[1].bodyBytes); assert.equal(posts[0].requestId, old.key);
  assert.equal(result.output.originalDeadlineAtMs, f.now + 300000); assert.equal(result.output.savedReplyAccepted, true); assert.equal(result.output.browserUiVerified, false);
});
for (const when of ['before', 'after']) test(`submit lost ${when} commit is never posted again`, async t => {
  const f = fixture(t); f.setLoss('submit', when); assert.equal((await f.producer().execute(f.context)).state, 'uncertain');
  const result = await f.producer().observe(f.context); assert.equal(result.state, when === 'after' ? 'completed' : 'uncertain');
  assert.equal(f.counts.post.filter(p => p.name === 'submit').length, 1);
});
test('original deadline is preserved across interruption and a late response cannot pass', async t => {
  const f = fixture(t); f.setLoss('create', 'after'); await f.producer().execute(f.context); const posts = f.counts.post.length;
  f.setTime(f.now + 300000); await assert.rejects(f.producer().observe(f.context), /original-deadline-exhausted/); assert.equal(f.counts.post.length, posts);
  const second = fixture(t), original = second.transport.postExact;
  second.transport.postExact = async c => { const value = await original(c); second.setTime(second.now + 300001); return value; };
  const late = await second.producer().execute(second.context); assert.equal(late.state, 'uncertain'); assert.equal(late.reason, 'assistant-original-deadline-exhausted'); assert.equal(second.counts.submit, 0);
});
test('changed process, epoch, device and body are refused before dependent effects', async t => {
  for (const change of ['process', 'epoch', 'device', 'body']) await t.test(change, async t => {
    const f = fixture(t); f.setLoss('draft', 'after'); await f.producer().execute(f.context); const posts = f.counts.post.length;
    if (change === 'process') f.ready.appProcess.MainPID = '999';
    if (change === 'epoch') f.ready.access.workspaceEpoch = randomUUID();
    if (change === 'device') { const original = f.transport.postExact; f.transport.postExact = async c => { c.request.deviceId = randomUUID(); return original(c); }; }
    if (change === 'body') { const original = f.transport.postExact; f.transport.postExact = async c => { c.request.bodyBytes += ' '; return original(c); }; }
    if (['process', 'epoch'].includes(change)) { await assert.rejects(f.producer().observe(f.context), /changed/); assert.equal(f.counts.post.length, posts); }
    else assert.equal((await f.producer().observe(f.context)).state, 'uncertain');
    assert.equal(f.counts.submit, 0);
  });
});
test('replayed draft receipt cannot overwrite or submit subsequently changed writing', async t => {
  const f = fixture(t); f.setLoss('draft', 'after'); await f.producer().execute(f.context); f.changeDraft();
  const value = await f.producer().observe(f.context); assert.equal(value.state, 'uncertain'); assert.equal(value.reason, 'assistant-current-draft-changed'); assert.equal(f.counts.submit, 0);
});
test('tombstoned create receipt stops rather than allocates a replacement identity', async t => {
  const f = fixture(t); f.setLoss('create', 'after'); await f.producer().execute(f.context); f.tombstone();
  const value = await f.producer().observe(f.context); assert.equal(value.state, 'failed'); assert.equal(f.counts.create, 1); assert.equal(f.counts.draft, 0);
  const posts = f.counts.post.length; assert.equal((await f.producer().observe(f.context)).state, 'failed'); assert.equal(f.counts.post.length, posts);
});
test('duplicate saved replies and unavailable runtime proof do not claim acceptance', async t => {
  const f = fixture(t), observe = f.transport.observeSubmit;
  f.transport.observeSubmit = async c => { const v = await observe(c); v.history.messages.push({ ...v.history.messages[0], id: randomUUID() }); return v; };
  assert.equal((await f.producer().execute(f.context)).reason, 'assistant-exactly-one-saved-reply-required');
  const second = fixture(t); second.ready.fullRuntimeVerified = false;
  assert.equal((await second.producer().execute(second.context)).reason, 'assistant-full-runtime-verification-required'); assert.equal(second.counts.create, 0);
});
test('missing fixed host transport stays a gap; browser and frontend health remain distinct', async t => {
  const f = fixture(t); const value = await f.producer(null).execute(f.context); assert.equal(value.state, 'gap');
  assert.equal(f.context.journal.db.prepare('SELECT count(*) n FROM delivery_phases').get().n, 1);
  assert.equal(f.context.intent.input.installedHealth.frontend.id, f.context.prior.sign.frontendId);
  assert.notEqual(f.context.intent.input.installedHealth.frontend.id, f.context.prior.installation.journal.health.frontend.id);
});
test('concurrent journal callers admit one submit and preserve original child keys', async t => {
  const f = fixture(t), second = Object.create(ReleaseJournal.prototype); second.directory = f.root; second.readOnly = false;
  second.db = new DatabaseSync(join(f.root, 'journal.sqlite'));
  try { await Promise.all([f.producer().execute(f.context), f.producer().observe({ ...f.context, journal: second })]); }
  finally { second.close(); }
  const completed = await f.producer().observe(f.context); assert.equal(completed.state, 'completed');
  assert.equal(f.counts.session, 1); assert.equal(f.counts.create, 1); assert.equal(f.counts.draft, 1);
  assert.equal(f.counts.post.filter(value => value.name === 'submit').length, 1);
  assert.equal(f.context.journal.db.prepare("SELECT count(*) n FROM delivery_phases WHERE phase LIKE 'assistant/%'").get().n, 5);
});
test('captured unknown operations and expired child reservations stay protected', async t => {
  const f = fixture(t); f.ready.state.operations.push({ id: randomUUID(), state: 'unknown', text: 'Original uncertainty' });
  f.setLoss('create', 'after'); await f.producer().execute(f.context); f.ready.state.operations[0].text = 'Changed';
  await assert.rejects(f.producer().observe(f.context), /old-unknown-operation-changed/); assert.equal(f.counts.submit, 0);
  const second = fixture(t), parent = second.context.intent;
  assert.throws(() => second.context.journal.reserveDeliveryPhase(second.context.descriptor.operation.id, 'assistant/submit', {
    parentKey: parent.key, parentInputSha256: parent.inputSha256, deadlineAtMs: second.now + 300000, priorResultsSha256: sha256('{}'), payload: {},
  }, second.now), /assistant-substep-prerequisite-incomplete/);
  assert.throws(() => second.context.journal.reserveDeliveryPhase(second.context.descriptor.operation.id, 'assistant/session', {
    parentKey: parent.key, parentInputSha256: parent.inputSha256, deadlineAtMs: second.now + 300001, priorResultsSha256: sha256('{}'), payload: {},
  }, second.now), /assistant-parent-intent-mismatch/);
});
test('actual Store Entity draft response has no kind field and still qualifies exact saved reply', async t => {
  const f = fixture(t), value = await f.producer().execute(f.context);
  assert.equal(value.state, 'completed');
  const draft = f.context.journal.deliveryPhase(f.context.descriptor.operation.id, 'assistant/draft').current.output;
  assert.deepEqual(Object.keys(draft.draft).sort(), ['deviceId', 'id', 'revision', 'updatedAt', 'value']);
  assert.equal(draft.requestBody.kind, 'draft');
  assert.equal(value.output.savedReplyAccepted, true);
});
