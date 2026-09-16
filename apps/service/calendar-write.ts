import { randomUUID } from 'node:crypto';
import { providerCalendarOpenSchema, providerCalendarPrepareSchema, providerCalendarOperationSchema, providerCalendarConfirmSchema, type ProviderCalendarPrepare, type ProviderCalendarEditable, type ProviderCalendarReview } from '../../packages/domain/calendar-write.js';
import type { CalendarSourceRef, CalendarEvent } from '../../packages/domain/calendar.js';
import type { Accounts } from './accounts.js';
import { Store, Fault } from './store.js';
import { ProviderError } from './providers.js';
import { calendarProviderContext } from './calendar-provider-context.js';
import { applyProviderCalendarPlan, calendarFingerprint, findCalendarOperation, findCalendarDeletion, planProviderCalendarWrite, readProviderCalendarEvent, verifyCalendarReadAccess, verifyCalendarWriteAccess, type CalendarProviderPlan, type ProviderEventSnapshot } from './provider-calendar-write.js';

type Head = { device: string; input: ProviderCalendarPrepare; review: ProviderCalendarReview; plan?: CalendarProviderPlan; base?: ProviderEventSnapshot; attempted: boolean };
type CalendarAuthority = {
  resolveSource(device: string, sourceId: string, generation: string): CalendarSourceRef;
  providerChanged(source: CalendarSourceRef, event: CalendarEvent | undefined, action: ProviderCalendarPrepare['action'], scope?: string): void;
};
const headKey = (id: string) => 'calendar-write:operation:' + id;
const active = new Set<ProviderCalendarReview['state']>(['preparing', 'review', 'applying', 'unknown']);
const message = (error: unknown) => error instanceof Error ? error.message : 'This Calendar operation could not be completed. The saved proposal is kept.';

/** Provider effects have an immutable review and one dispatch admission.
 * An unknown result can be observed, but never silently replayed. */
export class CalendarWriteService {
  private closed = false;
  private controller = new AbortController();
  private jobs = new Map<string, Promise<ProviderCalendarReview>>();
  constructor(private store: Store, private accounts: Pick<Accounts, 'state' | 'calendarOperation'>, private calendar: CalendarAuthority, private now: () => number = Date.now) {
    for (const head of this.heads()) {
      if (head.review.state === 'applying') this.write(head, { state: head.attempted ? 'unknown' : 'failed', detail: head.attempted ? 'The service stopped during this save. Check its provider result before doing anything else.' : 'The service stopped before dispatch. Your proposal is kept for another review.' });
      else if (head.review.state === 'preparing') this.write(head, { state: 'failed', detail: 'Preparation stopped before any Calendar write. Reopen the kept event to review it again.' });
    }
  }
  private heads() { return this.store.internalList<Head>('calendar-write:operation:'); }
  private stamp() { return new Date(this.now()).toISOString(); }
  private ensureOpen() { if (this.closed) throw new Fault(503, 'calendar_write_closed', 'Calendar editing is restarting. Your saved proposal is kept.'); }
  private epoch(epoch: string) { if (epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen this Calendar after workspace recovery.'); }
  private head(id: string) { return this.store.internalRead<Head>(headKey(id)); }
  private owned(device: string, epoch: string, id: string) {
    this.ensureOpen(); this.epoch(epoch); const head = this.head(id);
    if (!head || head.device !== device || head.review.epoch !== epoch) throw new Fault(404, 'calendar_operation_missing', 'This Calendar operation is unavailable in this workspace.');
    return head;
  }
  private write(head: Head, patch: Partial<ProviderCalendarReview>, extra: Partial<Head> = {}) {
    const next: Head = { ...head, ...extra, review: { ...head.review, ...patch, revision: head.review.revision + 1, updatedAt: this.stamp() } };
    this.store.internalWrite(headKey(next.review.id), next); return next;
  }
  private tracked(id: string, run: () => Promise<ProviderCalendarReview>) {
    const existing = this.jobs.get(id); if (existing) return existing;
    const job = run(); this.jobs.set(id, job); void job.finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); }).catch(() => {}); return job;
  }
  private currentSource(source: CalendarSourceRef) {
    const account = this.accounts.state('').accounts.find(item => item.id === source.accountId);
    if (!account || account.provider !== source.provider || !['connected', 'refreshing'].includes(account.state) || !account.capabilities.calendarRead) throw new Fault(409, 'calendar_account_unavailable', 'Reconnect the original Calendar account before checking this saved operation.');
    // Read-only recovery can use a new connection to the same authenticated
    // provider identity. This never rebinds the old operation for another write.
    return { ...source, generation: account.generation };
  }
  async open(device: string, raw: unknown): Promise<ProviderCalendarEditable> {
    this.ensureOpen(); const input = providerCalendarOpenSchema.parse(raw); this.epoch(input.epoch);
    const source = this.calendar.resolveSource(device, input.target.sourceId, input.target.generation);
    return this.accounts.calendarOperation(source.accountId, source.generation, ['calendarRead'], this.controller.signal, async (_account, request, check) => {
      const access = await verifyCalendarReadAccess(request, source.provider, source.calendarId);
      const snapshot = await readProviderCalendarEvent(request, source.provider, source.calendarId, input.target); check(); this.epoch(input.epoch);
      snapshot.value = { ...snapshot.value, ...calendarProviderContext(this.store, source, snapshot.event) };
      const target = input.target.scope === 'series' ? { ...input.target, eventId: snapshot.event.id, seriesId: snapshot.event.id, originalStart: undefined } : input.target;
      return { epoch: input.epoch, source: { ...source, ...access }, target, event: snapshot.event, value: snapshot.value, version: snapshot.version,
        attendees: snapshot.attendees, onlineMeeting: snapshot.onlineMeeting, formattedDescription: snapshot.formattedDescription,
        repeating: snapshot.repeating, recurrenceEditable: snapshot.recurrenceEditable, warnings: [
          ...(snapshot.formattedDescription ? ['The original formatted description is preserved unless its replacement is explicitly reviewed.'] : []),
          ...(snapshot.repeating && !snapshot.recurrenceEditable ? ['The full provider repeat pattern is kept. Replacing it requires an explicit review.'] : []),
        ] };
    });
  }
  private assertAvailable(device: string, input: ProviderCalendarPrepare, source: CalendarSourceRef) {
    const target = input.target?.seriesId ?? input.target?.eventId;
    for (const other of this.heads()) {
      if (input.action === 'create' && other.device === device && other.review.writerId === input.writerId && ['confirmed', 'observed'].includes(other.review.state)) throw new Fault(409, 'calendar_writer_saved', 'This original event draft was already saved. Check its saved operation before starting a separate new event.', { operationId: other.review.id });
      if (!active.has(other.review.state) || other.review.state === 'review' && Date.parse(other.review.expiresAt) <= this.now()) continue;
      const sameWriter = other.device === device && other.review.writerId === input.writerId;
      const otherTarget = other.input.target?.seriesId ?? other.input.target?.eventId;
      const sameEvent = target && otherTarget === target && other.review.source.accountId === source.accountId && other.review.source.calendarId === source.calendarId;
      if (sameWriter || sameEvent) throw new Fault(409, 'calendar_operation_pending', 'This event has an unfinished Calendar review or uncertain save. Check its original operation first.', { operationId: other.review.id, state: other.review.state });
    }
  }
  async prepare(device: string, raw: unknown): Promise<ProviderCalendarReview> {
    this.ensureOpen(); const input = providerCalendarPrepareSchema.parse(raw); this.epoch(input.epoch);
    const admission = this.store.admit(device, input, { type: 'calendar-write-prepare', ...input }, () => {
      const source = this.calendar.resolveSource(device, input.sourceId, input.generation);
      this.assertAvailable(device, input, source);
      const id = randomUUID(), stamp = this.stamp();
      const head: Head = { device, input, attempted: false, review: { id, epoch: input.epoch, writerId: input.writerId, source, action: input.action, target: input.target,
        revision: 1, state: 'preparing', createdAt: stamp, updatedAt: stamp, expiresAt: new Date(this.now() + 30 * 60000).toISOString(), attendees: 0, warnings: [], changes: [] } };
      this.store.internalWrite(headKey(id), head); return { id };
    });
    const id = admission.value.id;
    if (!admission.fresh) return this.jobs.get(id) ?? this.owned(device, input.epoch, id).review;
    return this.tracked(id, async () => {
      let head = this.head(id)!;
      try {
        const prepared = await this.accounts.calendarOperation(head.review.source.accountId, input.generation, ['calendarRead', 'calendarWrite'], this.controller.signal, async (_account, request, check) => {
          const source = head.review.source;
          await verifyCalendarWriteAccess(request, source.provider, source.calendarId);
          const base = input.target ? await readProviderCalendarEvent(request, source.provider, source.calendarId, input.target) : undefined;
          if (base) base.value = { ...base.value, ...calendarProviderContext(this.store, source, base.event) };
          if (input.value?.projectId && !this.store.readEntity('project', input.value.projectId)) throw new Fault(409, 'missing_project', 'Choose an available Project.');
          if (input.value?.taskId) {
            const task = this.store.readEntity('task', input.value.taskId);
            if (!task || task.value.trashed || (task.value.projectId ?? null) !== input.value.projectId) throw new Fault(409, 'calendar_task_changed', 'Choose an available task from this Project.');
          }
          check(); this.epoch(input.epoch);
          const digest = calendarFingerprint({ id, epoch: input.epoch, source, input, base: base?.raw ?? null });
          const plan = planProviderCalendarWrite(source.provider, source.calendarId, input, id, digest, base);
          return { base, digest, plan };
        });
        this.ensureOpen(); this.epoch(input.epoch);
        head = this.write(head, { state: 'review', digest: prepared.digest, value: input.value, before: prepared.base?.value,
          attendees: prepared.base?.attendees ?? 0, warnings: prepared.plan.warnings, changes: prepared.plan.changes,
          detail: 'Review this exact Calendar change before applying it.' }, { plan: prepared.plan, base: prepared.base });
      } catch (error) { head = this.write(head, { state: 'failed', detail: message(error) }); }
      return head.review;
    });
  }
  read(device: string, raw: unknown) {
    const input = providerCalendarOperationSchema.parse(raw); return this.owned(device, input.epoch, input.operationId).review;
  }
  prepared(device: string, epoch: string, requestId: string) {
    this.ensureOpen(); this.epoch(epoch);
    return this.heads().find(head => head.device === device && head.input.requestId === requestId)?.review;
  }
  async confirm(device: string, raw: unknown): Promise<ProviderCalendarReview> {
    const input = providerCalendarConfirmSchema.parse(raw); const current = this.owned(device, input.epoch, input.operationId);
    const admission = this.store.admit(device, input, { type: 'calendar-write-confirm', ...input }, () => {
      if (current.review.revision !== input.expectedRevision || current.review.digest !== input.digest || current.review.state !== 'review' || !current.plan) throw new Fault(409, 'calendar_review_changed', 'Review this Calendar operation in its current state.');
      if (input.decision === 'cancel') { this.write(current, { state: 'cancelled', detail: 'The review was cancelled before any provider write.' }); return { dispatch: false }; }
      if (Date.parse(current.review.expiresAt) <= this.now()) throw new Fault(409, 'calendar_review_expired', 'Reopen the event and prepare a fresh review. Your writing is kept.');
      if (current.review.attendees && !input.acknowledgeNotifications) throw new Fault(409, 'calendar_guest_review', 'Review that the provider may notify this event’s guests before applying the change.');
      this.write(current, { state: 'applying', detail: 'Checking the original event and Calendar permission before applying the reviewed change.' });
      return { dispatch: true };
    });
    if (!admission.fresh || !admission.value.dispatch) return this.jobs.get(input.operationId) ?? this.head(input.operationId)!.review;
    return this.tracked(input.operationId, async () => {
      let head = this.head(input.operationId)!;
      try {
        const source = head.review.source;
        const event = await this.accounts.calendarOperation(source.accountId, source.generation, ['calendarRead', 'calendarWrite'], this.controller.signal, async (_account, request, check) => {
          await verifyCalendarWriteAccess(request, source.provider, source.calendarId);
          if (head.input.target) {
            const fresh = await readProviderCalendarEvent(request, source.provider, source.calendarId, head.input.target);
            if (fresh.etag !== head.plan!.etag || !head.base || calendarFingerprint(fresh.raw) !== calendarFingerprint(head.base.raw)) throw new Fault(409, 'calendar_event_changed', 'The provider event changed after review. Your proposal is kept; review it alongside the current event.');
          }
          check(); this.epoch(input.epoch); this.ensureOpen();
          head = this.write(head, { detail: 'Applying the reviewed Calendar change.' }, { attempted: true });
          return applyProviderCalendarPlan(request, source.provider, head.plan!);
        });
        // Persist an affirmative response even if connection authority changes
        // immediately afterwards. It belongs to this admitted operation.
        head = this.write(head, { state: 'confirmed', event: event?.event, detail: head.input.action === 'delete' ? 'The provider confirmed deletion of the reviewed event.' : 'The provider confirmed the reviewed event save.' });
        try { this.calendar.providerChanged(source, event?.event ?? head.base?.event, head.input.action, head.input.target?.scope); }
        catch { head = this.write(head, { detail: head.review.detail + ' Refresh Calendar to update its saved view.' }); }
      } catch (error) {
        const conflict = error instanceof Fault && error.code === 'calendar_event_changed' || error instanceof ProviderError && error.responseStatus === 412;
        const definiteRejection = error instanceof ProviderError && (error.code === 'permission' || error.code === 'reconnect' || error.responseStatus !== undefined && [400, 404, 405, 409, 422].includes(error.responseStatus));
        head = this.write(head, { state: conflict ? 'conflict' : head.attempted && !definiteRejection ? 'unknown' : 'failed',
          detail: head.attempted && !conflict && !definiteRejection ? 'The provider result is not confirmed. Check this saved operation; no second change will be sent automatically.' : message(error) });
      }
      return head.review;
    });
  }
  async reconcile(device: string, raw: unknown): Promise<ProviderCalendarReview> {
    const input = providerCalendarOperationSchema.parse(raw), current = this.owned(device, input.epoch, input.operationId);
    if (current.review.state !== 'unknown') return this.jobs.get(input.operationId) ?? current.review;
    return this.tracked(input.operationId, async () => {
      let head = this.head(input.operationId)!;
      try {
        const source = this.currentSource(head.review.source);
        const found = await this.accounts.calendarOperation(source.accountId, source.generation, ['calendarRead'], this.controller.signal, async (_account, request, check) => {
          const result = head.input.action === 'delete'
            ? await findCalendarDeletion(request, source.provider, source.calendarId, head.plan!.eventId!)
            : await findCalendarOperation(request, source.provider, source.calendarId, head.review.id, head.review.digest!, head.plan?.eventId);
          check(); this.epoch(input.epoch); return result;
        });
        if (head.input.action === 'delete' ? found.state === 'absent' : found.state === 'observed') {
          const event = found.state === 'observed' ? found.snapshot.event : undefined;
          head = this.write(head, { state: 'observed', event, detail: head.input.action === 'delete'
            ? 'The event is now absent. This confirms its current state, not which client deleted it.'
            : 'The original save marker was found in the provider. Later provider edits may also be present; no duplicate save was sent.' });
          this.calendar.providerChanged(source, event ?? head.base?.event, head.input.action, head.input.target?.scope);
        } else head = this.write(head, { detail: found.state === 'present' ? 'The event is still present. Keep this operation for review; no second deletion was sent.' : found.state === 'absent' ? 'No matching save is visible yet. Keep this operation for review; no second write was sent.' : 'The event has a different save marker. Keep the original operation for review; no second write was sent.' });
      } catch (error) { head = this.write(head, { detail: message(error) }); }
      return head.review;
    });
  }
  async close() { if (this.closed) return; this.closed = true; this.controller.abort(); await Promise.allSettled([...this.jobs.values()]); }
}
