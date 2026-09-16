import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, RefreshCw } from './icons';
import type { AssistantState } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { ChatGptSignInStatus, ChatGptSignInMethod, ChatGptAccountStatus } from '../../../packages/domain/sign-in';
import type { VoiceCatalog } from '../../../packages/domain/voice';
import type { RuntimeStatus } from '../../../packages/domain/runtime';
import { readLocal, request, saveLocal } from './api';

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
  const mounted = useRef(true), reads = useRef(new Map<string, Promise<void>>());
  const refresh = (): Promise<void> => {
    // Host observations must remain visible while a remote voice/catalog read
    // is pending. Keep at most one request per resource, not one per timer tick.
    const observe = <T,>(path: string, apply: (value: T) => void) => {
      const pending = reads.current.get(path); if (pending) return pending;
      const reading = request<T>(path).then(value => { if (mounted.current) apply(value); }).finally(() => { reads.current.delete(path); });
      reads.current.set(path, reading); return reading;
    };
    return Promise.allSettled([
      observe<AssistantState>('assistant/state', setAssistant),
      observe<RuntimeStatus>('assistant/runtime', setRuntime),
      observe<ChatGptSignInStatus>('assistant/sign-in', setSignIn),
      observe<ChatGptAccountStatus>('assistant/account', setAccount),
      observe<VoiceCatalog>('assistant/voice/catalog', setVoice),
    ]).then(() => undefined);
  };
  useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(() => void refresh(), 1800); return () => { mounted.current = false; clearInterval(timer); }; }, []);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Setup has not been confirmed. Check connection status.'); }
    finally { setBusy(false); }
  };
  const connection = assistant?.connection;
  const ready = connection?.state === 'ready';
  const accountReady = ready && connection.modelAuthReady;
  const waitingForSignIn = signIn?.state === 'starting' || signIn?.state === 'waiting';
  const startSignIn = async (method: ChatGptSignInMethod) => {
    const key = 'e3:chatgpt-signin-request';
    const intent = readLocal<{ requestId: string; epoch: string; method?: ChatGptSignInMethod }>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, method };
    if (!saveLocal(key, intent)) throw new Error('Free browser storage before starting sign-in.');
    const result = await request<ChatGptSignInStatus>('assistant/sign-in/start', intent);
    localStorage.removeItem(key); setSignIn(result);
  };
  return <section className="card settings-card"><h2>Assistant & voice</h2>{recoveryPaused && <p className="notice">Connections are paused in this copy. Open Data & recovery → Connections after recovery before setting them up again.</p>}
    <div className="setting-row"><div><strong>Private workspace</strong><p>{online ? 'Your saved work is available on this host.' : 'Unavailable. This device keeps unsaved drafts.'}</p></div><span className={`status-pill ${online ? 'done' : ''}`}>{online ? 'Connected' : 'Offline'}</span></div>
    <div className="assistant-setup"><div className="section-heading"><div><span className="eyebrow">OpenClaw + ChatGPT</span><h3>{accountReady ? 'Your Assistant is ready.' : 'Connect your Assistant.'}</h3></div>{accountReady && <span className="status-pill done"><Check size={14}/>Ready</span>}</div>
      <p>Edition 3 uses OpenClaw’s ChatGPT connection. Choose this host or connect your other private host. Each conversation stays with the host that created it.</p>
      <div className="connection-facts"><div><span>OpenClaw</span><strong>{ready ? 'Connected' : runtime?.phase === 'preparing' ? 'Preparing workspace…' : runtime?.phase === 'process' ? 'Starting on this host…' : runtime?.phase === 'gateway' || connection?.state === 'connecting' ? 'Connecting workspace…' : 'Not connected'}</strong></div><div><span>ChatGPT access</span><strong>{accountReady ? 'Models available' : ready ? 'Checking model access' : 'Waiting for OpenClaw'}</strong></div></div>
      <p className="metadata" role="status">{connection?.message ?? 'Reading connection status…'}</p>
      {connection?.pairingRequestId && <p className="notice">OpenClaw needs approval for this device. Request: <code>{connection.pairingRequestId}</code></p>}
      <div className="setup-actions">{accountReady ? <button className="primary" onClick={openAssistant}>Open Assistant<ArrowRight size={16}/></button> : <button className="primary" disabled={!canConnect || busy || runtime?.state === 'starting'} onClick={() => void perform(() => request('assistant/runtime/start', { requestId: crypto.randomUUID(), epoch: snapshot.epoch }))}>{runtime?.state === 'starting' ? 'Starting OpenClaw…' : runtime?.state === 'running' ? 'Reconnect this host' : 'Start on this host'}</button>}<button aria-label="Refresh Assistant connection" disabled={busy} onClick={() => void perform(async () => { if (ready) await request('assistant/models'); await refresh(); })}><RefreshCw size={16}/>Check status</button></div>
      {runtime && ['starting', 'error', 'unavailable'].includes(runtime.state) && <p className={runtime.state === 'starting' ? 'metadata' : 'field-error'} role="status">{runtime.message}{runtime.state === 'starting' && runtime.elapsedSeconds !== undefined && ` · ${runtime.elapsedSeconds < 60 ? `${runtime.elapsedSeconds}s` : `${Math.floor(runtime.elapsedSeconds / 60)}m ${runtime.elapsedSeconds % 60}s`} elapsed`}</p>}
      <details className="gateway-options"><summary>Connect a private OpenClaw Gateway</summary><form onSubmit={event => { event.preventDefault(); void perform(async () => { await request('assistant/connection', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, url: address, ...(token ? { token } : {}) }); setToken(''); }); }}><p className="metadata">Use the secure address and connection token from OpenClaw setup on your chosen host.</p><label>Gateway address<input required type="url" placeholder="wss://your-private-host" value={address} onChange={event => setAddress(event.target.value)} autoComplete="off" spellCheck={false}/></label><label>Connection token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Kept only by the private service"/></label><button disabled={busy || !canConnect || !address}>Connect Gateway</button></form></details>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
    <div className="assistant-setup voice-signin"><div className="section-heading"><div><span className="eyebrow">Assistant, agents & voice</span><h3>ChatGPT account</h3></div></div>
      <p>{account?.emails.length ? account.emails.join(', ') : account?.profileCount ? `${account.profileCount} saved account(s)` : 'No account identity confirmed'}</p>
      <p className="metadata">{account?.message ?? 'Checking saved account…'}</p>
      {!!signIn?.id && <p className="metadata" role="status">{waitingForSignIn ? '' : 'Last sign-in: '}{signIn.message}</p>}
      {signIn?.state === 'waiting' && (signIn.authorizationUrl || signIn.verificationUrl) && <div className="device-signin">{signIn.userCode && <><span>Your sign-in code</span><code>{signIn.userCode}</code></>}<a className="button-link" href={signIn.authorizationUrl ?? signIn.verificationUrl} target="_blank" rel="noopener noreferrer">Continue in browser<ArrowRight size={16}/></a><p className="metadata">{signIn.method === 'browser' ? 'Finish in a browser on this computer so OpenAI can return to Nova.' : 'Use this code only for the sign-in you started here.'} This attempt expires in about 15 minutes.</p></div>}
      <div className="setup-actions">{waitingForSignIn ? <button disabled={busy || !signIn?.id} onClick={() => void perform(() => request('assistant/sign-in/cancel', { requestId: crypto.randomUUID(), epoch: snapshot.epoch, attemptId: signIn!.id }))}>Stop sign-in</button> : <button disabled={busy || !canConnect || !runtime?.canSignIn} onClick={() => void perform(() => startSignIn(remoteHost ? 'device-code' : 'browser'))}>{remoteHost ? 'Get a sign-in code' : 'Sign in with browser'}</button>}<button disabled={busy || !canConnect} onClick={() => void perform(async () => { setAccount(await request<ChatGptAccountStatus>('assistant/account?refresh=1')); if (ready) await request('assistant/models'); })}>Check account</button></div>
      {!remoteHost && !waitingForSignIn && <details><summary>Use a sign-in code instead</summary><p className="metadata">Available when your OpenAI account permits device-code sign-in.</p><button disabled={busy || !canConnect || !runtime?.canSignIn} onClick={() => void perform(() => startSignIn('device-code'))}>Get a sign-in code</button></details>}
      {remoteHost && <p className="metadata">Sign in from any device using a code. If your account requires a browser callback, a temporary host connection is needed for that setup.</p>}
      {!runtime?.canSignIn && !waitingForSignIn && <p className="metadata">Start the Assistant on this host to sign in here. For another host, sign in there.</p>}
      {voice && <div className="voice-readiness"><strong>{voice.state === 'available' ? 'Voice connection available' : voice.state === 'unconfigured' ? 'Voice account needed' : voice.state === 'disconnected' ? 'Assistant disconnected' : 'Voice access not confirmed'}</strong><p className="metadata">{voice.message}</p></div>}
      <p className="metadata">Signing in does not start the microphone. Start voice from a conversation.</p>
    </div>
  </section>;
}
