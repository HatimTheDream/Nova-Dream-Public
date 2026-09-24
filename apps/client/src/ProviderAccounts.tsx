import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { AccountPermission, AccountsState, ClientConfiguration, ConnectedAccount, Provider } from '../../../packages/domain/accounts';
import { ApiError, readLocal, request, saveLocal } from './api';
import { ArrowRight, Check, ChevronDown, RefreshCw } from './icons';
import { RefreshReader } from './refresh-reader';
import { pollReader } from './polling';
import { matchingProviderIntent, providerAccountStatus, providerConnectionStatus, providerPollInterval, providerSignInActive, type ProviderPending as Pending } from './settings-account-status';

const permissionNames:Record<AccountPermission,string>={mailDraft:'Save drafts',mailSend:'Send mail',mailModify:'Organize mail',calendarWrite:'Change calendar events',contactsRead:'Read contacts',contactsWrite:'Sync contacts'};
function AccountPermissions({account,disabled,upgrade}:{account:ConnectedAccount;disabled:boolean;upgrade:(permissions:AccountPermission[])=>void}) {
  const [selected,setSelected]=useState<AccountPermission[]>([]);
  const choices=[{id:'writing',title:'Save drafts and send mail',permissions:['mailDraft','mailSend'] as AccountPermission[],description:account.provider==='microsoft'?'Microsoft also includes permission to organize mail with draft access.':'Drafts and sending use the same Gmail compose permission.'},{id:'organize',title:'Organize mail',permissions:['mailModify'] as AccountPermission[],description:account.provider==='google'?'Gmail includes reading, drafting and sending with permission to move and label mail.':'Mark read, flag, categorize and move messages. Sending is separate.'},{id:'calendar',title:'Change calendar events',permissions:['calendarWrite'] as AccountPermission[],description:'Review event changes in Calendar before applying them to this account.'},{id:'contacts',title:'Sync account contacts',permissions:['contactsRead','contactsWrite'] as AccountPermission[],description:'Import people and sync their shared contact details. Private CRM notes, relationships and reminders stay in Nova Dream.'}];
  return <details className="account-permission-editor"><summary>Account permissions <ChevronDown size={16} aria-hidden="true"/></summary>
    <div className="account-permissions">{(Object.keys(permissionNames) as AccountPermission[]).map(permission=><span key={permission}>{account.capabilities[permission]&&<Check size={13}/>} {permissionNames[permission]} · {account.capabilities[permission]?'granted':'not granted'}</span>)}</div>
    {choices.filter(choice=>choice.permissions.some(permission=>!account.capabilities[permission])).map(choice=><label className="account-permission-choice" key={choice.id}><input type="checkbox" disabled={disabled||account.state!=='connected'} checked={choice.permissions.every(permission=>selected.includes(permission))} onChange={event=>setSelected(value=>event.target.checked?[...new Set([...value,...choice.permissions])]:value.filter(permission=>!choice.permissions.includes(permission)))}/><span><strong>{choice.title}</strong><small>{choice.description}</small></span></label>)}
    {!!selected.length&&<><p className="metadata">Continue with {account.email||account.label} in your browser. Existing access is requested again with these additions. Only granted permissions become available.</p><button className="primary" disabled={disabled||account.state!=='connected'} onClick={()=>upgrade(selected)}>Add permissions</button></>}
    {account.state!=='connected'&&<p className="metadata">Reconnect this account before adding permissions.</p>}
  </details>;
}
export function ProviderAccounts({ snapshot, online, recoveryPaused = false, active = true }: { snapshot: Snapshot; online: boolean; recoveryPaused?: boolean; active?: boolean }) {
  const [state, setState] = useState<AccountsState>(), [error, setError] = useState('');
  const context = useRef(snapshot); context.current = snapshot;
  const [reader] = useState(() => new RefreshReader({
    identity: () => `${context.current.epoch}:${context.current.deviceId}`,
    read: signal => request<AccountsState>('accounts', undefined, signal),
    accept: next => { setState(next); setError(''); },
    fail: () => setError('Account status is unavailable. Existing connections and saved work are kept.'),
  }));
  const interval = providerPollInterval(active, state?.attempts);
  useEffect(() => { if (interval !== null) return pollReader(reader, () => interval); }, [reader, interval, snapshot.epoch, snapshot.deviceId]);
  useEffect(() => { setState(undefined); setError(''); return () => reader.cancel(); }, [reader, snapshot.epoch, snapshot.deviceId]);
  return <div className="provider-connections"><div className="section-heading"><h3>Mail, calendar & contacts</h3><button className="icon-button" aria-label="Refresh account connections" onClick={() => void reader.refresh()}><RefreshCw size={18}/></button></div>{error && <p className="field-error" role="status">{error}</p>}{state ? (['google', 'microsoft'] as const).map(provider => <ProviderCard key={`${snapshot.epoch}:${snapshot.deviceId}:${provider}`} provider={provider} state={state} snapshot={snapshot} online={online} refresh={() => reader.refresh()} recoveryPaused={recoveryPaused}/>) : <p className="metadata">Reading account setup…</p>}</div>;
}
function ProviderCard({ provider, state, snapshot, online, refresh, recoveryPaused }: { provider: Provider; state: AccountsState; snapshot: Snapshot; online: boolean; refresh: () => Promise<void>; recoveryPaused: boolean }) {
  const client = state.clients.find(c => c.provider === provider)!, name = provider === 'google' ? 'Google' : 'Microsoft';
  const legacyKey = `e3:account-change:${snapshot.deviceId}:${sessionStorage.getItem('e3:tab')}:${provider}`, key = `${legacyKey}:${snapshot.epoch}`;
  const [pending, setPending] = useState(() => matchingProviderIntent(readLocal<Pending>(key), snapshot.epoch) ?? matchingProviderIntent(readLocal<Pending>(legacyKey), snapshot.epoch)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [baseRevision, setBaseRevision] = useState(client.revision), [reviewSetup, setReviewSetup] = useState(false);
  const [clientId, setClientId] = useState(client.clientId ?? ''), [secret, setSecret] = useState(''), [clearSecret, setClearSecret] = useState(false), [tenant, setTenant] = useState(client.tenant ?? 'common'), [port, setPort] = useState(client.callbackPort ?? 4389);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const latestAttempt = state.attempts.find(a => a.provider === provider), signingIn = latestAttempt && providerSignInActive(latestAttempt.state);
  const locked = busy || !!pending || !online, signInLocked = locked || !!signingIn;
  const accounts = state.accounts.filter(a => a.provider === provider);
  const clearIntent = (requestId: string) => { for (const storedKey of [key, legacyKey]) if (matchingProviderIntent(readLocal(storedKey), snapshot.epoch)?.command.requestId === requestId) localStorage.removeItem(storedKey); };
  const action = async (kind: Pending['action'], fields: Record<string, unknown> = {}) => {
    if (busy || !online) return;
    const original = pending ?? { action: kind, command: { requestId: crypto.randomUUID(), epoch: snapshot.epoch, ...fields } };
    // A client secret lives only in this form until the host accepts it. The
    // persisted journal can reconcile a configuration receipt without the secret.
    const kept = original.action === 'configure' ? { action: original.action, command: { requestId: original.command.requestId, epoch: original.command.epoch } } : original;
    if (!saveLocal(key, kept)) { setError('Free browser storage before changing an account connection.'); return; }
    setPending(kept); setBusy(true); setError('');
    try {
      const confirmed = pending?.action === 'configure' ? await request<{ revision: number }>(`accounts/configuration-receipts/${pending.command.requestId}`) : await request<{ revision?: number }>(`accounts/${original.action}`, original.command);
      if (alive.current && original.action === 'configure' && confirmed.revision !== undefined) { setBaseRevision(confirmed.revision); setReviewSetup(false); }
      clearIntent(original.command.requestId); if (alive.current) { setPending(undefined); if (original.action === 'configure') { setSecret(''); setClearSecret(false); } }
      await refresh();
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : 'The account change is not confirmed.');
      if (e instanceof ApiError && e.code === 'account_configuration_changed') setReviewSetup(true);
      if (e instanceof ApiError && ['validation', 'epoch_changed', 'account_changed', 'account_configuration_changed', 'account_client_missing', 'account_signin_active', 'account_signin_missing', 'account_configuration_unconfirmed'].includes(e.code)) { clearIntent(original.command.requestId); setPending(undefined); await refresh(); }
    } finally { if (alive.current) setBusy(false); }
  };
  const probe = async (accountId: string, expectedRevision: number) => {
    setBusy(true); setError(''); try { await request('accounts/probe', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, accountId, expectedRevision }); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Access could not be checked.'); }
    finally { if (alive.current) setBusy(false); await refresh(); }
  };
  const importGoogle = async (file?: File) => {
    if (!file) return;
    try { if (file.size > 65536) throw new Error('Choose the small OAuth client JSON file.'); const registration = JSON.parse(await file.text()); const value = state.callbackUri ? registration.web : registration.installed; if (typeof value?.client_id !== 'string' || (value.client_secret !== undefined && typeof value.client_secret !== 'string')) throw new Error('Choose an OAuth client JSON matching this host’s application type.'); if (!alive.current) return; setClientId(value.client_id); setSecret(value.client_secret ?? ''); setClearSecret(false); setError(''); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'This setup file could not be read.'); }
  };
  const attempt = latestAttempt && <><div className="account-signin" role="status"><p>{latestAttempt.message}</p>{!!latestAttempt.requestedPermissions?.length&&<p className="metadata">Requested additions: {latestAttempt.requestedPermissions.map(permission=>permissionNames[permission]).join(', ')}.</p>}{!!latestAttempt.missingPermissions?.length&&<p className="metadata">Not granted: {latestAttempt.missingPermissions.map(permission=>permissionNames[permission]).join(', ')}.</p>}{latestAttempt.state === 'waiting' && latestAttempt.authorizationUrl && <a className="button-link primary" href={latestAttempt.authorizationUrl} target="_blank" rel="noopener noreferrer">Continue to {name}<ArrowRight size={16}/></a>}{signingIn && <button disabled={locked} onClick={() => void action('cancel', { attemptId: latestAttempt.id })}>Stop sign-in</button>}</div>
    {provider === 'google' && ['waiting', 'failed'].includes(latestAttempt.state) && <details className="settings-details"><summary>Google sign-in help</summary><p>If Google says the app is in testing, ask its owner to add your address in Google Auth Platform → Audience → Test users.</p><p>Work or school accounts may separately need Google Workspace administrator approval. Resolve the restriction before retrying; existing connections are kept.</p><a href="https://support.google.com/cloud/answer/15549945?hl=en" target="_blank" rel="noopener noreferrer">Google’s app audience guide</a></details>}
  </>;
  return <section className="provider-card" aria-label={`${name} account setup`}><div className="section-heading"><h4>{name}</h4><span className="metadata">{recoveryPaused ? 'Paused for recovery' : providerConnectionStatus(accounts, client.configured)}</span></div>
    {accounts.map(account => { const result = state.probes.find(p => p.accountId === account.id && p.generation === account.generation); return <article className="connected-account" key={account.id}><details className="settings-account-row"><summary><span><strong>{account.label}</strong>{account.email && account.email !== account.label && <span className="metadata">{account.email}</span>}<span className="metadata">{recoveryPaused ? 'Paused for recovery' : providerAccountStatus(account.state)}</span></span><span className="settings-manage-label">Manage</span></summary><div className="account-permissions"><span>{account.capabilities.mailRead ? <Check size={13}/> : null}Mail read {account.capabilities.mailRead ? 'granted' : 'not granted'}</span><span>{account.capabilities.calendarRead ? <Check size={13}/> : null}Calendar read {account.capabilities.calendarRead ? 'granted' : 'not granted'}</span></div>
      {result && <div className="account-read-result"><p>{result.calendars.state === 'available' ? `${result.calendars.items.length} calendar${result.calendars.items.length === 1 ? '' : 's'} visible${result.calendars.limited ? ' · more available' : ''}` : `Calendar access unavailable · ${result.calendars.message}`}</p><p>{result.mail.state === 'available' ? `${result.mail.folders.length} mail folder${result.mail.folders.length === 1 ? '' : 's'} visible${result.mail.limited ? ' · more available' : ''}` : `Mail access unavailable · ${result.mail.message}`}</p><small>Checked {new Date(result.checkedAt).toLocaleString()}. Access check only; full sync is separate.</small>{result.calendars.items.length > 0 && <details><summary>Visible calendars</summary><ul>{result.calendars.items.map(c => <li key={c.id}>{c.name}{c.primary ? ' · primary' : ''}</li>)}</ul></details>}</div>}
      {account.message && account.state === 'connected' && <p className="metadata">{account.message}</p>}
      <AccountPermissions key={`${account.id}:${account.revision}`} account={account} disabled={signInLocked} upgrade={permissions=>void action('start',{provider,accountId:account.id,expectedRevision:account.revision,permissions})}/>
      <div className="setup-actions"><button disabled={locked || account.state !== 'connected'} onClick={() => void probe(account.id, account.revision)}>Check read access</button><button disabled={signInLocked} onClick={() => void action('start', { provider, accountId: account.id, expectedRevision: account.revision })}>Reconnect</button>{account.state !== 'disconnected' && <button disabled={locked} onClick={() => void action('disconnect', { accountId: account.id, expectedRevision: account.revision })}>Disconnect</button>}</div></details>{account.message && account.state !== 'connected' && <p className="metadata" role="status">{account.message}</p>}</article>; })}
    {latestAttempt && (['completed', 'cancelled', 'expired'].includes(latestAttempt.state) && !latestAttempt.missingPermissions?.length ? <details className="settings-details"><summary>Sign-in history</summary>{attempt}</details> : attempt)}
    {pending && <div className="notice"><p>The original {pending.action === 'configure' ? 'setup' : 'account change'} is awaiting confirmation.</p><button disabled={busy || !online} onClick={() => void action(pending.action)}>Reconcile original change</button></div>}
    {error && <p className="field-error" role="alert">{error}</p>}{reviewSetup && <div className="notice"><p>Saved setup: {client.clientId} · revision {client.revision}. Your fields are kept.</p><button disabled={busy} onClick={() => { setBaseRevision(client.revision); setReviewSetup(false); setError('Review the kept fields, then save explicitly.'); }}>Review my kept setup</button></div>}
    <details className="settings-details account-add"><summary>Add {name} account</summary><div className="setup-actions"><button className="primary" disabled={signInLocked || !client.configured} onClick={() => void action('start', { provider })}>Connect {name} account</button></div>
    {!client.configured && <p className="metadata">Save this host’s app registration first.</p>}
    <details className="account-registration"><summary>App registration setup</summary><form onSubmit={e => { e.preventDefault(); const configuration: ClientConfiguration = { clientId, ...(provider === 'microsoft' ? { provider, tenant, callbackPort: port } : { provider }), ...(clearSecret ? { clientSecret: '' } : secret ? { clientSecret: secret } : {}) }; void action('configure', { expectedRevision: baseRevision, configuration }); }}><fieldset disabled={signInLocked}>
      <p className="metadata">Use a {name} {state.callbackUri ? 'Web application' : 'public Desktop'} OAuth client matching this host’s callback.</p>
      <label>Client ID<input required maxLength={300} autoComplete="off" spellCheck={false} value={clientId} onChange={e => setClientId(e.target.value)}/></label>
      <label>Client secret {provider === 'google' ? '(if required)' : '(Web registration)'}<input type="password" autoComplete="new-password" maxLength={1000} value={secret} onChange={e => { setSecret(e.target.value); if (e.target.value) setClearSecret(false); }}/><small>Encrypted on this host. Blank keeps this client’s saved secret.</small></label>
      {client.hasClientSecret && <label className="checkbox-label"><input type="checkbox" checked={clearSecret} onChange={e => setClearSecret(e.target.checked)}/>Clear the saved client secret</label>}
      {state.callbackUri && <p className="metadata">Register this exact Web callback: <code>{state.callbackUri}</code>.</p>}
      {provider === 'google' ? <><label>Import client JSON<input type="file" accept="application/json,.json" onChange={e => { void importGoogle(e.target.files?.[0]); e.target.value = ''; }}/></label><p className="metadata">Enable Gmail and Google Calendar. <a href={state.callbackUri ? 'https://developers.google.com/identity/protocols/oauth2/web-server' : 'https://developers.google.com/identity/protocols/oauth2/native-app'} target="_blank" rel="noopener noreferrer">Google setup guide</a></p></> : <><label>Account audience or tenant<input required value={tenant} onChange={e => setTenant(e.target.value)} placeholder="common"/><small>Use common for personal and work/school accounts if your registration allows both.</small></label>{!state.callbackUri && <><label>Local callback port<input type="number" min={1024} max={65535} required value={port} onChange={e => setPort(Number(e.target.value))}/></label><p className="metadata">Register <code>http://127.0.0.1:{port}/oauth/callback</code> as a public desktop redirect and keep this port available. <a href="https://learn.microsoft.com/en-us/entra/identity-platform/reply-url" target="_blank" rel="noopener noreferrer">Microsoft setup guide</a></p></>}</>}
      <button type="submit" disabled={!clientId.trim() || reviewSetup}>Save app setup</button></fieldset></form></details></details>
  </section>;
}
