import type { Command, Entity } from '../../../packages/domain/contracts';
import { routineSchema, type Routine } from '../../../packages/domain/tasks';

/** Keep the existing routine journal and its original command separate from task drafts. */
export type RoutineEditorDraft = {
  value: Routine; revision: number; epoch: string; pending?: Command;
  confirmation?: { command: Command; routine: Entity<Routine> };
};
export const routineDraftKey = (deviceId: string, routineId: string) => `e3:routine-editor:${deviceId}:${routineId}`;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function matchingRoutineCommand(draft: RoutineEditorDraft, command: Command, id: string) {
  return command.kind === 'routine' && command.entityId === id && command.epoch === draft.epoch
    && command.expectedRevision === draft.revision && typeof command.requestId === 'string' && !!command.requestId;
}

export function routineConfirmation(command: Command, confirmed: Entity<Routine>) {
  const payload = routineSchema.safeParse(command.payload), value = routineSchema.safeParse(confirmed?.value);
  return command.kind === 'routine' && command.entityId === confirmed?.id
    && confirmed.revision === command.expectedRevision + 1 && payload.success && value.success
    && same(payload.data, value.data);
}

/** Adopt only this command's genuine result; merge writing made after its captured payload. */
export function confirmedRoutineDraft(stored: RoutineEditorDraft | undefined, command: Command, confirmed: Entity<Routine>) {
  if (!stored?.pending || !same(stored.pending, command) || !matchingRoutineCommand(stored, command, confirmed.id)
    || !routineConfirmation(command, confirmed)) return undefined;
  const captured = command.payload as Routine, value = { ...confirmed.value };
  for (const key of new Set([...Object.keys(captured), ...Object.keys(stored.value)])) {
    const field = key as keyof Routine;
    if (!same(stored.value[field], captured[field])) {
      if (Object.hasOwn(stored.value, field)) Object.assign(value, { [field]: stored.value[field] });
      else delete value[field];
    }
  }
  const draft: RoutineEditorDraft = { ...stored, value, revision: confirmed.revision, pending: undefined, confirmation: { command, routine: confirmed } };
  return { draft, confirmed, clean: same(value, confirmed.value) };
}

/** A retained response also protects writing whose most recent local write failed. */
export function routineResponseDraft(current: RoutineEditorDraft, retained: RoutineEditorDraft | undefined, command: Command, confirmed: Entity<Routine>) {
  const local = confirmedRoutineDraft(current, command, confirmed);
  if (!local) return undefined;
  let kept = retained ? confirmedRoutineDraft(retained, command, confirmed) : local;
  if (!kept && retained && !retained.pending && retained.epoch === current.epoch && retained.revision === confirmed.revision
    && same(retained.confirmation?.command, command) && same(retained.confirmation?.routine, confirmed)) {
    kept = { draft: retained, confirmed, clean: same(retained.value, confirmed.value) };
  }
  if (!kept) return undefined; // Another command or a later revision owns the journal.
  const captured = command.payload as Routine, value = { ...kept.draft.value };
  for (const key of new Set([...Object.keys(captured), ...Object.keys(current.value)])) {
    const field = key as keyof Routine;
    if (same(current.value[field], captured[field])) continue;
    if (!same(kept.draft.value[field], confirmed.value[field]) && !same(kept.draft.value[field], current.value[field])) return undefined;
    if (Object.hasOwn(current.value, field)) Object.assign(value, { [field]: current.value[field] });
    else delete value[field];
  }
  return { draft: { ...kept.draft, value }, confirmed, clean: same(value, confirmed.value) };
}

/** A known response is sufficient even when snapshot refresh failed or moved ahead. */
export function reopenedRoutineConfirmation(current: RoutineEditorDraft, retained: RoutineEditorDraft | undefined) {
  const command = current.pending, confirmation = retained?.confirmation;
  if (!command || !confirmation || !same(command, confirmation.command) || retained.pending
    || retained.epoch !== current.epoch || retained.revision !== confirmation.routine.revision) return undefined;
  return routineResponseDraft(current, retained, command, confirmation.routine);
}

export function routineDraftProblem(draft: RoutineEditorDraft, id: string, epoch: string, host?: Entity<Routine>, existing = true) {
  if (draft.epoch !== epoch) return 'This draft belongs to an earlier workspace. Its original writing and save are kept for review.';
  if (draft.pending && !matchingRoutineCommand(draft, draft.pending, id)) return 'The kept save does not match this series. Its original request is preserved for review.';
  if (existing && (!host || host.id !== id)) return 'This saved series is unavailable. Its draft is kept; an occurrence cannot recreate it.';
  if (!draft.pending && host && host.revision > draft.revision) return 'A newer saved schedule is available. Review it before saving your kept proposal.';
  return '';
}

/** A definite rejection may unlock only its exact pending command, never another writer's save. */
export function rejectedRoutineDraft(current: RoutineEditorDraft, retained: RoutineEditorDraft | undefined, command: Command) {
  if (!current.pending || !retained?.pending || !same(current.pending, command) || !same(retained.pending, command)
    || !matchingRoutineCommand(current, command, command.entityId) || !matchingRoutineCommand(retained, command, command.entityId)) return undefined;
  const captured = command.payload as Routine, value = { ...retained.value };
  for (const key of new Set([...Object.keys(captured), ...Object.keys(current.value)])) {
    const field = key as keyof Routine;
    if (same(current.value[field], captured[field])) continue;
    if (!same(retained.value[field], captured[field]) && !same(retained.value[field], current.value[field])) return undefined;
    if (Object.hasOwn(current.value, field)) Object.assign(value, { [field]: current.value[field] });
    else delete value[field];
  }
  return { ...retained, value, pending: undefined };
}

export function reviewedRoutineDraft(current: RoutineEditorDraft, retained: RoutineEditorDraft | undefined, id: string, epoch: string, host: Entity<Routine>, rejected?: Command) {
  if (current.epoch !== epoch || host.id !== id || host.revision < current.revision) return undefined;
  const draft = current.pending ? rejected && rejectedRoutineDraft(current, retained, rejected)
    : retained && retained.epoch === epoch && !retained.pending && retained.revision === current.revision && same(retained.value, current.value) ? current : undefined;
  if (!draft) return undefined;
  return { ...draft, revision: host.revision, confirmation: undefined };
}
