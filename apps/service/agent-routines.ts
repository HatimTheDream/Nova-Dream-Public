import { randomUUID } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { agentRoutineSaveSchema, agentRoutineSchema, type AgentRoutine, type AgentRoutineState, type AgentRoutineValue, type RoutineOccurrence } from '../../packages/domain/agent-routines.js';
import { Fault, Store } from './store.js';
import { AssignmentService } from './assignments.js';
import { latestAgentRun, nextAgentRun } from './agent-schedule.js';

const routineKey = (id: string) => `agent-routines:item:${id}`;
const historyPrefix = (id?: string) => `agent-routines:history:${id ?? 'all'}:`;
const graceMs = 60_000;

/** A schedule owns occurrences, never a second copy of an assignment or result. */
export class AgentRoutines {
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private store: Store, private assignments: AssignmentService, private now = Date.now) {}
  private list() { return this.store.internalList<AgentRoutine>('agent-routines:item:'); }
  state(routineId?: string, before?: string): AgentRoutineState {
    const prefix = historyPrefix(routineId), cursor = before ? this.store.internalRead<{ suffix: string; routineId: string }>(`agent-routines:cursor:${before}`) : undefined;
    if (before && (!cursor || (routineId && cursor.routineId !== routineId))) throw new Fault(404, 'routine_cursor', 'Reload the routine history before continuing.');
    const rows = this.store.internalPage<RoutineOccurrence>(prefix, cursor ? prefix + cursor.suffix : '', 101), page = rows.slice(0, 100);
    return { routines: this.list().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), history: page.map(({ value: item }) => {
      if (!item.attemptId) return item;
      const a = this.assignments.summary(item.attemptId);
      return { ...item, attempt: { id: a.id, assignmentId: a.assignmentId, state: a.state, message: a.message, routine: a.routine, ...(a.result ? { result: { file: a.result.file } } : {}) } };
    }), nextCursor: rows.length > 100 ? page.at(-1)!.value.id : null };
  }
  preview(raw: unknown) {
    const value = agentRoutineSchema.parse(raw), times: number[] = []; let after = this.now();
    for (let n = 0; n < 5; n++) { const next = nextAgentRun(value, after); if (next === null) break; times.push(next); after = next; }
    return { times };
  }
  save(device: string, raw: unknown) {
    const input = agentRoutineSaveSchema.parse(raw);
    return this.store.admit(device, input, { type: 'agent-routine.save', ...input }, () => {
      const current = this.store.internalRead<AgentRoutine>(routineKey(input.id));
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'routine_changed', 'This routine changed. Your writing is kept; review the saved version before applying it.', current);
      if (!current && this.list().length >= 100) throw new Fault(507, 'routine_quota', 'The saved routine limit is reached. Existing routines and history are kept.');
      const value = input.value, plan = this.store.readEntity('assignment', value.assignmentId);
      const definitionChanged = !current || canonical({ ...value, name: '', enabled: false, archived: false }) !== canonical({ ...current.value, name: '', enabled: false, archived: false });
      if (value.enabled || definitionChanged) {
        if (!plan || plan.value.archived || plan.value.state !== 'planned' || plan.revision !== value.assignmentRevision) throw new Fault(409, 'assignment_changed', 'Choose the current active assignment plan before enabling this routine.');
        if (this.store.readEntity('agent', plan.value.agentId)?.value.archived !== false) throw new Fault(409, 'agent_changed', 'Restore this agent before enabling its routine.');
        const project = plan.value.projectId ? this.store.readEntity('project', plan.value.projectId) : undefined;
        if ((project?.revision ?? null) !== value.projectRevision || (plan.value.projectId && !project)) throw new Fault(409, 'project_changed', 'Review the current Project before enabling this routine.');
      }
      const at = this.now(), next = nextAgentRun(value, at);
      const preserve = current && !definitionChanged && current.value.enabled && value.enabled && !current.attention;
      if (value.enabled && next === null && !preserve) throw new Fault(400, 'routine_schedule', 'This schedule has no future occurrence. Choose a future time.');
      const saved: AgentRoutine = { id: input.id, revision: input.expectedRevision + 1, epoch: input.epoch, deviceId: device, updatedAt: at, value, agentId: plan?.value.agentId ?? current!.agentId, nextAt: value.enabled && !value.archived ? preserve ? current.nextAt : next : null, attention: null };
      this.store.internalWrite(routineKey(input.id), saved);
      this.store.internalWrite(`agent-routines:revision:${input.id}:${saved.revision.toString().padStart(8, '0')}`, saved);
      return saved;
    }).value;
  }
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* No failed transaction advances its durable cursor. */ } }, 1000); this.timer.unref();
  }
  tick() {
    if (this.closed) return;
    const at = this.now();
    for (const routine of this.list().filter(r => r.value.enabled && !r.value.archived && !r.attention && r.nextAt !== null && r.nextAt <= at).sort((a, b) => a.nextAt! - b.nextAt! || a.id.localeCompare(b.id))) {
      if (routine.epoch !== this.store.epoch) { this.store.internalWrite(routineKey(routine.id), { ...routine, nextAt: null, attention: 'The workspace was recovered. Review and enable this schedule again.' }); continue; }
      const count = this.store.internalRead<number>('agent-routines:count') ?? 0;
      if (count >= 20000) { this.store.internalWrite(routineKey(routine.id), { ...routine, nextAt: null, attention: 'Routine history storage is full. Saved work is kept; scheduling is paused.' }); continue; }
      const first = routine.nextAt!, latest = latestAgentRun(routine.value, at, first), overdue = at - first > graceMs;
      const scheduledAt = overdue && routine.value.missed === 'latest' ? latest : first;
      const nextAt = nextAgentRun(routine.value, at), id = randomUUID();
      const event: RoutineOccurrence = { id, routineId: routine.id, routineRevision: routine.revision, scheduledAt, recordedAt: at, state: 'started', message: 'Started the exact saved assignment for this occurrence.', ...(latest > first ? { throughAt: latest } : {}) };
      const record = (state: RoutineOccurrence['state'], message: string, attemptId?: string) => {
        const saved = { ...event, state, message, ...(attemptId ? { attemptId } : {}) }, suffix = `${(9999999999999 - at).toString().padStart(13, '0')}:${id}`;
        this.store.internalWrite(historyPrefix() + suffix, saved); this.store.internalWrite(historyPrefix(routine.id) + suffix, saved);
        this.store.internalWrite(`agent-routines:cursor:${id}`, { suffix, routineId: routine.id });
        this.store.internalWrite('agent-routines:count', count + 1);
        this.store.internalWrite(routineKey(routine.id), { ...routine, nextAt: state === 'review' ? null : nextAt, attention: state === 'review' ? message : null });
      };
      if (overdue && routine.value.missed !== 'latest') {
        this.store.internalAtomic(() => record(routine.value.missed === 'review' ? 'review' : 'skipped', routine.value.missed === 'review' ? 'The host missed a scheduled run. Review and enable the routine to continue; missed work has not run.' : 'Skipped the elapsed schedule window under this routine’s missed-run policy.'));
        continue;
      }
      const available = this.assignments.state();
      if (!available.canStart) { this.store.internalAtomic(() => record('skipped', available.reason + ' This occurrence was skipped; the next scheduled time is kept.')); continue; }
      try {
        this.assignments.start(routine.deviceId, { requestId: id, epoch: routine.epoch, assignmentId: routine.value.assignmentId, revision: routine.value.assignmentRevision, projectRevision: routine.value.projectRevision }, {
          origin: { routineId: routine.id, routineRevision: routine.revision, scheduledAt, occurrenceId: id },
          admitted: attempt => record('started', event.message, attempt.id),
        });
      } catch (reason) {
        if (!(reason instanceof Fault)) throw reason;
        this.store.internalAtomic(() => record('review', `${reason.message} Scheduling is paused until you review this routine.`));
      }
    }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
