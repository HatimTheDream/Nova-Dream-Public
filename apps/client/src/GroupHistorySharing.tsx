import { useEffect, useRef, useState } from 'react';
import type { GroupMember } from '../../../packages/domain/assistant-groups';
import type { GroupHistoryRef, GroupResponseRef } from '../../../packages/domain/assistant-group-turns';
import { request } from './api';
import { Dialog } from './ui';
import { draftBrowserStorage } from './draft-browser-storage';
import { GroupHistoryJournal, validateHistoryPreview, type HistoryCommand, type HistoryOwner, type HistoryPreview } from './group-history-sharing';
import { GroupContextInspector } from './GroupContextInspector';

const get = (path: string) => request<unknown>(path);
export function GroupHistorySharing({ owner, groupRevision, sequence, members, selection, close, changed }: {
  owner: HistoryOwner; groupRevision: number; sequence: number | null; members: GroupMember[];
  selection: { history: GroupHistoryRef[]; responses: GroupResponseRef[] }; close(): void; changed(): void;
}) {
  const alive = useRef(true), working = useRef(false);
  const [journal] = useState(() => new GroupHistoryJournal(draftBrowserStorage, owner, () => alive.current));
  const [, redraw] = useState(0), update = () => { if (alive.current) redraw(n => n + 1); };
  const [member, setMember] = useState(''), [review, setReview] = useState<HistoryPreview>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [inspection, setInspection] = useState<GroupHistoryRef | GroupResponseRef>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pending = journal.value.pending, display = pending?.preview ?? review;
  const preview = async () => {
    if (working.current || pending || !member || !sequence || journal.invalid) return;
    const command: HistoryCommand = { action: 'grant-history-v2', requestId: crypto.randomUUID(), epoch: owner.epoch,
      groupId: owner.groupId, expectedGroupRevision: groupRevision, expectedSequence: sequence,
      membershipId: member, throughSequence: sequence, history: selection.history, responses: selection.responses };
    working.current = true; setBusy(true); setError(''); setReview(undefined);
    try {
      const result = validateHistoryPreview(owner, command, await request('assistant/group-preparations/preview', command));
      if (alive.current) setReview(result);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'The original history could not be reviewed.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const share = async () => {
    if (working.current || journal.invalid) return;
    if (!pending && (!review || !journal.keep(review))) { update(); return; }
    working.current = true; setBusy(true); setError('');
    try {
      if (journal.canContinue) await journal.send(command => request('assistant/group-preparations', command), get);
      else await journal.observe(get);
      if (alive.current && journal.value.pending?.confirmation) changed();
    } finally { working.current = false; if (alive.current) { setBusy(false); update(); } }
  };
  if (inspection) return <GroupContextInspector epoch={owner.epoch} groupId={owner.groupId} reference={inspection} close={() => setInspection(undefined)}/>;
  return <Dialog title="Share Earlier Group History" close={close}>
    <p>Choose one current member. Review the selected messages, replies and their included context before sharing.
      Sharing permits future messages to include this history; it does not request a reply.</p>
    {!pending && <>
      <label>Share With<select value={member} disabled={busy || journal.invalid} onChange={e => { setMember(e.target.value); setReview(undefined); }}>
        <option value="">Choose A Member</option>{members.map(row => <option key={row.id} value={row.id}>{row.name} · Membership {row.id.slice(0, 8)}</option>)}
      </select></label>
      <p>{selection.history.length} Selected Messages · {selection.responses.length} Selected Replies</p>
      <button disabled={busy || journal.invalid || !member || !sequence || !selection.history.length && !selection.responses.length}
        onClick={() => void preview()}>Review Exact History</button>
    </>}
    {display && <section aria-label="Exact History To Share">
      <h3>History For {members.find(row => row.id === display.command.membershipId)?.name || 'The Original Member'}</h3>
      <p>Membership {display.command.membershipId.slice(0, 8)} · Group Version {display.command.expectedGroupRevision}.
        This includes {display.includedHistory.length} original messages and {display.includedResponses.length} completed replies, including inherited context.</p>
      {display.includedHistory.map((ref, i) => <button key={ref.roundId} onClick={() => setInspection(ref)}>Inspect Message {i + 1}</button>)}
      {display.includedResponses.map((ref, i) => <button key={ref.attemptId} onClick={() => setInspection(ref)}>Inspect Reply {i + 1}</button>)}
      {pending?.confirmation ? <p role="status">This exact history-sharing choice is saved.</p>
        : pending?.rejection ? <p role="status">The original sharing request was not admitted. Review the current member and history before making another choice.</p>
          : <button className="primary" disabled={busy || journal.invalid} onClick={() => void share()}>
            {!pending ? 'Share This Exact History' : journal.canContinue ? 'Continue Original Sharing Request' : 'Check Original Sharing Request'}</button>}
      {pending && !pending.confirmation && !pending.rejection && <p role="status">
        {pending.dispatched ? 'Sharing is unconfirmed. The original request is kept; checking will not submit it again.' : 'This original choice is kept and has not been sent.'}</p>}
      {(pending?.confirmation || pending?.rejection) && <button disabled={busy} onClick={() => {
        if (journal.finish()) { setReview(undefined); setMember(''); changed(); } update();
      }}>Keep Original And Review Another Choice</button>}
      {pending && !pending.dispatched && <button disabled={busy} onClick={() => {
        if (journal.finish(true)) { setReview(undefined); setMember(''); } update();
      }}>Keep Unsent Choice And Review Another</button>}
    </section>}
    {(error || journal.error) && <p role="alert" className="field-error">{error || journal.error}</p>}
  </Dialog>;
}
