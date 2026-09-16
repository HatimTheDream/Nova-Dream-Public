import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addressBrowseSchema, addressImportSchema, addressLinkSchema, addressSyncSchema, sharedContact, sharedFields, withSharedContact, type AddressBookState, type AddressLink, type AddressReview, type SharedContact, type SharedField } from '../../packages/domain/address-books.js';
import { canonical } from '../../packages/domain/contracts.js';
import { blankRecord, type Contact } from '../../packages/domain/workspace-records.js';
import { contactDestination, contactEmails } from '../../packages/domain/contacts.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { ProviderError } from './providers.js';
import { getProviderContact, providerContactFolders, providerContactsPage, updateProviderContact } from './provider-contacts.js';
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const difference = (a: SharedContact, b: SharedContact) => sharedFields.filter(k => !equal(a[k], b[k]));
type Review = AddressReview & { device: string; epoch: string; createdAt: number };
export class AddressBooks {
  private jobs = new Map<string, Promise<void>>(); private controller = new AbortController(); private timer?: ReturnType<typeof setInterval>; private closed = false;
  constructor(private store: Store, private accounts: Pick<Accounts, 'state' | 'contactOperation'>, private now: () => number = Date.now) {}
  private links() { return this.store.internalList<AddressLink>('crm:address-link:'); }
  private write(link: AddressLink) { this.store.internalWrite('crm:address-link:' + link.id, link); return link; }
  private account(device: string, input: { epoch: string; accountId: string; generation: string }) {
    if (this.closed) throw new Fault(503, 'closing', 'The workspace is restarting. Your contact changes are kept.');
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen Contacts after workspace recovery.');
    const account = this.accounts.state(device).accounts.find(a => a.id === input.accountId);
    if (!account || account.generation !== input.generation || account.state !== 'connected') throw new Fault(409, 'account_changed', 'Reconnect this exact account and resume its contact links.');
    return account;
  }
  state(device: string, raw: unknown): AddressBookState { const input = z.object({ epoch: z.uuid() }).strict().parse(raw); if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen Contacts after recovery.'); return { accounts: this.accounts.state(device).accounts.filter(a => a.state !== 'disconnected'), links: this.links().map(link => ({ ...link, intent: link.intent ? { ...link.intent, etag: '' } : undefined })), running: [...this.jobs.keys()] }; }
  async browse(device: string, raw: unknown): Promise<AddressReview> {
    const input = addressBrowseSchema.parse(raw), account = this.account(device, input);
    const result = await this.accounts.contactOperation(account.id, account.generation, ['contactsRead'], this.controller.signal, async (a, request, check) => { check(); const page = await providerContactsPage(a.provider, request, input.cursor, input.folder); check(); const folders = !input.cursor && !input.folder ? await providerContactFolders(a.provider, request) : undefined; check(); return { ...page, folders }; });
    this.account(device, input);
    const contacts = this.store.listEntities('contact').filter(c => !c.value.archived), links = this.links();
    const review: Review = { id: randomUUID(), device, epoch: input.epoch, createdAt: this.now(), accountId: account.id, generation: account.generation, folder: input.folder, skipped: result.skipped, next: result.next, folders: result.folders, entries: result.entries.map(remote => ({ remoteId: remote.id, value: remote.value, matches: contacts.filter(c => contactEmails(c.value).some(email => remote.value.emails.some(r => r.toLowerCase() === email.toLowerCase()))).map(c => ({ id: c.id, revision: c.revision, name: c.value.name, organization: c.value.organization })), linked: links.find(l => l.accountId === account.id && l.remoteId === remote.id)?.contactId })) };
    this.store.internalAtomic(() => { for (const old of this.store.internalList<Review>('crm:address-review:')) if (this.now() - old.createdAt > 30 * 60000) this.store.internalDelete('crm:address-review:' + old.id); if (this.store.internalList('crm:address-review:').length >= 100) throw new Fault(429, 'busy', 'Finish an existing import before starting another.'); this.store.internalWrite('crm:address-review:' + review.id, review); });
    const { device: _device, epoch: _epoch, createdAt: _at, ...view } = review; return view;
  }
  import(device: string, raw: unknown) {
    const input = addressImportSchema.parse(raw);
    return this.store.admit(device, input, { type: 'contacts.import', ...input }, () => {
      const account = this.account(device, input), review = this.store.internalRead<Review>('crm:address-review:' + input.reviewId);
      if (!account.capabilities.contactsRead || input.mode === 'both' && !account.capabilities.contactsWrite) throw new Fault(403, 'permission', 'Grant the requested contact access in Settings first.');
      if (!review || review.device !== device || review.epoch !== input.epoch || review.accountId !== account.id || review.generation !== account.generation || this.now() - review.createdAt > 30 * 60000) throw new Fault(409, 'review_expired', 'Refresh the address-book review. Existing contacts are kept.');
      if (new Set(input.entries.map(e => e.remoteId)).size !== input.entries.length) throw new Fault(400, 'duplicate', 'Choose each account contact once.');
      const imported: string[] = [];
      for (const entry of input.entries) {
        const row = review.entries.find(e => e.remoteId === entry.remoteId);
        if (!row || this.links().some(l => l.accountId === account.id && l.remoteId === entry.remoteId)) throw new Fault(409, 'already_linked', 'This contact was already imported. Refresh the review.');
        const existing = entry.target === 'new' ? undefined : this.store.readEntity('contact', entry.target);
        if (entry.target !== 'new' && (!existing || existing.revision !== entry.revision || existing.value.archived)) throw new Fault(409, 'contact_changed', 'A matching contact changed. Refresh the review.');
        const id = existing?.id ?? 'contact:' + randomUUID();
        let value = existing?.value ?? withSharedContact(blankRecord('contact', input.timezone) as Contact, row.value);
        // Existing values are never silently replaced or uploaded on first import.
        if (existing) { const local = sharedContact(value), merged = { ...local }; for (const field of sharedFields) if (field === 'emails') merged.emails = [...new Set([...local.emails, ...row.value.emails])]; else if (!local[field]) merged[field] = row.value[field]; value = withSharedContact(value, merged); }
        const contact = this.store.reviseContact(device, id, value, existing?.revision ?? 0), local = sharedContact(contact.value), fields = difference(local, row.value);
        const link: AddressLink = { id: 'link:' + createHash('sha256').update(account.id + ':' + row.remoteId).digest('hex').slice(0, 40), accountId: account.id, generation: account.generation, remoteId: row.remoteId, contactId: id, revision: 1, base: row.value, mode: input.mode, state: fields.length ? 'conflict' : 'synced', checkedAt: new Date(this.now()).toISOString(), ...(fields.length ? { conflict: { local, remote: row.value, fields }, message: 'Review the existing and imported details before syncing.' } : {}) };
        if (this.links().length >= 10000) throw new Fault(507, 'quota', 'The linked address-book limit has been reached. Existing contacts are kept.');
        this.write(link); imported.push(id);
      }
      return { imported };
    }).value;
  }
  changeLink(device: string, raw: unknown) {
    const input = addressLinkSchema.parse(raw);
    const result = this.store.admit(device, input, { type: 'contacts.link', ...input }, () => {
      const account = this.account(device, input), link = this.links().find(l => l.id === input.linkId && l.accountId === account.id);
      if (!link || link.revision !== input.revision) throw new Fault(409, 'link_changed', 'This contact link changed. Refresh before continuing.');
      if (input.action === 'pause') return this.write({ ...link, revision: link.revision + 1, state: 'paused', message: 'Sync paused. This person and their history remain here.' });
      if (input.action === 'resume') return this.write({ ...link, generation: account.generation, revision: link.revision + 1, state: link.conflict ? 'conflict' : link.intent ? 'unknown' : 'synced', message: undefined });
      if (!link.conflict || link.intent || link.generation !== account.generation) throw new Fault(409, 'link_changed', 'Reconcile this link before choosing conflict values.');
      const contactId = contactDestination(link.contactId, this.store.listEntities('contact')), current = this.store.readEntity('contact', contactId);
      if (!current || current.value.archived || !equal(sharedContact(current.value), link.conflict.local)) throw new Fault(409, 'contact_changed', 'Contact details changed during review. Refresh the comparison.');
      const value = { ...link.conflict.remote };
      for (const field of link.conflict.fields) { const choice = input.choices?.[field]; if (!choice) throw new Fault(400, 'validation', 'Choose a value for each conflicting field.'); Object.assign(value, { [field]: link.conflict[choice][field] }); }
      const local = sharedContact(current.value); for (const field of sharedFields.filter(f => !link.conflict!.fields.includes(f))) Object.assign(value, { [field]: local[field] });
      if (link.mode === 'read' && difference(value, link.conflict.remote).length) throw new Fault(400, 'read_only', 'A read-only link can accept the account version, or pause to keep local differences.');
      this.store.reviseContact(device, current.id, withSharedContact(current.value, value), current.revision);
      return this.write({ ...link, contactId: current.id, revision: link.revision + 1, base: link.conflict.remote, conflict: undefined, state: 'synced', message: undefined });
    }).value;
    if (input.action !== 'pause') void this.launch(device, input).catch(() => {});
    return result;
  }
  async sync(device: string, raw: unknown) { const input = addressSyncSchema.parse(raw); this.account(device, input); await this.launch(device, input); return this.state(device, { epoch: input.epoch }); }
  private launch(device: string, input: { epoch: string; accountId: string; generation: string }): Promise<void> {
    if (this.jobs.has(input.accountId)) return this.jobs.get(input.accountId)!;
    const job = this.run(device, input).finally(() => this.jobs.delete(input.accountId)); this.jobs.set(input.accountId, job); return job;
  }
  private async run(device: string, input: { epoch: string; accountId: string; generation: string }) {
    const account = this.account(device, input);
    const links = this.links().filter(l => l.accountId === account.id && l.generation === account.generation && !['paused', 'missing'].includes(l.state)).sort((a, b) => a.checkedAt.localeCompare(b.checkedAt)).slice(0, 100);
    for (const original of links) {
      this.controller.signal.throwIfAborted();
      let link = this.links().find(l => l.id === original.id)!;
      const contacts = this.store.listEntities('contact'), id = contactDestination(link.contactId, contacts), contact = this.store.readEntity('contact', id);
      if (!contact || contact.value.archived) { this.write({ ...link, revision: link.revision + 1, state: 'paused', message: 'Contact archived here; the account original is kept.' }); continue; }
      const fence = () => { this.account(device, input); const latest = this.links().find(l => l.id === link.id); if (latest?.revision !== link.revision || latest.state === 'paused') throw new Fault(409, 'link_changed', 'Contact sync changed while this request was running.'); };
      try {
        await this.accounts.contactOperation(account.id, account.generation, ['contactsRead'], this.controller.signal, async (a, request, check) => {
          check(); let remote = await getProviderContact(a.provider, request, link.remoteId); fence(); check();
          const current = this.store.readEntity('contact', id)!;
          if (!current || current.value.archived) throw new Fault(409, 'contact_changed', 'Contact changed while syncing.');
          let local = sharedContact(current.value);
          if (link.intent) {
            const intent = link.intent;
            if (intent.changed.every(k => equal(remote.value[k], intent.value[k]))) { link = this.write({ ...link, revision: link.revision + 1, base: { ...remote.value, ...Object.fromEntries(sharedFields.filter(k => !intent.changed.includes(k)).map(k => [k, link.base[k]])) }, intent: undefined, state: 'synced', message: undefined }); }
            else if (intent.changed.every(k => equal(remote.value[k], intent.before[k])) && remote.etag === intent.etag) { link = this.write({ ...link, revision: link.revision + 1, intent: undefined, state: 'synced', message: undefined }); }
            else { this.write({ ...link, revision: link.revision + 1, intent: undefined, state: 'conflict', conflict: { local, remote: remote.value, fields: difference(local, remote.value) }, message: 'The interrupted update differs from the current account version. Review both.' }); return; }
          }
          const localChanges = difference(local, link.base), remoteChanges = difference(remote.value, link.base), conflicts = localChanges.filter(k => remoteChanges.includes(k) && !equal(local[k], remote.value[k]));
          if (link.state === 'conflict' || conflicts.length || link.mode === 'read' && localChanges.length) { const fields = difference(local, remote.value); if (fields.length) { if (link.state === 'conflict' && equal(link.conflict, { local, remote: remote.value, fields })) return; this.write({ ...link, contactId: id, revision: link.revision + 1, state: 'conflict', checkedAt: new Date(this.now()).toISOString(), conflict: { local, remote: remote.value, fields }, message: 'Choose the details to keep before syncing.' }); return; } }
          const merged = { ...local }; for (const field of remoteChanges.filter(k => !localChanges.includes(k))) Object.assign(merged, { [field]: remote.value[field] });
          const push = difference(merged, remote.value);
          if (push.length && link.mode === 'both') {
            if (!a.capabilities.contactsWrite) throw new ProviderError('permission', 'Grant contact sync permission in Settings to send these edits.');
            // Persist before dispatch. Recovery reads this exact provider record before any retry.
            link = this.write({ ...link, revision: link.revision + 1, contactId: id, intent: { before: remote.value, value: merged, changed: push, startedAt: new Date(this.now()).toISOString(), localRevision: current.revision, etag: remote.etag }, state: 'unknown' });
            fence(); check(); remote = await updateProviderContact(a.provider, request, remote, merged, push);
            // A confirmed provider result is recorded even if a concurrent pause/disconnect arrived after dispatch.
            const latest = this.links().find(l => l.id === link.id)!;
            if (latest.revision !== link.revision) { this.write({ ...latest, revision: latest.revision + 1, base: remote.value, intent: undefined }); return; }
          }
          this.store.internalAtomic(() => {
            const latest = this.store.readEntity('contact', id)!;
            if (!latest || latest.value.archived) { this.write({ ...link, revision: link.revision + 1, base: remote.value, intent: undefined, state: 'paused' }); return; }
            // Preserve edits made on another window during the network request, field by field.
            const next = sharedContact(latest.value); for (const field of sharedFields) if (equal(next[field], local[field])) Object.assign(next, { [field]: remote.value[field] });
            if (!equal(next, sharedContact(latest.value))) this.store.reviseContact(device, id, withSharedContact(latest.value, next), latest.revision);
            this.write({ ...link, contactId: id, revision: link.revision + 1, base: remote.value, intent: undefined, conflict: undefined, state: 'synced', checkedAt: new Date(this.now()).toISOString(), message: undefined });
          });
        });
      } catch (error) {
        const latest = this.links().find(l => l.id === link.id); if (!latest || latest.revision !== link.revision || this.closed) continue;
        const missing = error instanceof ProviderError && error.code === 'not_found';
        this.write({ ...latest, revision: latest.revision + 1, state: missing ? 'missing' : latest.intent ? 'unknown' : 'error', checkedAt: new Date(this.now()).toISOString(), message: missing ? 'Removed from the account. Your contact and CRM history are kept here.' : error instanceof Error ? error.message : 'Sync paused. Existing details are kept.' });
      }
    }
  }
  start() { this.timer = setInterval(() => { if (this.closed) return; for (const account of this.accounts.state('crm').accounts.filter(a => a.state === 'connected' && a.capabilities.contactsRead)) if (this.links().some(l => l.accountId === account.id && l.generation === account.generation && !['paused', 'missing', 'conflict'].includes(l.state))) void this.launch('crm', { epoch: this.store.epoch, accountId: account.id, generation: account.generation }).catch(() => {}); }, 60000); this.timer.unref(); }
  async close() { this.closed = true; clearInterval(this.timer); this.controller.abort(); await Promise.allSettled(this.jobs.values()); }
}
