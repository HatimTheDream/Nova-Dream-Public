import type { Command, Entity } from '../../../packages/domain/contracts';
import type { Assignment } from '../../../packages/domain/workspace-records';
import type { AssignmentAttempt, AssignmentStart, AssignmentState } from '../../../packages/domain/assignments';
import { libraryAssignmentId, type LibraryWorkDraft } from './library-work-draft';

type LaunchIO = {
  keep: (next: LibraryWorkDraft) => LibraryWorkDraft;
  commit: (command: Command) => Promise<Entity<Assignment>>;
  start: (command: AssignmentStart) => Promise<AssignmentAttempt>;
  read: (assignmentId: string, before?: string) => Promise<AssignmentState>;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(k => Object.hasOwn(right, k) && sameValue(left[k], right[k]));
}

export async function resumeLibraryWork(draft: LibraryWorkDraft, epoch: string, io: LaunchIO): Promise<LibraryWorkDraft> {
  const pending = draft.pending, assignmentId = libraryAssignmentId(draft.id);
  if (draft.attemptId) return draft;
  if (!pending || !draft.agentId) throw Error('The original start request could not be read.');
  const matches = (attempt: AssignmentAttempt) => attempt.epoch === epoch && attempt.assignmentId === assignmentId
    && attempt.assignmentRevision === draft.planRevision && attempt.connected?.role === 'result'
    && attempt.connected.number === 1 && attempt.connected.rootAttemptId === attempt.id;
  const finish = (attempt: AssignmentAttempt) => {
    if (!matches(attempt)) throw Error('The returned work does not match this original assignment.');
    return io.keep({...draft, pending: undefined, attemptId: attempt.id});
  };
  if (pending.stage === 'check-start') {
    const seen = new Set<string>();
    let before: string | undefined;
    do {
      const page = await io.read(assignmentId, before);
      const first = page.attempts.find(matches);
      if (first) return finish(first);
      before = page.nextCursor ?? undefined;
      if (before && seen.has(before)) throw Error('The original work history could not be confirmed.');
      if (before) seen.add(before);
    } while (before);
  }
  if (pending.stage === 'save-plan') {
    const payload: Assignment = {
      title: draft.title.trim(), brief: draft.brief, expectedOutput: 'Reviewed Content Draft',
      agentId: draft.agentId, agentRevision: pending.agentRevision, projectId: draft.projectId, due: '',
      state: 'planned', archived: false, executionMode: 'proposal', workSources: draft.sources, workOrigin: draft.origin,
    };
    const saved = await io.commit({kind: 'assignment', entityId: assignmentId, expectedRevision: draft.planRevision,
      requestId: pending.planRequestId, epoch, payload});
    if (saved.id !== assignmentId || saved.revision !== draft.planRevision + 1 || !sameValue(payload, saved.value))
      throw Error('The saved plan does not match this preparation. Check its original request.');
    draft = io.keep({...draft, planRevision: saved.revision, pending: {...pending, stage: 'start'}});
  }
  draft = io.keep({...draft, pending: {...pending, stage: 'check-start'}});
  const attempt = await io.start({requestId: pending.startRequestId, epoch, assignmentId, revision: draft.planRevision, projectRevision: pending.projectRevision});
  return finish(attempt);
}
