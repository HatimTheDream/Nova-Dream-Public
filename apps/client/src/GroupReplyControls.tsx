import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { groupExecutionAccountSchema } from '../../../packages/domain/assistant-group-execution';
import { request } from './api';
import { GroupReplyJournal, type GroupReplyBinding } from './group-reply-journal';

const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
const get = (path: string) => request<unknown>(path);
const post = (path: string, body: unknown) => request<unknown>(path, body);
const accountStatusSchema = z.object({ state: z.enum(['available', 'empty', 'unavailable']),
  accounts: z.array(z.object({ profileId: groupExecutionAccountSchema.shape.profileId, label: z.string().max(512),
    health: z.enum(['ready', 'cooldown', 'reconnect', 'unknown']), duplicateOf: z.string().optional() })).max(100).optional() });
const modelsSchema = z.array(z.object({ id: z.string().max(512), name: z.string().max(512),
  available: z.boolean() })).max(10000);
export const replyStateLabel = (state: string) => ({
  preparing: 'Preparing', dispatching: 'Outcome Unconfirmed', ready: 'Ready To Request Reply',
  accepted: 'Waiting For A Reply', unknown: 'Outcome Unconfirmed',
  completed: 'Reply Saved', failed: 'Failed', cancelled: 'Stopped',
}[state] ?? 'Not Set Up');
export function GroupReplyControls({ binding, originDevice, savedText, changed }: {
  binding: GroupReplyBinding; originDevice: boolean; savedText: string; changed: () => void;
}) {
  const alive = useRef(true);
  const [, draw] = useState(0), update = () => { if (alive.current) draw(n => n + 1); };
  const [journal] = useState(() => new GroupReplyJournal(storage, binding, () => alive.current && originDevice));
  const [accounts, setAccounts] = useState<z.infer<typeof accountStatusSchema>['accounts']>();
  const [models, setModels] = useState<z.infer<typeof modelsSchema>>([]);
  const [profile, setProfile] = useState(''), [model, setModel] = useState('');
  const [choicesBusy, setChoicesBusy] = useState(false), [choicesError, setChoicesError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (originDevice) void read(); }, []);
  const run = async (action: () => Promise<unknown>, refreshHistory = true) => {
    const pending = action(); update(); await pending;
    if (alive.current) { update(); if (refreshHistory) changed(); }
  };
  const read = () => run(() => journal.read(get), false);
  const choices = async () => {
    if (choicesBusy) return;
    setChoicesBusy(true); setChoicesError(''); setAccounts(undefined); setModels([]);
    try {
      const [rawAccounts, rawModels] = await Promise.all([get('assistant/account'), get('assistant/models')]);
      const status = accountStatusSchema.parse(rawAccounts), catalog = modelsSchema.parse(rawModels);
      if (!alive.current) return;
      setAccounts(status.state === 'available' ? status.accounts : []);
      setModels(catalog.filter(m => m.available && groupExecutionAccountSchema.shape.model.safeParse(m.id).success));
      if (status.state !== 'available') setChoicesError('No ready ChatGPT account was returned. Open Accounts in Settings to reconnect.');
    } catch (e) { if (alive.current) setChoicesError(e instanceof Error ? e.message : 'Account and model choices could not be checked.'); }
    finally { if (alive.current) setChoicesBusy(false); }
  };
  if (!originDevice) return <p className="metadata">Saved replies are readable here. Native reply controls remain on the device that prepared this message.</p>;
  const last = journal.value.last, pending = journal.value.pending;
  const phase = last?.send ?? last?.setup;
  const canSetup = journal.canAct && !last && !choicesBusy
    && accounts?.some(a => a.profileId === profile && a.health === 'ready' && !a.duplicateOf)
    && models.some(m => m.id === model);
  return <div className="group-reply-controls" aria-label="Original Reply Controls" aria-busy={journal.busy}>
    <div className="group-reply-status" role="status">
      {pending?.rejection ? 'Action Not Admitted' : journal.unresolved ? pending?.dispatched ? 'Original Request Unconfirmed' : 'Original Request Kept'
        : replyStateLabel(phase?.state ?? '')}
      {last && !journal.checked ? ' · Last Confirmed State' : ''}
      {last?.stop ? ` · ${last.stop.state === 'confirmed' ? 'Stop Confirmed' : last.stop.state === 'requested' ? 'Stop Requested' : last.stop.state === 'failed' ? 'Stop Not Sent' : 'Stop Unconfirmed'}` : ''}
    </div>
    {last?.activity?.text && !['completed', 'failed', 'cancelled'].includes(last.send?.state ?? '') && <div>
      <span className="metadata">Reply In Progress · Completion Unconfirmed</span>
      <div className="group-message-bubble">{last.activity.text}</div>
    </div>}
    {last?.text && last.text !== savedText && <div><span className="metadata">Latest Saved Reply</span>
      <div className="group-message-bubble">{last.text}</div></div>}
    {last && <p className="metadata">Account: {accounts?.find(a => a.profileId === last.account.profileId)?.label ?? last.account.profileId} · Model: {last.account.model}</p>}
    {!last && !journal.unresolved && <div className="group-reply-setup">
      <button disabled={choicesBusy || journal.busy || journal.invalid} onClick={() => void choices()}>
        {choicesBusy ? 'Checking Choices…' : 'Choose Account And Model'}</button>
      {accounts && <><label>Account<select aria-label="Reply Account" value={profile} disabled={journal.busy} onChange={e => setProfile(e.target.value)}>
        <option value="">Choose An Account</option>
        {accounts.map(a => <option key={a.profileId} value={a.profileId} disabled={a.health !== 'ready' || !!a.duplicateOf}>
          {a.label}{a.health !== 'ready' ? ' · Unavailable' : a.duplicateOf ? ' · Shared Allowance' : ''}</option>)}
      </select></label><label>Model<select aria-label="Reply Model" value={model} disabled={journal.busy} onChange={e => setModel(e.target.value)}>
        <option value="">Choose A Model</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select></label><button disabled={!canSetup} onClick={() => void run(() => journal.start('setup', post, { account: { profileId: profile, model } }))}>Set Up Reply</button></>}
      {choicesError && <p role="alert">{choicesError}</p>}
    </div>}
    <div className="button-row">
      <button disabled={journal.busy || journal.invalid} onClick={() => void read()}>
        {journal.unresolved ? 'Check Original Request' : 'Refresh Saved State'}</button>
      {journal.canContinueOriginal && <button disabled={journal.busy || journal.invalid}
        onClick={() => void run(() => journal.continueOriginal(post))}>Continue Kept Request</button>}
      {last && <>
        {last.canSend && <button className="primary" disabled={!journal.canAct}
          onClick={() => void run(() => journal.start('send', post))}>Request Reply</button>}
        <button disabled={!journal.canAct} onClick={() => void run(() => journal.observe(post))}>Check Reply Progress</button>
        {last.canStop && <button disabled={!journal.canStop}
          onClick={() => void run(() => journal.start('stop', post))}>Stop This Reply</button>}
        {last.canContinueStop && <button disabled={!journal.canContinueStop}
          onClick={() => void run(() => journal.start('continue-stop', post))}>Continue Unsent Stop</button>}
        {(['setup', 'send'] as const).map(name => last[name]?.canContinueUnsent && <button key={name} disabled={!journal.canAct}
          onClick={() => void run(() => journal.start('continue-unsent', post, { phase: name }))}>
          {name === 'setup' ? 'Continue Unsent Setup' : 'Continue Unsent Reply'}</button>)}
      </>}
    </div>
    {journal.value.observation && <p role="status">Progress check unconfirmed. Refresh Saved State checks the original operation without starting another check.</p>}
    {(journal.error || phase?.error) && <p className="field-error" role="alert">{journal.error || phase?.error}</p>}
    {last?.stop && 'format' in last.stop && last.stop.error && <p className="field-error" role="alert">{last.stop.error}</p>}
    {journal.retentionError && <p role="status">The request is kept in this window. Native actions stay blocked until it can be retained.</p>}
    {(journal.unresolved || journal.retentionError) && <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(journal.value, null, 2))
      .then(() => { if (alive.current) setCopyNotice('Original Request Copied'); })
      .catch(() => { if (alive.current) setCopyNotice('Copy unavailable. Keep this window open.'); })}>Copy Original Request</button>}
    {copyNotice && <span role="status">{copyNotice}</span>}
    {!last && <p className="metadata">Setup keeps this person's account and message binding. Request Reply is a separate action.</p>}
  </div>;
}
