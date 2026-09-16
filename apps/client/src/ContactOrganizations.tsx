import { useState } from 'react';
import type { Contact } from '../../../packages/domain/workspace-records';
import { organizationKey } from '../../../packages/domain/contacts';
import { Plus, X } from './icons';

export function ContactOrganizations({ value, change }: { value: Contact; change(patch: Partial<Contact>): void }) {
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState(''), [error, setError] = useState('');
  const others = value.otherOrganizations ?? [];
  const add = () => {
    const name = draft.trim();
    if (!name) return;
    if ([value.organization, ...others].some(s => organizationKey(s) === organizationKey(name))) { setError('This organization is already listed.'); return; }
    change(value.organization.trim() ? { otherOrganizations: [...others, name] } : { organization: name });
    setDraft(''); setAdding(false); setError('');
  };
  return <div className="contact-organizations"><label>Primary organization<input maxLength={240} value={value.organization} onChange={event => change({ organization: event.target.value })}/></label>
    {others.map((name, i) => <div className="contact-organization-row" key={i}><input aria-label={`Organization ${i + 2}`} value={name} maxLength={240} onChange={event => change({ otherOrganizations: others.map((s, n) => n === i ? event.target.value : s) })}/><button type="button" title={`Make ${name} primary`} onClick={() => change({ organization: name, otherOrganizations: [...others.filter((_, n) => n !== i), ...(value.organization.trim() ? [value.organization] : [])] })}>Make primary</button><button className="icon-button" type="button" aria-label={`Remove organization ${name}`} onClick={() => change({ otherOrganizations: others.filter((_, n) => n !== i) })}><X size={16}/></button></div>)}
    {adding ? <div className="contact-organization-row"><input autoFocus aria-label="New organization" placeholder="Organization name" maxLength={240} value={draft} onChange={event => { setDraft(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } if (event.key === 'Escape') { event.preventDefault(); setAdding(false); setDraft(''); setError(''); } }}/><button type="button" disabled={!draft.trim()} onClick={add}>Add</button><button type="button" className="icon-button" aria-label="Cancel adding organization" onClick={() => { setAdding(false); setDraft(''); setError(''); }}><X size={16}/></button></div> : <button className="contact-add-organization" type="button" disabled={others.length >= 30} onClick={() => setAdding(true)}><Plus size={15}/>Add organization</button>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
