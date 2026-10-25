import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { assistantRequestSchema, connectionSchema } from '../../packages/domain/assistant.js';
import { closeSetupRequestSchema, setupRequestReferenceSchema, type SetupRequestReference, type SetupRequestView } from '../../packages/domain/setup-request.js';
import { Fault, type Store } from './store.js';

type Record = SetupRequestView & { deviceId: string; ownerId: string; ownerPid: number };
const key = (id: string) => `assistant:setup-request:${id}`;
const activeKey = 'assistant:setup-active';
const intent = (ref: SetupRequestReference) => ({ type: 'assistant.setup-request', ...ref });
const project = (record: Record): SetupRequestView => { const { deviceId: _, ownerId: _owner, ownerPid: _pid, ...view } = record; return view; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return !(e instanceof Error && 'code' in e && e.code === 'ESRCH'); } };

/** A timeout can observe this original receipt. Neither a GET nor a restart dispatches it. */
export class SetupRequests {
  private jobs = new Map<string, Promise<void>>();
  private closed = false;
  private ownerId = randomUUID();
  constructor(private store: Store, private ownerAlive = alive) {}
  get updateMaintenanceBusy() { return this.jobs.size; }
  private record(device: string, ref: SetupRequestReference): Record | undefined {
    if (ref.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. The original setup request is kept.');
    const receipt = this.store.replayAdmission<{ requestId: string }>(device, ref, intent(ref));
    const record = this.store.internalRead<Record>(key(ref.requestId));
    if (!receipt && !record) return undefined;
    if (!receipt || receipt.requestId !== ref.requestId || !record || record.deviceId !== device
      || record.sha256 !== ref.sha256 || record.kind !== ref.kind || record.epoch !== ref.epoch)
      throw new Fault(409, 'setup_receipt_changed', 'The original setup receipt could not be verified.');
    return record;
  }
  read(device: string, raw: unknown): SetupRequestView {
    const ref = setupRequestReferenceSchema.parse(raw), record = this.record(device, ref);
    if (!record) return { ...ref, revision: 0, state: 'not-found', message: 'This request has no saved receipt yet. It has not been repeated.' };
    if (record.state === 'working' && !this.jobs.has(ref.requestId))
      return { ...project(record), state: 'unknown', message: 'The host restarted before the original setup outcome was recorded. Current readiness is separate.' };
    return project(record);
  }
  start(device: string, kind: SetupRequestReference['kind'], raw: unknown, effect: () => Promise<{ applied: boolean }>): SetupRequestView {
    const input = kind === 'runtime-start' ? assistantRequestSchema.strict().parse(raw) : connectionSchema.parse(raw);
    const ref: SetupRequestReference = { requestId: input.requestId, epoch: input.epoch, kind,
      sha256: createHash('sha256').update(canonical(input)).digest('hex') };
    if (this.closed) throw new Fault(503, 'setup_closed', 'This host is closing. Check the original setup after reconnecting.');
    this.store.assertUpdateAdmission();
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Setup is paused in this recovery copy.');
    const admitted = this.store.admit(device, ref, intent(ref), () => {
      const activeId = this.store.internalRead<string>(activeKey);
      const active = activeId ? this.store.internalRead<Record>(key(activeId)) : undefined;
      if (active?.state === 'working' && active.epoch === this.store.epoch) throw new Fault(409, 'setup_active', 'Check the original host setup request before starting another.');
      const record: Record = { ...ref, deviceId: device, ownerId: this.ownerId, ownerPid: process.pid,
        revision: 1, state: 'working', message: 'The original setup request was admitted. Readiness is checked separately.' };
      this.store.internalWrite(key(ref.requestId), record); this.store.internalWrite(activeKey, ref.requestId);
      return { requestId: ref.requestId };
    });
    if (admitted.fresh) {
      const job = Promise.resolve().then(async () => {
        this.store.assertUpdateAdmission();
        if (this.closed || this.store.recoveryEffectsPaused) throw Error('Setup stopped before dispatch');
        return effect();
      }).then(result => this.finish(device, ref, result.applied ? 'applied' : 'failed'),
        () => this.finish(device, ref, 'failed')).finally(() => { this.jobs.delete(ref.requestId); });
      // A lost final write stays unknown; never retry an external action for it.
      this.jobs.set(ref.requestId, job.catch(() => undefined));
    }
    return this.read(device, ref);
  }
  private finish(device: string, ref: SetupRequestReference, state: 'applied' | 'failed') {
    const record = this.record(device, ref);
    if (!record || record.state !== 'working') throw Error('Original setup owner changed');
    this.store.internalWrite(key(ref.requestId), { ...record, revision: record.revision + 1, state,
      message: state === 'applied' ? 'The original setup command was applied. Check host and account readiness separately.'
        : 'The original setup command finished without confirming success. Review current setup before a new request.' } satisfies Record);
  }
  closeRequest(device: string, raw: unknown): SetupRequestView {
    const input = closeSetupRequestSchema.parse(raw), ref = input.original;
    if (input.epoch !== ref.epoch) throw new Fault(409, 'epoch_changed', 'Keep the original setup workspace.');
    if (this.closed) throw new Fault(503, 'setup_closed', 'This host is closing.');
    this.store.assertUpdateAdmission();
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Setup review is paused in this recovery copy.');
    const previous = this.store.replayAdmission<{ view: SetupRequestView }>(device, input, { type: 'assistant.setup-close', ...input });
    if (previous) return previous.view;
    const current = this.read(device, ref);
    if (this.jobs.has(ref.requestId) || current.state === 'working') throw new Fault(409, 'setup_active', 'The original setup is still running. Check its outcome.');
    const original = this.record(device, ref);
    if (original?.state === 'working' && original.ownerId !== this.ownerId && this.ownerAlive(original.ownerPid))
      throw new Fault(409, 'setup_owner_present', 'The original setup owner is still present. Its request cannot be closed here.');
    if (current.revision !== input.revision) throw new Fault(409, 'setup_changed', 'Read the original setup again before closing its request.');
    // Fence an unadmitted identity first. A delayed original POST then replays
    // this receipt and cannot dispatch. A crash between these writes is safe.
    this.store.admit(device, ref, intent(ref), () => {
      this.store.internalWrite(key(ref.requestId), { ...ref, deviceId: device, ownerId: this.ownerId, ownerPid: process.pid,
        revision: 1, state: 'closed', closedFrom: 'not-found',
        message: 'This original request was closed before admission. A delayed copy cannot run.' } satisfies Record);
      return { requestId: ref.requestId };
    });
    return this.store.admit(device, input, { type: 'assistant.setup-close', ...input }, () => {
      const record = this.record(device, ref)!;
      const view = record.state === 'closed' ? project(record) : {
        ...project(record), revision: record.revision + 1, state: 'closed' as const,
        reviewedUnknown: record.state === 'working',
        closedFrom: record.state,
        message: record.state === 'working' ? 'The unconfirmed original was closed without repeating it or claiming success. Current host setup is kept.'
          : 'The original setup receipt is kept. This review did not repeat its command.',
      };
      this.store.internalWrite(key(ref.requestId), { ...view, deviceId: device, ownerId: record.ownerId, ownerPid: record.ownerPid });
      return { view };
    }).value.view;
  }
  async close() { this.closed = true; await Promise.allSettled([...this.jobs.values()]); }
}
