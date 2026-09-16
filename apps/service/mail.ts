import { createHash, randomUUID } from 'node:crypto';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { canonical } from '../../packages/domain/contracts.js';
import { mailReadSchema, type MailReadResult } from '../../packages/domain/mail.js';

type MailCursor = { id: string; device: string; accountId: string; generation: string; fingerprint: string; next: string; seen: string[]; expires: number };
export class MailService {
  constructor(private store: Store, private accounts: Accounts, private now: () => number = Date.now) {}
  async read(device: string, raw: unknown): Promise<MailReadResult> {
    const request = mailReadSchema.parse(raw);
    if (request.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Open this mailbox again after workspace recovery.');
    const fingerprint = createHash('sha256').update(canonical(request.selector)).digest('hex');
    const cursor = request.cursor && this.store.internalRead<MailCursor>(`mail:cursor:${request.cursor}`);
    if (request.cursor && (!cursor || cursor.device !== device || cursor.accountId !== request.accountId || cursor.generation !== request.generation || cursor.fingerprint !== fingerprint || cursor.expires <= this.now())) throw new Fault(409, 'mail_cursor_changed', 'This mail page belongs to an older view. Refresh the current folder.');
    const page = await this.accounts.mailRead(request.accountId, request.generation, request.selector, cursor ? cursor.next : undefined);
    // Account generation has been checked after the provider completed. Do not
    // publish an old workspace's response or continuation after recovery.
    if (request.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed while this mailbox was loading.');
    const seen = cursor ? cursor.seen ?? [] : [];
    if (page.next) {
      const digest = createHash('sha256').update(page.next).digest('hex');
      if (seen.includes(digest) || seen.length >= 250) {
        page.next = undefined;
        page.message = seen.includes(digest) ? 'The provider repeated a mail page. This view is incomplete; refresh the folder.' : 'This mail view reached its page limit and is incomplete. Narrow the view before loading more.';
      } else seen.push(digest);
    }
    let nextCursor: string | undefined;
    if (page.next) {
      const cursors = this.store.internalList<MailCursor>('mail:cursor:').sort((a, b) => a.expires - b.expires);
      const expired = cursors.filter(entry => entry.expires <= this.now()), live = cursors.filter(entry => entry.expires > this.now());
      for (const entry of [...expired, ...live.slice(0, Math.max(0, live.length - 499))]) this.store.internalDelete(`mail:cursor:${entry.id}`);
      nextCursor = randomUUID();
      this.store.internalWrite(`mail:cursor:${nextCursor}`, { id: nextCursor, device, accountId: request.accountId, generation: request.generation, fingerprint, next: page.next, seen, expires: this.now() + 30 * 60000 } satisfies MailCursor);
    }
    return { accountId: request.accountId, generation: request.generation, kind: request.selector.kind, value: page.value, readAt: new Date(this.now()).toISOString(), coverage: page.message ? 'partial' : nextCursor ? 'page' : 'complete', ...(nextCursor ? { nextCursor } : {}), ...(page.message ? { message: page.message } : {}) };
  }
}
