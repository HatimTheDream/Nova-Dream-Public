import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { phoneCommandSchema, phonePairSchema, phoneRevokeSchema, type PhoneDevice, type PhonePairing } from '../../packages/domain/phone.js';
import { Fault, Store } from './store.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pairedKey = (id: string) => 'phone:device:' + id;
type Device = PhoneDevice & { epoch: string; tokenDigest: string };
type Challenge = { epoch: string; codeDigest: string; expiresAt: number };
type PairReceipt = { requestId: string; digest: string; epoch: string; token: string; deviceId: string; createdAt: number };
const required = () => new Fault(401, 'phone_pair_required', 'Pair this phone from Settings on your computer. Your saved device drafts are kept.');

/** Adapts the predecessor's one-use, expiring pairing and digest-only device
 * authorization to E3's encrypted shared store. No desktop session bootstrap. */
export class PhoneAccess {
  constructor(private store: Store, private now: () => number = Date.now) {}
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
      if (receipt) {
        if (receipt.digest !== digest(canonical(input))) throw new Fault(409, 'request_reused', 'This pairing request was already used for different details.');
        if (receipt.epoch !== this.store.epoch || receipt.createdAt + 30 * 60000 <= now) throw required();
        const deviceId = this.authenticate(receipt.token);
        if (deviceId !== receipt.deviceId) throw required();
        return { token: receipt.token, deviceId };
      }
    }
    const tries = this.store.internalRead<number[]>('phone:pair-attempts')?.filter(time => time > now - 5 * 60000) ?? [];
    if (tries.length >= 8) throw new Fault(429, 'phone_pair_throttled', 'Too many pairing attempts. Wait five minutes, then create a new code on your computer.');
    this.store.internalWrite('phone:pair-attempts', [...tries, now]);
    if (!parsed.success) throw required();
    const input = parsed.data;
    return this.store.internalAtomic(() => {
      const challenge = this.store.internalRead<Challenge>('phone:challenge');
      if (!challenge || challenge.epoch !== this.store.epoch || challenge.expiresAt <= now || !equal(challenge.codeDigest, digest(input.code))) throw required();
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
  }
  authenticate(token: string): string {
    if (!this.enabled || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw required();
    const tokenDigest = digest(token), now = this.now();
    const device = this.store.internalList<Device>('phone:device:').find(item => item.epoch === this.store.epoch && item.revokedAt === undefined && item.expiresAt > now && equal(item.tokenDigest, tokenDigest));
    if (!device) throw required();
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
