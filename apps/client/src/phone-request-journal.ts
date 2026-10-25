import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';
import { phonePairSchema, phoneCommandSchema, phoneRevokeSchema, pairingRejectionSchema, type PairingRejection } from '../../../packages/domain/phone';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export type PairInput = z.infer<typeof phonePairSchema>;
type PairAttempt = { request: PairInput; sha256?: string; state: 'pending' | 'confirmed' | 'rejected'; deviceId?: string; proof?: PairingRejection };
type PairRecord = { format: 1; current?: PairAttempt; history: PairAttempt[] };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pairAttempt = z.object({ request: phonePairSchema, sha256: hash.optional(), state: z.enum(['pending', 'confirmed', 'rejected']),
  deviceId: z.uuid().optional(), proof: pairingRejectionSchema.optional() }).strict().refine(value =>
  value.state === 'pending' || value.state === 'confirmed' && !!value.deviceId
  || value.state === 'rejected' && !!value.proof && value.proof.sha256 === value.sha256 && value.proof.requestId === value.request.requestId);
const pairRecord = z.object({ format: z.literal(1), current: pairAttempt.optional(), history: z.array(pairAttempt).max(16) }).strict();

/** Preserve legacy raw bytes. New records keep bounded complete original requests. */
export class PairingJournal {
  private raw: string | null = null;
  private legacy: string | null = null;
  private invalid = false;
  private attempted?: string;
  private staged?: PairRecord;
  value: PairRecord = { format: 1, history: [] };
  error = '';
  readonly key = 'e3:phone-pair:v2';
  constructor(private storage: Storage) {
    try {
      this.raw = storage.getItem(this.key);
      if (this.raw !== null) {
        if (this.raw.length > 65536) throw Error();
        this.value = pairRecord.parse(JSON.parse(this.raw));
      } else {
        this.legacy = storage.getItem('e3:phone-pair');
        if (this.legacy !== null) {
          if (this.legacy.length > 2048) throw Error();
          const value = JSON.parse(this.legacy);
          if (value !== null) this.value.current = { request: phonePairSchema.parse(value), state: 'pending' };
        }
      }
    } catch { this.invalid = true; this.error = 'The original pairing request could not be read. Its stored copy is kept.'; }
  }
  get current() { return this.staged?.current ?? this.value.current; }
  private write(value: PairRecord) {
    this.staged = value;
    try {
      if (this.invalid || !pairRecord.safeParse(value).success) throw Error();
      const next = canonical(value), before = this.storage.getItem(this.key);
      if (before !== this.raw && !(before === this.attempted && before === next)
        || this.raw === null && this.storage.getItem('e3:phone-pair') !== this.legacy) throw Error();
      this.attempted = next; this.storage.setItem(this.key, next);
      if (this.storage.getItem(this.key) !== next) throw Error();
      this.value = value; this.raw = next; this.staged = undefined; this.attempted = undefined; this.error = ''; return true;
    } catch { this.error = 'Keep this window open. The complete original pairing request could not be retained.'; return false; }
  }
  begin(input: PairInput, sha256: string) {
    const previous = this.current;
    if (previous && (previous.state !== 'pending' || canonical(previous.request) !== canonical(input)) || !hash.safeParse(sha256).success) return false;
    return this.write({ ...this.value, current: { request: input, sha256, state: 'pending' } });
  }
  settle(input: PairInput, sha256: string, result: unknown, rejection = false) {
    const current = this.current;
    if (!current || current.state !== 'pending' || current.sha256 !== sha256 || canonical(current.request) !== canonical(input)) return false;
    if (rejection) {
      const parsed = pairingRejectionSchema.safeParse(result);
      if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.sha256 !== sha256) return false;
      return this.write({ ...this.value, current: { ...current, state: 'rejected', proof: parsed.data } });
    }
    const parsed = z.object({ deviceId: z.uuid(), apiVersion: z.literal(1) }).strict().safeParse(result);
    return parsed.success && this.write({ ...this.value, current: { ...current, state: 'confirmed', deviceId: parsed.data.deviceId } });
  }
  reviewNewCode() {
    const current = this.current;
    if (!current || current.state === 'pending' || this.value.history.length >= 16) { this.error = 'The original pairing history is kept. Review it before adding another attempt.'; return false; }
    return this.write({ format: 1, history: [...this.value.history, current] });
  }
  retryRetention() { return !!this.staged && this.write(this.staged); }
}
export type PhoneCommand = { path: 'phone/enable' | 'phone/disable' | 'phone/pairing' | 'phone/revoke'; body: { requestId: string; epoch: string; deviceId?: string } };
export function phoneResultValid(path: PhoneCommand['path'], value: unknown): boolean {
  if (path === 'phone/revoke') return z.object({ revoked: z.literal(true) }).strict().safeParse(value).success;
  if (path === 'phone/pairing') return z.object({ code: z.string().regex(/^\d{4}-?\d{4}$/), expiresAt: z.number().int().nonnegative() }).strict().safeParse(value).success;
  return z.object({ enabled: z.boolean(), route: z.object({ state: z.enum(['off', 'checking', 'ready', 'unavailable', 'error']), message: z.string() }),
    devices: z.array(z.object({ id: z.uuid(), name: z.string(), expiresAt: z.number(), lastSeenAt: z.number(), pairedAt: z.number() })).max(1000) }).safeParse(value).success;
}
const commandSchema = z.object({ path: z.enum(['phone/enable', 'phone/disable', 'phone/pairing', 'phone/revoke']),
  body: phoneRevokeSchema.or(phoneCommandSchema), confirmed: z.boolean().optional() }).strict().refine(value =>
  value.path === 'phone/revoke' ? 'deviceId' in value.body : !('deviceId' in value.body));
export class PhoneCommandJournal {
  value?: PhoneCommand & { confirmed?: boolean };
  error = '';
  private raw: string | null = null;
  private invalid = false;
  private attempted?: string;
  private legacy: string | null = null;
  readonly key: string;
  constructor(private storage: Storage, private epoch: string, private deviceId: string) {
    this.key = `e3:phone-command:${epoch}:${deviceId}`;
    try {
      this.raw = storage.getItem(this.key);
      this.legacy = this.raw === null ? storage.getItem(`e3:phone-command:${deviceId}`) : null;
      const raw = this.raw ?? this.legacy;
      if (raw !== null) {
        if (raw.length > 4096) throw Error();
        const value = JSON.parse(raw);
        if (value !== null) {
          const parsed = commandSchema.parse(value);
          if (parsed.body.epoch === epoch) this.value = parsed;
          else if (this.raw !== null) throw Error();
        }
      }
    } catch { this.invalid = true; this.error = 'The original phone access request could not be read. Its stored copy is kept.'; }
  }
  get pending() { return this.value && !this.value.confirmed ? this.value : undefined; }
  keep(value: PhoneCommand & { confirmed?: boolean }) {
    try {
      if (this.invalid || value.body.epoch !== this.epoch || !commandSchema.safeParse(value).success
        || this.pending && canonical({ path: this.pending.path, body: this.pending.body }) !== canonical({ path: value.path, body: value.body })) throw Error();
      const next = canonical(value), raw = this.storage.getItem(this.key);
      if (raw !== this.raw && !(raw === this.attempted && raw === next)
        || this.raw === null && this.storage.getItem(`e3:phone-command:${this.deviceId}`) !== this.legacy) throw Error();
      this.attempted = next; this.storage.setItem(this.key, next);
      if (this.storage.getItem(this.key) !== next) throw Error();
      this.value = value; this.raw = next; this.attempted = undefined; this.error = ''; return true;
    } catch { this.error = 'Keep this window open. The original phone access change could not be retained.'; return false; }
  }
}
