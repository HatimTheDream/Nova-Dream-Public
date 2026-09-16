import { contactEmails } from '../../packages/domain/contacts.js';
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { contactEmailKey, mailContactPrepareSchema, mailContactLinkSchema, type MailContactReview, type MailContactProposal, type MailContactPrepare } from '../../packages/domain/mail-contact.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';

const invalid = (): never => { throw new Fault(409, 'mail_contact_source', 'The selected sender could not be verified. Refresh this email before linking a Contact.'); };
const line = z.string().max(4000).refine(value => !/[\r\n\0]/.test(value));
/** Read exactly the selected message. A thread summary's latest sender is not
 * interchangeable with the sender of the message the user chose. */
export async function mailContactSender(input: MailContactPrepare, raw: unknown) {
  let from = '', subject = '';
  if (input.source.provider === 'google') {
    const parsed = z.object({ thread: z.object({ id: z.string(), messages: z.array(z.object({ id: z.string(), threadId: z.string().optional(), labelIds: z.array(z.string()).optional(), payload: z.object({ headers: z.array(z.object({ name: z.string(), value: line })).default([]) }) })) }) }).safeParse(raw);
    if (!parsed.success || parsed.data.thread.id !== input.source.threadId) return invalid();
    const matches = parsed.data.thread.messages.filter(message => message.id === input.messageId);
    if (matches.length !== 1 || matches[0].threadId && matches[0].threadId !== input.source.threadId || matches[0].labelIds?.includes('DRAFT')) return invalid();
    const headers = matches[0].payload.headers;
    const senders = headers.filter(header => header.name.toLowerCase() === 'from');
    if (senders.length !== 1) return invalid();
    from = senders[0].value; subject = headers.find(header => header.name.toLowerCase() === 'subject')?.value ?? '';
  } else {
    const parsed = z.object({ messages: z.array(z.object({ id: z.string(), conversationId: z.string(), from: line, subject: z.string().max(4000).optional(), isDraft: z.boolean().optional() })) }).safeParse(raw);
    if (!parsed.success) return invalid();
    const matches = parsed.data.messages.filter(message => message.id === input.messageId);
    if (matches.length !== 1 || matches[0].conversationId !== input.source.threadId || matches[0].isDraft) return invalid();
    from = matches[0].from; subject = matches[0].subject ?? '';
  }
  const parsed = await simpleParser(`From: ${from}\r\n\r\n`, { skipHtmlToText: true, skipTextToHtml: true });
  const addresses = parsed.from?.value;
  if (addresses?.length !== 1 || addresses[0].group || !z.email().max(254).safeParse(addresses[0].address).success) return invalid();
  return { sender: addresses[0].address!, name: (addresses[0].name || addresses[0].address!).slice(0, 240), subject: subject.slice(0, 500) };
}

export class MailContacts {
  constructor(private store: Store, private accounts: Accounts, private now: () => number = Date.now) {}
  private assertAccount(device: string, input: MailContactPrepare) {
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen the email after workspace recovery.');
    const account = this.accounts.state(device).accounts.find(item => item.id === input.source.accountId);
    if (!account || account.provider !== input.source.provider || account.generation !== input.generation || !account.capabilities.mailRead || !['connected', 'refreshing'].includes(account.state)) throw new Fault(409, 'account_changed', 'Refresh the original mail account before linking this sender.');
  }
  async prepare(device: string, raw: unknown): Promise<MailContactProposal> {
    const input = mailContactPrepareSchema.parse(raw); this.assertAccount(device, input);
    const selector = input.source.provider === 'google' ? { kind: 'gmail.thread' as const, threadId: input.source.threadId } : { kind: 'microsoft.conversation' as const, conversationId: input.source.threadId, messageId: input.messageId };
    const page = await this.accounts.mailRead(input.source.accountId, input.generation, selector);
    const sender = await mailContactSender(input, page.value); this.assertAccount(device, input);
    const review: MailContactReview = { id: randomUUID(), device, epoch: input.epoch, generation: input.generation, source: { ...input.source, messageId: input.messageId, sender: sender.sender, subject: sender.subject }, name: sender.name, createdAt: this.now() };
    // Reviews carry no message bodies or provider credentials.
    for (const old of this.store.internalList<MailContactReview>('mail:contact-review:')) if (old.createdAt < this.now() - 30 * 86400000) this.store.internalDelete('mail:contact-review:' + old.id);
    this.store.internalWrite('mail:contact-review:' + review.id, review);
    const matches = this.store.listEntities('contact').filter(item => !item.value.mergedInto && contactEmails(item.value).includes(contactEmailKey(sender.sender))).map(item => ({ id: item.id, revision: item.revision, name: item.value.name, email: item.value.email, organization: item.value.organization, archived: item.value.archived }));
    return { review, matches };
  }
  link(device: string, raw: unknown) {
    const input = mailContactLinkSchema.parse(raw);
    return this.store.linkMailContact(device, input, review => {
      if (review.device !== device || review.epoch !== input.epoch || review.createdAt < this.now() - 30 * 60000) throw new Fault(409, 'mail_contact_review', 'Review this sender again before saving a Contact.');
      this.assertAccount(device, { epoch: input.epoch, generation: review.generation, source: { provider: review.source.provider, accountId: review.source.accountId, threadId: review.source.threadId }, messageId: review.source.messageId });
    });
  }
}
