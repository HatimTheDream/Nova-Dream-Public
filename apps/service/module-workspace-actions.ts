import { z } from 'zod';
import type { ModuleAction } from '../../packages/domain/module-actions.js';
import { homeCaptureSchema, homeLibraryCommandSchema, homeReferenceSchema } from '../../packages/domain/home-library.js';
import { homeFeedOpenSchema } from '../../packages/domain/home-feed.js';
import { agentActivityCommandSchema } from '../../packages/domain/agent-activity.js';
import { meetingCommandSchema, type HubMeeting } from '../../packages/domain/hub-meetings.js';
import { hubLayoutCommandSchema } from '../../packages/domain/hub-layout.js';
import { agentRoutineSaveSchema, agentRoutineSchema } from '../../packages/domain/agent-routines.js';
import { assignmentStopSchema, assignmentTerminal, type AssignmentAttempt } from '../../packages/domain/assignments.js';
import { contentWorkspaceCommandSchema, type ContentJob } from '../../packages/domain/content-workspace.js';
import { dailyOrderSchema, taskHistorySchema } from '../../packages/domain/tasks.js';
import type { HomeLibrary } from './home-library.js';
import type { HomeFeed } from './home-feed.js';
import type { AgentActivity } from './agent-activity.js';
import type { HubMeetings } from './hub-meetings.js';
import type { AgentHub } from './agent-hub.js';
import type { AgentRoutines } from './agent-routines.js';
import type { ContentWorkspace } from './content-workspace.js';
import type { ModuleServices, Operation } from './module-actions.js';

/** Optional services expose only their maintained public commands, never access grants. */
export type WorkspaceModuleServices = {
  homeLibrary?: HomeLibrary;
  homeFeed?: HomeFeed;
  agentActivity?: AgentActivity;
  hubMeetings?: HubMeetings;
  agentHub?: AgentHub;
  agentRoutines?: AgentRoutines;
  contentWorkspace?: ContentWorkspace;
};

const empty = z.object({}).strict();
const id = z.string().min(1).max(100);
const argumentsOf = (schema: z.ZodObject<any>, omit: string[] = []) => z.object(Object.fromEntries(
  Object.entries(schema.shape).filter(([key]) => !['requestId', 'epoch', ...omit].includes(key)),
) as z.ZodRawShape).strict();
function optionOf(schema: { options: readonly z.ZodType[] }, type: string): z.ZodObject<any> {
  const option = schema.options.find(value => value instanceof z.ZodObject && value.shape.type.safeParse(type).success);
  if (!(option instanceof z.ZodObject)) throw new Error('Unknown workspace command option.');
  return option;
}
const envelope = (a: ModuleAction, fixed: Record<string, unknown> = {}) => ({ ...a.input, ...fixed, requestId: a.id, epoch: a.epoch });
const attemptState = (attempt?: AssignmentAttempt): ModuleAction['state'] => {
  if (!attempt || !assignmentTerminal(attempt.state)) return 'unknown';
  return attempt.state === 'returned' ? 'applied' : attempt.state === 'cancelled' ? 'cancelled' : 'failed';
};

/** These adapters keep the original ModuleAction id as the service receipt id.
 * Async checks read that receipt and the same saved job; they never issue start again. */
export function createWorkspaceOperations(s: ModuleServices): Record<string, Operation> {
  const operations: Record<string, Operation> = {};
  const receipt = <T>(a: ModuleAction, input: { requestId: string; epoch: string }, intent: unknown): T => {
    const saved = s.store.replayAdmission<T>(a.deviceId, input, intent);
    // An absent receipt is uncertainty, not proof that the original effect failed.
    if (saved === undefined) throw new Error('The original command has no confirmed receipt. Inspect its saved state; do not start it again.');
    return saved;
  };
  const command = (name: string, title: string, module: string, schema: { options: readonly z.ZodType[] }, type: string,
    run: (device: string, input: unknown) => unknown | Promise<unknown>, extra: Partial<Operation> = {}) => {
    operations[name] = { title, module, write: true, schema: argumentsOf(optionOf(schema, type), ['type']),
      run: a => run(a.deviceId, envelope(a, { type })), ...extra };
  };

  operations['tasks.history'] = { title: 'Read retained versions of a Task', module: 'Tasks', schema: taskHistorySchema, read: (_d, input) => s.store.taskHistory(input) };
  operations['tasks.state'] = { title: 'Read Task order, focus and occurrence history', module: 'Tasks', schema: empty, read: device => s.store.snapshot(device).taskState };
  operations['tasks.order'] = { title: 'Order the exact Tasks in a day', module: 'Tasks', write: true, schema: argumentsOf(dailyOrderSchema), run: a => s.store.orderTasks(a.deviceId, envelope(a)) };
  // Focus needs a live window-owned heartbeat. The Assistant cannot impersonate that window.
  operations['assignments.state'] = { title: 'Read original assignment attempts', module: 'Agents', ownerOnly: true,
    schema: z.object({ assignmentId: id.optional(), before: z.uuid().optional() }).strict(), read: (_d, input) => s.assignments.state(input.assignmentId, input.before) };
  operations['assignments.read'] = { title: 'Read an assignment attempt and its captured sources', module: 'Agents', ownerOnly: true,
    schema: z.object({ attemptId: z.uuid() }).strict(), read: (_d, input) => s.assignments.detail(input.attemptId) };
  operations['assignments.stop'] = { title: 'Request stop of the original assignment attempt', module: 'Agents', ownerOnly: true, write: true,
    schema: argumentsOf(assignmentStopSchema), run: a => s.assignments.stop(a.deviceId, envelope(a)),
    check: a => { const input = assignmentStopSchema.parse(envelope(a)); receipt(a, input, { type: 'assignment.stop', ...input }); return s.assignments.detail(input.attemptId).attempt; },
    resultState: result => result?.state === 'cancelled' ? 'applied' : attemptState(result) };

  if (s.homeLibrary) {
    const library = s.homeLibrary;
    operations['home.library.read'] = { title: 'Read Library collections, notes, links and saved references', module: 'Home', ownerOnly: true, schema: empty, read: device => library.state(device) };
    operations['home.references.read'] = { title: 'Check an exact saved Library reference', module: 'Home', ownerOnly: true, schema: z.object({ reference: homeReferenceSchema }).strict(), read: (device, input) => library.resolve(device, input.reference) };
    for (const [name, type, title] of [
      ['home.collections.save', 'collection-save', 'Save a versioned Library collection'],
      ['home.items.save', 'item-save', 'Save a Library note or link'],
      ['home.ideas.save', 'preferences-save', 'Save the Ideas shown on Home'],
    ]) command(name, title, 'Home', homeLibraryCommandSchema, type, (device, input) => library.command(device, input), { ownerOnly: true });
    operations['home.context.capture'] = { title: 'Capture exact saved Library sources for later reference', module: 'Home', ownerOnly: true, write: true,
      schema: argumentsOf(homeCaptureSchema), run: a => library.capture(a.deviceId, envelope(a)) };
  }
  if (s.homeFeed) {
    const feed = s.homeFeed;
    operations['home.feed.read'] = { title: 'Read Feed results and attention items without starting work', module: 'Home', ownerOnly: true, schema: empty, read: device => feed.state(device) };
    for (const [index, name, title] of [[0, 'home.feed.open', 'Open an exact saved Feed target'], [1, 'home.feed.reference', 'Open an exact saved Feed reference']] as const) {
      operations[name] = { title, module: 'Home', ownerOnly: true, schema: argumentsOf(homeFeedOpenSchema.options[index]), read: (device, input) => feed.destination(device, { ...input, epoch: s.store.epoch }) };
    }
  }
  if (s.agentActivity) {
    const activity = s.agentActivity;
    operations['agents.activity.read'] = { title: 'Read agent personality, initiative, sleep and activity', module: 'Agents', ownerOnly: true, schema: empty, read: () => activity.state() };
    for (const [name, type, title] of [
      ['agents.preferences.save', 'preferences', 'Review personality and proactive conversation preferences'],
      ['agents.wake', 'wake', 'Wake an agent for its existing authorized work'],
      ['agents.sleep', 'sleep', 'Sleep an agent after work, optionally pausing its exact meeting'],
      ['agents.interact', 'interact', 'Choose an office interaction without starting agent work'],
    ]) command(name, title, 'Agents', agentActivityCommandSchema, type, (device, input) => activity.command(device, input), { ownerOnly: true, review: type === 'preferences' });
    operations['agents.sleep'].check = a => {
      const input = agentActivityCommandSchema.parse(envelope(a, { type: 'sleep' }));
      const saved = receipt<Record<string, unknown>>(a, input, { operation: 'agent.activity', ...input });
      return { ...saved, preference: activity.state().preferences.find(preference => preference.agentId === input.agentId) };
    };
    operations['agents.sleep'].resultState = result => result.preference?.value.sleep === 'asleep' ? 'applied' : 'unknown';
  }
  if (s.hubMeetings) {
    const meetings = s.hubMeetings;
    operations['agents.meetings.read'] = { title: 'Read the current gathering and saved discussions', module: 'Agents', ownerOnly: true, schema: empty, read: () => meetings.state() };
    operations['agents.meetings.detail'] = { title: 'Read a discussion and its original speaker results', module: 'Agents', ownerOnly: true, schema: z.object({ meetingId: z.uuid() }).strict(), read: (_d, input) => meetings.detail(input.meetingId) };
    command('agents.meetings.gather', 'Gather participants and an agenda without starting work', 'Agents', meetingCommandSchema, 'gather', (device, input) => meetings.command(device, input), { ownerOnly: true });
    for (const type of ['start', 'pause', 'end'] as const) {
      command(`agents.meetings.${type}`, `${type === 'start' ? 'Review and start' : type === 'pause' ? 'Pause' : 'End'} the exact discussion`, 'Agents', meetingCommandSchema, type, (device, input) => meetings.command(device, input), {
        ownerOnly: true, review: type === 'start',
        check: a => { const input = meetingCommandSchema.parse(envelope(a, { type })); receipt(a, input, { operation: 'hub.meeting', ...input }); return meetings.detail(String(a.input.meetingId)); },
        resultState: (result: HubMeeting) => {
          // A dispatch may hold the worker before the meeting has saved its attemptId.
          if (result.turns.some(turn => s.assignments.state(turn.planId).attempts.some(attempt => !assignmentTerminal(attempt.state)))) return 'unknown';
          if (type === 'start') return result.state === 'complete' ? 'applied' : result.state === 'ended' ? 'cancelled' : 'unknown';
          return ['paused', 'ended', 'complete'].includes(result.state) ? 'applied' : 'unknown';
        },
      });
    }
  }
  if (s.agentHub) {
    const hub = s.agentHub;
    operations['agents.hub.read'] = { title: 'Read Headquarters rooms, roster and real work status', module: 'Agents', ownerOnly: true,
      schema: z.object({ before: id.optional(), agentId: id.optional(), archived: z.boolean().default(false) }).strict().refine(input => !(input.before && input.agentId)), read: (_d, input) => hub.state(input.before, input.archived, input.agentId) };
    for (const [type, title] of [['add-room', 'Add a Headquarters room'], ['rename-room', 'Rename a Headquarters room'], ['place-agent', 'Place an agent at an available office desk'], ['furnish-room', 'Change a room furnishing']]) {
      const schema = argumentsOf(optionOf(hubLayoutCommandSchema.shape.action, type), ['type']).extend({ expectedRevision: hubLayoutCommandSchema.shape.expectedRevision });
      operations[`agents.hub.${type}`] = { title, module: 'Agents', ownerOnly: true, write: true, schema,
        run: a => { const { expectedRevision, ...action } = a.input; return hub.changeLayout(a.deviceId, { requestId: a.id, epoch: a.epoch, expectedRevision, action: { ...action, type } }); } };
    }
  }
  if (s.agentRoutines) {
    const routines = s.agentRoutines;
    operations['agents.routines.read'] = { title: 'Read agent schedules and original occurrence history', module: 'Agents', ownerOnly: true,
      schema: z.object({ routineId: z.uuid().optional(), before: z.uuid().optional() }).strict(), read: (_d, input) => routines.state(input.routineId, input.before) };
    operations['agents.routines.preview'] = { title: 'Preview five schedule times without enabling work', module: 'Agents', ownerOnly: true, schema: agentRoutineSchema, read: (_d, input) => routines.preview(input) };
    operations['agents.routines.save'] = { title: 'Review and save a versioned agent schedule', module: 'Agents', ownerOnly: true, write: true, review: true, schema: argumentsOf(agentRoutineSaveSchema), run: a => routines.save(a.deviceId, envelope(a)) };
  }
  if (s.contentWorkspace) {
    const content = s.contentWorkspace;
    operations['content.library.read'] = { title: 'Read saved Content brands and templates', module: 'Content', schema: empty, read: () => content.library() };
    operations['content.state'] = { title: 'Read Content reviews and original work attempts', module: 'Content', schema: z.object({ contentId: id }).strict(), read: (_d, input) => content.state(input.contentId) };
    operations['content.result'] = { title: 'Read a complete returned Content result without applying it', module: 'Content', schema: z.object({ jobId: z.uuid() }).strict(), read: (_d, input) => content.result(input.jobId) };
    operations['content.history'] = { title: 'Read retained versions of a Content draft', module: 'Content', schema: z.object({ id, beforeRevision: z.number().int().positive().optional() }).strict(), read: (_d, input) => s.store.recordHistory({ ...input, kind: 'content' }) };
    for (const [name, type, title] of [
      ['content.library.save', 'library-save', 'Save a versioned Content brand or template'],
      ['content.review.request', 'review-request', 'Request a review for the exact saved Content version'],
      ['content.review.comment', 'review-comment', 'Add a versioned Content review comment'],
      ['content.review.resolve', 'review-resolve', 'Resolve or reopen an exact Content review comment'],
      ['content.review.decide', 'review-decide', 'Review and record a Content approval or change request'],
      ['content.restore', 'restore', 'Review restoring a retained Content version'],
      ['content.apply-work', 'apply-work', 'Review applying a returned result to its unchanged Content source'],
    ]) command(name, title, 'Content', contentWorkspaceCommandSchema, type, (device, input) => content.command(device, input), {
      review: ['review-decide', 'restore', 'apply-work'].includes(type), ownerOnly: type === 'review-decide',
    });
    const currentJob = (a: ModuleAction, type: 'work' | 'work-control', action?: 'start' | 'stop') => {
      const input = contentWorkspaceCommandSchema.parse(envelope(a, { type, ...(action ? { action } : {}) }));
      const saved = receipt<Pick<ContentJob, 'id' | 'contentId'>>(a, input, { operation: type === 'work' ? 'content.workspace' : 'content.work-control', ...input });
      const current = content.state(saved.contentId).jobs.find(job => job.id === saved.id);
      if (!current) throw new Error('The original Content work is unavailable. Do not start replacement work.');
      return current;
    };
    const workState = (job: ContentJob) => job.error && !job.attempt ? 'failed' : attemptState(job.attempt);
    command('content.work', 'Review an agent Content run against this saved version', 'Content', contentWorkspaceCommandSchema, 'work', (device, input) => content.command(device, input), {
      ownerOnly: true, review: true, check: a => currentJob(a, 'work'), resultState: workState,
    });
    for (const action of ['start', 'stop'] as const) {
      operations[`content.work.${action}`] = { title: action === 'start' ? 'Review starting the original Content job' : 'Request stop of the original Content job', module: 'Content', ownerOnly: true, write: true, review: action === 'start',
        schema: argumentsOf(optionOf(contentWorkspaceCommandSchema, 'work-control'), ['type', 'action']),
        run: a => content.command(a.deviceId, envelope(a, { type: 'work-control', action })),
        check: a => currentJob(a, 'work-control', action),
        resultState: job => action === 'stop' && job.attempt?.state === 'cancelled' ? 'applied' : workState(job),
      };
    }
  }
  return operations;
}
