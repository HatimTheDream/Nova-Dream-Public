import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { phoneCommandSchema, phonePairSchema, phoneRevokeSchema, type PhoneDevice, type PhonePairing, type PairingRejection, type AccessContext } from '../../packages/domain/phone.js';
import { Fault, Store } from './store.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pairedKey = (id: string) => 'phone:device:' + id;
type Device = PhoneDevice & { epoch: string; tokenDigest: string };
type Challenge = { epoch: string; codeDigest: string; expiresAt: number };
type PairReceipt = { requestId: string; digest: string; epoch: string; token: string; deviceId: string; createdAt: number };
type RejectedPair = { requestId: string; digest: string; epoch: string; deadline?: number; proof: PairingRejection };
const required = () => new Fault(401, 'phone_pair_required', 'Pair this phone from Settings on your computer. Your saved device drafts are kept.');

/** Adapts the predecessor's one-use, expiring pairing and digest-only device
 * authorization to E3's encrypted shared store. No desktop session bootstrap. */
export class PhoneAccess {
  constructor(private store: Store, private now: () => number = Date.now) {}
  pairingReason(token: string): AccessContext['pairingReason'] {
    if (!this.enabled) return 'disabled';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return 'required';
    const tokenDigest = digest(token), device = this.store.internalList<Device>('phone:device:')
      .find(item => item.epoch === this.store.epoch && equal(item.tokenDigest, tokenDigest));
    return !device ? 'required' : device.revokedAt !== undefined ? 'revoked' : device.expiresAt <= this.now() ? 'expired' : undefined;
  }
  get enabled() { return this.store.internalRead<{ enabled: boolean }>('phone:access')?.enabled === true; }
  devices(): PhoneDevice[] {
    return this.store.internalList<Device>('phone:device:').filter(device => device.epoch === this.store.epoch).map(({ tokenDigest: _token, epoch: _epoch, ...device }) => device);
  }
  setEnabled(device: string, raw: unknown, enabled: boolean) {
    const input = phoneCommandSchema.parse(raw);
    return this.store.admit(device, input, { type: 'phone.access', ...input, enabled }, () => {
      this.store.internalWrite('phone:access', { enabled });
      if (!enabled) {
        this.store.internalDelete('phone:challenge');
        for (const paired of this.store.internalList<Device>('phone:device:')) if (paired.revokedAt === undefined) this.store.internalWrite(pairedKey(paired.id), { ...paired, revokedAt: this.now() });
      }
      return { enabled };
    });
  }
  startPairing(device: string, raw: unknown): PhonePairing {
    const input = phoneCommandSchema.parse(raw);
    if (!this.enabled) throw new Fault(409, 'phone_access_off', 'Enable private phone access before creating a pairing code.');
    return this.store.admit(device, input, { type: 'phone.pairing', ...input }, () => {
      if (this.devices().filter(item => item.revokedAt === undefined && item.expiresAt > this.now()).length >= 12) throw new Fault(409, 'phone_device_limit', 'Remove a paired device before adding another.');
      const code = String(randomInt(10000000, 100000000)), expiresAt = this.now() + 5 * 60000;
      this.store.internalWrite('phone:challenge', { epoch: this.store.epoch, codeDigest: digest(code), expiresAt } satisfies Challenge);
      return { code: code.match(/.{4}/g)!.join('-'), expiresAt };
    }).value;
  }
  pair(raw: unknown, previousToken = ''): { token: string; deviceId: string } {
    if (!this.enabled) throw required();
    // Count malformed attempts too. Persist the small global window so a
    // service restart cannot reset the predecessor's pairing rate limit.
    const parsed = phonePairSchema.safeParse(raw);
    const now = this.now();
    if (parsed.success) {
      const input = parsed.data, receipt = this.store.internalRead<PairReceipt>('phone:pair-receipt:' + input.requestId);
      const rejection = this.store.internalRead<RejectedPair>('phone:pair-rejection:' + input.requestId);
      if (rejection) {
        if (rejection.digest !== digest(canonical(input))) throw new Fault(409, 'request_reused', 'This pairing request was already used for different details.');
        throw new Fault(401, 'phone_pair_rejected', 'Pair this phone with a new owner code. The original rejected request cannot run.', rejection.proof);
      }
      if (receipt) {
        if (receipt.digest !== digest(canonical(input))) throw new Fault(409, 'request_reused', 'This pairing request was already used for different details.');
        if (receipt.epoch !== this.store.epoch) throw required();
        if (receipt.createdAt + 30 * 60000 <= now) return this.rejectPair(input, 'session_expired');
        let deviceId: string;
        try { deviceId = this.authenticate(receipt.token); }
        catch { return this.rejectPair(input, this.pairingReason(receipt.token) === 'revoked' ? 'session_revoked' : 'session_expired'); }
        if (deviceId !== receipt.deviceId) throw required();
        return { token: receipt.token, deviceId };
      }
    }
    const tries = this.store.internalRead<number[]>('phone:pair-attempts')?.filter(time => time > now - 5 * 60000) ?? [];
    if (tries.length >= 8) throw new Fault(429, 'phone_pair_throttled', 'Too many pairing attempts. Wait five minutes, then create a new code on your computer.');
    this.store.internalWrite('phone:pair-attempts', [...tries, now]);
    if (!parsed.success) throw required();
    const input = parsed.data;
    if (input.expiresAt !== undefined && input.expiresAt <= now) return this.rejectPair(input, 'request_expired');
    if (input.expiresAt !== undefined && input.expiresAt > now + 10 * 60000) return this.rejectPair(input, 'clock_mismatch');
    const result = this.store.internalAtomic<{ rejection: PairingRejection } | { token: string; deviceId: string }>(() => {
      const challenge = this.store.internalRead<Challenge>('phone:challenge');
      if (!challenge || challenge.epoch !== this.store.epoch || challenge.expiresAt <= now || !equal(challenge.codeDigest, digest(input.code)))
        return { rejection: this.keepRejection(input, 'code_unavailable') };
      for (const old of this.store.internalList<Device>('phone:device:').filter(item => item.revokedAt !== undefined || item.expiresAt <= now).sort((a, b) => b.pairedAt - a.pairedAt).slice(49)) this.store.internalDelete(pairedKey(old.id));
      // A fresh owner code may re-pair this same browser. Proof comes only
      // from its old HttpOnly cookie, never a caller-provided device ID. Rotate
      // authorization while retaining the identity used by its unsent writing.
      const previous = /^[A-Za-z0-9_-]{43}$/.test(previousToken) ? this.store.internalList<Device>('phone:device:').find(item => item.epoch === this.store.epoch && equal(item.tokenDigest, digest(previousToken))) : undefined;
      const token = randomBytes(32).toString('base64url'), id = previous?.id ?? randomUUID();
      this.store.internalWrite(pairedKey(id), { id, epoch: this.store.epoch, name: input.name, tokenDigest: digest(token), pairedAt: now, lastSeenAt: now, expiresAt: now + 30 * 86400000 } satisfies Device);
      this.store.internalWrite('phone:pair-receipt:' + input.requestId, { requestId: input.requestId, digest: digest(canonical(input)), epoch: this.store.epoch, token, deviceId: id, createdAt: now } satisfies PairReceipt);
      this.store.internalDelete('phone:challenge');
      for (const old of this.store.internalList<PairReceipt>('phone:pair-receipt:')) if (old.createdAt + 30 * 60000 <= now) this.store.internalDelete('phone:pair-receipt:' + old.requestId);
      return { token, deviceId: id };
    });
    if ('rejection' in result) throw this.rejectionFault(result.rejection);
    return result;
  }
  private rejectPair(input: ReturnType<typeof phonePairSchema.parse>, reason: PairingRejection['reason']): never {
    throw this.rejectionFault(this.store.internalAtomic(() => this.keepRejection(input, reason)));
  }
  private keepRejection(input: ReturnType<typeof phonePairSchema.parse>, reason: PairingRejection['reason']): PairingRejection {
    const now = this.now(), value = digest(canonical(input));
    const proof: PairingRejection = { format: 1, requestId: input.requestId, sha256: value, state: 'rejected', reason };
    // A finite deadline refuses this identity after its fence expires. Legacy
    // requests have no deadline, so their bounded fences are kept permanently.
    for (const old of this.store.internalList<RejectedPair>('phone:pair-rejection:'))
      if (old.deadline !== undefined && old.deadline <= now) this.store.internalDelete('phone:pair-rejection:' + old.requestId);
    const deadline = input.expiresAt !== undefined && input.expiresAt <= now + 10 * 60000 ? input.expiresAt : undefined;
    if (deadline === undefined && this.store.internalList<RejectedPair>('phone:pair-rejection:').filter(row => row.deadline === undefined).length >= 512)
      throw new Fault(507, 'phone_pair_history_full', 'The earlier pairing requests are kept. Pairing recovery needs host review.');
    if (deadline === undefined || deadline > now) this.store.internalWrite('phone:pair-rejection:' + input.requestId,
      { requestId: input.requestId, digest: value, epoch: this.store.epoch, ...(deadline === undefined ? {} : { deadline }), proof } satisfies RejectedPair);
    return proof;
  }
  private rejectionFault(proof: PairingRejection) {
    const reason = proof.reason;
    return new Fault(401, 'phone_pair_rejected', reason === 'request_expired' ? 'Pair this phone again: the original request is past its admission deadline.'
      : reason === 'clock_mismatch' ? 'Pair this phone again after checking this device’s clock.'
        : reason === 'session_revoked' ? 'Pair this phone again: its previous access was removed.'
          : reason === 'session_expired' ? 'Pair this phone again: its previous session expired.'
            : 'Pair this phone with a new owner code. The original code expired or is no longer available.', proof);
  }
  private authenticatedDevice(token: string) {
    if (!this.enabled || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw required();
    const tokenDigest = digest(token), now = this.now();
    const device = this.store.internalList<Device>('phone:device:').find(item => item.epoch === this.store.epoch && item.revokedAt === undefined && item.expiresAt > now && equal(item.tokenDigest, tokenDigest));
    if (!device) throw required();
    return { device, now };
  }
  /** Recheck the original token without turning background reads into last-seen writes. */
  checkAuthentication(token: string): string { return this.authenticatedDevice(token).device.id; }
  authenticate(token: string): string {
    const { device, now } = this.authenticatedDevice(token);
    if (device.lastSeenAt + 5 * 60000 < now) this.store.internalWrite(pairedKey(device.id), { ...device, lastSeenAt: now });
    return device.id;
  }
  revoke(owner: string, raw: unknown) {
    const input = phoneRevokeSchema.parse(raw);
    return this.store.admit(owner, input, { type: 'phone.revoke', ...input }, () => {
      const device = this.store.internalRead<Device>(pairedKey(input.deviceId));
      if (!device || device.epoch !== this.store.epoch) throw new Fault(404, 'phone_device_missing', 'This device is no longer paired with this workspace.');
      if (device.revokedAt === undefined) this.store.internalWrite(pairedKey(device.id), { ...device, revokedAt: this.now() });
      return { revoked: true };
    });
  }
}
