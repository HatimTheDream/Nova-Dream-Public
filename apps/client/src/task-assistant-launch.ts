import { z } from 'zod';
import { canonical, commandSchema, taskSchema, type Command, type Entity, type Task } from '../../../packages/domain/contracts';
import { assignmentStartSchema, type AssignmentAttempt, type AssignmentStart } from '../../../packages/domain/assignments';
import { assignmentSchema, type AgentDesign, type Assignment } from '../../../packages/domain/workspace-records';
import { planValueFromTask } from '../../../packages/domain/task-work';

export type TaskAssistantLaunchScope = { deviceId: string; epoch: string; taskId: string };
type PlanCommand = Command & { kind: 'assignment'; payload: Assignment };
type LinkCommand = Command & { kind: 'task'; payload: Task };
export type TaskAssistantLaunchJournal = {
  version: 1;
  scope: TaskAssistantLaunchScope;
  capturedTask: Entity<Task>;
  projectRevision: number | null;
  planCommand: PlanCommand;
  linkRequestId: string;
  startRequestId: string;
  plan?: Entity<Assignment>;
  linkCommand?: LinkCommand;
  linkRefusal?: 'revision_conflict';
  task?: Entity<Task>;
  startRequest?: AssignmentStart;
  attempt?: AssignmentAttempt;
};
export type TaskAssistantLaunchIO = {
  commit: <T>(command: Command) => Promise<Entity<T>>;
  start: (request: AssignmentStart) => Promise<AssignmentAttempt>;
  save: (journal: TaskAssistantLaunchJournal) => boolean;
};

const scopeSchema = z.object({ deviceId: z.string().min(1), epoch: z.string().uuid(), taskId: z.string().min(1) }).strict();
const entitySchema = <T extends z.ZodTypeAny>(value: T) => z.object({
  id: z.string().min(1), revision: z.number().int().positive(), updatedAt: z.string(), deviceId: z.string().min(1), value,
}).strict();
const journalSchema = z.object({
  version: z.literal(1), scope: scopeSchema, capturedTask: entitySchema(taskSchema),
  projectRevision: z.number().int().positive().nullable(),
  planCommand: commandSchema.extend({ kind: z.literal('assignment'), payload: assignmentSchema }),
  linkRequestId: z.string().uuid(), startRequestId: z.string().uuid(),
  plan: entitySchema(assignmentSchema).optional(),
  linkCommand: commandSchema.extend({ kind: z.literal('task'), payload: taskSchema }).optional(),
  linkRefusal: z.literal('revision_conflict').optional(),
  task: entitySchema(taskSchema).optional(), startRequest: assignmentStartSchema.optional(),
  // AssignmentAttempt has no runtime schema. Validate the identity and fields
  // consumed here while retaining its complete service response for the UI.
  attempt: z.object({
    id: z.string().uuid(), epoch: z.string().uuid(), deviceId: z.string(), assignmentId: z.string(),
    assignmentRevision: z.number().int().positive(), state: z.enum(['prepared', 'dispatching', 'running', 'stopping', 'returned', 'failed', 'cancelled', 'unknown']),
  }).passthrough().optional(),
}).strict();

export class TaskAssistantLaunchError extends Error {
  constructor(public code: 'task_launch_storage' | 'task_launch_scope' | 'task_launch_invalid', message: string) { super(message); }
}

function invalid(): never {
  throw new TaskAssistantLaunchError('task_launch_invalid', 'Request unverified. Keep it for recovery; further work is blocked.');
}
function linkedValue(journal: TaskAssistantLaunchJournal): Task {
  const origin = journal.capturedTask.value.origin;
  return { ...journal.capturedTask.value, origin: origin && origin.kind !== 'assignment' ? origin : {
    kind: 'assignment', id: journal.plan!.id, revision: journal.plan!.revision,
  } };
}

/** Read only: loading a journal never submits or resumes an operation. */
export function readTaskAssistantLaunch(value: unknown, scope: TaskAssistantLaunchScope): TaskAssistantLaunchJournal | undefined {
  if (value == null) return undefined;
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) return invalid();
  const journal = parsed.data as TaskAssistantLaunchJournal;
  if (canonical(journal.scope) !== canonical(scope)) {
    throw new TaskAssistantLaunchError('task_launch_scope', 'Wrong task, device or workspace. Reopen the original task.');
  }
  const { capturedTask, planCommand, plan, linkCommand, task, startRequest, attempt } = journal;
  if (capturedTask.id !== scope.taskId || capturedTask.value.trashed || planCommand.epoch !== scope.epoch ||
      planCommand.expectedRevision !== 0 || !planCommand.entityId.startsWith('assignment:') ||
      planCommand.payload.projectId !== (capturedTask.value.projectId ?? null) ||
      (planCommand.payload.projectId === null) !== (journal.projectRevision === null) ||
      new Set([planCommand.requestId, journal.linkRequestId, journal.startRequestId]).size !== 3) return invalid();
  if (plan && (plan.id !== planCommand.entityId || plan.revision !== 1 || canonical(plan.value) !== canonical(planCommand.payload))) return invalid();
  if (linkCommand && (!plan || linkCommand.requestId !== journal.linkRequestId || linkCommand.epoch !== scope.epoch ||
      linkCommand.entityId !== scope.taskId || linkCommand.expectedRevision !== capturedTask.revision ||
      canonical(linkCommand.payload) !== canonical(linkedValue(journal)))) return invalid();
  if (task && (!linkCommand || task.id !== scope.taskId || task.revision !== capturedTask.revision + 1 ||
      canonical(task.value.origin) !== canonical(linkCommand.payload.origin))) return invalid();
  if (journal.linkRefusal && (!linkCommand || task || startRequest || attempt)) return invalid();
  if (startRequest && (!plan || !task || startRequest.requestId !== journal.startRequestId || startRequest.epoch !== scope.epoch ||
      startRequest.assignmentId !== plan.id || startRequest.revision !== plan.revision || startRequest.projectRevision !== journal.projectRevision)) return invalid();
  if (attempt && (!startRequest || attempt.epoch !== scope.epoch || attempt.deviceId !== scope.deviceId ||
      attempt.assignmentId !== startRequest.assignmentId || attempt.assignmentRevision !== startRequest.revision)) return invalid();
  return structuredClone(journal);
}

export function createTaskAssistantLaunch(input: {
  scope: TaskAssistantLaunchScope; task: Entity<Task>; agent: Entity<AgentDesign>; projectRevision: number | null;
  brief: string; expectedOutput: string; maxMinutes: number;
}, uuid: () => string = () => crypto.randomUUID()): TaskAssistantLaunchJournal {
  const journal: TaskAssistantLaunchJournal = {
    version: 1, scope: structuredClone(input.scope), capturedTask: structuredClone(input.task), projectRevision: input.projectRevision,
    planCommand: {
      kind: 'assignment', entityId: `assignment:${uuid()}`, requestId: uuid(), epoch: input.scope.epoch, expectedRevision: 0,
      payload: { ...planValueFromTask(input.task.value, input.agent), brief: input.brief, expectedOutput: input.expectedOutput, maxMinutes: input.maxMinutes },
    },
    linkRequestId: uuid(), startRequestId: uuid(),
  };
  return readTaskAssistantLaunch(journal, input.scope)!;
}

/** Explicitly resume the same three requests; callers serialize button presses. */
export async function resumeTaskAssistantLaunch(value: TaskAssistantLaunchJournal, scope: TaskAssistantLaunchScope, io: TaskAssistantLaunchIO): Promise<TaskAssistantLaunchJournal> {
  let journal = readTaskAssistantLaunch(value, scope)!;
  const keep = (next: TaskAssistantLaunchJournal) => {
    const checked = readTaskAssistantLaunch(next, scope)!;
    if (!io.save(structuredClone(checked))) throw new TaskAssistantLaunchError('task_launch_storage', 'Request not saved. Keep this window open and free browser storage.');
    journal = checked;
  };
  if (journal.attempt || journal.linkRefusal) return journal;
  if (!journal.plan) {
    keep(journal);
    const plan = await io.commit<Assignment>(structuredClone(journal.planCommand));
    keep({ ...journal, plan });
  }
  if (!journal.task) {
    const linkCommand: LinkCommand = journal.linkCommand ?? {
      kind: 'task', entityId: scope.taskId, requestId: journal.linkRequestId, epoch: scope.epoch,
      expectedRevision: journal.capturedTask.revision, payload: linkedValue(journal),
    };
    keep({ ...journal, linkCommand });
    let task: Entity<Task>;
    try { task = await io.commit<Task>(structuredClone(linkCommand)); }
    catch (reason) {
      // A confirmed link conflict cannot have admitted this task write. Keep
      // the original plan and proposal, but release the task editor after reload.
      if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'revision_conflict') keep({ ...journal, linkRefusal: 'revision_conflict' });
      throw reason;
    }
    // The UI can adopt this confirmed revision even if the subsequent start
    // acknowledgement is lost. Never advance to start before retaining it.
    keep({ ...journal, task });
  }
  const startRequest: AssignmentStart = journal.startRequest ?? {
    requestId: journal.startRequestId, epoch: scope.epoch, assignmentId: journal.plan!.id,
    revision: journal.plan!.revision, projectRevision: journal.projectRevision,
  };
  keep({ ...journal, startRequest });
  const attempt = await io.start(structuredClone(startRequest));
  keep({ ...journal, attempt });
  return journal;
}

export function taskAssistantLaunchFailure(reason: unknown): 'storage' | 'conflict' | 'rejected' | 'unconfirmed' {
  if (reason instanceof TaskAssistantLaunchError) return reason.code === 'task_launch_storage' ? 'storage' : 'rejected';
  if (reason && typeof reason === 'object' && 'code' in reason) {
    const error = reason as { code: unknown; status?: unknown };
    if (error.code === 'revision_conflict') return 'conflict';
    if (typeof error.status === 'number' && error.status >= 400 && error.status < 500 &&
        ![408, 429].includes(error.status) && error.code !== 'host_unavailable') return 'rejected';
  }
  return 'unconfirmed';
}
