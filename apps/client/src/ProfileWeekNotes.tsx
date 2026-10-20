import { useEffect, useRef, useState } from 'react';
import { sameProfileWeek, type ProfileWeekIdentity } from '../../../packages/domain/profile-week';
import { weekNoteIdentityKey, weekNoteStateSchema, type WeekNoteState } from '../../../packages/domain/profile-week-note';
import { request } from './api';
import { Dialog, Empty } from './ui';
import { retainedWindowId } from './useWorkspace';
import { mayLeaveRecordDrafts } from './record-draft-navigation';
import { readWeekNoteJournal, weekNoteDraftKey } from './profile-week-note-client';
import { WeekNotePages } from './profile-week-note-pages';
import { discoverWeekNoteWriting, recoverWeekNoteWriting, type WeekNoteRecoveryEntry } from './profile-week-note-recovery';
import { useWeekNoteDraft, weekNoteBrowserStorage } from './useWeekNoteDraft';
import './profile-week-notes.css';

const label = (identity: ProfileWeekIdentity) => `Week Of ${new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeZone: 'UTC',
}).format(new Date(`${identity.start}T12:00:00Z`))}`;
const stamp = (value: string, timezone: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short', timeZone: timezone,
}).format(new Date(value));
const problemText = (problem: unknown) => problem instanceof Error ? problem.message : 'Your note is unavailable. Existing writing is kept.';
const readState = async (epoch: string, identity: ProfileWeekIdentity) => {
  const state = weekNoteStateSchema.parse(await request(`profile/week/note?${new URLSearchParams(identity)}`));
  if (state.epoch !== epoch || !sameProfileWeek(state.identity, identity)) throw Error('This note belongs to another workspace or week. Your original selection is kept.');
  return state;
};

/** Optional notes stay separate from Task credit and preserve the exact selected week/timezone. */
export function ProfileWeekNotes({ epoch, deviceId, identity, active }: {
  epoch: string; deviceId: string; identity: ProfileWeekIdentity; active: boolean;
}) {
  const [summary, setSummary] = useState<WeekNoteState>(), [error, setError] = useState(''), [kept, setKept] = useState(false);
  const [mode, setMode] = useState<'saved' | 'recovery' | 'editor'>(), [editor, setEditor] = useState<WeekNoteState>();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true), generation = useRef(0), summaryGeneration = useRef(0);
  const current = useRef({ epoch, deviceId, identity, active }); current.current = { epoch, deviceId, identity, active };
  const action = useRef<HTMLButtonElement>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const owner = `${epoch}:${deviceId}`, ownerRef = useRef(owner); ownerRef.current = owner;
  const identityKey = weekNoteIdentityKey(identity);
  const refreshSummary = async () => {
    const captured = current.current, token = ++summaryGeneration.current;
    try {
      const value = await readState(captured.epoch, captured.identity);
      if (!alive.current || summaryGeneration.current !== token || ownerRef.current !== owner ||
        !sameProfileWeek(current.current.identity, captured.identity)) return;
      setSummary(value); setError('');
    } catch (problem) {
      if (alive.current && summaryGeneration.current === token && ownerRef.current === owner) setError(problemText(problem));
    }
    if (alive.current && summaryGeneration.current === token && ownerRef.current === owner) refreshKept();
  };
  const refreshKept = () => {
    try {
      const raw = weekNoteBrowserStorage.getItem(weekNoteDraftKey(deviceId, retainedWindowId, current.current.identity));
      const value = raw === null ? undefined : readWeekNoteJournal(raw);
      setKept(raw !== null && (!value || value.epoch !== epoch || value.dirty || !!value.pending));
    } catch (problem) { setError(problemText(problem)); }
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; summaryGeneration.current++; if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current); };
  }, []);
  useEffect(() => {
    if (active) { refreshKept(); void refreshSummary(); }
    else { generation.current++; setMode(undefined); setEditor(undefined); setLoading(false); }
  }, [active, identityKey, owner]);
  const open = async (selected: ProfileWeekIdentity) => {
    if (!alive.current || !mayLeaveRecordDrafts() || !current.current.active) return;
    const token = ++generation.current, capturedOwner = ownerRef.current;
    setLoading(true); setError(''); setEditor(undefined); setMode('editor');
    try {
      const state = await readState(epoch, selected);
      if (alive.current && generation.current === token && ownerRef.current === capturedOwner && current.current.active) setEditor(state);
    } catch (problem) { if (alive.current && generation.current === token && ownerRef.current === capturedOwner) setError(problemText(problem)); }
    finally { if (alive.current && generation.current === token && ownerRef.current === capturedOwner) setLoading(false); }
  };
  const close = () => {
    if (!alive.current || !mayLeaveRecordDrafts()) return;
    generation.current++; setMode(undefined); setEditor(undefined); setLoading(false); refreshKept();
    focusFrame.current = requestAnimationFrame(() => {
      if (alive.current && current.current.active) action.current?.focus();
      focusFrame.current = undefined;
    });
  };
  const browse = (next: 'saved' | 'recovery') => {
    if (!alive.current || !current.current.active || !mayLeaveRecordDrafts()) return;
    generation.current++; setEditor(undefined); setLoading(false); setError(''); setMode(next);
  };
  const confirmed = summary?.epoch === epoch && sameProfileWeek(summary.identity, identity) ? summary.note : undefined;
  return <section className="profile-week-notes" aria-label="My Week Note">
    <div className="section-heading"><div><h3>My Week Note</h3><p className="metadata">An optional reflection, kept with this week and timezone.</p></div>
      <div className="button-row"><button ref={action} className="primary" onClick={() => void open(identity)}>{kept ? 'Resume My Note' : confirmed?.trashed ? 'Review Trashed Note' : confirmed ? 'Edit My Note' : 'Write My Note'}</button>
        <button onClick={() => browse('saved')}>Saved Notes</button><button onClick={() => browse('recovery')}>Recover Writing</button></div></div>
    {confirmed && <p className="week-note-preview">{confirmed.trashed ? 'This week’s note is in Trash. Its writing is kept until you restore it.' : confirmed.text.slice(0, 260) + (confirmed.text.length > 260 ? '…' : '')}</p>}
    {error && !mode && <div className="notice warning" role="alert"><p>{error}</p><button onClick={() => void refreshSummary()}>Refresh Note</button></div>}
    {active && mode === 'editor' && (editor
      ? <WeekNoteEditor key={`${owner}:${weekNoteIdentityKey(editor.identity)}`} state={editor} deviceId={deviceId} windowId={retainedWindowId}
          close={close} saved={() => { refreshKept(); void refreshSummary(); }}/>
      : <Dialog title="My Week Note" close={close}><p role={error ? 'alert' : 'status'}>{error || (loading ? 'Reading the saved note…' : 'The note has not been read yet.')}</p><button onClick={close}>Back To Your Week</button></Dialog>)}
    {active && mode === 'saved' && <WeekNotesList key={owner} epoch={epoch} close={close} open={selected => void open(selected)}/>}
    {active && mode === 'recovery' && <WeekNoteRecovery key={owner} epoch={epoch} deviceId={deviceId} windowId={retainedWindowId} close={close} open={selected => void open(selected)}/>}
  </section>;
}

export function WeekNoteEditor({ state, deviceId, windowId, close, saved }: {
  state: WeekNoteState; deviceId: string; windowId: string; close(): void; saved(): void;
}) {
  const draft = useWeekNoteDraft(state, deviceId, windowId);
  const [review, setReview] = useState<WeekNoteState>(), [reviewing, setReviewing] = useState(false), [reviewError, setReviewError] = useState('');
  const [trashChoice, setTrashChoice] = useState(false), [notice, setNotice] = useState('');
  const reviewFlight = useRef(false);
  const alive = useRef(true), generation = useRef(0), current = useRef({ state, deviceId, windowId }); current.current = { state, deviceId, windowId };
  const owns = () => alive.current && current.current.state.epoch === state.epoch &&
    current.current.deviceId === deviceId && current.current.windowId === windowId && sameProfileWeek(current.current.state.identity, state.identity);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const readSaved = async () => {
    if (!owns() || reviewFlight.current) return;
    const token = ++generation.current; reviewFlight.current = true; setReviewing(true); setReviewError('');
    try {
      const result = await readState(state.epoch, state.identity);
      if (owns() && generation.current === token && draft.observe(result)) setReview(result);
    } catch (problem) { if (owns() && generation.current === token) setReviewError(problemText(problem)); }
    finally { if (owns() && generation.current === token) { reviewFlight.current = false; setReviewing(false); } }
  };
  const send = async (action: 'save' | 'trash' | 'restore') => {
    if (!owns()) return;
    const result = await draft.send(action);
    if (result && owns()) {
      setTrashChoice(false); setReview(undefined);
      setNotice(result.action === 'save' ? 'Your note is saved.' : result.action === 'trash' ? 'Your note is in Trash. Its writing is kept.' : 'Your note is restored.');
      saved();
    }
  };
  const adopt = (keep: boolean) => {
    if (owns() && !reviewFlight.current && review && draft.acceptReviewed(review, keep)) { setReview(undefined); setTrashChoice(false); setNotice(keep ? 'Your writing is kept against the reviewed version. Save when ready.' : 'You are using the reviewed saved writing.'); }
  };
  const pending = draft.journal.pending, trashed = draft.journal.base?.trashed;
  const canReview = !draft.blocked && !draft.busy && !reviewing && (!pending || !!draft.journal.rejection);
  return <Dialog title={`${label(state.identity)} · My Note`} close={() => { if (draft.retain()) close(); }}>
    <div className="week-note-editor">
      <p className="metadata">{state.identity.timezone}{draft.journal.base ? ` · Saved version ${draft.journal.base.revision}${trashed ? ' · In Trash' : ''}` : ''}</p>
      <p className="week-note-visibility">Saved notes are shared with authenticated devices in this workspace. They are not added to Search or automatic Assistant context.</p>
      <label className="field"><span>Your writing</span><textarea aria-label="Your week note" value={draft.journal.text} maxLength={20000} rows={10}
        readOnly={draft.blocked || draft.busy || !!pending || !!trashed}
        onChange={event => { setNotice(''); draft.change(event.target.value); }}/></label>
      <p className="metadata">{draft.journal.text.length.toLocaleString()} / 20,000 characters · {draft.blocked ? 'Editing unavailable' : draft.hasConfirmedResult ? 'Saved on the host; local confirmation needs storage' : pending ? 'Original request kept' : draft.journal.dirty ? draft.kept ? 'Unfinished writing kept in this browser' : 'Keep this window open: writing needs storage' : draft.journal.base ? 'Saved writing' : 'No saved note yet'}</p>
      {draft.error && <p className="notice warning" role="alert">{draft.error}</p>}
      {reviewError && <p role="alert" className="field-error">{reviewError}</p>}
      {notice && <p role="status">{notice}</p>}
      {draft.changed && <p className="notice">The saved note has changed. Review it before saving your writing.</p>}
      {pending && <p className="notice">{draft.hasConfirmedResult ? 'The host confirmed the original request. Retry keeping that confirmation on this device; it will not send another request.' : draft.journal.rejection ? 'This request was refused. Review the saved version before choosing what to keep.' : 'The original request is awaiting confirmation. Checking it keeps the same writing and request.'}</p>}
      {review && <section className="week-note-review" aria-label="Reviewed saved note">
        <h3>{review.note ? `Saved Version ${review.note.revision}${review.note.trashed ? ' · In Trash' : ''}` : 'No Saved Note'}</h3>
        {review.note ? <><p className="metadata">{stamp(review.note.updatedAt, review.identity.timezone)}</p><p className="week-note-writing">{review.note.text}</p></> : <p>No note is saved for this exact week and timezone.</p>}
        {canReview && <div className="button-row"><button onClick={() => adopt(true)}>Keep My Writing</button><button onClick={() => adopt(false)}>Use Saved Writing</button></div>}
      </section>}
      {trashChoice && <section className="notice warning" aria-label="Move note to Trash"><p>Move this saved note to Trash? Its writing stays available to review and restore.</p><div className="button-row"><button disabled={draft.busy} onClick={() => void send('trash')}>Move Note To Trash</button><button disabled={draft.busy} onClick={() => setTrashChoice(false)}>Keep Note</button></div></section>}
      <div className="button-row week-note-actions">
        {pending && !draft.journal.rejection ? <button className="primary" disabled={draft.busy || draft.blocked} onClick={() => void send(pending.action)}>{draft.hasConfirmedResult ? 'Retry Keeping Confirmed Result' : `Check Original ${pending.action === 'save' ? 'Save' : pending.action === 'trash' ? 'Trash' : 'Restore'}`}</button>
          : trashed ? <button className="primary" disabled={draft.busy || draft.blocked || !!pending || draft.changed} onClick={() => void send('restore')}>Restore Note</button>
          : <button className="primary" disabled={draft.busy || draft.blocked || !!pending || draft.changed || !draft.journal.dirty || !draft.journal.text.trim()} onClick={() => void send('save')}>Save Note</button>}
        <button disabled={draft.busy || reviewing || draft.blocked} onClick={() => void readSaved()}>{reviewing ? 'Reading Saved Version…' : 'Review Saved Version'}</button>
        {draft.journal.base && !trashed && <button disabled={draft.busy || draft.blocked || !!pending || draft.changed || draft.journal.dirty} onClick={() => setTrashChoice(true)}>Trash Note</button>}
        <button onClick={() => { if (draft.retain()) close(); }}>{draft.blocked ? 'Close' : 'Keep & Close'}</button>
      </div>
    </div>
  </Dialog>;
}

export function WeekNotesList({ epoch, close, open }: { epoch: string; close(): void; open(identity: ProfileWeekIdentity): void }) {
  const [, render] = useState(0);
  const [pages] = useState(() => new WeekNotePages(epoch, (before, version) => request('profile/week/notes' +
    (before && version ? `?${new URLSearchParams({ before, version })}` : '')), () => render(value => value + 1)));
  useEffect(() => { pages.active = true; void pages.refresh(); return () => pages.retire(); }, [pages]);
  return <Dialog title="Saved Week Notes" close={close}>
    <div className="week-note-list"><p>Notes keep their original week and timezone, including notes in Trash.</p>
      <div className="section-heading"><p className="metadata">{pages.loaded ? `${pages.rows.length} of ${pages.total} notes` : 'Reading saved notes…'}</p><button disabled={pages.busy} onClick={() => void pages.refresh()}>Refresh Notes</button></div>
      {pages.error && <p role="alert" className="notice warning">{pages.error}</p>}
      {pages.busy && <p role="status">Reading notes…</p>}
      {pages.loaded && !pages.rows.length && <Empty title="No saved week notes yet.">Write a note for a week when you want to remember what mattered.</Empty>}
      <ul>{pages.rows.map(row => <li key={weekNoteIdentityKey(row.identity)}><button className="text-button" onClick={() => { if (pages.active) open(row.identity); }}>{label(row.identity)}</button><span className="metadata">{row.identity.timezone} · {row.trashed ? 'In Trash' : `Version ${row.revision}`} · {stamp(row.updatedAt, row.identity.timezone)}</span></li>)}</ul>
      {pages.refreshing ? <button disabled={pages.busy} onClick={() => void pages.refresh(true)}>Continue Refreshing Notes</button> : pages.next && <button disabled={pages.busy} onClick={() => void pages.more()}>Load Earlier Notes</button>}
      <button onClick={close}>Back To Your Week</button>
    </div>
  </Dialog>;
}

export function WeekNoteRecovery({ epoch, deviceId, windowId, close, open }: {
  epoch: string; deviceId: string; windowId: string; close(): void; open(identity: ProfileWeekIdentity): void;
}) {
  const [entries, setEntries] = useState<WeekNoteRecoveryEntry[]>([]), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const current = useRef({ epoch, deviceId, windowId }); current.current = { epoch, deviceId, windowId };
  const alive = useRef(true);
  const owns = () => alive.current && current.current.epoch === epoch && current.current.deviceId === deviceId && current.current.windowId === windowId;
  const refresh = () => {
    if (!owns()) return;
    const result = discoverWeekNoteWriting(weekNoteBrowserStorage, deviceId, epoch, windowId);
    // Keep previously confirmed rows when a bounded scan cannot finish.
    if (!result.error || !loaded) { setEntries(result.entries); setLoaded(true); }
    setError(result.error);
  };
  useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; }; }, []);
  const recover = (entry: WeekNoteRecoveryEntry) => {
    if (!owns() || !mayLeaveRecordDrafts()) return;
    try {
      const result = recoverWeekNoteWriting(weekNoteBrowserStorage, entry, deviceId, epoch, windowId);
      open(result.identity);
    } catch (problem) { setError(problemText(problem)); }
  };
  return <Dialog title="Recover Week Note Writing" close={close}>
    <div className="week-note-list"><p>Kept writing from this browser device. Opening another window’s draft copies its original writing and pending request into an empty slot here; the original stays kept.</p>
      <button onClick={refresh}>Refresh Kept Writing</button>
      {error && <p role="alert" className="notice warning">{error}</p>}
      {loaded && !entries.length && !error && <Empty title="No unfinished week notes found.">Saved notes are available from Saved Notes.</Empty>}
      <ul>{entries.map(entry => <li key={entry.key}>
        <strong>{label(entry.identity)}</strong><span className="metadata">{entry.identity.timezone} · {entry.current ? 'This window' : 'Another window'}</span>
        {entry.journal && <p className="week-note-writing">{entry.journal.text}</p>}
        {entry.journal?.pending && <p className="metadata">Original {entry.journal.pending.action === 'save' ? 'Save' : entry.journal.pending.action === 'trash' ? 'Trash' : 'Restore'} request kept</p>}
        {entry.unavailable ? <p role="note">{entry.unavailable}</p> : <button onClick={() => recover(entry)}>{entry.current ? 'Open This Kept Note' : 'Copy Original & Open'}</button>}
      </li>)}</ul>
      <button onClick={close}>Back To Your Week</button>
    </div>
  </Dialog>;
}
