import { useEffect, useRef, useState } from 'react';
import type { AccessContext, PhonePairing, PhoneState } from '../../../packages/domain/phone';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Copy, Device } from './icons';

type Pending = { path: string; body: { requestId: string; epoch: string; deviceId?: string } };
export function PhoneSettings({ epoch, deviceId, access }: { epoch: string; deviceId: string; access?: AccessContext }) {
  const [state, setState] = useState<PhoneState>();
  const key = `e3:phone-command:${deviceId}`;
  const [pending, setPending] = useState<Pending | undefined>(() => readLocal(key));
  const [pairing, setPairing] = useState<PhonePairing>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef(false);
  const phone = access?.surface === 'phone', recoveryPaused = !!(access?.recovery || access?.recoveryLocal);
  useEffect(() => {
    if (phone) return;
    let alive = true, reading = false;
    const refresh = async () => { if (reading) return; reading = true; try { const next = await request<PhoneState>('phone/state'); if (alive) setState(next); } catch { if (alive) setMessage('Phone settings are unavailable. Reconnect to your computer.'); } finally { reading = false; } };
    void refresh(); const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [phone]);
  const send = async (path?: string, target?: string) => {
    if (active.current || recoveryPaused) return;
    const operation = pending ?? { path: 'phone/' + path, body: { requestId: crypto.randomUUID(), epoch, ...(target ? { deviceId: target } : {}) } };
    if (!saveLocal(key, operation)) { setMessage('Browser storage is full. Free space before changing phone access.'); return; }
    setPending(operation); active.current = true; setBusy(true); setMessage('');
    try {
      const result = await request<PhoneState | PhonePairing>(operation.path, operation.body, undefined, 45000);
      if ('code' in result) setPairing(result);
      else if ('route' in result) setState(result);
      if (operation.path === 'phone/disable') setPairing(undefined);
      saveLocal(key, null); setPending(undefined);
      setState(await request<PhoneState>('phone/state'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The change is unconfirmed. Retry the same change.');
      if (error instanceof ApiError && error.status && error.status < 500) { saveLocal(key, null); setPending(undefined); }
    } finally { active.current = false; setBusy(false); }
  };
  if (phone) return <section className="card settings-card"><h2>Connected to your computer</h2><p>Your phone uses the same saved workspace. Manage Google, Microsoft, Assistant sign-in and paired devices in Settings on your computer.</p></section>;
  return <section className="card settings-card phone-settings"><h2><Device size={22}/> {access?.surface === 'web' ? 'Optional Tailscale pairing' : 'Private phone access'}</h2><p>{access?.surface === 'web' ? 'Open this same website on your phone and sign in to use your workspace. Tailscale is only needed for the separate private-network pairing option below.' : 'Use the same Inbox, Calendar, Tasks and Assistant on your phone.'}</p>
    {recoveryPaused && <p className="notice">Review connection setup in Backup & recovery before enabling phone access for this copy.</p>}<div className="setting-row"><div><strong>{state?.enabled ? 'Tailscale pairing enabled' : 'Tailscale pairing off'}</strong><p role="status">{state?.route.message ?? 'Checking phone settings…'}</p></div><button disabled={recoveryPaused || busy || !!pending || !state} onClick={() => void send(state?.enabled ? 'disable' : 'enable')}>{state?.enabled ? 'Turn off' : 'Enable'}</button></div>
    {state?.enabled && state.route.state !== 'ready' && <div className="phone-actions"><button disabled={recoveryPaused || busy || !!pending} onClick={() => void send('enable')}>Reconnect Tailscale</button><a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Get Tailscale</a></div>}
    {state?.route.state === 'ready' && state.route.qrCodeDataUrl && <div className="phone-qr"><img src={state.route.qrCodeDataUrl} width={256} height={256} alt="QR code to open this Nova workspace on your phone"/><div><h3>Open Nova on your phone</h3><p>Connect Tailscale on your phone, then scan with its camera.</p><p>This opens your private workspace. If asked to pair, create a code below.</p></div></div>}
    {state?.route.origin && <div className="phone-address"><a href={state.route.origin} target="_blank" rel="noreferrer">{state.route.origin}</a><button title="Copy phone address" aria-label="Copy phone address" onClick={() => void navigator.clipboard.writeText(state.route.origin!).then(() => setMessage('Phone address copied.'), () => setMessage('Select and copy the phone address.'))}><Copy size={18}/></button></div>}
    {state?.route.state === 'ready' && <><div className="setting-row"><div><strong>Pair a phone</strong><p>Open the private address on your phone, then enter a code. Each code works once and expires in five minutes.</p></div><button disabled={recoveryPaused || busy || !!pending} onClick={() => void send('pairing')}>{pairing ? 'New code' : 'Create code'}</button></div>{pairing && <div className="phone-code" role="status">{pairing.expiresAt > now ? <><code>{pairing.code}</code><span>Expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></> : <span>This code expired. Create a new code.</span>}</div>}</>}
    <details className="phone-help"><summary>Tailscale pairing not connecting?</summary><ol><li>Open Tailscale on this computer and your phone. Both must be connected to the same private network.</li><li>If phone access is unavailable here, use Reconnect Tailscale. If Tailscale asks you to sign in, finish that in its app, then reconnect here.</li><li>Scan the QR code or open the private address in your phone's browser. Create a fresh pairing code if access was removed or the old code expired.</li></ol><p>Turning off Tailscale disconnects devices using this private route. Access through your protected website and your saved work are unaffected.</p></details>
    {!!state?.devices.length && <div className="phone-devices"><h3>Paired devices</h3>{state.devices.map(device => <div className="setting-row" key={device.id}><div><strong>{device.name}</strong><p>{device.revokedAt !== undefined ? 'Access removed' : device.expiresAt <= now ? 'Pairing expired' : `Last connected ${new Date(device.lastSeenAt).toLocaleDateString()}`}</p></div>{device.revokedAt === undefined && device.expiresAt > now && <button disabled={recoveryPaused || busy || !!pending} onClick={() => void send('revoke', device.id)}>Remove access</button>}</div>)}</div>}
    {pending && <div className="notice"><span>{busy ? 'Applying phone access change…' : 'A phone access change is unconfirmed. Retry to recover its original result.'}</span><button disabled={recoveryPaused || busy} onClick={() => void send()}>Retry change</button></div>}
    {message && <p role="status">{message}</p>}
  </section>;
}

type PairRequest = { requestId: string; code: string; name: string };
const pairKey = 'e3:phone-pair';
function keptPair(): PairRequest | undefined { try { return JSON.parse(sessionStorage.getItem(pairKey) ?? 'null') ?? undefined; } catch { return undefined; } }
export function PhonePairingScreen({ paired }: { paired: () => Promise<void> }) {
  const [pending, setPending] = useState(keptPair);
  const [name, setName] = useState(pending?.name ?? 'My phone');
  const [code, setCode] = useState(pending?.code ?? '');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false);
  const pair = async () => {
    if (active.current) return;
    const operation = pending ?? { requestId: crypto.randomUUID(), code, name };
    try { sessionStorage.setItem(pairKey, JSON.stringify(operation)); } catch { setMessage('Allow browser storage before pairing this phone.'); return; }
    setPending(operation); active.current = true; setBusy(true); setMessage('');
    try {
      await request('pair', operation); sessionStorage.removeItem(pairKey); setPending(undefined); setCode(''); await paired();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The host is unavailable. Retry this pairing.');
      if (error instanceof ApiError && error.status && error.status < 500) { sessionStorage.removeItem(pairKey); setPending(undefined); }
    } finally { active.current = false; setBusy(false); }
  };
  return <main className="startup phone-pairing"><img src="/mascot/lynx-mark.webp" alt="Nova"/><h1>Pair your phone</h1><p>On your computer, open Settings → Phone & devices and create a code.</p><form onSubmit={event => { event.preventDefault(); void pair(); }}><label>Device name<input value={name} maxLength={80} required disabled={busy || !!pending} onChange={event => setName(event.target.value)}/></label><label>Pairing code<input inputMode="numeric" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} value={code} maxLength={80} required disabled={busy || !!pending} onChange={event => setCode(event.target.value)}/></label><button className="primary" disabled={busy || !code.trim() || !name.trim()}>{busy ? 'Pairing…' : pending ? 'Retry pairing' : 'Connect phone'}</button></form>{message && <p role="alert">{message}</p>}<p className="muted">Existing unsent drafts remain stored on this device.</p></main>;
}
