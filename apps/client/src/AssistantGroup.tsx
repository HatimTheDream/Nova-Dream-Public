import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { canonical, type Snapshot } from '../../../packages/domain/contracts';
import type { GroupCommand, GroupEvent, GroupMember } from '../../../packages/domain/assistant-groups';
import { activeProjects } from '../../../packages/domain/project-organization';
import { assistantSpace } from '../../../packages/domain/assistant-space';
import { request } from './api';
import { ArrowLeft, Plus, Users, RotateCcw, X } from './icons';
import { SquareLynx } from './nova/square-lynx/SquareLynx';
import { GroupEditorJournal, emptyGroupEditor, type GroupEditorScope, type GroupEditorDraft } from './assistant-group-journal';
import { GroupReader } from './assistant-group-reader';
import { registerRecordDraftNavigation } from './record-draft-navigation';
import type { GroupViewTarget } from './assistant-group-view';
import './assistant-group.css';
import { GroupMessaging } from './GroupMessaging';

type Props = { snapshot: Snapshot; windowId: string; target: NonNullable<GroupViewTarget>;
  back: () => void; changed: () => void; refreshWorkspace: () => Promise<void>; sidebarControls: ReactNode; navigationCovered: boolean;
  panelChanged: (open: boolean) => void; closePanelRequest: number };
const message = (error: unknown) => error instanceof Error ? error.message : 'This Group change could not be confirmed.';
const get = (url: string) => request<unknown>(url);
// Access itself can be denied, so evaluate the browser getter inside the journal's guards.
const groupStorage = { getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value) };

/** A Group is a saved shared conversation target, never a fabricated native Conversation. */
export function AssistantGroup(props: Props) {
  const { snapshot, target, windowId } = props;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [, render] = useState(0), update = () => { if (alive.current) render(value => value + 1); };
  const [reader] = useState(() => new GroupReader(snapshot.epoch, target.groupId, () => alive.current));
  const load = async () => { const pending = reader.load(get); update(); const ok = await pending; update(); return ok; };
  useEffect(() => {
    if (target.kind === 'group') void load();
    return () => reader.invalidate();
  }, []);
  const scope = { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId, groupId: target.groupId };
  return <section className="assistant-group conversation" aria-label="Group Conversation" inert={props.navigationCovered}>
    {!reader.detail && target.kind === 'group' ? <>
      <div className="conversation-header">{props.sidebarControls}<button onClick={props.back}><ArrowLeft size={17}/>Back To Chat</button></div>
      <div className="group-empty"><h2>{reader.busy ? 'Opening Group' : 'Group Unavailable'}</h2>
        <p role={reader.error ? 'alert' : 'status'}>{reader.error || 'Reading the saved members and original history.'}</p>
        {!reader.busy && <button onClick={() => void load()}>Check Saved Group</button>}</div>
    </> : <GroupEditor {...props} scope={scope} reader={reader} update={update} load={load}/>}
  </section>;
}

export function GroupEditor({ snapshot, scope, reader, update, load, back, changed, refreshWorkspace, sidebarControls, panelChanged, closePanelRequest }: Props & {
  scope: GroupEditorScope; reader: GroupReader; update: () => void; load: () => Promise<boolean>;
}) {
  const alive = useRef(true), title = useRef<HTMLInputElement>(null), membersButton = useRef<HTMLButtonElement>(null), panelTitle = useRef<HTMLHeadingElement>(null);
  const closeRequest = useRef(closePanelRequest);
  const reviewedRejection = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const initial = reader.detail ? { ...emptyGroupEditor(), title: reader.detail.group.title, projectId: reader.detail.group.projectId } : emptyGroupEditor();
  const [journal] = useState(() => new GroupEditorJournal(groupStorage, scope, () => alive.current, initial, reader.detail ? 'group' : 'create'));
  const [panel, setPanel] = useState<'members' | 'history' | null>(reader.detail ? null : 'members');
  const [preview, setPreview] = useState<{ id: string; revision: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [replacement, setReplacement] = useState<{ revision: number; defaultMemberId: string; memberId: string } | null>(null);
  const group = reader.detail?.group, members = reader.detail?.members ?? [], draft = journal.value.draft;
  const replacementId = replacement?.revision === group?.revision && replacement?.defaultMemberId === group?.defaultMemberId
    && members.some(member => member.id === replacement?.memberId && member.id !== group?.defaultMemberId) ? replacement?.memberId : undefined;
  const agents = snapshot.records?.agent ?? [], available = agents.filter(agent => !agent.value.archived);
  const pending = journal.value.pending, blocked = reviewing || journal.invalid || journal.busy || reader.busy || !!pending && !pending.receipt || !group && !!pending?.receipt;
  const metadataBlocked = blocked || !!group?.archived || !!group?.trashed;
  const projects = activeProjects(snapshot).filter(project => assistantSpace(project.value) === 'chat');
  const change = (patch: Partial<GroupEditorDraft>) => { journal.change({ ...journal.value.draft, ...patch }); update(); };
  // An unreadable journal cannot be edited; leaving preserves its untouched bytes.
  const retain = () => { const ok = journal.invalid || journal.retain(); update(); return ok; };
  useLayoutEffect(() => registerRecordDraftNavigation(retain), [journal]);
  useEffect(() => {
    if (journal.value.pending?.receipt && !reader.detail) void load().then(ok => { if (ok && alive.current) changed(); });
  }, [journal]);
  useEffect(() => {
    if (panel) requestAnimationFrame(() => {
      if (!alive.current) return;
      if (panel === 'members' && !preview) title.current?.focus();
      else panelTitle.current?.focus();
    });
  }, [panel, preview?.id]);
  const show = (next: typeof panel) => { if (!retain()) return; setPreview(null); setPanel(next); };
  const closePanel = () => { if (!retain()) return; setPreview(null); setPanel(null); requestAnimationFrame(() => membersButton.current?.focus()); };
  useEffect(() => { panelChanged(!!panel); return () => panelChanged(false); }, [panel]);
  useEffect(() => {
    if (closeRequest.current !== closePanelRequest) { closeRequest.current = closePanelRequest; closePanel(); }
  }, [closePanelRequest]);
  const refresh = async () => { if (await load()) changed(); };
  const afterReceipt = async () => {
    if (!alive.current) return;
    setNotice('');
    setReplacement(null);
    await refresh();
  };
  const run = async (input: Omit<GroupCommand, 'requestId' | 'epoch' | 'groupId' | 'expectedRevision'> & Record<string, unknown>) => {
    if (!alive.current || blocked) return;
    if (journal.value.pending && !journal.finish()) { update(); return; }
    const before = canonical(journal.value.draft);
    try {
      const command = { ...input, requestId: crypto.randomUUID(), epoch: scope.epoch, groupId: scope.groupId,
        expectedRevision: group?.revision ?? 0 } as GroupCommand;
      const promise = journal.send(command, value => request('assistant/groups', value)); update();
      const receipt = await promise; update();
      if (!receipt || !alive.current) return;
      if ((receipt.action === 'create' || receipt.action === 'add-members') && canonical(journal.value.draft) === before)
        journal.change({ ...journal.value.draft, members: [], defaultAgentId: null });
      await afterReceipt();
    } catch (error) { if (alive.current) { setNotice(message(error)); update(); } }
  };
  const original = async (kind: 'observe' | 'continue') => {
    const promise = kind === 'observe'
      ? journal.observe((groupId, requestId) => request(`assistant/groups?view=request&groupId=${groupId}&requestId=${requestId}`))
      : journal.continueUnsent(command => request('assistant/groups', command));
    update(); const receipt = await promise; update(); if (receipt) await afterReceipt();
  };
  const history = async (more = false) => {
    if (!retain()) return;
    setPanel('history'); setPreview(null);
    const promise = reader.history(get, more); update(); await promise; update();
  };
  const reviewRejected = async () => {
    if (reviewing || !journal.value.pending?.rejection) return;
    const original = journal.value.pending.command;
    setReviewing(true);
    try {
      // Once this original has been reviewed, retry only its local archive step.
      // A failed pointer readback must reach the journal's exact-byte recovery.
      if (reviewedRejection.current !== original.requestId) {
        if (!journal.retain()) return;
        await refreshWorkspace();
        if (!alive.current) return;
        if (original.action !== 'create' && !await load()) return;
        reviewedRejection.current = original.requestId;
      }
      if (!alive.current || !journal.finishRejected()) return;
      reviewedRejection.current = undefined;
      setNotice('Your writing is kept. Review the current members, then save a new change.'); changed();
    } catch (error) { if (alive.current) setNotice(message(error)); }
    finally { if (alive.current) { setReviewing(false); update(); } }
  };
  const selectedInvalid = draft.members.some(selected => !available.some(agent => agent.id === selected.agentId
    && agent.revision === selected.agentRevision) || members.some(member => member.agentId === selected.agentId));
  const defaultNeeded = !group || members.length === 0;
  const selectAgent = (id: string, revision: number, checked: boolean) => {
    const next = checked ? [...draft.members, { agentId: id, agentRevision: revision }] : draft.members.filter(member => member.agentId !== id);
    change({ members: next, defaultAgentId: next.some(member => member.agentId === draft.defaultAgentId) ? draft.defaultAgentId : null });
  };
  const profile = preview && agents.find(agent => agent.id === preview.id && agent.revision === preview.revision && !agent.value.archived);
  const openProfile = (member: GroupMember) => {
    const current = agents.find(agent => agent.id === member.agentId && !agent.value.archived);
    if (!current || !retain()) return;
    setPreview({ id: current.id, revision: current.revision }); setPanel('members');
  };
  const undo = (event: GroupEvent) => {
    if (event.command.action !== 'remove-member' || !group) return;
    const removed = reader.events.flatMap(row => row.addedMembers).find(member => member.id === event.removedMembershipIds[0]);
    const agent = available.find(agent => agent.id === removed?.agentId);
    if (!agent || members.some(member => member.agentId === agent.id)) return;
    void run({ action: 'undo-removal', removalEventId: event.id, agentRevision: agent.revision,
      defaultAgentId: members.length ? null : agent.id, shareEarlierHistory: false });
  };
  const remove = (member: GroupMember) => {
    const replacement = members.find(other => other.id === replacementId && other.id !== member.id);
    if (group?.defaultMemberId === member.id && members.length > 1 && !replacement) return;
    void run({ action: 'remove-member', membershipId: member.id,
      replacementMembershipId: group?.defaultMemberId === member.id ? replacement?.id ?? null : null });
  };
  return <>
    <div className="conversation-header">
      {sidebarControls}
      <button className="text-button" onClick={() => { if (retain()) back(); }}><ArrowLeft size={17}/>Back To Chat</button>
      <div className="conversation-title"><strong>{group?.title || 'New Group'}</strong><span className="metadata">{group?.trashed ? 'Deleted Group' : group?.archived ? 'Archived Group' : 'Group Chat'}</span></div>
      <button ref={membersButton} aria-expanded={panel === 'members'} aria-controls="assistant-group-members" onClick={() => panel === 'members' ? closePanel() : show('members')}><Users size={17}/>Members{group ? ` · ${members.length}` : ''}</button>
    </div>
    {(journal.error || notice || reader.error) && <div className="group-notice" role={journal.error || reader.error ? 'alert' : 'status'}>
      <span>{journal.error || reader.error || notice}</span>
      {journal.error && !journal.invalid && <button disabled={journal.busy} onClick={retain}>Retry Keeping Writing</button>}
      {reader.error && <button disabled={reader.busy} onClick={() => void refresh()}>Refresh Saved Group</button>}
    </div>}
    {pending && <div className="group-notice" role="status">
      <span>{pending.receipt ? 'The Original Change Is Confirmed.' : pending.rejection ? pending.rejection.message : journal.canContinueUnsent ? 'Your Original Change Is Kept And Has Not Been Sent.' : 'The Original Change Is Awaiting Confirmation.'}</span>
      {pending.rejection ? <button disabled={reviewing || journal.busy || journal.invalid} onClick={() => void reviewRejected()}>Keep Writing And Review Current Group</button>
        : !pending.receipt && <button disabled={journal.busy || journal.invalid} onClick={() => void original(journal.canContinueUnsent ? 'continue' : 'observe')}>{journal.canContinueUnsent ? 'Continue Original Change' : 'Check Original Change'}</button>}
    </div>}
    <div className={`group-body ${panel ? 'group-panel-open' : ''}`}>
      <div className="group-conversation">
        {group ? <GroupMessaging key={`${scope.epoch}:${scope.deviceId}:${scope.windowId}:${group.id}`} snapshot={snapshot} group={group} members={members} windowId={scope.windowId}/> : <div className="group-empty">
          <Users size={32}/><h2>Bring Your Agents Together</h2>
          <p>Choose the people for this Group and its default responder. Earlier history stays private unless you explicitly share it.</p>
        </div>}
      </div>
      {panel && <aside id="assistant-group-members" className="group-members-panel" aria-label={preview ? 'Agent Profile' : panel === 'history' ? 'Group History' : 'Group Members'}>
        <header className={`group-panel-heading ${preview ? 'group-profile-heading' : ''}`}><button onClick={preview ? () => setPreview(null) : closePanel}><ArrowLeft size={17}/>{preview ? 'Back To Members' : 'Back To Group'}</button><h2 ref={panelTitle} tabIndex={-1}>{preview ? 'Agent Profile' : panel === 'history' ? 'Group History' : 'Members'}</h2><button className="icon-button" aria-label="Close Group Panel" onClick={closePanel}><X size={18}/></button></header>
        {preview ? <div className="group-profile">{profile ? <><SquareLynx appearance={profile.value.appearance} size="icon" accessibility={{ mode: 'decorative' }}/><h3>{profile.value.name}</h3><p>{profile.value.position || 'Saved Agent'}</p><p className="metadata">Current Saved Profile · Revision {profile.revision}</p></> : <p role="status">This profile changed or is unavailable. Return to Members to review its current identity.</p>}</div>
        : panel === 'history' ? <>
          <p className="metadata">Original Membership Changes · {reader.historyRevision ? `Revision ${reader.historyRevision}` : 'Loading'}</p>
          {reader.historyRevision !== group?.revision && <button disabled={reader.busy} onClick={() => void history()}>Refresh Group History</button>}
          <ol className="group-history">{reader.events.map(event => {
            const removed = event.command.action === 'remove-member' ? reader.events.flatMap(row => row.addedMembers).find(member => member.id === event.removedMembershipIds[0]) : undefined;
            const restored = reader.events.some(row => row.command.action === 'undo-removal' && row.command.removalEventId === event.id);
            return <li key={event.id}><strong>{groupEventTitle(event, removed)}</strong><span className="metadata">{event.actor.name} · {new Date(event.at).toLocaleString()}</span>
              {event.command.action === 'remove-member' && <button disabled={metadataBlocked || restored || reader.next !== null || !available.some(agent => agent.id === removed?.agentId) || members.some(member => member.agentId === removed?.agentId)} onClick={() => undo(event)}><RotateCcw size={14}/>{restored ? 'Removal Undone' : 'Undo Removal'}</button>}</li>;
          })}</ol>
          {reader.next != null && <button disabled={reader.busy} onClick={() => void history(true)}>Load More Changes</button>}
          <p className="metadata">Undo adds a new membership. It preserves the earlier membership and a newer default-responder choice.</p>
        </> : <>
          <label className="group-field">Group Name<input ref={title} value={draft.title} maxLength={150} onChange={event => change({ title: event.target.value })} disabled={journal.invalid}/></label>
          {group ? <div className="button-row"><button disabled={metadataBlocked || !draft.title.trim() || draft.title.trim() === group.title} onClick={() => void run({ action: 'rename', title: draft.title })}>Save Name</button>{draft.title !== group.title && <button disabled={journal.invalid} onClick={() => change({ title: group.title })}>Use Saved Name</button>}</div>
            : <label className="group-field">Project<select value={draft.projectId ?? ''} onChange={event => change({ projectId: event.target.value || null })} disabled={journal.invalid}><option value="">No Project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.value.name}</option>)}{draft.projectId && !projects.some(project => project.id === draft.projectId) && <option value={draft.projectId}>Unavailable Project</option>}</select></label>}
          {!!group?.projectId && <p className="metadata">Project: {snapshot.projects.find(project => project.id === group.projectId)?.value.name ?? 'Unavailable'}</p>}
          {!!members.length && <ul className="group-member-list">{members.map(member => {
            const current = available.find(agent => agent.id === member.agentId), isDefault = member.id === group?.defaultMemberId;
            return <li key={member.id}><div className="group-member-identity"><SquareLynx appearance={member.appearance} size="icon" accessibility={{ mode: 'decorative' }}/><button className="text-button" disabled={!current} onClick={() => openProfile(member)}>{member.name}</button><small>{isDefault ? 'Default Responder' : !current ? 'Unavailable' : 'Member'}</small></div>
              <div className="button-row">{!isDefault && <button disabled={metadataBlocked || !current} onClick={() => void run({ action: 'choose-default', membershipId: member.id })}>Make Default</button>}
                {isDefault && members.length > 1 && <select aria-label={`Replacement For ${member.name}`} value={replacementId ?? ''} onChange={event => setReplacement(event.target.value && group ? { revision: group.revision, defaultMemberId: member.id, memberId: event.target.value } : null)}><option value="">Choose Replacement</option>{members.filter(other => other.id !== member.id).map(other => <option key={other.id} value={other.id}>{other.name}</option>)}</select>}
                <button disabled={metadataBlocked || isDefault && members.length > 1 && !replacementId} onClick={() => remove(member)}>Remove</button>
              </div></li>;
          })}</ul>}
          <h3>{group ? 'Add Members' : 'Choose Members'}</h3>
          <div className="group-agent-options">{available.filter(agent => !members.some(member => member.agentId === agent.id)).map(agent => {
            const selected = draft.members.find(member => member.agentId === agent.id);
            return <label key={agent.id}><input type="checkbox" checked={!!selected} disabled={journal.invalid || !selected && draft.members.length + members.length >= 32}
              onChange={event => selectAgent(agent.id, agent.revision, event.target.checked)}/><span>{agent.value.name}<small>{agent.value.position || 'Saved Agent'}{selected && selected.agentRevision !== agent.revision ? ' · Changed Since Selection' : ''}</small></span></label>;
          })}</div>
          {!available.length && <p>Create a saved agent in Team to add members here.</p>}
          {selectedInvalid && <p role="alert">A selected member changed or is already in the Group. Clear that selection before continuing.</p>}
          {!!draft.members.length && <button className="text-button" disabled={journal.invalid} onClick={() => change({ members: [], defaultAgentId: null })}>Clear Selected Members</button>}
          {defaultNeeded && !!draft.members.length && <label className="group-field">Default Responder<select value={draft.defaultAgentId ?? ''} onChange={event => change({ defaultAgentId: event.target.value || null })}><option value="">Choose A Responder</option>{draft.members.map(member => <option key={member.agentId} value={member.agentId}>{agents.find(agent => agent.id === member.agentId)?.value.name ?? 'Unavailable Agent'}</option>)}</select></label>}
          <p className="metadata">New members receive no earlier history. Membership does not change their permissions.</p>
          <button className="primary" disabled={metadataBlocked || selectedInvalid || !group && (!draft.title.trim() || !!draft.projectId && !projects.some(project => project.id === draft.projectId)) || !!group && !draft.members.length || defaultNeeded && !!draft.members.length && !draft.members.some(member => member.agentId === draft.defaultAgentId)} onClick={() => void run(group
            ? { action: 'add-members', members: draft.members, defaultAgentId: defaultNeeded ? draft.defaultAgentId : null, shareEarlierHistory: false }
            : { action: 'create', title: draft.title, projectId: draft.projectId, members: draft.members, defaultAgentId: draft.members.length ? draft.defaultAgentId : null, shareEarlierHistory: false })}><Plus size={16}/>{group ? 'Add Selected Members' : 'Create Group'}</button>
          {group && <div className="group-management"><button disabled={blocked} onClick={() => void run({ action: 'set-archived', archived: !group.archived })}>{group.archived ? 'Restore From Archive' : 'Archive Group'}</button><button disabled={blocked} onClick={() => void run({ action: 'set-trashed', trashed: !group.trashed })}>{group.trashed ? 'Restore Group' : 'Move Group To Deleted'}</button><button disabled={reader.busy} onClick={() => void history()}>Group History</button></div>}
        </>}
      </aside>}
    </div>
  </>;
}

export function groupEventTitle(event: GroupEvent, removed?: GroupMember) {
  const command = event.command;
  switch (command.action) {
    case 'create': return `Created ${command.title}`;
    case 'rename': return `Renamed To ${command.title}`;
    case 'add-members': return `Added ${event.addedMembers.map(member => member.name).join(', ')}`;
    case 'remove-member': return `Removed ${removed?.name ?? 'A Member'}`;
    case 'undo-removal': return `Restored ${event.addedMembers[0]?.name ?? 'A Member'}`;
    case 'choose-default': return 'Changed The Default Responder';
    case 'set-archived': return command.archived ? 'Archived The Group' : 'Restored From Archive';
    case 'set-trashed': return command.trashed ? 'Moved The Group To Deleted' : 'Restored The Group';
  }
}
