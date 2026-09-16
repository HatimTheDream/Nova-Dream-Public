import { useEffect, useRef, useState } from 'react';
import type { Entity } from '../../../packages/domain/contracts';
import type { Contact } from '../../../packages/domain/workspace-records';
import type { MailContactLink, MailContactPrepare, MailContactProposal } from '../../../packages/domain/mail-contact';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';

type Kept = { command: MailContactLink; proposal: MailContactProposal };
export function MailContactDialog({ returnLabel = 'Back to email', input, journalKey, previousJournalKey, close, opened, refresh }: { returnLabel?: string; input: MailContactPrepare; journalKey: string; previousJournalKey?: string; close(): void; opened(id: string): void; refresh(): Promise<void> }) {
  const [pending, setPending] = useState(() => {
    // A duplicated tab keeps the original receipt; an explicit tombstone in
    // this tab must never fall back to the parent's already settled request.
    let absent = false; try { absent = localStorage.getItem(journalKey) === null; } catch { /* Do not substitute a different journal on storage failure. */ }
    return readLocal<Kept>(journalKey) ?? (absent && previousJournalKey ? readLocal<Kept>(previousJournalKey) : undefined);
  });
  const [proposal, setProposal] = useState<MailContactProposal | undefined>(() => pending?.proposal);
  const [name, setName] = useState(''), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [saved, setSaved] = useState<Entity<Contact>>();
  const alive = useRef(true), flight = useRef(false), sequence = useRef(0);
  const review = async () => {
    const attempt = ++sequence.current; setBusy(true); setError('');
    try {
      const next = await request<MailContactProposal>('mail/contacts/prepare', input);
      if (!alive.current || attempt !== sequence.current) return;
      setProposal(next); setName(next.review.name); setSelected(next.matches.length === 1 && !next.matches[0].archived ? next.matches[0].id : '');
    } catch (reason) { if (alive.current && attempt === sequence.current) setError(reason instanceof Error ? reason.message : 'The sender could not be read.'); }
    finally { if (alive.current && attempt === sequence.current) setBusy(false); }
  };
  useEffect(() => { alive.current = true; if (!pending) void review(); return () => { alive.current = false; sequence.current++; }; }, []);
  const open = async (contact: Entity<Contact>) => { await refresh(); if (alive.current) opened(contact.id); };
  const link = async () => {
    if (flight.current || !proposal) return;
    const match = proposal.matches.find(item => item.id === selected);
    const kept: Kept = pending ?? { proposal, command: { requestId: crypto.randomUUID(), epoch: input.epoch, reviewId: proposal.review.id, target: match ? { kind: 'existing', id: match.id, revision: match.revision } : { kind: 'new', name: name.trim() } } };
    if (!saveLocal(journalKey, kept)) { setError('Free browser storage before saving this Contact. Your email writing is kept.'); return; }
    setPending(kept); flight.current = true; setBusy(true); setError('');
    try {
      const contact = await request<Entity<Contact>>('mail/contacts/link', kept.command);
      if (!alive.current) return;
      setSaved(contact);
      if (saveLocal(journalKey, null)) setPending(undefined);
      await open(contact);
    } catch (reason) {
      if (!alive.current) return;
      setError(reason instanceof Error ? reason.message : 'Saving is unconfirmed. Reconcile this original request.');
      if (reason instanceof ApiError && ['validation', 'epoch_changed', 'mail_contact_review', 'account_changed', 'contact_matches_changed'].includes(reason.code) && saveLocal(journalKey, null)) { setPending(undefined); setProposal(undefined); }
    } finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  return <Dialog title="Connect this sender" close={close}><div className="mail-contact-review">
    <p className="metadata">Keep a Contact in your workspace, linked to this email. Contact notes remain in Nova Dream.</p>
    {proposal && <><p><strong>{proposal.review.name}</strong><br/>{proposal.review.source.sender}</p><p className="metadata">{proposal.review.source.subject || 'Email without a subject'} · {proposal.review.source.provider === 'google' ? 'Google' : 'Microsoft'}</p>
      {!pending && !saved && (proposal.matches.length ? <fieldset disabled={busy}><legend>Choose an existing Contact</legend><p className="metadata">{proposal.matches.length} matching {proposal.matches.length === 1 ? 'email address' : 'records'}. Linking preserves the Contact’s current name and notes.</p>{proposal.matches.map(item => <label className="checkbox-label" key={item.id}><input type="radio" name="mail-contact-match" checked={selected === item.id} disabled={item.archived} onChange={() => setSelected(item.id)}/><span>{item.name}{item.organization ? ` · ${item.organization}` : ''}{item.archived ? ' · Archived: restore in Contacts first' : ''}</span></label>)}</fieldset> : <label>Contact name<input maxLength={240} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label>)}
      {pending && <p role="status" className="metadata">The original save is kept. Reconcile it to check the saved result.</p>}
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {busy && <p role="status">{flight.current ? 'Saving Contact…' : 'Reading the selected sender…'}</p>}
    <div className="button-row">{saved ? <button className="primary" disabled={busy} onClick={() => void open(saved).catch(reason => setError(reason.message))}>Open saved Contact</button> : proposal ? <button className="primary" disabled={busy || !pending && (proposal.matches.length ? !selected : !name.trim())} onClick={() => void link()}>{pending ? 'Reconcile save' : proposal.matches.length ? 'Link & open Contact' : 'Create & open Contact'}</button> : !busy && <button onClick={() => void review()}>Review sender again</button>}<button onClick={close}>{returnLabel}</button></div>
  </div></Dialog>;
}
