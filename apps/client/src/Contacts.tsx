import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { Contact } from '../../../packages/domain/workspace-records';
import type { MailContactSource } from '../../../packages/domain/mail-contact';
import { contactDestination, contactMatches, contactOrganizations, organizationKey, sortContacts, type ContactSort } from '../../../packages/domain/contacts';
import type { RecordTarget } from './RecordsPage';
import { readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { RecordEditor } from './RecordEditor';
import { AddressBooks } from './AddressBooks';
import { OrganizationDirectory, ContactPipeline } from './ContactCrm';
import { ContactAvatar } from './ContactPhoto';
import { ContactPage, ContactSenders } from './ContactPage';
import { ComposerMenu } from './ComposerMenu';
import { ArrowLeft, Check, Inbox, MoreHorizontal, Pin, Plus, Search, Users, X } from './icons';
import { Empty } from './ui';
import './records.css';
import './contacts.css';

export type ContactsProps = { snapshot: Snapshot; refresh(): Promise<void>; editTask(task: Entity<Task>): void; target?: RecordTarget | null; openEmail(source: MailContactSource): Promise<void>; openCalendar(): void; openSettings(): void };
type ContactIndex = { selected: string | null; drafts: string[]; seenTarget?: string; editing?: boolean };
export default function Contacts(props: ContactsProps) {
  const { snapshot, target, refresh } = props;
  const key = `e3:record-index:${snapshot.deviceId}:contact:${retainedWindowId}`;
  const [index, setIndex] = useState<ContactIndex>(() => readLocal(key) ?? { selected: null, drafts: [] });
  const [view, setView] = useState<{ query: string; archived: boolean; sort: ContactSort }>(() => ({ query: '', archived: false, sort: 'name', ...(readLocal(key + ':view') ?? {}) }));
  const [section, setSection] = useState<'people' | 'organizations' | 'pipeline'>('people'), [organization, setOrganization] = useState<string>();
  const [books, setBooks] = useState(false);
  const [senders, setSenders] = useState(false), [error, setError] = useState('');
  const detail = useRef<HTMLElement>(null), directory = useRef<HTMLElement>(null);
  const contacts = snapshot.records?.contact ?? [];
  const keep = (next: ContactIndex) => { if (!saveLocal(key, next)) { setError('Free browser storage before navigating. Your writing remains open.'); return false; } setIndex(next); return true; };
  const prefer = (next: typeof view) => { setView(next); if (!saveLocal(key + ':view', next)) setError('This view is kept in the current window only.'); };
  const open = (id: string, resolve = false, nonce?: string) => {
    setSection('people');
    const destination = resolve ? contactDestination(id, contacts) : id;
    const journal = readLocal<{ dirty?: boolean; pending?: unknown }>(`e3:journal:${snapshot.deviceId}:${destination}:${retainedWindowId}`);
    if (keep({ ...index, selected: destination, editing: !!journal?.dirty || !!journal?.pending, seenTarget: nonce ?? index.seenTarget })) requestAnimationFrame(() => detail.current?.focus());
  };
  useEffect(() => { if (target?.kind === 'contact' && target.nonce !== index.seenTarget) open(target.id, true, target.nonce); }, [target?.nonce]);
  const selected = contacts.find(contact => contact.id === index.selected);
  const drafts = index.drafts.filter(id => !contacts.some(contact => contact.id === id));
  const filtered = useMemo(() => sortContacts(contacts.filter(contact => contact.value.archived === view.archived && contactMatches(contact.value, view.query)), view.sort, view.archived), [contacts, view]);
  const group = (contact: Entity<Contact>) => view.sort === 'organization' ? contact.value.organization.trim() || 'No organization' : view.sort === 'recent' || view.archived ? '' : contact.value.favorite ? 'Favorites' : 'Contacts';
  const create = () => { setSection('people'); const id = `contact:${crypto.randomUUID()}`; if (keep({ ...index, drafts: [...drafts, id], selected: id, editing: true })) { prefer({ ...view, archived: false }); requestAnimationFrame(() => detail.current?.focus()); } };
  const close = () => { if (keep({ ...index, selected: null, editing: false })) requestAnimationFrame(() => directory.current?.querySelector<HTMLButtonElement>(`[data-contact-id="${index.selected}"]`)?.focus()); };
  return <main className="contacts-page">
    <header className="contacts-heading"><div><h1>Contacts</h1><select className="crm-section-select" aria-label="Contacts view" value={section} onChange={e => setSection(e.target.value as typeof section)}><option value="people">People</option><option value="organizations">Organizations</option><option value="pipeline">Pipeline</option></select><span className="metadata">{contacts.filter(contact => !contact.value.archived).length} people</span></div><div className="button-row"><button onClick={create}><Plus size={18}/>New contact</button><ComposerMenu label="Contact options" icon={<MoreHorizontal size={20}/>} placement="below" align="right">{hide => <><button onClick={() => { hide(); setSenders(true); }}><Inbox size={18}/>Add from Inbox</button><button onClick={() => { hide(); setBooks(true); }}>Address books & sync</button><button aria-pressed={view.archived} onClick={() => { hide(); setSection('people'); prefer({ ...view, archived: !view.archived }); }}>{view.archived && <Check size={16}/>}Archived contacts</button></>}</ComposerMenu></div></header>
    {error && <p className="field-error" role="alert">{error}</p>}
    {section === 'organizations' ? <OrganizationDirectory snapshot={snapshot} refresh={refresh} selectedName={organization} open={id => open(id)}/> : section === 'pipeline' ? <ContactPipeline contacts={contacts} open={id => open(id)}/> : <div className={`contacts-workspace${index.selected ? ' has-selection' : ''}`}>
      <section className="contacts-directory" ref={directory} aria-label="Contact directory">
        <div className="contacts-search"><label className="search-input"><Search size={18}/><input aria-label="Search contacts" placeholder="Search contacts…" value={view.query} onChange={event => prefer({ ...view, query: event.target.value })}/>{view.query && <button className="icon-button" aria-label="Clear contact search" onClick={() => prefer({ ...view, query: '' })}><X size={15}/></button>}</label><select className="contacts-sort" aria-label="Sort contacts" title="Sort contacts" value={view.sort} onChange={event => prefer({ ...view, sort: event.target.value as ContactSort })}><option value="name">Name</option><option value="organization">Organization</option><option value="recent">Recently updated</option></select></div>
        {view.archived && <div className="contacts-list-label">Archived<button onClick={() => prefer({ ...view, archived: false })}>Show contacts</button></div>}
        <div className="contacts-rows">{!view.archived && drafts.map((id, n) => <button data-contact-id={id} key={id} className="contact-row" aria-pressed={index.selected === id} onClick={() => open(id)}><span className="contact-avatar"><Users size={20}/></span><span><strong>Unfinished contact {n + 1}</strong><small>Resume writing</small></span></button>)}
          {filtered.map((contact, n) => <div key={contact.id}>{group(contact) && (!n || organizationKey(group(contact)) !== organizationKey(group(filtered[n - 1]))) && <div className="contacts-list-label">{group(contact)}</div>}<button data-contact-id={contact.id} className="contact-row" aria-pressed={index.selected === contact.id} onClick={() => open(contact.id)}><ContactAvatar value={contact.value}/><span className="contact-row-copy"><strong>{contact.value.name}</strong><small>{contactOrganizations(contact.value).join(' · ') || contact.value.email || contact.value.phone || contact.value.position}</small></span>{contact.value.favorite && !view.archived && <Pin size={15} aria-label="Favorite"/>}{contact.value.mergedInto && <small>Combined</small>}</button></div>)}
          {!filtered.length && (!drafts.length || view.archived) && <Empty title={view.query ? 'No matching contacts' : view.archived ? 'No archived contacts' : 'Your people, in one place'}>{!view.query && !view.archived ? 'Add someone you know or choose a sender from Inbox.' : undefined}</Empty>}
        </div>
      </section>
      <section ref={detail} tabIndex={-1} className="contacts-detail" aria-label="Contact details">
        {index.selected ? <><button className="contact-back" onClick={close}><ArrowLeft size={18}/>Contacts</button>{!selected && !drafts.includes(index.selected) ? <Empty title="This contact is unavailable"/> : index.editing || !selected ? <RecordEditor key={index.selected} compact kind="contact" id={index.selected} entity={selected} {...props} close={() => selected ? keep({ ...index, editing: false }) : close()} onSaved={() => { if (keep({ ...index, editing: false, drafts: drafts.filter(id => id !== index.selected) })) requestAnimationFrame(() => { detail.current?.scrollTo({ top: 0 }); detail.current?.focus(); }); }} removeDraft={() => keep({ ...index, selected: null, editing: false, drafts: drafts.filter(id => id !== index.selected) })}/> : <ContactPage key={selected.id} {...props} contact={selected} contacts={contacts} organization={name => { setOrganization(name); setSection('organizations'); }} edit={() => keep({ ...index, editing: true })} open={id => open(id)} close={close}/>}</> : <div className="contact-idle"><Users size={40}/><h2>Keep the useful context.</h2><p>Choose a contact to see their details, emails and follow-ups.</p><button onClick={() => setSenders(true)}><Inbox size={18}/>Add from Inbox</button></div>}
      </section>
    </div>}
    {books && <AddressBooks snapshot={snapshot} refresh={refresh} close={() => setBooks(false)} settings={() => { setBooks(false); props.openSettings(); }} open={id => { setBooks(false); open(id, true); }}/>}
    {senders && <ContactSenders snapshot={snapshot} refresh={refresh} close={() => setSenders(false)} open={id => { setSenders(false); open(id, true); }}/>}</main>;
}
