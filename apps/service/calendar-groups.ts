import { randomUUID } from 'node:crypto';
import { calendarGroupPrepareSchema, calendarGroupActionSchema, calendarGroupRemoved, calendarGroupUncertain, type CalendarGroupPrepare, type CalendarGroupReview } from '../../packages/domain/calendar-groups.js';
import { providerCalendarOperationSchema, type ProviderCalendarPrepare, type ProviderCalendarReview, type providerCalendarConfirmSchema } from '../../packages/domain/calendar-write.js';
import type { z } from 'zod';
import type { Accounts } from './accounts.js';
import type { CalendarService } from './calendar.js';
import type { CalendarWriteService } from './calendar-write.js';
import { calendarFingerprint } from './provider-calendar-write.js';
import { Store, Fault } from './store.js';

type Child = { seriesId: string; writerId: string; requestId: string; input?: ProviderCalendarPrepare; operationId?: string; confirmation?: z.infer<typeof providerCalendarConfirmSchema>; error?: string; history: string[] };
type Head = { device: string; input: CalendarGroupPrepare; review: CalendarGroupReview; children: Child[]; keepRemaining?: boolean };
const key = (id: string) => 'calendar-group:operation:' + id;
const child = (seriesId: string, history: string[] = []): Child => ({ seriesId, writerId: randomUUID(), requestId: randomUUID(), history });
const message = (error: unknown) => error instanceof Error ? error.message : 'This pattern could not be checked. The original selection is kept.';

/** Explicit bounded selection, existing per-series effect authority, durable
 * partial outcomes. Reading/restarting a group never continues its deletions. */
export class CalendarGroups {
  private closed = false;
  private jobs = new Map<string, Promise<CalendarGroupReview>>();
  constructor(private store: Store, private accounts: Pick<Accounts, 'state'>, private calendar: Pick<CalendarService, 'resolveSource'>, private writes: CalendarWriteService, private now: () => number = Date.now) {
    for (const head of this.heads()) if (['preparing', 'applying'].includes(head.review.state)) this.save(head, undefined, 'The service restarted. Review the retained result for each pattern before continuing.');
  }
  private heads() { return this.store.internalList<Head>('calendar-group:operation:'); }
  private head(id: string) { return this.store.internalRead<Head>(key(id))!; }
  private ensureOpen() { if (this.closed) throw new Fault(503, 'calendar_group_closed', 'Calendar is restarting. This schedule review is kept.'); }
  private epoch(epoch: string) { if (epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen Calendar after workspace recovery.'); }
  private owned(device: string, epoch: string, id: string) {
    this.ensureOpen(); this.epoch(epoch); const head = this.head(id);
    if (!head || head.device !== device || head.review.epoch !== epoch) throw new Fault(404, 'calendar_group_missing', 'This schedule review is unavailable in this workspace.');
    return head;
  }
  private operation(head: Head, item: Child): ProviderCalendarReview | undefined {
    const operation = item.operationId ? this.writes.read(head.device, { requestId: randomUUID(), epoch: head.review.epoch, operationId: item.operationId })
      : this.writes.prepared(head.device, head.review.epoch, item.requestId);
    if (operation) {
      if (operation.writerId !== item.writerId || operation.action !== 'delete' || operation.target?.scope !== 'series' || operation.target.eventId !== item.seriesId || operation.source.accountId !== head.review.source.accountId || operation.source.calendarId !== head.review.source.calendarId) throw new Fault(409, 'calendar_group_child_changed', 'A pattern result does not match this original schedule review.');
      item.operationId = operation.id;
    }
    return operation;
  }
  private save(head: Head, phase?: 'preparing' | 'applying', detail?: string, closed = head.review.closed) {
    const items = head.children.map(item => { const operation = this.operation(head, item); return { seriesId: item.seriesId, ...(operation ? { operation } : {}), ...(item.error ? { error: item.error } : {}) }; });
    const removed = items.filter(calendarGroupRemoved).length;
    closed ||= Boolean(head.keepRemaining && !items.some(calendarGroupUncertain) && items.every(item => !['review', 'preparing'].includes(item.operation?.state ?? '')));
    const state: CalendarGroupReview['state'] = phase ?? (removed === items.length ? 'confirmed' : closed ? removed ? 'partial' : 'cancelled' : items.every(item => calendarGroupRemoved(item) || item.operation?.state === 'review' && !item.error) ? 'review' : 'partial');
    const digest = state === 'review' ? calendarFingerprint({ id: head.review.id, epoch: head.review.epoch, round: head.review.round, source: head.review.source, items: items.map(item => ({ seriesId: item.seriesId, id: item.operation!.id, revision: item.operation!.revision, digest: item.operation!.digest })) }) : undefined;
    const unchanged = state === head.review.state && calendarFingerprint(items) === calendarFingerprint(head.review.items) && closed === head.review.closed;
    const review: CalendarGroupReview = JSON.parse(JSON.stringify({ ...head.review, state, items, digest, closed: closed || state === 'confirmed', detail: detail ?? (unchanged ? head.review.detail : state === 'review' ? 'Review every remaining pattern. They will be removed separately; any partial results are retained.' : state === 'confirmed' ? 'Every selected pattern has a confirmed or observed deletion result.' : closed ? `${removed} of ${items.length} patterns were removed. The other patterns were kept; no deletion is pending in this review.` : `${removed} of ${items.length} selected patterns have been removed. Review the remaining results before continuing.`) }));
    if (calendarFingerprint(review) !== calendarFingerprint(head.review)) { review.revision++; review.updatedAt = new Date(this.now()).toISOString(); }
    const next = { ...head, review }; this.store.internalWrite(key(review.id), next); return next;
  }
  private tracked(id: string, run: () => Promise<CalendarGroupReview>) {
    const old = this.jobs.get(id); if (old) return old;
    const job = run(); this.jobs.set(id, job); void job.finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); }).catch(() => {}); return job;
  }
  private command(head: Head, operation: ProviderCalendarReview, decision: 'confirm' | 'cancel', acknowledgeNotifications = false) {
    return { requestId: randomUUID(), epoch: head.review.epoch, operationId: operation.id, expectedRevision: operation.revision, digest: operation.digest!, decision, acknowledgeNotifications };
  }
  async prepare(device: string, raw: unknown) {
    this.ensureOpen(); const input = calendarGroupPrepareSchema.parse(raw); this.epoch(input.epoch);
    const admission = this.store.admit(device, input, { type: 'calendar-group-prepare', ...input }, () => {
      const existing = this.heads().find(head => head.device === device && head.review.writerId === input.writerId && !head.review.closed);
      if (existing) throw new Fault(409, 'calendar_group_pending', 'This schedule draft already has a retained review. Check its original request.', { operationId: existing.review.id });
      const source = this.calendar.resolveSource(device, input.sourceId, input.generation), id = randomUUID(), stamp = new Date(this.now()).toISOString();
      const head: Head = { device, input, children: [...input.seriesIds].sort().map(id => child(id)), review: { id, epoch: input.epoch, writerId: input.writerId, source, label: input.label, revision: 1, round: 1, createdAt: stamp, updatedAt: stamp, state: 'preparing', closed: false, items: input.seriesIds.map(seriesId => ({ seriesId })), detail: 'Reading the exact selected series and Calendar permissions.' } };
      this.store.internalWrite(key(id), head); return { id };
    });
    if (!admission.fresh) return this.jobs.get(admission.value.id) ?? this.read(device, { requestId: randomUUID(), epoch: input.epoch, operationId: admission.value.id });
    return this.tracked(admission.value.id, () => this.prepareRemaining(admission.value.id));
  }
  private async prepareRemaining(id: string): Promise<CalendarGroupReview> {
    let head = this.head(id);
    try {
      for (let i = 0; i < head.children.length; i++) {
        this.ensureOpen(); const item = head.children[i], previous = this.operation(head, item);
        if (previous && ['confirmed', 'observed'].includes(previous.state)) continue;
        try {
          const source = head.review.source;
          const editable = await this.writes.open(head.device, { epoch: head.review.epoch, target: { sourceId: source.id, generation: source.generation, eventId: item.seriesId, seriesId: item.seriesId, scope: 'series' } });
          this.ensureOpen(); this.epoch(head.review.epoch);
          item.input = { requestId: item.requestId, epoch: head.review.epoch, writerId: item.writerId, sourceId: source.id, generation: source.generation, action: 'delete', target: editable.target, expectedVersion: editable.version, replaceDescription: false, replaceRecurrence: false, replaceReminder: false };
          head = this.save(head, 'preparing', 'Checking each selected series before showing the complete review.');
          const operation = await this.writes.prepare(head.device, item.input); head = this.head(id); head.children[i].operationId = operation.id;
        } catch (error) { head.children[i].error = message(error); }
        head = this.save(head, 'preparing', 'Checking each selected series before showing the complete review.');
      }
    } catch (error) { return this.save(head, undefined, message(error)).review; }
    return this.save(head).review;
  }
  read(device: string, raw: unknown) {
    const input = providerCalendarOperationSchema.parse(raw), head = this.owned(device, input.epoch, input.operationId);
    if (this.jobs.has(input.operationId)) return head.review;
    return this.save(head).review;
  }
  async reconcile(device: string, raw: unknown) {
    const input = providerCalendarOperationSchema.parse(raw), head = this.owned(device, input.epoch, input.operationId);
    if (this.jobs.has(input.operationId)) return this.jobs.get(input.operationId)!;
    return this.tracked(input.operationId, async () => {
      for (const item of head.children) {
        this.ensureOpen(); const operation = this.operation(head, item);
        if (operation?.state === 'unknown') await this.writes.reconcile(device, { requestId: randomUUID(), epoch: input.epoch, operationId: operation.id });
      }
      return this.save(this.head(input.operationId)).review;
    });
  }
  async action(device: string, raw: unknown) {
    const input = calendarGroupActionSchema.parse(raw); let current = this.owned(device, input.epoch, input.operationId);
    if (!this.jobs.has(input.operationId)) current = this.save(current);
    const admission = this.store.admit(device, input, { type: 'calendar-group-action', ...input }, () => {
      if (current.review.revision !== input.expectedRevision || current.review.closed || this.jobs.has(input.operationId)) throw new Fault(409, 'calendar_group_changed', 'Check the current schedule results before making another decision.');
      if (input.action === 'confirm') {
        if (current.review.state !== 'review' || !input.digest || current.review.digest !== input.digest) throw new Fault(409, 'calendar_group_changed', 'Review every selected series in its current state.');
        if (current.review.items.some(item => !calendarGroupRemoved(item) && item.operation!.attendees > 0) && !input.acknowledgeNotifications) throw new Fault(409, 'calendar_group_guests', 'Review that the provider may notify guests of these series.');
        for (let i = 0; i < current.children.length; i++) if (!calendarGroupRemoved(current.review.items[i])) current.children[i].confirmation = this.command(current, current.review.items[i].operation!, 'confirm', input.acknowledgeNotifications);
      } else if (input.action === 'review' && current.review.items.some(calendarGroupUncertain)) throw new Fault(409, 'calendar_group_uncertain', 'Check uncertain results before preparing the remaining patterns. No deletion will be repeated automatically.');
      current.keepRemaining = input.action === 'cancel';
      this.save(current, 'applying', input.action === 'confirm' ? 'Removing the reviewed series one at a time.' : 'Keeping unapplied patterns before preparing another decision.');
      return { accepted: true };
    });
    if (!admission.fresh) return this.jobs.get(input.operationId) ?? this.read(device, { requestId: randomUUID(), epoch: input.epoch, operationId: input.operationId });
    return this.tracked(input.operationId, async () => {
      let head = this.head(input.operationId);
      try {
        if (input.action === 'confirm') {
          for (let i = 0; i < head.children.length; i++) {
            this.ensureOpen(); const item = head.children[i];
            if (calendarGroupRemoved({ seriesId: item.seriesId, operation: this.operation(head, item) })) continue;
            let operation: ProviderCalendarReview;
            try { operation = await this.writes.confirm(device, item.confirmation!); }
            catch (error) { head = this.head(input.operationId); head.children[i].error = message(error); return this.save(head).review; }
            head = this.save(this.head(input.operationId), 'applying', 'The result of each pattern is retained before continuing.');
            if (!['confirmed', 'observed'].includes(operation.state)) break;
          }
          return this.save(head).review;
        }
        for (let i = 0; i < head.children.length; i++) {
          this.ensureOpen(); const item = head.children[i], operation = this.operation(head, item);
          if (operation?.state === 'review') {
            item.confirmation = this.command(head, operation, 'cancel'); head = this.save(head, 'applying', 'Keeping the remaining unapplied patterns.');
            await this.writes.confirm(device, item.confirmation); head = this.head(input.operationId);
          }
        }
        head = this.save(head);
        if (input.action === 'cancel') return this.save(head, undefined, undefined, !head.review.items.some(calendarGroupUncertain)).review;
        const original = head.review.source, account = this.accounts.state(device).accounts.find(item => item.id === original.accountId && item.provider === original.provider);
        if (!account) throw new Fault(409, 'calendar_account_unavailable', 'Reconnect the original account before reviewing the remaining patterns.');
        const source = this.calendar.resolveSource(device, original.id, account.generation);
        if (source.accountId !== original.accountId || source.calendarId !== original.calendarId || source.provider !== original.provider) throw new Fault(409, 'calendar_source_changed', 'The selected Calendar does not match the original schedule.');
        head.review.source = source; head.review.round++;
        head.children = head.children.map((item, i) => calendarGroupRemoved(head.review.items[i]) ? item : child(item.seriesId, [...item.history, ...(item.operationId ? [item.operationId] : [])]));
        this.save(head, 'preparing', 'Reading the remaining patterns for a new explicit review.');
        return this.prepareRemaining(input.operationId);
      } catch (error) { return this.save(this.head(input.operationId), undefined, message(error)).review; }
    });
  }
  async close() { this.closed = true; await Promise.allSettled([...this.jobs.values()]); }
}
