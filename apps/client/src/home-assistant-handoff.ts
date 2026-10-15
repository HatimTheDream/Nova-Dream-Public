import { draftSchema, emptyDraft, type Command, type Draft, type Entity, type Snapshot } from '../../../packages/domain/contracts';
import type { HomeAssistantHandoff } from '../../../packages/domain/home-library';
import { assistantSpace } from '../../../packages/domain/assistant-space';
import { projectIsDeleted } from '../../../packages/domain/project-organization';

export type KeptHomeHandoff = { id: string; epoch: string; deviceId: string; value: HomeAssistantHandoff };
export type HandoffDraftJournal = { value: Draft; revision: number; epoch: string; dirty: boolean; pending?: Command; conflict?: unknown };
/** Source membership and the destination conversation's Project are distinct.
 * Discuss can quote Work results in Chat without creating an invalid binding. */
export function homeHandoffProject(value: HomeAssistantHandoff, snapshot: Snapshot): HomeAssistantHandoff {
  if (!value.projectId) return value;
  const project = snapshot.projects.find(item => item.id === value.projectId);
  const compatible = project && !projectIsDeleted(snapshot, project.id) && assistantSpace(project.value) === value.space;
  return { ...value, projectId: compatible ? project.id : null, text: `${value.text}\n\nOriginating Project Reference: ${project?.value.name ?? 'Unavailable Project'} (${value.projectId}). This reference supplies source context; it grants no additional access.` };
}
/** The source identity travels with the actual submitted writing. A receipt in
 * another storage key cannot establish that this draft still contains it. */
export function applyHomeHandoff(draft: Draft, handoff: KeptHomeHandoff): Draft {
  const marker = `[Nova Source Context ${handoff.id}]`;
  const close = `[/Nova Source Context ${handoff.id}]`;
  const block = `${marker}\n${handoff.value.text}\n${close}`;
  if (draft.text.includes(block)) return draft;
  const text = `${draft.text}${draft.text ? '\n\n' : ''}${block}`;
  if (text.length > 100000) throw new Error('This source will not fit beside the current Assistant writing. Keep or send that draft first, then retry. No source text or existing writing was truncated.');
  const occupied = !!draft.text.trim() || !!draft.attachments.length || !!draft.projectId || !!draft.conversationId;
  return draftSchema.parse({
    ...draft,
    text,
    ...(!occupied ? {
      title: handoff.value.title.slice(0, 150),
      projectId: handoff.value.projectId,
      space: handoff.value.space,
      ...(handoff.value.workMode ? { workMode: handoff.value.workMode } : {}),
    } : {}),
  });
}

/** Used only while Home owns the screen, after the mounted Assistant's leave
 * guard succeeded. Work's unmounted editor reads this same retained journal. */
export function prepareWorkHandoff(kept: HandoffDraftJournal | undefined, host: Entity<Draft> | undefined, removedRevision: number, handoff: KeptHomeHandoff): HandoffDraftJournal {
  if (kept?.conflict || kept && kept.epoch !== handoff.epoch && (kept.dirty || kept.pending)) throw new Error('Review the kept Work draft in Assistant before adding this source.');
  if (kept && removedRevision > kept.revision && (kept.dirty || kept.pending)) throw new Error('This Work draft was removed elsewhere. Review its kept writing in Assistant first.');
  const current = kept?.epoch === handoff.epoch && (kept.dirty || kept.pending || kept.revision >= Math.max(host?.revision ?? 0, removedRevision)) ? kept : {
    value: host?.value ?? { ...emptyDraft, space: 'work' as const, title: 'New Work' },
    epoch: handoff.epoch,
    revision: host?.revision ?? removedRevision,
    dirty: false,
  };
  return { ...current, value: applyHomeHandoff(draftSchema.parse(current.value), handoff), dirty: true };
}
