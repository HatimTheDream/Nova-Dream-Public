/** Bridge to the maintained coordinator. Its reservation remains the only
 * authority to dispatch one installation request; this module has no installer. */
import { normalizeCoordinatorDescriptor, resumeRelease } from './release-coordinate.mjs';
import { describeInstallAdapter } from './release-adapters.mjs';
import { validateOperationContinuation } from './release-plan.mjs';
export { buildFullCoordinatorDescriptor } from './release-delivery-full-coordinator.mjs';
const need = (v, code) => { if (!v) throw Error(code); };
const uncertain = reason => ({ state: 'uncertain', reason, externalId: null, receipt: null, output: null });

export function createCoordinatorInstallationAdapter({ describe = describeInstallAdapter, resume = resumeRelease, clock = Date.now, identityObserver = null, admission = null } = {}) {
  const acceptedIdentity = async (value, context) => value.state === 'completed' && identityObserver
    ? identityObserver.observe(context, value) : value;
  const check = (descriptor, input) => {
    const frozen = normalizeCoordinatorDescriptor(input.coordinatorDescriptor);
    validateOperationContinuation(frozen.input.operation, descriptor.operation);
    need(frozen.input.operation.id === descriptor.operation.id, 'install-delivery-operation-changed');
    // The existing coordinator alone qualifies fresh prerequisites for the
    // first reservation. Expired admission receipts cannot block observation
    // of an already dispatched job or trigger a repeated rehearsal.
    return frozen;
  };
  const observe = async context => {
    // A delivery reservation preceding coordinator reservation proves no outcome.
    // Absence stays uncertain; it never becomes permission for an install POST.
    const old = context.journal.intent(context.descriptor.operation.id);
    if (!old) return uncertain('original-install-reservation-not-recorded');
    const status = await resume(context.journal.directory, context.descriptor.operation.id);
    const intent = status.intent; need(intent && intent.idempotencyKey === old.idempotencyKey, 'original-install-key-changed');
    return acceptedIdentity({ state: intent.state === 'reserved' ? 'uncertain' : intent.state, externalId: intent.externalJobId,
      receipt: intent.lastObservation?.observation ?? null, reason: intent.state === 'completed' ? 'controller-completed-acceptance-required' : 'original-controller-operation-observed',
      output: intent.state === 'completed' ? { coordinatorOperationId: status.operationId, idempotencyKey: intent.idempotencyKey,
        jobId: intent.externalJobId, controllerCompleted: true, savedReplyAccepted: false, browserAccepted: false } : null }, context);
  };
  return {
    input: async ({ descriptor, prior }) => {
      need(prior.route?.route === 'full', 'frontend-install-uses-frontend-controller');
      need(prior.publication?.coordinatorDescriptor, 'publication-coordinator-input-missing');
      return { coordinatorDescriptor: prior.publication.coordinatorDescriptor };
    },
    validate: async context => { check(context.descriptor, context.input); if (admission && context.input.admission) await admission.validate(context); },
    ...(admission ? { admit: context => admission.prepare(context) } : {}),
    execute: async context => {
      const frozen = check(context.descriptor, context.intent.input);
      if(admission){
        const ready=await admission.apply({...context,input:context.intent.input});
        if(ready.observeOnly)return observe(context);
      }else{
        const description = await describe({ ...frozen.adapter, operation: frozen.input.operation, input: frozen.input });
        context.journal.attachDeliveryCoordinator(context.descriptor.operation.id, frozen, description, clock());
      }
      const status = await resume(context.journal.directory, context.descriptor.operation.id);
      const original = status.intent;
      need(original, 'coordinator-intent-unavailable');
      return acceptedIdentity({ state: original.state === 'reserved' ? 'uncertain' : original.state, externalId: original.externalJobId,
        reason: original.state === 'completed' ? 'controller-completed-acceptance-required' : 'original-controller-operation-observed', receipt: original.lastObservation?.observation ?? null,
        output: original.state === 'completed' ? { coordinatorOperationId: status.operationId, idempotencyKey: original.idempotencyKey, jobId: original.externalJobId,
          controllerCompleted: true, savedReplyAccepted: false, browserAccepted: false } : null }, context);
    }, observe,
    verify: async (value, context) => {
      const original = context.journal.intent(context.descriptor.operation.id);
      if (value.state === 'completed') need(original?.state === 'completed' && value.externalId === original.externalJobId
        && value.output?.idempotencyKey === original.idempotencyKey && value.output?.coordinatorOperationId === context.descriptor.operation.id
        && value.output?.savedReplyAccepted === false && value.output?.browserAccepted === false, 'controller-result-does-not-match-original-install');
      if (identityObserver) await identityObserver.verify(value, context);
    },
  };
}
