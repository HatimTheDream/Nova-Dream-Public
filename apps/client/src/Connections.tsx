import { useEffect, useRef, useState } from 'react';
import type { AssistantState } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { ChatGptSignInStatus, ChatGptSignInMethod, ChatGptAccountStatus } from '../../../packages/domain/sign-in';
import type { VoiceCatalog } from '../../../packages/domain/voice';
import type { RuntimeStatus } from '../../../packages/domain/runtime';
import { ApiError, readLocal, request, saveLocal } from './api';
import { RefreshReader } from './refresh-reader';
import { pollReader } from './polling';
import { ChatGptAccountList } from './ChatGptAccounts';
import { accountIntentWasNotAdmitted, accountSummary, accountTime, keepSignInIntent, type AccountOrderIntent, type AccountSignInIntent } from './chatgpt-account-controls';

export function Connections({ snapshot, online, openAssistant, remoteHost = false, recoveryPaused = false }: { snapshot: Snapshot; online: boolean; openAssistant: () => void; remoteHost?: boolean; recoveryPaused?: boolean }) {
  const canConnect = online && !recoveryPaused;
  const [assistant, setAssistant] = useState<AssistantState>();
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [signIn, setSignIn] = useState<ChatGptSignInStatus>();
  const [account, setAccount] = useState<ChatGptAccountStatus>();
  const [voice, setVoice] = useState<VoiceCatalog>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [method, setMethod] = useState<ChatGptSignInMethod>(remoteHost ? 'device-code' : 'browser');
  const [accountStale, setAccountStale] = useState(false);
  const mounted = useRef(true), context = useRef({ snapshot, assistant }); context.current = { snapshot, assistant };
  const [readers] = useState(() => {
    const identity = () => JSON.stringify([context.current.snapshot.epoch, context.current.snapshot.deviceId]);
    const hostIdentity = () => JSON.stringify([identity(), context.current.assistant?.connection.generation, context.current.assistant?.connection.url]);
    return [
      new RefreshReader({ identity, read: signal => request<AssistantState>('assistant/state', undefined, signal), accept: setAssistant }),
      new RefreshReader({ identity, read: signal => request<RuntimeStatus>('assistant/runtime', undefined, signal), accept: setRuntime }),
      new RefreshReader({ identity: hostIdentity, read: signal => request<ChatGptSignInStatus>('assistant/sign-in', undefined, signal), accept: setSignIn }),
      new RefreshReader({ identity: hostIdentity, read: signal => request<ChatGptAccountStatus>('assistant/account', undefined, signal), accept: value => { setAccount(value); setAccountStale(false); }, fail: () => setAccountStale(true) }),
      new RefreshReader({ identity: hostIdentity, read: signal => request<VoiceCatalog>('assistant/voice/catalog', undefined, signal), accept: setVoice }),
    ];
  });
  const refresh = () => Promise.all(readers.map(reader => reader.refresh())).then(() => undefined);
  useEffect(() => {
    mounted.current = true; setBusy(false); setError(''); setAccountStale(false); setAssistant(undefined); setRuntime(undefined); setSignIn(undefined); setAccount(undefined); setVoice(undefined);
    return () => { mounted.current = false; readers.forEach(reader => reader.cancel()); };
  }, [snapshot.epoch, snapshot.deviceId, readers]);
  const connecting = runtime?.state === 'starting' || assistant?.connection.state === 'connecting';
  const signingIn = signIn?.state === 'starting' || signIn?.state === 'waiting';
  useEffect(() => {
    const stops = readers.slice(0, 2).map(reader => pollReader(reader, () => connecting ? 2000 : 30000));
    return () => { stops.forEach(stop => stop()); };
  }, [snapshot.epoch, snapshot.deviceId, readers, connecting]);
  useEffect(() => {
    setSignIn(undefined); setAccount(undefined); setVoice(undefined); setAccountStale(false);
    if (!assistant) return;
    const stops = readers.slice(3).map((reader, index) => pollReader(reader, () => index === 0 ? 60000 : null));
    return () => { stops.forEach(stop => stop()); readers.slice(2).forEach(reader => reader.cancel()); };
  }, [snapshot.epoch, snapshot.deviceId, !!assistant, assistant?.connection.generation, assistant?.connection.url, readers]);
  useEffect(() => {
    if (assistant) return pollReader(readers[2], () => signingIn ? 2000 : 30000);
  }, [snapshot.epoch, snapshot.deviceId, !!assistant, assistant?.connection.generation, assistant?.connection.url, readers, signingIn]);
  const accountEvidence = JSON.stringify([assistant?.connection.generation, assistant?.connection.modelAuthReady, signIn?.state === 'completed' ? signIn.id : null]);
  const previousAccountEvidence = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!assistant) { previousAccountEvidence.current = undefined; return; }
    const changed = previousAccountEvidence.current !== undefined && previousAccountEvidence.current !== accountEvidence; previousAccountEvidence.current = accountEvidence;
    if (changed && !document.hidden) {
      // Account and voice readiness change at authentication boundaries, not on every heartbeat.
      readers.slice(3).forEach(reader => { void reader.refresh(); });
    }
  }, [accountEvidence, readers]);
  const perform = async (action: () => Promise<unknown>) => {
    const current = () => mounted.current && snapshot.epoch === context.current.snapshot.epoch && snapshot.deviceId === context.current.snapshot.deviceId;
    setBusy(true); setError('');
    try { await action(); if (current()) await refresh(); }
    catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Setup has not been confirmed. Check connection status.'); }
    finally { if (current()) setBusy(false); }
  };
  const connection = assistant?.connection;
  const ready = connection?.state === 'ready';
  const accountReady = ready && connection.modelAuthReady;
  const waitingForSignIn = signIn?.state === 'starting' || signIn?.state === 'waiting';
  const signInKey = `e3:chatgpt-signin-request:${snapshot.epoch}`, orderKey = `e3:chatgpt-account-order:${snapshot.epoch}`;
  const legacySignIn = readLocal<AccountSignInIntent>('e3:chatgpt-signin-request');
  const pendingSignIn = readLocal<AccountSignInIntent>(signInKey) ?? (legacySignIn?.epoch === snapshot.epoch ? legacySignIn : undefined);
  const pendingOrder = readLocal<AccountOrderIntent>(orderKey);
  const clearIntent = (key: string, requestId: string) => { if (readLocal<{ requestId: string }>(key)?.requestId === requestId) localStorage.removeItem(key); };
  const submitSignIn = async (intent: AccountSignInIntent) => {
    if (!saveLocal(signInKey, intent)) throw new Error('Free browser storage before starting sign-in.');
    const clear = () => { clearIntent(signInKey, intent.requestId); clearIntent('e3:chatgpt-signin-request', intent.requestId); };
    try {
      const result = await request<ChatGptSignInStatus>('assistant/sign-in/start', intent);
      clear();
      if (mounted.current && context.current.snapshot.epoch === intent.epoch) setSignIn(result);
    } catch (reason) { if (reason instanceof ApiError && accountIntentWasNotAdmitted(reason.code)) clear(); throw reason; }
  };
  const startSignIn = (intent: 'add' | 'reconnect', profileId?: string) => submitSignIn(keepSignInIntent(pendingSignIn, { epoch: snapshot.epoch, method, intent, ...(profileId ? { profileId } : {}) }, () => crypto.randomUUID()));
  const reorder = async (profileIds: string[]) => {
    if (pendingOrder && JSON.stringify(pendingOrder.profileIds) !== JSON.stringify(profileIds)) throw new Error('Resume the earlier account change before choosing another order.');
    const intent = pendingOrder ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, profileIds };
    if (!saveLocal(orderKey, intent)) throw new Error('Free browser storage before changing account order.');
    try {
      const result = await request<ChatGptAccountStatus>('assistant/account/order', intent);
      clearIntent(orderKey, intent.requestId);
      if (mounted.current && context.current.snapshot.epoch === intent.epoch) setAccount(result);
    } catch (reason) { if (reason instanceof ApiError && accountIntentWasNotAdmitted(reason.code)) clearIntent(orderKey, intent.requestId); throw reason; }
  };
  const unresolvedSignIn = signIn?.state === 'interrupted' && (!accountReady || accountStale || account?.state !== 'available' || !signIn.profileId || account.accounts?.find(value => value.profileId === signIn.profileId)?.health !== 'ready');
  const showSignIn = waitingForSignIn || unresolvedSignIn || !!pendingSignIn || !accountReady;
  return <section className="card settings-card"><h2>Assistant</h2>{recoveryPaused && <p className="notice">Connections are paused in this copy. Open Data to review recovery.</p>}
    <div className="assistant-setup"><div className="section-heading settings-connection-status"><strong>{recoveryPaused ? 'Paused for recovery' : !online ? 'Offline' : accountReady ? 'Ready to work' : !connection ? 'Checking connection…' : connecting ? 'Connecting…' : 'Connection needs attention'}</strong>
      {accountReady ? <button onClick={openAssistant}>Open Assistant</button> : <button className="primary" disabled={!canConnect || busy || !runtime || !connection || runtime.state === 'starting'} onClick={() => void perform(() => request('assistant/runtime/start', { requestId: crypto.randomUUID(), epoch: snapshot.epoch }))}>{!runtime || !connection ? 'Checking this host…' : runtime.state === 'starting' ? 'Starting OpenClaw…' : runtime.state === 'running' ? 'Reconnect this host' : 'Start on this host'}</button>}</div>
      {!ready && <p className="metadata" role="status">{connection?.message ?? 'Reading connection status…'}</p>}
      {connection?.pairingRequestId && <p className="notice">OpenClaw needs approval for this device. Request: <code>{connection.pairingRequestId}</code></p>}
      {runtime && ['starting', 'error', 'unavailable'].includes(runtime.state) && <p className={runtime.state === 'starting' ? 'metadata' : 'field-error'} role="status">{runtime.message}{runtime.state === 'starting' && runtime.elapsedSeconds !== undefined && ` · ${runtime.elapsedSeconds < 60 ? `${runtime.elapsedSeconds}s` : `${Math.floor(runtime.elapsedSeconds / 60)}m ${runtime.elapsedSeconds % 60}s`} elapsed`}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
    <div className="assistant-setup voice-signin"><h3>ChatGPT accounts</h3>
      {!account ? <p>Checking saved account…</p> : account.accounts?.length ? <ChatGptAccountList status={account} disabled={busy || waitingForSignIn || !canConnect || !runtime?.canSignIn || !!pendingSignIn || !!pendingOrder} reconnect={id => void perform(() => startSignIn('reconnect', id))} reorder={ids => void perform(() => reorder(ids))}/> : <p>{accountSummary(account)}</p>}
      {accountStale && <p className="metadata" role="status">Account Status Could Not Be Refreshed</p>}
      {account && account.state !== 'available' && <p className="metadata">{account.message}</p>}
      {!!signIn?.id && signIn.state !== 'completed' && showSignIn && <p className="metadata" role="status">{waitingForSignIn ? '' : 'Earlier sign-in: '}{signIn.message}</p>}
      {signIn?.state === 'waiting' && (signIn.authorizationUrl || signIn.verificationUrl) && <div className="device-signin">{signIn.userCode && <><span>Your Sign-In Code</span><code>{signIn.userCode}</code></>}<a className="button-link" href={signIn.authorizationUrl ?? signIn.verificationUrl} target="_blank" rel="noopener noreferrer">Continue In Browser</a><p className="metadata">{signIn.method === 'browser' ? 'Finish in a browser on this computer.' : 'Use this code only for the sign-in you started here.'}{accountTime(signIn.expiresAt) ? ` Expires ${accountTime(signIn.expiresAt)}.` : ''}</p></div>}
      <div className="setup-actions">{waitingForSignIn && <button disabled={busy || !canConnect || !signIn?.id} onClick={() => void perform(() => request('assistant/sign-in/cancel', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, attemptId: signIn!.id }))}>Stop Sign-In</button>}{pendingSignIn && <button disabled={busy || !canConnect} onClick={() => void perform(() => submitSignIn(pendingSignIn))}>Resume Sign-In</button>}{pendingOrder && <button disabled={busy || !canConnect || waitingForSignIn} onClick={() => void perform(() => reorder(pendingOrder.profileIds))}>Resume Account Change</button>}</div>
      <details className="settings-details account-add"><summary>Add ChatGPT account</summary>
      {!remoteHost && !waitingForSignIn && <label className="chatgpt-signin-method">Sign-In Method<select value={method} disabled={busy || !!pendingSignIn} onChange={event => setMethod(event.target.value as ChatGptSignInMethod)}><option value="browser">Browser</option><option value="device-code">Device Code</option></select></label>}
      <button disabled={busy || waitingForSignIn || !canConnect || !runtime?.canSignIn || !!pendingSignIn || !!pendingOrder} onClick={() => void perform(() => startSignIn('add'))}>Sign in to ChatGPT</button></details>
      {remoteHost && waitingForSignIn && <p className="metadata">Use this code on any device. Browser callbacks require a temporary host connection.</p>}
      {runtime && !runtime.canSignIn && !waitingForSignIn && <p className="metadata">Start the Assistant on this host to sign in here. For another host, sign in there.</p>}
      {voice && <div className="voice-readiness"><strong>{voice.state === 'available' ? 'Voice connection available' : voice.state === 'unconfigured' ? 'Voice account needed' : voice.state === 'disconnected' ? 'Assistant disconnected' : 'Voice access not confirmed'}</strong>{voice.state !== 'available' && <p className="metadata">{voice.message}</p>}</div>}
    </div>
    <details className="settings-details"><summary>Connection details</summary>
      <p className="metadata">{connection?.message}</p>
      <div className="connection-facts"><div><span>AI runtime</span><strong>{!connection ? 'Checking…' : ready ? 'Connected' : connecting ? 'Connecting…' : 'Not connected'}</strong></div><div><span>Model access</span><strong>{accountReady ? 'Available' : 'Not confirmed'}</strong></div></div>
      <button aria-label="Refresh Assistant connection and accounts" disabled={busy || !canConnect} onClick={() => void perform(async () => { await request<ChatGptAccountStatus>('assistant/account?refresh=1'); if (ready) await request('assistant/models'); })}>Refresh connection</button>
      {!!signIn?.id && (!showSignIn || signIn.state === 'completed') && <p className="metadata">Last sign-in: {signIn.message}</p>}
      <details className="gateway-options settings-details"><summary>Advanced connection setup</summary><form onSubmit={event => { event.preventDefault(); void perform(async () => { await request('assistant/connection', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, url: address, ...(token ? { token } : {}) }); setToken(''); }); }}><p className="metadata">Use the secure address and connection token from your chosen OpenClaw host.</p><label>Gateway address<input required type="url" placeholder="wss://your-private-host" value={address} onChange={event => setAddress(event.target.value)} autoComplete="off" spellCheck={false}/></label><label>Connection token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Kept only by the private service"/></label><button disabled={busy || !canConnect || !address}>Connect Gateway</button></form></details>

    </details>
  </section>;
}
