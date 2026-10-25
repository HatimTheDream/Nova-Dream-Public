import { UserRound } from './icons';
import './transcript-identity.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canonical, type Snapshot } from '../../../packages/domain/contracts';
import type { AssistantGroup, GroupMember } from '../../../packages/domain/assistant-groups';
import { groupDraftScopeSchema, parseGroupDraft, type GroupDraftScope, type GroupPreparationCommand, type GroupHistoryRef, type GroupResponseRef } from '../../../packages/domain/assistant-group-turns';
import { request, ApiError } from './api';
import { GroupMessageJournal, groupMessageKey, writingFromDraft } from './group-message-journal';
import { GroupMessageReader, groupDigest, preparationUrl, type GroupRoundView } from './group-message-reader';
import { registerRecordDraftNavigation } from './record-draft-navigation';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import { GroupReplyControls } from './GroupReplyControls';
import { GroupMessageRecovery } from './GroupMessageRecovery';
import { GroupContextInspector } from './GroupContextInspector';
import { GroupHistorySharing } from './GroupHistorySharing';

type Props = { snapshot: Snapshot; group: AssistantGroup; members: GroupMember[]; windowId: string };
const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
const get = (url: string) => request<unknown>(url);
const post = (command: GroupPreparationCommand) => request<unknown>('assistant/group-preparations', command);
const explain = (e: unknown) => e instanceof Error ? e.message : 'Your original message is kept.';
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function groupComposerScope({ snapshot, group, members, windowId }: Props, choice: string): GroupDraftScope | null {
  const ids = choice === 'default' ? group.defaultMemberId ? [group.defaultMemberId] : []
    : choice === 'everyone' ? group.activeMembershipIds : [choice];
  const recipients = ids.flatMap(id => {
    const member = members.find(row => row.id === id);
    const agent = snapshot.records?.agent.find(row => row.id === member?.agentId && !row.value.archived);
    return agent && group.activeMembershipIds.includes(id) ? [{ membershipId: id, agentRevision: agent.revision }] : [];
  });
  const project = group.projectId ? snapshot.projects.find(row => row.id === group.projectId) : null;
  if (!ids.length || recipients.length !== ids.length || group.archived || group.trashed || group.projectId && !project) return null;
  return groupDraftScopeSchema.parse({ format: 1, epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId, groupId: group.id,
    groupRevision: group.revision, membershipRevision: group.membershipRevision, defaultRevision: group.defaultRevision,
    mode: choice === 'default' || choice === 'everyone' ? choice : 'selected', recipients,
    project: project ? { id: project.id, revision: project.revision } : null });
}
const choiceOf = (scope: GroupDraftScope) => scope.mode === 'selected' ? scope.recipients[0].membershipId : scope.mode;
const pointerKey = (p: Props) => `e3:group-message-selection:${p.snapshot.epoch}:${p.snapshot.deviceId}:${p.windowId}:${p.group.id}`;
function initialScope(p: Props) {
  try {
    const raw = storage.getItem(pointerKey(p));
    if (raw !== null) {
      if (raw.length > 16000) throw Error('The saved recipient choice is too large.');
      const scope = groupDraftScopeSchema.parse(JSON.parse(raw));
      if (scope.epoch !== p.snapshot.epoch || scope.deviceId !== p.snapshot.deviceId || scope.windowId !== p.windowId || scope.groupId !== p.group.id)
        throw Error('The kept recipient choice belongs to another Group.');
      return { scope, error: '' };
    }
    return { scope: groupComposerScope(p, 'default'), error: '' };
  } catch (e) { return { scope: null, error: explain(e) }; }
}
export const groupReplyLabel = (state: string) => ({
  'not-sent': 'Not Sent', preparing: 'Preparing', dispatching: 'Sending — Outcome Unconfirmed',
  ready: 'Ready To Request Reply', accepted: 'Waiting For A Reply', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped',
  unknown: 'Outcome Unconfirmed',
}[state] ?? 'Outcome Unconfirmed');

export function GroupMessaging(props: Props) {
  const { snapshot, group, members } = props;
  const alive = useRef(true), active = useRef<GroupMessageJournal | null>(null);
  const [, redraw] = useState(0), update = () => { if (alive.current) redraw(n => n + 1); };
  const [initial] = useState(() => initialScope(props));
  const [journal, setJournal] = useState(() => {
    if (!initial.scope) return null;
    let first: GroupMessageJournal;
    first = new GroupMessageJournal(storage, initial.scope, () => alive.current && active.current === first);
    return first;
  });
  active.current = journal;
  const [reader] = useState(() => new GroupMessageReader(snapshot.epoch, group.id, () => alive.current));
  const [notice, setNotice] = useState(initial.error), [choice, setChoice] = useState(initial.scope ? choiceOf(initial.scope) : 'default');
  const [openRound, setOpenRound] = useState<string | null>(null);
  const [kept, setKept] = useState<GroupDraftScope[]>([]);
  const [readingDraft, setReadingDraft] = useState(false);
  const [comparison, setComparison] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [inspection, setInspection] = useState<GroupHistoryRef | GroupResponseRef>();
  const [sharing, setSharing] = useState(false);
  const currentScope = groupComposerScope(props, journal ? choiceOf(journal.scope) : choice);
  const current = !!journal && !!currentScope && equal(journal.scope, currentScope);
  const choiceChanged = !!journal && choice !== choiceOf(journal.scope);
  const writing = journal?.value.writing, pending = journal?.value.pending;
  const retained = () => {
    if (!journal) return !initial.error;
    if (journal.invalid) return true; // Leave malformed original bytes untouched.
    if (!journal.retain()) { update(); return false; }
    try {
      const raw = canonical(journal.scope);
      storage.setItem(pointerKey(props), raw);
      if (storage.getItem(pointerKey(props)) !== raw) throw Error('Your writing is kept, but its recipient selection was not confirmed.');
      return true;
    } catch (e) { setNotice(explain(e)); return false; }
  };
  useLayoutEffect(() => registerRecordDraftNavigation(retained), [journal, props.windowId, group.id]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (more = false) => { const work = reader.load(get, more); update(); await work; update(); };
  useEffect(() => { void load(); }, [reader]);
  const readDraft = async (selected: GroupMessageJournal) => {
    setReadingDraft(true);
    try {
      const id = 'draft:group:' + await groupDigest(selected.scope);
      let raw: string | null = null;
      try {
        const result = await request<{ epoch: string; groupId: string; view: string; raw: string; draft: unknown }>(
          preparationUrl(group.id, { view: 'draft', draftId: id }));
        if (result.epoch !== snapshot.epoch || result.groupId !== group.id || result.view !== 'draft'
          || parseGroupDraft(result.raw).id !== id || !equal(parseGroupDraft(result.raw), result.draft))
          throw Error('The saved message identity could not be verified.');
        raw = result.raw;
      } catch (e) { if (!(e instanceof ApiError && e.status === 404 && e.code === 'group_draft_missing')) throw e; }
      if (alive.current && active.current === selected) { selected.readSaved(raw); return true; }
      return false;
    } catch (e) { if (alive.current && active.current === selected) setNotice(explain(e)); return false; }
    finally { if (alive.current && active.current === selected) { setReadingDraft(false); update(); } }
  };
  useEffect(() => { if (journal && !journal.invalid) void readDraft(journal); }, [journal]);
  const switchScope = (scope: GroupDraftScope) => {
    if (journal?.busy || !retained()) return;
    let next: GroupMessageJournal;
    next = new GroupMessageJournal(storage, scope, () => alive.current && active.current === next);
    if (next.invalid) { setNotice(next.error); return; }
    active.current = next;
    if (!next.retain()) { active.current = journal; setNotice(next.error); return; }
    try {
      const raw = canonical(scope); storage.setItem(pointerKey(props), raw);
      if (storage.getItem(pointerKey(props)) !== raw) throw Error('The new recipient choice could not be kept.');
      setJournal(next); setChoice(choiceOf(scope));
      setComparison(false); setNotice('Previous writing stays with its original recipients.');
    } catch (e) { active.current = journal; setNotice(explain(e)); }
  };
  const openRecovered = (scope: GroupDraftScope) => {
    if (!alive.current || scope.epoch !== snapshot.epoch || scope.deviceId !== snapshot.deviceId
      || scope.groupId !== group.id || scope.windowId !== props.windowId) return false;
    let next: GroupMessageJournal;
    next = new GroupMessageJournal(storage, scope, () => alive.current && active.current === next);
    if (next.invalid) { setNotice(next.error); return false; }
    try {
      const raw = canonical(scope); storage.setItem(pointerKey(props), raw);
      if (storage.getItem(pointerKey(props)) !== raw) throw Error('The recovered draft selection could not be kept.');
      active.current = next; setJournal(next); setChoice(choiceOf(scope)); setComparison(false);
      setNotice('Your original is kept. This recovered copy is unsaved until you choose Save Draft.'); return true;
    } catch (e) { setNotice(explain(e)); return false; }
  };
  const change = (patch: Partial<NonNullable<typeof writing>>) => {
    if (!journal || !writing) return;
    journal.change({ ...writing, ...patch }); retained(); update();
  };
  const discover = () => {
    const scopes: GroupDraftScope[] = [];
    try {
      if (localStorage.length > 4096) throw Error('Too many local entries to safely list. Existing writing is kept.');
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (!key.startsWith('e3:group-message:') || key.length > 24000) continue;
        let scope: GroupDraftScope;
        try { scope = groupDraftScopeSchema.parse(JSON.parse(decodeURIComponent(key.slice('e3:group-message:'.length)))); } catch { continue; }
        if (key !== groupMessageKey(scope) || scope.epoch !== snapshot.epoch || scope.deviceId !== snapshot.deviceId
          || scope.windowId !== props.windowId || scope.groupId !== group.id) continue;
        if (scopes.length >= 64) throw Error('There are more kept recipient drafts than this list can show safely.');
        scopes.push(scope);
      }
      setKept(scopes); setNotice(scopes.length ? 'Choose an original recipient draft below.' : 'There are no other kept recipient drafts in this window.');
    } catch (e) { setNotice(explain(e)); }
  };
  const command = async (action: 'save' | 'prepare' | 'original') => {
    if (!journal) return;
    const original = journal;
    try {
      if (!retained()) return;
      const work = action === 'save' ? original.save(post) : action === 'prepare' ? original.prepare(reader.sequence!, post)
        : original.canContinue ? original.continueOriginal(post)
          : original.observe(c => get(preparationUrl(c.groupId, { view: 'request', requestId: c.requestId })));
      update(); const receipt = await work;
      if (receipt && alive.current && active.current === original) {
        setNotice(receipt.roundId ? 'Your message is prepared. No replies have been requested.' : 'This draft version is saved.');
        await load();
        if (receipt.roundId && reader.rows.some(row => row.id === receipt.roundId)) await open(receipt.roundId);
      }
    } catch (e) { if (alive.current && active.current === original) setNotice(explain(e)); }
    finally { update(); }
  };
  const open = async (id: string) => {
    const work = reader.open(id, get); update();
    if (await work && alive.current) setOpenRound(id); update();
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(writing?.text ?? ''); if (alive.current) setNotice('Complete message copied.'); }
    catch { if (alive.current) setNotice('Copy was unavailable. Select the complete text in the message field and copy it.'); }
  };
  const reviewRejected = async () => {
    if (!journal?.value.pending?.rejection || journal.busy || readingDraft) return;
    const original = journal;
    if (await readDraft(original) && alive.current && active.current === original && original.finishRejected()) {
      setNotice('The rejected request is kept. Review this draft and its current recipients before saving again.');
      await load(); update();
    }
  };
  const blocked = !journal || journal.invalid || journal.busy || readingDraft || !journal.checked || !current || choiceChanged
    || journal.conflict !== undefined || !!pending && !pending.receipt;
  const prepared = journal?.value.savedRaw && parseGroupDraft(journal.value.savedRaw).preparedRoundId;
  return <section className="group-messaging" aria-label="Group Messages">
    <header className="group-messages-heading"><h2>Messages{reader.sequence !== null ? ` · ${reader.total}` : ''}</h2>
      <button disabled={reader.busy} onClick={() => void load()}>Refresh Messages</button></header>
    {reader.error && <p className="group-message-status" role="alert">{reader.error}</p>}
    <div className="group-transcript">
      {!reader.rows.length && <p className="metadata">{reader.busy ? 'Reading saved messages…' : 'Write a message and choose who should respond. Earlier messages are shared only when you select them.'}</p>}
      {reader.rows.map(row => {
        const detail = openRound === row.id ? reader.details.get(row.id) : undefined;
        return <article key={row.id} className="group-round">
          <button className="group-round-heading" aria-expanded={!!detail} disabled={reader.busy} onClick={() => detail ? setOpenRound(null) : void open(row.id)}>
            <span>{row.preview || 'Prepared Message'}</span><small>{new Date(row.at).toLocaleString()} · {row.recipientMembershipIds.length} {row.recipientMembershipIds.length === 1 ? 'Recipient' : 'Recipients'}</small>
          </button>
          {detail && <GroupTranscriptRound detail={detail} members={members} disabled={!journal || journal.invalid || journal.busy}
            writing={writing} change={change} deviceId={snapshot.deviceId} refresh={() => void open(row.id)} inspect={setInspection}/>}
        </article>;
      })}
      {reader.next !== null && <button disabled={reader.busy} onClick={() => void load(true)}>Load More Messages</button>}
    </div>
    <div className="group-message-composer">
      <div className="group-recipient-row">
        <label>Responders<select aria-label="Message Responders" value={choice} onChange={e => setChoice(e.target.value)}>
          <option value="default">Default · {members.find(m => m.id === group.defaultMemberId)?.name ?? 'Unavailable'}</option>
          <option value="everyone">Ask Everyone</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name} · {snapshot.records?.agent.find(a => a.id === m.agentId)?.value.position || 'Saved Member'}</option>)}
          {choice !== 'default' && choice !== 'everyone' && !members.some(m => m.id === choice) && <option value={choice}>Original Member Unavailable</option>}
        </select></label>
        <button disabled={!!journal?.busy || !groupComposerScope(props, choice)} onClick={() => { const scope = groupComposerScope(props, choice); if (scope) switchScope(scope); }}>Use These Recipients</button>
        <button onClick={discover}>Kept Drafts</button>
        <button disabled={!!journal?.busy} onClick={() => { if (retained()) setRecovering(true); }}>Recover From Another Tab</button>
      </div>
      {!!kept.length && <div className="group-kept-drafts">{kept.map(scope => <button key={groupMessageKey(scope)}
        disabled={!!journal?.busy} onClick={() => switchScope(scope)}>{scope.mode === 'everyone' ? 'Everyone' : scope.mode === 'default' ? 'Default Responder' : 'Selected Responder'} · Group Revision {scope.groupRevision}</button>)}</div>}
      {journal ? <>
        <p className="metadata">Writing For: {journal.scope.recipients.map(r => members.find(m => m.id === r.membershipId)?.name ?? 'Original Member Unavailable').join(', ')}.
          {choiceChanged ? ' Apply the new recipient choice to open its separate draft.' : ''}</p>
        {!current && <p className="metadata" role="status">These original recipients or their saved details changed. Your writing stays here. Review the current recipients before preparing another message.</p>}
        <label className="group-message-field">Message<textarea value={writing!.text} maxLength={20000} rows={4}
          disabled={journal.invalid} onChange={e => change({ text: e.target.value })} placeholder="Write to this Group…"/></label>
        <div className="group-message-status" role={journal.error ? 'alert' : 'status'}>
          <span>{journal.invalid ? 'Kept Writing Needs Review' : journal.retentionError ? 'Kept In This Window' : pending?.rejection ? 'Save Not Admitted'
            : pending && !pending.receipt ? pending.dispatched ? 'Save Unconfirmed' : 'Original Request Kept'
            : journal.dirty ? 'Changes Kept On This Device' : journal.value.savedRaw ? 'Saved Draft Version' : 'New Message'}</span>
          <span>{journal.error || notice}</span>
          {journal.error && !journal.invalid && <button onClick={() => { retained(); update(); }}>Retry Keeping Writing</button>}
          <button disabled={journal.invalid} onClick={() => void copy()}>Copy Writing</button>
          {pending?.rejection ? <button disabled={journal.busy || journal.invalid || readingDraft} onClick={() => void reviewRejected()}>Review Rejected Save</button>
            : pending && !pending.receipt && <button disabled={journal.busy || journal.invalid} onClick={() => void command('original')}>
            {journal.canContinue ? 'Continue Original Request' : 'Check Original Save'}</button>}
        </div>
        <p className="metadata">Earlier Context: {writing!.history.length} {writing!.history.length === 1 ? 'Message' : 'Messages'} · {writing!.responses.length} {writing!.responses.length === 1 ? 'Reply' : 'Replies'}. Open a message to choose context. Included replies also include their original input context.</p>
        <GroupContextChoices writing={writing!} snapshot={snapshot} disabled={journal.invalid || journal.busy}
          change={change} inspect={setInspection}/>
        <button disabled={journal.invalid || journal.busy} onClick={() => { if (retained()) setSharing(true); }}>Share Earlier History With A Member</button>
        {journal.conflict !== undefined && <div className="group-message-comparison">
          <button aria-expanded={comparison} onClick={() => setComparison(!comparison)}>Review Saved Draft Difference</button>
          {comparison && <><h3>Your Kept Writing</h3><pre>{writing!.text}</pre><h3>Latest Saved Writing</h3>
            <pre>{journal.conflict ? writingFromDraft(journal.conflict).text : 'No Saved Draft'}</pre>
            {journal.conflict && <GroupContextChoices writing={writingFromDraft(journal.conflict)} snapshot={snapshot}
              disabled={true} change={() => {}} inspect={setInspection}/>}
            <div className="button-row"><button disabled={!!pending} onClick={() => { journal.chooseSaved(false); update(); }}>Keep My Edits</button>
              <button disabled={!!pending} onClick={() => { journal.chooseSaved(true); update(); }}>Use Latest Saved</button></div>
            <p className="metadata">Both copies are kept. Your choice prepares the editor; Save Draft is separate.</p></>}
        </div>}
        <div className="button-row">
          <button disabled={blocked || !journal.dirty} onClick={() => void command('save')}>Save Draft</button>
          <button className="primary" disabled={blocked || journal.dirty || !writing!.text.trim() || !!prepared || reader.sequence === null || reader.busy}
            onClick={() => void command('prepare')}>{prepared ? 'Message Prepared' : 'Prepare Message'}</button>
          {!journal.checked && <button disabled={readingDraft || journal.invalid} onClick={() => void readDraft(journal)}>Check Saved Draft</button>}
        </div>
        <p className="metadata">Preparation keeps the exact message and recipients. Open a prepared message to set up and request each person's reply.</p>
      </> : <p role="status">{notice || 'Add an available member, then choose the recipients for your message.'}</p>}
    </div>
    {recovering && <GroupMessageRecovery scope={{ epoch: snapshot.epoch, deviceId: snapshot.deviceId,
      windowId: props.windowId, groupId: group.id }} prepare={retained} opened={openRecovered} close={() => setRecovering(false)}/>}
    {inspection && <GroupContextInspector epoch={snapshot.epoch} groupId={group.id} reference={inspection} close={() => setInspection(undefined)}/>}
    {sharing && <GroupHistorySharing owner={{ epoch: snapshot.epoch, deviceId: snapshot.deviceId, groupId: group.id }}
      groupRevision={group.revision} sequence={reader.sequence} members={members.filter(row => group.activeMembershipIds.includes(row.id))} selection={{ history: writing?.history ?? [], responses: writing?.responses ?? [] }}
      changed={() => void load()} close={() => setSharing(false)}/>}
  </section>;
}

/** A retained attachment/context selection is always visible, including drafts
 * made by another supported editor. Current names cannot relabel old versions. */
export function GroupContextChoices({ writing, snapshot, disabled, change, inspect }: {
  writing: import('./group-message-journal').GroupWriting; snapshot: Snapshot; disabled: boolean;
  change: (patch: Partial<import('./group-message-journal').GroupWriting>) => void;
  inspect?: (ref: GroupHistoryRef | GroupResponseRef) => void;
}) {
  if (!writing.sources.length && !writing.history.length && !writing.responses.length) return null;
  return <details className="group-context-details"><summary>Review Included Context · {writing.sources.length + writing.history.length + writing.responses.length}</summary>
    <ul>
      {writing.sources.map((source, index) => {
        const entity = source.kind === 'layout' ? snapshot.layout : source.kind === 'task' ? snapshot.tasks.find(r => r.id === source.id)
          : source.kind === 'project' ? snapshot.projects.find(r => r.id === source.id)
          : source.kind === 'routine' ? snapshot.routines?.find(r => r.id === source.id)
          : snapshot.records?.[source.kind]?.find(r => r.id === source.id);
        const value = entity?.revision === source.revision ? entity.value as unknown as { title?: string; name?: string } : undefined;
        const label = value?.title || value?.name || `Original ${source.kind[0].toUpperCase() + source.kind.slice(1)} Version ${source.revision}`;
        return <li key={`${source.kind}:${source.id}`}><span>{label}</span>
          <button disabled={disabled} aria-label={`Remove Source ${index + 1}`} onClick={() => change({ sources: writing.sources.filter((_, i) => i !== index) })}>Remove Source</button></li>;
      })}
      {writing.history.map((ref, index) => <li key={ref.roundId}><span>Earlier Message {index + 1}</span>
        {inspect && <button onClick={() => inspect(ref)}>Inspect Message {index + 1}</button>}
        <button disabled={disabled} aria-label={`Remove Earlier Message ${index + 1}`} onClick={() => change({ history: writing.history.filter((_, i) => i !== index) })}>Remove Message</button></li>)}
      {writing.responses.map((ref, index) => <li key={ref.attemptId}><span>Earlier Reply {index + 1} And Its Original Context</span>
        {inspect && <button onClick={() => inspect(ref)}>Inspect Reply {index + 1}</button>}
        <button disabled={disabled} aria-label={`Remove Earlier Reply ${index + 1}`} onClick={() => change({ responses: writing.responses.filter((_, i) => i !== index) })}>Remove Reply</button></li>)}
    </ul>
  </details>;
}

export function GroupTranscriptRound({ detail, members, writing, change, disabled, deviceId, refresh, inspect }: {
  detail: GroupRoundView; members: GroupMember[]; writing?: import('./group-message-journal').GroupWriting;
  change: (patch: Partial<import('./group-message-journal').GroupWriting>) => void; disabled: boolean;
  deviceId?: string; refresh?: () => void;
  inspect?: (ref: GroupHistoryRef | GroupResponseRef) => void;
}) {
  const { round, responses } = detail;
  const history = writing?.history ?? [], selected = writing?.responses ?? [];
  return <div className="group-round-detail">
    <div className="group-message group-owner-message">
      <div className="group-message-author"><span className="transcript-identity-avatar" aria-hidden="true">{round.owner?.value.appearance ? <SquareLynx appearance={round.owner.value.appearance} size="icon" accessibility={{ mode: 'decorative' }}/> : <UserRound size={18}/>}</span><strong>{round.owner?.value.name || 'You'}</strong></div>
      <div className="group-message-bubble">{round.text}</div>
      <span className="metadata">Prepared · {round.recipients.map(r => r.captured.value.name).join(', ')}</span>
      {inspect && <button onClick={() => inspect({ roundId: round.id, sha256: detail.sha256 })}>Inspect This Message And Its Context</button>}
      <label className="group-context-choice"><input type="checkbox" disabled={disabled || history.length >= 64 && !history.some(r => r.roundId === round.id)}
        checked={history.some(r => r.roundId === round.id && r.sha256 === detail.sha256)}
        onChange={e => change({ history: e.target.checked ? [...history.filter(r => r.roundId !== round.id), { roundId: round.id, sha256: detail.sha256 }] : history.filter(r => r.roundId !== round.id) })}/>Include This Message As Context</label>
    </div>
    {responses.map((response, i) => <div key={response.attemptId} className="group-message group-agent-message">
      <div className="group-message-author"><span className="transcript-identity-avatar" aria-hidden="true"><SquareLynx appearance={round.recipients[i].captured.value.appearance} size="icon" accessibility={{ mode: 'decorative' }}/></span><strong>{response.author.name}</strong>
        <span>{response.author.position}</span>{!members.some(m => m.id === response.author.membershipId) && <small>Left Group</small>}</div>
      <div className="group-message-bubble">{response.text || (response.state === 'completed' ? 'Reply completed without text.' : 'No saved reply yet.')}</div>
      <span className="metadata">{groupReplyLabel(response.state)}{response.state === 'completed' && !response.selectable ? ' · Original Turn Unavailable' : ''}
        {response.stop ? ` · ${response.stop.state === 'confirmed' ? 'Stop Confirmed' : response.stop.state === 'requested' ? 'Stop Requested' : response.stop.state === 'failed' ? 'Stop Not Sent' : 'Stop Unconfirmed'}` : ''}</span>
      {response.selectable && response.ref && <label className="group-context-choice"><input type="checkbox"
        disabled={disabled || selected.length >= 32 && !selected.some(r => equal(r, response.ref))}
        checked={selected.some(r => equal(r, response.ref))}
        onChange={e => change({ responses: e.target.checked ? [...selected.filter(r => !equal(r, response.ref)), response.ref!] : selected.filter(r => !equal(r, response.ref)) })}/>Include This Reply As Context</label>}
      {inspect && response.ref && <button onClick={() => inspect(response.ref!)}>Inspect This Reply And Its Context</button>}
      {deviceId && <GroupReplyControls key={`${round.epoch}:${deviceId}:${round.id}:${response.attemptId}:${detail.sha256}`}
        binding={{ epoch: round.epoch, deviceId, groupId: round.groupId, roundId: round.id, roundSha256: detail.sha256,
          attemptId: response.attemptId, author: { agentId: response.author.agentId, agentRevision: response.author.agentRevision,
            membershipId: response.author.membershipId, roundId: round.id } }}
        originDevice={deviceId === round.deviceId} savedText={response.text} changed={refresh ?? (() => {})}/>}
    </div>)}
    {!detail.availability.current && <p className="metadata">{detail.availability.message || 'The original input is preserved. Its current access needs review.'}</p>}
  </div>;
}
