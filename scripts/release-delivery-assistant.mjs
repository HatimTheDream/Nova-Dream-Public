/** Durable saved-reply acceptance. The production host transport is a separate
 * required capability; this module never accepts a manual acceptance receipt.
 * Create/draft POST continuation is explicitly effect-capable and idempotent.
 * A dispatched submit is observed only, even if no response was received. */
import { isDeepStrictEqual } from 'node:util';
import { readEvidenceFile, sha256 } from './release-plan.mjs';

const need = (value, reason) => { if (!value) throw Error(reason); };
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = value => sha256(canonical(value));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const names = ['session', 'create', 'draft', 'submit', 'saved-reply'];
const active = new Set(['prepared', 'dispatching', 'accepted', 'running']);
const result = (state, reason, context, output = null, receipt = null) => ({ state, reason, output, receipt, externalId: context.descriptor.operation.id });
const safeReason = error => /^[a-z][a-z0-9-]{0,99}$/.test(error?.message ?? '') ? error.message : 'assistant-response-unavailable';
const rejected = error => ['request_reused', 'epoch_changed', 'draft_removed', 'conversation_removed', 'conversation_removing',
  'revision_conflict', 'session_expired', 'draft_changed', 'conversation_changed'].includes(error?.code);

export function assistantAcceptanceInput({ descriptor, prior }) {
  need(['frontend', 'full'].includes(prior.route?.route), 'assistant-verified-route-required');
  let health;
  if (prior.route.route === 'frontend') {
    const installed = prior.installation;
    need(installed?.state === 'completed' && installed.journal?.phase === 'completed' && installed.journal.outcome === 'selected'
      && installed.operationId === descriptor.operation.id && installed.journal.frontendId === prior.publication?.frontendId,
    'assistant-completed-frontend-installation-required');
    need(hash(prior.sign?.frontendId) && installed.journal.frontendId === prior.sign.frontendId, 'assistant-selected-frontend-identity-changed');
    // Maintained journal.health is the pre-promotion health. Preserve its exact
    // backend identity and derive only the signed selected frontend projection.
    health = { ...installed.journal.health, frontend: { id: prior.sign.frontendId, version: descriptor.operation.version,
      buildVersion: descriptor.operation.buildVersion, source: 'frontend' } };
    need(health?.candidateId === descriptor.operation.priorCandidateId && health.serviceInputsSha256 === prior.route.serviceInputsSha256,
      'assistant-installed-service-identity-changed');
  } else {
    // The existing coordinator completion alone has no dynamic health/runtime
    // binding. It cannot be promoted to an acceptance identity by this module.
    const proof = prior.installation?.acceptanceIdentity;
    need(prior.installation?.controllerCompleted === true && proof?.kind === 'maintained-installed-acceptance-identity'
      && proof.operationId === descriptor.operation.id && proof.candidateId === prior.route.targetCandidateId,
    'assistant-full-installation-identity-producer-required');
    health = proof.health;
  }
  need(hash(health?.candidateId) && uuid(health?.epoch) && uuid(health?.processIdentity), 'assistant-installed-health-required');
  return { format: 1, route: prior.route.route, operationId: descriptor.operation.id,
    installedHealth: health, installationSha256: digest(prior.installation), budgetMs: 300000,
    browserUiVerified: false };
}

export const oldUnknowns = state => Object.fromEntries(state.operations.filter(op => op.state === 'unknown').map(op => [op.id, digest(op)]));
export function unchangedUnknowns(state, expected) {
  const byId = new Map(state.operations.map(op => [op.id, op]));
  need(Object.entries(expected).every(([id, value]) => byId.has(id) && digest(byId.get(id)) === value), 'assistant-old-unknown-operation-changed');
}

/** These predicates preserve the historical ready/old_unknowns boundary. The
 * fixed transport must independently produce actual installation, process and
 * runtime proofs; booleans supplied by a configuration file are not evidence. */
export function verifyAssistantReady(value, input, retained = null, { initial = false, full = false } = {}) {
  need(value && isDeepStrictEqual(value.health, input.installedHealth), 'assistant-exact-health-changed');
  const epoch = input.installedHealth.epoch, candidate = input.installedHealth.candidateId;
  need(value.access?.workspaceEpoch === epoch && value.access.recovery === false && value.access.recoveryLocal === false,
    'assistant-workspace-or-recovery-changed');
  need(value.acceptance?.candidateId === candidate && value.acceptance.epoch === epoch && value.acceptance.heldFor === null
    && value.acceptance.maintenanceHeld === false && value.acceptance.nativeSuspended === false, 'assistant-native-hold-not-released');
  need(value.service?.id === 'openclaw' && value.service.state === 'ready' && typeof value.service.version === 'string', 'assistant-native-not-ready');
  const connection = value.state?.connection;
  need(Array.isArray(value.state?.operations) && Array.isArray(value.state?.conversations) && connection?.state === 'ready'
    && connection.modelAuthReady === true && ['operator.read', 'operator.write'].every(scope => connection.grantedScopes?.includes(scope))
    && uuid(connection.generation), 'assistant-native-model-auth-not-ready');
  need(value.appProcess?.ActiveState === 'active' && value.appProcess.SubState === 'running'
    && Number(value.appProcess.MainPID) > 1 && typeof value.appProcess.ExecMainStartTimestampMonotonic === 'string'
    && hash(value.runtimeProof?.configurationSha256) && value.runtimeProof.openclawVersion === value.service.version
    && Object.keys(value.runtimeProof.files ?? {}).length >= 2 && value.installationProof?.installationSha256 === input.installationSha256,
  'assistant-actual-process-runtime-proof-required');
  for (const file of Object.values(value.runtimeProof.files)) need(hash(file.sha256) && Number.isSafeInteger(file.bytes)
    && file.bytes > 0 && Number.isSafeInteger(file.inode) && file.inode > 0, 'assistant-runtime-file-proof-invalid');
  if (full) need(value.fullRuntimeVerified === true, 'assistant-full-runtime-verification-required');
  if (retained) {
    need(isDeepStrictEqual(value.appProcess, retained.appProcess) && isDeepStrictEqual(value.runtimeProof, retained.runtimeProof)
      && isDeepStrictEqual(value.installationProof, retained.installationProof) && connection.generation === retained.connectionGeneration,
    'assistant-process-runtime-or-native-identity-changed');
    unchangedUnknowns(value.state, retained.oldUnknownHashes);
  }
  if (initial) need(!value.state.operations.some(op => active.has(op.state)), 'assistant-existing-active-work-must-settle');
  return { appProcess: value.appProcess, runtimeProof: value.runtimeProof, installationProof: value.installationProof,
    connectionGeneration: connection.generation, oldUnknownHashes: retained?.oldUnknownHashes ?? oldUnknowns(value.state) };
}

function verifyConversation(value, session) {
  need(uuid(value?.id) && uuid(value.nativeId) && Number.isSafeInteger(value.revision) && value.revision > 0
    && value.state === 'ready' && value.permissionMode === 'read-only' && value.projectId === null && !value.pendingSettings
    && value.connectionGeneration === session.readiness.connectionGeneration && !value.archived && !value.deleted,
  'assistant-original-conversation-unsettled-or-changed');
  return value;
}
function verifyDraft(value, body, session) {
  need(body.kind === 'draft' && value?.id === body.entityId && value.deviceId === session.deviceId
    && value.revision === body.expectedRevision + 1 && isDeepStrictEqual(value.value, body.payload), 'assistant-current-draft-changed');
}
function verifyOperation(value, body, session, conversation) {
  need(uuid(value?.id) && value.requestId === body.requestId && value.deviceId === session.deviceId && value.epoch === body.epoch
    && value.conversationId === body.conversationId && value.conversationRevision === body.conversationRevision
    && value.nativeId === conversation.nativeId && value.connectionGeneration === session.readiness.connectionGeneration,
  'assistant-original-submit-identity-changed');
}

export function verifySavedAssistantReply({ ready, operation, history }, { input, session, conversation, submission, expectedReply, originalOperationId }) {
  verifyAssistantReady(ready, input, session.readiness, { full: true });
  verifyOperation(operation, submission, session, conversation);
  need(!originalOperationId || operation.id === originalOperationId, 'assistant-original-operation-replaced');
  const matches = ready.state.operations.filter(op => op.requestId === submission.requestId && op.conversationId === conversation.id);
  need(matches.length === 1 && isDeepStrictEqual(matches[0], operation), 'assistant-exact-operation-not-observed');
  need(operation.state === 'completed' && operation.nativeRunId && operation.text?.trim() === expectedReply
    && !operation.tools?.length, 'assistant-completed-reply-not-confirmed');
  need(history?.nativeId === conversation.nativeId && Array.isArray(history.messages)
    && !history.messages.some(item => item.role === 'tool') && Array.isArray(history.activeRunIds)
    && history.activeRunIds.length === 0 && !history.inFlightRun, 'assistant-saved-history-not-idle');
  const saved = history.messages.filter(item => item.role === 'assistant' && item.text?.trim() === expectedReply
    && (item.runId === operation.nativeRunId || item.operationId === operation.id));
  need(saved.length === 1 && typeof saved[0].id === 'string' && saved[0].id, 'assistant-exactly-one-saved-reply-required');
  return { conversationId: conversation.id, nativeId: conversation.nativeId, connectionGeneration: session.readiness.connectionGeneration,
    submitRequestId: submission.requestId, operationId: operation.id, nativeRunId: operation.nativeRunId, savedMessageId: saved[0].id,
    replySha256: sha256(expectedReply), savedReplyAccepted: true, browserUiVerified: false, oldUnknownsUnchanged: true };
}

/** Transport methods are fixed internal integration seams, never CLI callbacks:
 * validate / session / readReady / postExact / readDraft / observeSubmit.
 * It must keep session credentials in its protected host journal, and give only
 * a hash-bound opaque session reference to this journal. Default stays closed. */
export function createAssistantAcceptanceAdapter({ transport = null, storeReceipt, clock = Date.now } = {}) {
  const expected = context => assistantAcceptanceInput(context);
  const validate = context => need(isDeepStrictEqual(context.input, expected(context)), 'assistant-acceptance-input-changed');
  const parent = context => {
    need(isDeepStrictEqual(context.journal.loadDelivery(context.descriptor.operation.id).descriptor, context.descriptor), 'assistant-descriptor-changed');
    const p = context.journal.deliveryPhase(context.descriptor.operation.id, 'assistant');
    need(p && p.key === context.intent.key && p.inputSha256 === context.intent.inputSha256
      && isDeepStrictEqual(p.input, expected(context)), 'assistant-parent-intent-changed');
    need(Number.isSafeInteger(p.createdAtMs), 'assistant-original-clock-required'); return p;
  };
  const deadline = context => parent(context).createdAtMs + 300000;
  const within = context => need(clock() >= parent(context).createdAtMs && clock() < deadline(context), 'assistant-original-deadline-exhausted');
  const record = (context, row, state, reason, output = null) => {
    const receipt = output ? storeReceipt(context.journal, row.key, `assistant-${sha256(canonical(output))}.json`, Buffer.from(canonical(output) + '\n')) : null;
    return context.journal.recordDeliveryObservation(context.descriptor.operation.id, row.phase,
      { key: row.key, state, reason, output, receipt, externalId: row.key }, clock()).current;
  };
  const reserve = (context, name, payload, prior) => {
    const input = { parentKey: context.intent.key, parentInputSha256: context.intent.inputSha256,
      deadlineAtMs: deadline(context), priorResultsSha256: digest(prior), payload };
    return context.journal.reserveDeliveryPhase(context.descriptor.operation.id, `assistant/${name}`, input, clock());
  };
  const retained = (context, name, prior) => {
    const row = context.journal.deliveryPhase(context.descriptor.operation.id, `assistant/${name}`);
    if (!row) return null;
    need(row.input.parentKey === context.intent.key && row.input.parentInputSha256 === context.intent.inputSha256
      && row.input.deadlineAtMs === deadline(context) && row.input.priorResultsSha256 === digest(prior), 'assistant-original-child-input-changed');
    if (row.current?.receipt) need(isDeepStrictEqual(JSON.parse(readEvidenceFile(row.current.receipt)), row.current.output), 'assistant-child-receipt-changed');
    return row;
  };
  const run = async (context, inspectOnly = false) => {
    parent(context);
    if (!transport) return result('gap', 'assistant-fixed-host-transport-not-integrated', context);
    need(['validate', 'session', 'readReady', 'postExact', 'readDraft', 'observeSubmit'].every(key => typeof transport[key] === 'function'), 'assistant-host-capability-incomplete');
    await transport.validate({ ...context, input: context.intent.input });
    const input = context.intent.input, prior = {}, expectedReply = `Nova verification ${context.intent.key} passed.`;
    const callContext = { operationId: context.descriptor.operation.id, parentKey: context.intent.key, inputSha256: context.intent.inputSha256,
      input, deadlineAtMs: deadline(context) };
    const effect = async (admit = async () => {}) => { within(context); need(typeof context.beforeNewEffect === 'function', 'assistant-fresh-effect-gate-required');
      await context.beforeNewEffect(); parent(context); within(context); await transport.validate({ ...context, input: context.intent.input }); await admit(); within(context); };
    for (const name of names) {
      let row = retained(context, name, prior);
      let newlyReserved = false;
      if (row?.state === 'failed') return result('failed', row.current.reason, context);
      if (row?.state === 'completed') { prior[name] = row.current.output; continue; }
      if (inspectOnly) return result('uncertain', 'assistant-original-substep-incomplete', context);
      within(context);
      if (name === 'session') {
        if (!row) { await effect(); const reservation = reserve(context, name, { originalBudgetMs: 300000 }, prior); row = reservation.intent; newlyReserved = reservation.newlyReserved; }
        try {
          // A missing response to session setup is status-only; the transport
          // may not replace an unavailable original authenticated device.
          const output = await transport.session({ ...callContext, childKey: row.key, observeOnly: !newlyReserved });
          within(context);
          need(output && uuid(output.deviceId) && hash(output.sessionSha256) && output.sessionReference?.sha256 === output.sessionSha256,
            'assistant-original-session-unavailable');
          const readiness = verifyAssistantReady(output.ready, input, null, { initial: true, full: true });
          record(context, row, 'completed', 'assistant-original-session-bound', { deviceId: output.deviceId,
            sessionSha256: output.sessionSha256, sessionReference: output.sessionReference, readiness });
        } catch (error) { record(context, row, 'uncertain', safeReason(error)); return result('uncertain', safeReason(error), context); }
      } else {
        const session = prior.session, conversation = prior.create?.conversation;
        const fresh = await transport.readReady({ ...callContext, session });
        verifyAssistantReady(fresh, input, session.readiness);
        if (conversation) {
          const current = fresh.state.conversations.find(item => item.id === conversation.id);
          verifyConversation(current, session);
          need(current.nativeId === conversation.nativeId && (name === 'saved-reply' || name === 'submit' && !newlyReserved
            || current.revision === conversation.revision), 'assistant-current-conversation-changed');
        }
        const title = 'Nova deployment verification';
        let endpoint, fields;
        if (name === 'create') { endpoint = '/api/assistant/conversations'; fields = { space: 'chat', autoTitle: false, title, projectId: null, permissionMode: 'read-only' }; }
        if (name === 'draft') { endpoint = '/api/commands'; fields = { kind: 'draft', entityId: `draft:${session.deviceId}:${conversation.id}`, expectedRevision: 0,
          payload: { space: 'chat', workMode: 'chat', title, text: `Connection verification only. Reply exactly: ${expectedReply} Do not use tools or perform any other action.`, projectId: null, conversationId: conversation.id, attachments: [] } }; }
        if (name === 'submit') { endpoint = '/api/assistant/submit'; fields = { conversationId: conversation.id, conversationRevision: conversation.revision,
          draftId: prior.draft.draft.id, draftRevision: prior.draft.draft.revision, projectRevision: 0 }; }
        if (!row) { const reservation = reserve(context, name, { endpoint: endpoint ?? null, fields: fields ?? null, sessionSha256: session.sessionSha256 }, prior);
          row = reservation.intent; newlyReserved = reservation.newlyReserved; }
        need(row.input.payload.sessionSha256 === session.sessionSha256 && row.input.payload.endpoint === (endpoint ?? null)
          && isDeepStrictEqual(row.input.payload.fields, fields ?? null), 'assistant-original-request-changed');
        const body = endpoint ? { requestId: row.key, epoch: input.installedHealth.epoch, ...fields } : null;
        const request = endpoint ? { endpoint, bodyBytes: canonical(body), bodySha256: digest(body), requestId: row.key,
          deviceId: session.deviceId, sessionSha256: session.sessionSha256, epoch: body.epoch } : null;
        try {
          if (name === 'saved-reply' || name === 'submit' && !newlyReserved) {
            const submission = name === 'submit' ? body : prior.submit.requestBody;
            const observed = await transport.observeSubmit({ ...callContext, session, conversation, submission });
            within(context);
            if (!observed?.operation) { record(context, row, 'uncertain', 'assistant-original-submit-not-observed'); return result('uncertain', 'assistant-original-submit-not-observed', context); }
            verifyOperation(observed.operation, submission, session, conversation);
            if (name === 'submit') record(context, row, 'completed', 'assistant-original-submit-observed', { requestBody: body, operationId: observed.operation.id });
            else {
              const accepted = verifySavedAssistantReply(observed, { input, session, conversation, submission, expectedReply, originalOperationId: prior.submit.operationId });
              record(context, row, 'completed', 'assistant-saved-reply-verified', { ...accepted, evidence: observed });
            }
          } else {
            if (name === 'submit') {
              const draft = await transport.readDraft({ ...callContext, session, draftId: prior.draft.draft.id });
              verifyDraft(draft, prior.draft.requestBody, session);
              need(!fresh.state.operations.some(op => op.conversationId === conversation.id), 'assistant-fresh-conversation-already-has-operation');
            }
            await effect(async () => {
              const latest = await transport.readReady({ ...callContext, session });
              verifyAssistantReady(latest, input, session.readiness);
              if (conversation) {
                const current = latest.state.conversations.find(item => item.id === conversation.id);
                verifyConversation(current, session);
                need(current.nativeId === conversation.nativeId && current.revision === conversation.revision, 'assistant-current-conversation-changed');
              }
              if (name === 'submit') {
                verifyDraft(await transport.readDraft({ ...callContext, session, draftId: prior.draft.draft.id }), prior.draft.requestBody, session);
                need(!latest.state.operations.some(op => op.conversationId === conversation.id), 'assistant-fresh-conversation-already-has-operation');
              }
            });
            // The transaction winner alone dispatches submit. Any existing
            // reservation, including a lost pre-dispatch response, observes.
            record(context, row, 'running', name === 'submit' ? 'assistant-submit-dispatched-once' : 'assistant-idempotent-effect-continuation', { request });
            const output = await transport.postExact({ ...callContext, session, conversation, request,
              effectCapableContinuation: name !== 'submit' && !newlyReserved });
            within(context);
            if (name === 'create') { verifyConversation(output, session); record(context, row, 'completed', 'assistant-original-conversation-bound', { conversation: output }); }
            if (name === 'draft') { verifyDraft(output, body, session); record(context, row, 'completed', 'assistant-original-draft-receipt-bound', { draft: output, requestBody: body }); }
            if (name === 'submit') { verifyOperation(output, body, session, conversation); record(context, row, 'completed', 'assistant-original-submit-bound', { requestBody: body, operationId: output.id }); }
          }
        } catch (error) {
          const state = rejected(error) ? 'failed' : 'uncertain';
          const reason = rejected(error) ? 'assistant-original-request-rejected' : safeReason(error);
          record(context, row, state, reason); return result(state, reason, context);
        }
      }
      row = retained(context, name, prior); prior[name] = row.current.output;
    }
    const accepted = prior['saved-reply'];
    const proof = verifySavedAssistantReply(accepted.evidence, { input, session: prior.session, conversation: prior.create.conversation,
      submission: prior.submit.requestBody, expectedReply, originalOperationId: prior.submit.operationId });
    const output = { format: 1, kind: 'nova-delivery-saved-assistant-reply', operationId: context.descriptor.operation.id,
      key: context.intent.key, inputSha256: context.intent.inputSha256, originalDeadlineAtMs: deadline(context), ...proof };
    const receipt = storeReceipt(context.journal, context.intent.key, 'assistant-acceptance.json', Buffer.from(canonical(output) + '\n'));
    return result('completed', 'assistant-saved-reply-accepted', context, output, receipt);
  };
  return { input: async context => expected(context), validate, execute: context => run(context), observe: context => run(context),
    inspect: context => run(context, true), verify: async (value, context) => {
      if (value.externalId) need(value.externalId === context.descriptor.operation.id, 'assistant-parent-identity-changed');
      if (value.state === 'completed') need(isDeepStrictEqual(value.output, (await run(context, true)).output)
        && isDeepStrictEqual(JSON.parse(readEvidenceFile(value.receipt)), value.output), 'assistant-acceptance-result-changed');
    } };
}
