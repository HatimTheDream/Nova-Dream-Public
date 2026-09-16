import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { recoveryResumeSchema, type RecoveryReview } from '../../packages/domain/workspace-backup.js';
import type { ConnectedAccount } from '../../packages/domain/accounts.js';
import type { AgentRoutine } from '../../packages/domain/agent-routines.js';
import type { QueuedMessage, Conversation, AssistantOperation } from '../../packages/domain/assistant.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import { Store, Fault } from './store.js';

type RecoveryState = { held: boolean; effectsPaused?: boolean; backupId: string; connectionsPreparedAt?: string; native: string; nativeHash?: string; nativeBytes?: number };
/** Enable new setup in a recovered copy. Retained credentials and effect records
 * are evidence, never authority to reconnect or replay a previous dispatch. */
export class WorkspaceRecovery {
  constructor(private store: Store) {}
  private inputs() {
    return {
      state: this.store.internalRead<RecoveryState>('recovery:state'),
      accounts: this.store.internalList<ConnectedAccount>('accounts:item:'),
      routines: this.store.listEntities('routine'),
      agentRoutines: this.store.internalList<AgentRoutine>('agent-routines:item:'),
      queue: this.store.internalList<QueuedMessage>('assistant:queue:'),
      conversations: this.store.internalList<Conversation>('assistant:conversation:'),
      operations: this.store.internalList<AssistantOperation>('assistant:operation:'),
      assignments: this.store.internalList<AssignmentAttempt>('assignments:summary:'),
    };
  }
  review(): RecoveryReview {
    const data = this.inputs(), state = data.state;
    const fingerprint = createHash('sha256').update(canonical({ epoch: this.store.epoch, ...data })).digest('hex');
    return { available: !!state && !this.store.recoveryHeld && this.store.recoveryEffectsPaused, completed: !!state?.connectionsPreparedAt, fingerprint,
      accounts: data.accounts.filter(a => a.state !== 'disconnected').length,
      taskRoutines: data.routines.filter(r => r.value.state === 'active').length,
      agentRoutines: data.agentRoutines.filter(r => r.value.enabled).length,
      queuedMessages: data.queue.filter(q => q.state === 'paused').length,
      savedConversations: data.conversations.filter(c => !c.deleted).length,
      unconfirmedRuns: data.operations.filter(o => !['completed', 'cancelled', 'failed'].includes(o.state)).length + data.assignments.filter(a => !['returned', 'failed', 'cancelled'].includes(a.state)).length };
  }
  resume(device: string, raw: unknown) {
    const input = recoveryResumeSchema.parse(raw);
    return this.store.admit(device, input, { type: 'recovery.connections', ...input }, () => {
      const review = this.review();
      if (!review.available) throw new Fault(409, 'recovery_not_active', 'Open the recovered workspace before setting up its connections.');
      if (review.fingerprint !== input.fingerprint) throw new Fault(409, 'recovery_review_changed', 'The recovered work changed. Refresh this review before continuing.');
      const data = this.inputs(), at = new Date().toISOString();
      for (const id of ['gateway:configuration', 'runtime:configuration']) {
        const value = this.store.internalRead(id);
        if (value !== undefined) this.store.internalWrite('recovery:prior:' + id, value);
        this.store.internalDelete(id);
      }
      for (const account of data.accounts) if (account.state !== 'disconnected') this.store.internalWrite('accounts:item:' + account.id, { ...account, revision: account.revision + 1, state: 'reconnect', message: 'Sign in again in this recovered workspace. Earlier work and operation records are kept.', updatedAt: at });
      this.store.pauseRecoveredRoutines(device);
      for (const routine of data.agentRoutines) if (routine.value.enabled) this.store.internalWrite('agent-routines:item:' + routine.id, { ...routine, revision: routine.revision + 1, value: { ...routine.value, enabled: false }, nextAt: null, attention: 'Review and enable this routine after reconnecting.', updatedAt: Date.now() });
      for (const item of data.queue) if (item.state === 'paused' && item.automatic) this.store.internalWrite('assistant:queue:' + item.id, { ...item, revision: item.revision + 1, automatic: false, autoError: 'Saved before recovery. Review this message before continuing.', updatedAt: at });
      // Unknown operations keep their original state, identity and receipts.
      this.store.internalWrite('phone:access', { enabled: false });
      this.store.internalWrite('recovery:state', { ...data.state, held: false, effectsPaused: false, connectionsPreparedAt: at });
      return { accepted: true, accountsNeedSignIn: review.accounts, routinesPaused: review.taskRoutines + review.agentRoutines };
    });
  }
}
