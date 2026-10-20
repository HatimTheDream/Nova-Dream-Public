import { captureDirectAgentBinding, directAgentNativeKey } from '../../packages/domain/direct-agent.js';
import { assistantSpace } from '../../packages/domain/assistant-space.js';
import type { Conversation, createConversationSchema } from '../../packages/domain/assistant.js';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Fault, type Store } from './store.js';

/** There is deliberately no config switch or caller-supplied proof that opens
 * this gate. A dedicated native route requires separate runtime qualification. */
export function assertOrdinaryAssistant(conversation: Pick<Conversation, 'directAgent'> | undefined) {
  if (conversation?.directAgent) throw new Fault(409, 'direct_agent_runtime_unqualified', 'This agent chat is kept. Its dedicated connection must be qualified before sending or changing native settings.');
}

export function createDirectAgentConversation(store: Store, device: string, input: z.infer<typeof createConversationSchema>, teamId?: string): Conversation {
  store.assertUpdateAdmission();
  if (store.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Review the recovered workspace before creating an agent conversation.');
  if (!input.recipient) throw new Fault(400, 'direct_agent_required', 'Choose the exact saved agent.');
  if (assistantSpace(input) !== 'chat' || input.permissionMode && input.permissionMode !== 'read-only' || input.refineSource || teamId)
    throw new Fault(409, 'direct_agent_scope', 'Direct agent conversations use read-only Chat and their original recipient.');
  const admitted = store.admit(device, input, { type: 'conversation.create', ...input }, () => {
    const project = input.projectId ? store.readEntity('project', input.projectId) : undefined;
    if (input.projectId && (!project || store.projectIsDeleted(input.projectId) || assistantSpace(project.value) !== 'chat' || project.value.workspace))
      throw new Fault(409, 'direct_agent_project', 'Choose an available Chat Project.');
    let binding;
    try { binding = captureDirectAgentBinding(input.recipient!, store.readEntity('agent', input.recipient!.agentId), { requestId: input.requestId, deviceId: device, epoch: input.epoch }); }
    catch { throw new Fault(409, 'direct_agent_changed', 'The selected agent changed or is unavailable. Reopen its exact saved version.'); }
    const id = randomUUID(), at = new Date().toISOString();
    const conversation: Conversation = {
      id, revision: 1, space: 'chat', title: input.title, projectId: input.projectId, archived: false,
      directAgent: binding, permissionMode: 'read-only', model: input.model ?? null, thinking: input.thinking ?? null,
      fastMode: input.fastMode ?? null, createdAt: at, updatedAt: at, connectionGeneration: '',
      nativeKey: directAgentNativeKey(id), nativeId: null, state: 'ready',
    };
    return store.internalWrite(`assistant:conversation:${id}`, conversation);
  });
  const original = store.internalRead<Conversation>(`assistant:conversation:${admitted.value.id}`);
  if (!original?.directAgent) throw new Fault(409, 'direct_agent_missing', 'The original agent conversation is unavailable.');
  return original;
}
