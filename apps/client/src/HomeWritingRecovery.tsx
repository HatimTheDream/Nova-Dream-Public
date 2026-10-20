import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { HomePreservationState, HomeReference } from '../../../packages/domain/home-library';
import { commit } from './api';
import { Dialog } from './ui';
import { discoverHomeWriting, keepHomeWriting, keepSavedHomeWriting, preservedHomeForms, readHomeWriting, type HomeWritingEntry, type HomeWritingForm, type HomeWritingScope, type KeptHomeWriting } from './home-writing-recovery';

export function HomeWritingRecovery({ snapshot, scope, preservation, canAdopt, hasWriter, adopt, returnToWriter, openSaved, close }: {
 snapshot: Pick<Snapshot, 'epoch' | 'deviceId' | 'layout'>; scope: HomeWritingScope; preservation?: HomePreservationState;
 canAdopt: () => boolean; hasWriter: boolean; adopt: (copy: KeptHomeWriting) => boolean;
 returnToWriter: () => void; openSaved: (reference: HomeReference) => void; close: () => void;
}) {
 const scan = () => { try { return discoverHomeWriting(localStorage, scope); } catch { return { entries: [], notice: 'Browser storage is unavailable. Your original Home writing has not been removed.' }; } };
 const [found, setFound] = useState(scan), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [kept, setKept] = useState<KeptHomeWriting>();
 const active = useRef(false), flight = useRef(false), latest = useRef({ scope, preservation, canAdopt, snapshot });
 latest.current = { scope, preservation, canAdopt, snapshot };
 const identity = `${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
 useEffect(() => { active.current = true;return () => { active.current = false; }; }, [identity]);
 const sameScope = () => active.current && `${latest.current.scope.epoch}:${latest.current.scope.deviceId}:${latest.current.scope.windowId}` === identity;
 const canCopy = () => sameScope() && latest.current.canAdopt();
 const finish = (copy: KeptHomeWriting) => {
  if (!sameScope()) return;
  setKept(copy);
  if (!adopt(copy)) setMessage('The copy is kept in this window. Open the kept copy when Library can accept it.');
 };
 const recover = async (entry: HomeWritingEntry, form: HomeWritingForm) => {
  if (flight.current) return;
  flight.current = true;setBusy(true);setMessage('');
  try { finish(await keepHomeWriting(localStorage, entry, form.id, scope, canCopy)); }
  catch (reason) { if (sameScope()) setMessage(reason instanceof Error ? reason.message : 'The writing could not be copied. Its original remains kept.'); }
  finally { flight.current = false;if (sameScope()) setBusy(false); }
 };
 const recoverSaved = async (role: 'original' | 'current', form: HomeWritingForm) => {
  if (flight.current || !preservation) return;
  flight.current = true;setBusy(true);setMessage('');
  try { finish(await keepSavedHomeWriting(localStorage, preservation, role, form.id, scope, () => canCopy() ? latest.current.preservation : undefined)); }
  catch (reason) { if (sameScope()) setMessage(reason instanceof Error ? reason.message : 'The original saved writing remains kept.'); }
  finally { flight.current = false;if (sameScope()) setBusy(false); }
 };
 const reconcile = async (entry: HomeWritingEntry) => {
  if (flight.current || !sameScope()) return;
  flight.current = true;
  try {
   const raw = localStorage.getItem(entry.key), current = raw === entry.raw ? readHomeWriting(entry.key, raw, scope) : undefined;
   if (!current || current.problem || !current.pending || !latest.current.snapshot.layout || latest.current.snapshot.epoch !== current.pending.epoch) throw Error('The original command, source or workspace changed. Refresh and review it before reconciliation.');
   setBusy(true);setMessage('');
   // This is deliberately the original immutable request. The source journal is
   // never replaced, cleared or converted into a new Layout proposal here.
   const result = await commit(current.pending);
   if (!sameScope()) return;
   if (result.id !== 'layout' || result.revision !== current.pending.expectedRevision + 1) throw Error('The response could not be matched to the original layout revision. Keep its request for review.');
   setMessage(`Original save confirmed at layout revision ${result.revision}. The full original proposal and request remain kept here.`);
  } catch (reason) { if (sameScope()) setMessage(reason instanceof Error ? reason.message : 'Original save remains unconfirmed. Its exact request is still kept.'); }
  finally { flight.current = false;if (sameScope()) setBusy(false); }
 };
 const formRow = (form: HomeWritingForm, blocked: boolean, recover: () => void) => <article key={form.id} className="home-writing-form">
  <h4 className="preserve-case">{form.title}</h4><pre className="home-source-text">{form.text || 'No text entered yet.'}</pre>
  {form.problem && <p className="metadata">{form.problem}</p>}
  {form.value && <button className="compact-action compact-utility" disabled={busy || blocked || !canAdopt()} onClick={recover}>Continue As {form.value.kind === 'note' ? 'Note' : 'Link'}</button>}
 </article>;
 return <Dialog title="Recovered Home Writing" close={close}>
  <p>Saved Home notes and links are editable in Library. Original widget values and unfinished writing remain available here. Continuing a draft keeps a copy; it does not save or send it.</p>
  {message && <p role="status" className="notice">{message}</p>}
  {hasWriter && <div className="notice"><span>This window has a Library draft. Return to it before copying other writing.</span><button onClick={returnToWriter}>Return To Current Draft</button></div>}
  {kept && <button disabled={busy || !sameScope()} onClick={() => finish(kept)}>Open Kept Copy</button>}
  {preservation && <section aria-label="Original saved Home writing"><h3>Saved Home Writing</h3><p>{preservation.message}</p>
   {preservation.mappings.length > 0 && <div className="compact-actions">{preservation.mappings.map((mapping, index) => <button className="compact-action compact-utility" key={mapping.reference.id} disabled={busy || !canAdopt()} onClick={() => openSaved(mapping.reference)}>Open Recovered {mapping.reference.kind === 'note' ? 'Note' : 'Link'} {index + 1}</button>)}</div>}
   {(['original', 'current'] as const).filter(role => preservation[role] && (role === 'original' || preservation.status !== 'ready')).map(role => <details key={role}><summary>{role === 'original' ? 'Original saved widget values' : 'Later or unverified saved widget values'} · revision {preservation[role]!.revision}</summary>
    {preservedHomeForms(preservation, role).map(form => formRow(form, role === 'original' && preservation.mappings.length > 0, () => void recoverSaved(role, form)))}
    <details><summary>Complete retained metadata</summary><pre className="home-source-text">{JSON.stringify(preservation[role], null, 2)}</pre></details>
   </details>)}
  </section>}
  <section aria-label="Unfinished Home writing"><div className="section-heading"><h3>Unfinished Writing</h3><button disabled={busy} onClick={() => { setFound(scan());setMessage(''); }}>Refresh List</button></div>
   {found.notice && <p role="alert">{found.notice}</p>}
   {!found.entries.length && <p className="metadata">No unfinished Home writing was found in the checked browser storage.</p>}
   {found.entries.map(entry => <details className="home-writing-entry" key={entry.key}><summary>{entry.kind === 'layout' ? 'Layout proposal' : 'Widget editor'} · {entry.windowId === scope.windowId ? 'this window' : 'another window'} · {entry.forms.length} retained {entry.forms.length === 1 ? 'form' : 'forms'}</summary>
    {entry.problem && <p role="alert">{entry.problem}</p>}
    {entry.forms.map(form => formRow(form, !!entry.problem, () => void recover(entry, form)))}
    {entry.pending && <div className="notice"><p>The original layout save is kept. Reconciliation can finish that original save; it will not submit a replacement proposal.</p><button disabled={busy || !!entry.problem || !snapshot.layout} onClick={() => void reconcile(entry)}>Reconcile Original Save</button></div>}
    <details><summary>Complete original proposal and identity</summary><p className="metadata">{entry.key}</p>{entry.raw.length <= 512 * 1024 ? <pre className="home-source-text">{entry.raw}</pre> : <p>This record exceeds the readable recovery limit. Its complete original remains in browser storage.</p>}</details>
   </details>)}
  </section>
 </Dialog>;
}
