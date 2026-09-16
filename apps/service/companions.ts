import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { computerAccessActive, companionCallSchema, companionToolSchema, companionCommandSchema, companionLinkData, companionLinkSchema, companionPacketSchema, companionSignedData, type CompanionCall, type CompanionChallenge, type CompanionDevice, type CompanionOperation } from '../../packages/domain/companion.js';
import { Fault, Store } from './store.js';

type Device = Omit<CompanionDevice, 'connected'> & { epoch: string; publicKey: string };
const deviceKey = (id: string) => 'companion:device:' + id;
const operationKey = (id: string) => 'companion:operation:' + id;
const bounded = z.object({ enabledUntil: z.number().int().nonnegative().nullable(), scope: z.enum(['apps','desktop']).default('apps'), apps: z.array(z.string().min(1).max(150)).max(20), tools: z.array(companionToolSchema).max(19).optional() }).strict();
const proofError = () => new Fault(403, 'companion_unlinked', 'This desktop link is unavailable. Link it again in Install & devices.');
function checkSignature(key: string, data: string, signature: string) {
  try { const publicKey = createPublicKey(key); return publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'base64url')); } catch { return false; }
}

/** Only typed, signed desktop packets cross this boundary. No shell commands,
 * Gateway credentials, model configuration or local dispatcher is exposed. */
export class Companions {
  private checks = new Map<string, () => void>();
  private closed = false;
  constructor(private store: Store, private now: () => number = Date.now) {
    for (const op of this.all()) if (['queued', 'claimed'].includes(op.state)) this.save({ ...op, state: 'unknown', message: 'The host restarted. Check the original result; this action will not be repeated.' });
  }
  private all() { return this.store.internalList<CompanionOperation>('companion:operation:').filter(op => op.epoch === this.store.epoch); }
  private save(op: CompanionOperation) { return this.store.internalWrite(operationKey(op.id), op); }
  devices(): CompanionDevice[] {
    return this.store.internalList<Device>('companion:device:').filter(d => d.epoch === this.store.epoch).map(({ epoch: _epoch, publicKey: _key, ...device }) => ({ ...device, connected: !this.closed && !device.revokedAt && device.lastSeenAt > this.now() - 15000 }));
  }
  challenge(owner: string, raw: unknown): CompanionChallenge {
    const input = companionCommandSchema.parse(raw);
    return this.store.admit(owner, input, { type: 'companion.challenge', ...input }, () => {
      const challenges = this.store.internalList<CompanionChallenge>('companion:challenge:');
      for (const stale of challenges) if (stale.expiresAt <= this.now()) this.store.internalDelete('companion:challenge:' + stale.id);
      if (challenges.filter(c => c.expiresAt > this.now()).length >= 24) throw new Fault(429, 'companion_challenges', 'Finish an existing desktop link or wait five minutes before retrying.');
      const challenge = { id: randomUUID(), epoch: this.store.epoch, nonce: randomBytes(32).toString('base64url'), expiresAt: this.now() + 5 * 60000 };
      this.store.internalWrite('companion:challenge:' + challenge.id, { ...challenge, owner });
      return challenge;
    }).value;
  }
  link(owner: string, raw: unknown) {
    const input = companionLinkSchema.parse(raw);
    const previous = this.store.internalRead<Device>(deviceKey(input.deviceId));
    if (previous?.revokedAt) throw proofError(); // An old registration cannot undo revocation.
    return this.store.admit(owner, input, { type: 'companion.link', ...input }, () => {
      const challenge = this.store.internalRead<CompanionChallenge & { owner: string }>('companion:challenge:' + input.challengeId);
      if (!challenge || challenge.owner !== owner || challenge.epoch !== this.store.epoch || challenge.expiresAt <= this.now() || !checkSignature(input.publicKey, companionLinkData(challenge, input.deviceId), input.signature)) throw proofError();
      if (previous || this.devices().filter(d => !d.revokedAt).length >= 12) throw new Fault(409, 'companion_limit', 'Remove an existing desktop link before adding another.');
      this.store.internalWrite(deviceKey(input.deviceId), { id: input.deviceId, epoch: input.epoch, name: input.name, platform: input.platform, publicKey: input.publicKey, linkedAt: this.now(), lastSeenAt: 0, enabledUntil: 0, apps: [] } satisfies Device);
      this.store.internalDelete('companion:challenge:' + challenge.id);
      return { linked: true, deviceId: input.deviceId, epoch: input.epoch };
    }).value;
  }
  revoke(owner: string, raw: unknown) {
    const input = companionCommandSchema.extend({ deviceId: z.uuid() }).parse(raw);
    return this.store.admit(owner, input, { type: 'companion.revoke', ...input }, () => {
      const device = this.device(input.deviceId);
      this.store.internalWrite(deviceKey(device.id), { ...device, revokedAt: this.now(), enabledUntil: 0 });
      this.cancelDevice(device.id, 'This desktop link was revoked.');
      return { revoked: true };
    }).value;
  }
  private device(id: string) {
    const device = this.store.internalRead<Device>(deviceKey(id));
    if (this.closed || !device || device.epoch !== this.store.epoch || device.revokedAt !== undefined) throw proofError();
    return device;
  }
  enqueue(id: string, ownerId: string, call: CompanionCall, authorize: () => void) {
    authorize();
    const parsed = companionCallSchema.parse(call), prior = this.store.internalRead<CompanionOperation>(operationKey(id));
    if (Buffer.byteLength(JSON.stringify(parsed.arguments)) > 16000) throw new Fault(413, 'computer_arguments', 'Narrow this computer action.');
    if (prior) {
      if (prior.ownerId !== ownerId || prior.epoch !== this.store.epoch || canonical(prior.call) !== canonical(parsed)) throw new Fault(409, 'computer_call_reused', 'This computer operation already belongs to different input.');
      return prior;
    }
    const device = this.device(parsed.deviceId);
    if (device.lastSeenAt <= this.now() - 15000 || !computerAccessActive(device.enabledUntil, this.now())) throw new Fault(409, 'computer_offline', 'Open the desktop companion and enable computer access on the selected computer. Host work can continue.');
    if (this.all().some(op => op.call.deviceId === device.id && ['queued', 'claimed'].includes(op.state))) throw new Fault(409, 'computer_busy', 'Wait for the selected computer’s current action to finish.');
    if (this.all().length >= 3000) throw new Fault(507, 'computer_history_full', 'Computer history is full. Existing results remain available.');
    const op: CompanionOperation = { id, ownerId, epoch: this.store.epoch, call: parsed, createdAt: this.now(), expiresAt: Math.min(device.enabledUntil ?? Infinity, this.now() + 2 * 60000), state: 'queued' };
    this.checks.set(id, authorize); this.save(op); return op;
  }
  result(id: string, ownerId: string) {
    let op = this.store.internalRead<CompanionOperation>(operationKey(id));
    if (!op || op.ownerId !== ownerId || op.epoch !== this.store.epoch) throw new Fault(404, 'computer_result_missing', 'This result does not belong to the current request.');
    if (op.expiresAt <= this.now() && ['queued', 'claimed'].includes(op.state)) op = this.save({ ...op, state: op.state === 'queued' ? 'cancelled' : 'unknown', message: 'The computer action expired. It will not be repeated.' });
    return op;
  }
  packet(raw: unknown) {
    const input = companionPacketSchema.parse(raw), device = this.device(input.deviceId);
    if (input.epoch !== this.store.epoch || Math.abs(input.issuedAt - this.now()) > 60000 || !checkSignature(device.publicKey, companionSignedData(input), input.signature)) throw proofError();
    const receiptKey = 'companion:packet:' + input.deviceId;
    const receipt = this.store.internalRead<{ id: string; input: string; result: unknown; at: number }>(receiptKey);
    const digest = canonical(input);
    if (receipt?.id === input.requestId) { if (receipt.input !== digest) throw proofError(); return receipt.result; }
    if (receipt && input.issuedAt <= receipt.at) throw proofError();
    const result = this.store.internalAtomic(() => {
      if (input.action === 'disconnect') { this.store.internalWrite(deviceKey(device.id), { ...device, enabledUntil: 0, lastSeenAt: 0, apps: [] }); this.cancelDevice(device.id, 'The desktop disconnected.'); return { disconnected: true }; }
      if (input.action === 'poll') {
        const status = bounded.parse(input.payload);
        if (Buffer.byteLength(JSON.stringify(status.tools ?? [])) > 180000) throw new Fault(413, 'computer_catalog', 'The computer tool catalog is too large.');
        if (status.enabledUntil !== null && status.enabledUntil > this.now() + 61 * 60000) throw new Fault(400, 'computer_duration', 'Choose a timed session up to one hour or explicitly enable access until stopped.');
        this.store.internalWrite(deviceKey(device.id), { ...device, ...status, lastSeenAt: this.now() });
        if (!computerAccessActive(status.enabledUntil, this.now())) this.cancelDevice(device.id, 'Computer access is off.');
        for (const item of this.all().filter(op => op.call.deviceId === device.id && ['queued', 'claimed'].includes(op.state))) {
          const op = this.result(item.id, item.ownerId);
          if (op.state !== 'queued') continue;
          try { this.checks.get(op.id)?.(); if (!this.checks.has(op.id)) throw Error(); }
          catch { this.save({ ...op, state: 'cancelled', message: 'The originating request ended or lost permission.' }); continue; }
          return { operation: op };
        }
        return { operation: null };
      }
      const id = z.uuid().parse(input.payload.id), existing = this.store.internalRead<CompanionOperation>(operationKey(id));
      if (!existing || existing.call.deviceId !== device.id || existing.epoch !== this.store.epoch) throw proofError();
      const op = this.result(id, existing.ownerId);
      if (input.action === 'claim') {
        if (op.state !== 'queued' || !computerAccessActive(device.enabledUntil, this.now()) || !this.checks.has(op.id)) throw new Fault(409, 'computer_claimed', 'This action is no longer available for execution.');
        this.checks.get(op.id)!(); this.save({ ...op, state: 'claimed' });
        return { claimed: true, operation: { ...op, state: 'claimed' } };
      }
      const completed = z.object({ id: z.uuid(), state: z.enum(['completed', 'refused', 'unknown']), result: z.unknown() }).strict().parse(input.payload);
      if (Buffer.byteLength(JSON.stringify(completed.result)) > 400000) throw new Fault(413, 'computer_result_large', 'The computer result exceeded its bounded size.');
      if (['completed', 'refused'].includes(op.state)) { if (op.state !== completed.state || canonical(op.result) !== canonical(completed.result)) throw new Fault(409, 'computer_result_conflict', 'Keep the original computer result.'); return { received: true }; }
      // A desktop journals intent before claiming. If that request never
      // arrived, its restart must retire the queued action, not replay it.
      if (completed.state === 'unknown' && ['queued', 'cancelled'].includes(op.state)) {
        this.save({ ...op, state: 'cancelled', message: 'The desktop interrupted admission. This action will not be repeated.' }); this.checks.delete(id);
        return { received: true };
      }
      if (!['claimed', 'unknown'].includes(op.state)) throw new Fault(409, 'computer_not_claimed', 'This action was not admitted for execution.');
      this.save({ ...op, state: completed.state, result: completed.result }); this.checks.delete(id);
      return { received: true };
    });
    this.store.internalWrite(receiptKey, { id: input.requestId, input: digest, result, at: input.issuedAt }); return result;
  }
  private cancelDevice(id: string, message: string) {
    for (const op of this.all()) if (op.call.deviceId === id && ['queued', 'claimed'].includes(op.state)) { this.save({ ...op, state: op.state === 'queued' ? 'cancelled' : 'unknown', message }); this.checks.delete(op.id); }
  }
  close() { this.closed = true; this.checks.clear(); }
}
