import { dayInZone, nextDay } from '../../packages/domain/tasks.js';
import { mailCalendarKey } from '../../packages/domain/calendar-followups.js';
import type { CalendarService } from './calendar.js';
import type { MailContactSource } from '../../packages/domain/mail-contact.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { contactDirectoryReadSchema, type ContactDirectoryResult, type InboxSender } from '../../packages/domain/contact-directory.js';
import { contactEmails } from '../../packages/domain/contacts.js';
import type { Accounts } from './accounts.js';
import type { MailIndexService } from './mail-index.js';
import { Fault, Store } from './store.js';

/** A bounded projection of existing Inbox indexes, never an automatic address-book import. */
export class ContactDirectory {
  private parsed = new Map<string, { name: string; email: string } | null>();
  constructor(private store: Store, private accounts: Pick<Accounts, 'state'>, private index: Pick<MailIndexService, 'read'>, private calendar?: Pick<CalendarService, 'state'>) {}
  private async sender(from: string) {
    if (this.parsed.has(from)) return this.parsed.get(from)!;
    let sender: { name: string; email: string } | null = null;
    if (from.length <= 4000 && !/[\r\n\0]/.test(from)) {
      const addresses = (await simpleParser(`From: ${from}\r\n\r\n`, { skipHtmlToText: true, skipTextToHtml: true })).from?.value;
      const address = addresses?.[0];
      if (addresses?.length === 1 && address && !address.group && z.email().max(254).safeParse(address.address).success) sender = { name: (address.name || address.address!).slice(0, 240), email: address.address!.trim().toLowerCase() };
    }
    if (this.parsed.size >= 5000) this.parsed.delete(this.parsed.keys().next().value!);
    this.parsed.set(from, sender); return sender;
  }
  async read(device: string, raw: unknown): Promise<ContactDirectoryResult> {
    const input = contactDirectoryReadSchema.parse(raw);
    const fence = () => { if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen Contacts after workspace recovery.'); };
    fence();
    const contacts = this.store.listEntities('contact').filter(contact => !contact.value.mergedInto);
    const selected = input.contactId ? contacts.find(contact => contact.id === input.contactId) : undefined;
    if (input.contactId && !selected) throw new Fault(404, 'record_missing', 'This contact is unavailable.');
    const selectedEmails = selected ? contactEmails(selected.value) : [];
    const known = new Map<string, string | undefined>(); for (const contact of contacts.filter(contact => !contact.value.archived)) for (const email of contactEmails(contact.value)) known.set(email, known.has(email) ? undefined : contact.id);
    const accounts = this.accounts.state(device).accounts.filter(account => ['connected', 'refreshing'].includes(account.state) && account.capabilities.mailRead);
    const result: ContactDirectoryResult = { senders: [], total: 0, next: null, correspondence: [], accounts: accounts.length, partial: false, unavailable: 0 };
    const byEmail = new Map<string, InboxSender>(), candidates: InboxSender[] = []; let remaining = 50000;
    for (const account of accounts) {
      const current = () => { fence(); const next = this.accounts.state(device).accounts.find(item => item.id === account.id); return next?.generation === account.generation && next.capabilities.mailRead && ['connected', 'refreshing'].includes(next.state); };
      // Build each account's result separately so a connection revoked mid-read contributes nothing.
      const senders: InboxSender[] = [], correspondence: ContactDirectoryResult['correspondence'] = [];
      try {
        const read = await this.index.read(device, { epoch: input.epoch, accountId: account.id, generation: account.generation });
        const snapshot = read.snapshot; result.partial ||= !snapshot?.exhausted;
        let count = 0;
        for (const thread of snapshot?.threads ?? []) {
          if (--remaining < 0) { result.partial = true; break; }
          if (++count % 100 === 0) { await yieldTurn(); if (!current()) break; }
          if (!thread.sourceMessageId) continue;
          const sender = await this.sender(thread.from); if (!sender) continue;
          const source = { provider: account.provider, accountId: account.id, threadId: thread.id };
          if (!input.contactId && [sender.name, sender.email].join(' ').toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase())) senders.push({ ...sender, lastAt: thread.date, conversations: 1, contactId: known.get(sender.email), input: { epoch: input.epoch, generation: account.generation, source, messageId: thread.sourceMessageId } });
          if (selectedEmails.includes(sender.email)) correspondence.push({ source: { ...source, messageId: thread.sourceMessageId, sender: sender.email, subject: thread.subject.slice(0, 500) }, date: thread.date });
        }
        if (!current()) { result.unavailable++; continue; }
        candidates.push(...senders);
        result.correspondence.push(...correspondence);
      } catch (error) { fence(); if (error instanceof Fault && error.code === 'epoch_changed') throw error; result.unavailable++; }
    }
    fence();
    // Recheck all connections once more after the final asynchronous account read.
    const valid = new Set(this.accounts.state(device).accounts.filter(account => accounts.some(original => original.id === account.id && original.generation === account.generation) && account.capabilities.mailRead && ['connected', 'refreshing'].includes(account.state)).map(account => account.id));
    for (const sender of candidates.filter(sender => valid.has(sender.input.source.accountId))) { const existing = byEmail.get(sender.email); byEmail.set(sender.email, existing ? { ...(sender.lastAt > existing.lastAt ? sender : existing), conversations: existing.conversations + 1 } : sender); }
    if (selected && this.store.readEntity('contact', selected.id)?.revision !== selected.revision) throw new Fault(409, 'contact_changed', 'This contact changed. Refresh its correspondence.');
    const senders = [...byEmail.values()].filter(sender => valid.has(sender.input.source.accountId)).sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.email.localeCompare(b.email));
    result.total = senders.length; result.senders = senders.slice(input.offset, input.offset + 40); result.next = input.offset + 40 < result.total ? input.offset + 40 : null;
    result.correspondence = result.correspondence.filter(item => valid.has(item.source.accountId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25);
    if (selected && this.calendar) {
      const timezone = this.store.readEntity('layout', 'layout')!.value.timezone, from = dayInZone(timezone); let to = from; for (let n = 0; n < 60; n++) to = nextDay(to);
      const sources = new Set((selected.value.mailSources ?? []).map(mailCalendarKey));
      result.calendar = this.calendar.state(device, { from, to, timezone }).localEvents.filter(event => {
        const source = this.store.internalRead<{ source: MailContactSource }>('calendar:mail-source:' + event.eventId)?.source;
        return source && sources.has(mailCalendarKey(source)) && event.value.state !== 'cancelled';
      }).slice(0, 20).map(event => ({ eventId: event.eventId, originalDate: event.originalDate, title: event.value.title, date: event.value.start.date }));
    }
    return result;
  }
}
