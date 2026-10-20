import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { Contact } from '../../../packages/domain/workspace-records';
import type { MailContactSource } from '../../../packages/domain/mail-contact';
import { contactDestination, contactMatches, contactOrganizations, organizationKey, sortContacts, type ContactSort } from '../../../packages/domain/contacts';
import type { RecordTarget } from './RecordsPage';
import { readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { RecordDraftRecovery } from './RecordDraftRecovery';
import { currentRecordDraftTitle } from './record-draft-recovery';
import { RecordEditor } from './RecordEditor';
import { AddressBooks } from './AddressBooks';
import { OrganizationDirectory, ContactPipeline } from './ContactCrm';
import { ContactAvatar } from './ContactPhoto';
import { ContactPage, ContactSenders } from './ContactPage';
import { ComposerMenu } from './ComposerMenu';
import { ArrowLeft, Check, ChevronDown, Filter, Inbox, MoreHorizontal, Pin, Plus, Search, Users, X } from './icons';
import { Empty } from './ui';
import { useContactView } from './useContactView';
import { contactsWithOpenFollowUps } from './contact-presentation';
import './records.css';
import './contacts.css';

export type ContactsProps = { snapshot: Snapshot; refresh(): Promise<void>; editTask(task: Entity<Task>): void; target?: RecordTarget | null; openEmail(source: MailContactSource): Promise<void>; openCalendar(): void; openSettings(): void };
type ContactView = { query: string; archived: boolean; sort: ContactSort; section: 'people' | 'organizations' | 'pipeline'; favorites: boolean; followUps: boolean; organization?: { name: string; nonce: string } };
type ContactIndex = { selected: string | null; drafts: string[]; seenTarget?: string; editing?: boolean };
export default function Contacts(props: ContactsProps) {
  const { snapshot, target, refresh } = props;
  const key = `e3:record-index:${snapshot.deviceId}:contact:${retainedWindowId}`;
  const [index, setIndex] = useState<ContactIndex>(() => readLocal(key) ?? { selected: null, drafts: [] });
  const { view, prefer, error: viewError } = useContactView<ContactView>(key + ':view', { query: '', archived: false, sort: 'name', section: 'people', favorites: false, followUps: false });
  const section = view.section;
  const [createOrganization, setCreateOrganization] = useState('');
  const [books, setBooks] = useState(false), [recovering, setRecovering] = useState(false);
  const [senders, setSenders] = useState(false), [error, setError] = useState('');
  const detail = useRef<HTMLElement>(null), directory = useRef<HTMLElement>(null);
  const contacts = snapshot.records?.contact ?? [];
  const recoveryScope = { kind: 'contact' as const, deviceId: snapshot.deviceId, windowId: retainedWindowId, epoch: snapshot.epoch, records: contacts };
  const activeCount = contacts.filter(contact => !contact.value.archived).length;
  const keep = (next: ContactIndex) => { if (!saveLocal(key, next)) { setError('Free browser storage before navigating. Your writing remains open.'); return false; } setIndex(next); return true; };
  const open = (id: string, resolve = false, nonce?: string) => {
    prefer({ section: 'people' });
    const destination = resolve ? contactDestination(id, contacts) : id;
    const journal = readLocal<{ dirty?: boolean; pending?: unknown }>(`e3:journal:${snapshot.deviceId}:${destination}:${retainedWindowId}`);
    if (keep({ ...index, selected: destination, editing: !!journal?.dirty || !!journal?.pending, seenTarget: nonce ?? index.seenTarget })) requestAnimationFrame(() => detail.current?.focus());
  };
  useEffect(() => { if (target?.kind === 'contact' && target.nonce !== index.seenTarget) open(target.id, true, target.nonce); }, [target?.nonce]);
  const selected = contacts.find(contact => contact.id === index.selected);
  const drafts = index.drafts.filter(id => !contacts.some(contact => contact.id === id));
  const followUpContacts = useMemo(() => contactsWithOpenFollowUps(contacts, snapshot.tasks), [contacts, snapshot.tasks]);
  const filtered = useMemo(() => sortContacts(contacts.filter(contact => contact.value.archived === view.archived && contactMatches(contact.value, view.query) && (!view.favorites || contact.value.favorite) && (!view.followUps || followUpContacts.has(contact.id))), view.sort, view.archived), [contacts, view, followUpContacts]);
  const group = (contact: Entity<Contact>) => view.sort === 'organization' ? contact.value.organization.trim() || 'No organization' : view.sort === 'recent' || view.archived ? '' : contact.value.favorite ? 'Favorites' : 'Contacts';
  const create = () => { const id = `contact:${crypto.randomUUID()}`; if (keep({ ...index, drafts: [...drafts, id], selected: id, editing: true })) { prefer({ section: 'people', archived: false }); requestAnimationFrame(() => detail.current?.focus()); } };
  const openRecovered = (id: string) => {
    if (index.selected) return false;
    const next = { ...index, selected: id, editing: true, drafts: contacts.some(item => item.id === id) ? index.drafts : [...new Set([...index.drafts, id])] };
    if (!keep(next)) return false;
    requestAnimationFrame(() => detail.current?.focus()); return true;
  };
  const close = () => { if (keep({ ...index, selected: null, editing: false })) requestAnimationFrame(() => directory.current?.querySelector<HTMLButtonElement>(`[data-contact-id="${index.selected}"]`)?.focus()); };
  const scopeTitle = section === 'organizations' ? 'Organizations' : section === 'pipeline' ? 'Pipeline' : view.archived ? 'Archived People' : 'People';
  const filterCount = Number(view.favorites) + Number(view.followUps) + Number(view.archived);
  return <main className="contacts-page contacts-compact">
    <header className="contacts-heading">
      <div className="contacts-title"><div className="contacts-scope"><h1>{scopeTitle}</h1><ComposerMenu label={`Browse Contacts: ${scopeTitle}`} icon={<ChevronDown size={18}/>} placement="below" className="contact-controls-menu contact-scope-menu">{hide => <div className="compact-choice-menu">{(['people', 'organizations', 'pipeline'] as const).map(name => <button className="compact-action" key={name} aria-pressed={section === name} onClick={() => { hide(); prefer({ section: name }); }}>{section === name && <Check size={15}/>}{{ people: 'People', organizations: 'Organizations', pipeline: 'Pipeline' }[name]}</button>)}</div>}</ComposerMenu></div>{section === 'people' && <p className="metadata">{filtered.length}{view.query || filterCount ? ` of ${view.archived ? contacts.length - activeCount : activeCount}` : ''} {(view.query || filterCount ? (view.archived ? contacts.length - activeCount : activeCount) : filtered.length) === 1 ? 'person' : 'people'}</p>}</div>
      <div className="compact-actions contacts-header-actions">
        {section === 'people' && <ComposerMenu label="Filter And Sort People" text={filterCount ? `Filter · ${filterCount}` : 'Filter And Sort'} icon={<Filter size={16}/>} placement="below" align="right" className="contact-controls-menu">{hide => <div className="contact-filter-panel"><label><input type="checkbox" checked={view.favorites} onChange={e => prefer({ favorites: e.target.checked })}/>Favorites</label><label><input type="checkbox" checked={view.followUps} onChange={e => prefer({ followUps: e.target.checked })}/>With Open Follow-Ups</label><label><input type="checkbox" checked={view.archived} onChange={e => prefer({ archived: e.target.checked })}/>Archived People</label><label>Sort<select aria-label="Sort contacts" value={view.sort} onChange={e => prefer({ sort: e.target.value as ContactSort })}><option value="name">Name</option><option value="organization">Organization</option><option value="recent">Recently Updated</option></select></label><button className="compact-action" onClick={() => { prefer({ favorites: false, followUps: false, archived: false, sort: 'name' }); hide(); }}>Reset Filters</button></div>}</ComposerMenu>}
        <button className="compact-action compact-utility" onClick={() => setBooks(true)}>Address Books</button>
        <button className="primary compact-action compact-utility" onClick={section === 'organizations' ? () => setCreateOrganization(crypto.randomUUID()) : create}><Plus size={16}/>{section === 'organizations' ? 'Add Organization' : 'Add Person'}</button>
        <ComposerMenu label="Contact Options" icon={<MoreHorizontal size={18}/>} placement="below" align="right" className="contact-controls-menu">{hide => <div className="compact-choice-menu"><button className="compact-action" onClick={() => { hide(); setSenders(true); }}><Inbox size={16}/>Add From Inbox</button>{section === 'people' && <button className="compact-action" disabled={!!index.selected} title={index.selected ? 'Close the current editor before recovering another window’s writing.' : undefined} onClick={() => { hide(); setRecovering(true); }}>Recover Writing</button>}</div>}</ComposerMenu>
      </div>
    </header>
    {viewError && <p className="field-error" role="status">{viewError}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {section === 'organizations' ? <OrganizationDirectory snapshot={snapshot} refresh={refresh} selectedName={view.organization?.name} targetNonce={view.organization?.nonce} createRequest={createOrganization} open={id => open(id)}/> : section === 'pipeline' ? <ContactPipeline deviceId={snapshot.deviceId} contacts={contacts} open={id => open(id)}/> : <div className={`contacts-workspace${index.selected ? ' has-selection' : ''}`}>
      <section className="contacts-directory" ref={directory} aria-label="Contact directory">
        <div className="contacts-search"><label className="search-input"><Search size={18}/><input type="search" aria-label="Search contacts" placeholder="Search people…" value={view.query} onChange={event => prefer({ query: event.target.value })}/>{view.query && <button className="compact-action compact-icon" aria-label="Clear contact search" onClick={() => prefer({ query: '' })}><X size={15}/></button>}</label></div>
        {!!filterCount && <div className="contacts-filter-summary metadata">{[view.archived && 'Archived', view.favorites && 'Favorites', view.followUps && 'Open Follow-Ups'].filter(Boolean).join(' · ')}</div>}
        <div className="contacts-rows">{!view.archived && drafts.map((id, n) => <button data-contact-id={id} key={id} className="contact-row" aria-pressed={index.selected === id} onClick={() => open(id)}><span className="contact-avatar"><Users size={20}/></span><span><strong>{currentRecordDraftTitle(localStorage, recoveryScope, id) ?? `Unfinished contact ${n + 1}`}</strong><small>Resume writing</small></span></button>)}
          {filtered.map((contact, n) => <div key={contact.id}>{group(contact) && (!n || organizationKey(group(contact)) !== organizationKey(group(filtered[n - 1]))) && <div className="contacts-list-label">{group(contact)}</div>}<button data-contact-id={contact.id} className="contact-row" aria-pressed={index.selected === contact.id} onClick={() => open(contact.id)}><ContactAvatar value={contact.value}/><span className="contact-row-copy"><strong>{contact.value.name}</strong><small>{contactOrganizations(contact.value).join(' · ') || contact.value.email || contact.value.phone || contact.value.position}</small></span>{contact.value.favorite && !view.archived && <Pin size={15} aria-label="Favorite"/>}{contact.value.mergedInto && <small>Combined</small>}</button></div>)}
          {!filtered.length && (!drafts.length || view.archived) && <Empty title={view.query || filterCount ? 'No matching contacts' : view.archived ? 'No archived contacts' : 'Your people, in one place'}>{!view.query && !filterCount ? 'Add someone you know or choose a sender from Inbox.' : undefined}</Empty>}
        </div>
      </section>
      <section ref={detail} tabIndex={-1} className="contacts-detail" aria-label="Contact details">
        {index.selected ? <><button className="contact-back" onClick={close}><ArrowLeft size={18}/>People</button>{!selected && !drafts.includes(index.selected) ? <Empty title="This contact is unavailable"/> : index.editing || !selected ? <RecordEditor key={index.selected} compact kind="contact" id={index.selected} entity={selected} {...props} close={() => selected ? keep({ ...index, editing: false }) : close()} onSaved={() => { if (keep({ ...index, editing: false, drafts: drafts.filter(id => id !== index.selected) })) requestAnimationFrame(() => { detail.current?.scrollTo({ top: 0 }); detail.current?.focus(); }); }} removeDraft={() => keep({ ...index, selected: null, editing: false, drafts: drafts.filter(id => id !== index.selected) })}/> : <ContactPage key={selected.id} {...props} contact={selected} contacts={contacts} organization={name => prefer({ organization: { name, nonce: crypto.randomUUID() }, section: 'organizations' })} edit={() => keep({ ...index, editing: true })} open={id => open(id)} close={close}/>}</> : <div className="contact-idle"><Users size={40}/><h2>Keep the useful context.</h2><p>Choose a contact to see their details, emails and follow-ups.</p><button onClick={() => setSenders(true)}><Inbox size={18}/>Add From Inbox</button></div>}
      </section>
    </div>}
    {recovering && <RecordDraftRecovery scope={recoveryScope} canOpen={!index.selected && section === 'people'} open={openRecovered} close={() => setRecovering(false)}/>}
    {books && <AddressBooks snapshot={snapshot} refresh={refresh} close={() => setBooks(false)} settings={() => { setBooks(false); props.openSettings(); }} open={id => { setBooks(false); open(id, true); }}/>}
    {senders && <ContactSenders snapshot={snapshot} refresh={refresh} close={() => setSenders(false)} open={id => { setSenders(false); open(id, true); }}/>}</main>;
}
