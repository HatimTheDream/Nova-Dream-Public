import { useEffect, useRef, useState } from 'react';
import type { AccessContext, PhonePairing, PhoneState } from '../../../packages/domain/phone';
import { ApiError, request } from './api';
import { canonical } from '../../../packages/domain/contracts';
import { phonePairSchema } from '../../../packages/domain/phone';
import { PairingJournal, PhoneCommandJournal, phoneResultValid, type PhoneCommand } from './phone-request-journal';
import { Copy, Device } from './icons';
import { NovaAppMark, useAppIcon } from './AppIcon';
import { readCachedAppIcon } from './app-icon';

const local = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
const session = { getItem: (key: string) => sessionStorage.getItem(key), setItem: (key: string, value: string) => sessionStorage.setItem(key, value) };
export function PhoneSettings({ epoch, deviceId, access }: { epoch: string; deviceId: string; access?: AccessContext }) {
  const [state, setState] = useState<PhoneState>();
  const identity = `${epoch}:${deviceId}`;
  const owner = useRef<{ identity: string; journal: PhoneCommandJournal; intent?: PhoneCommand } | undefined>(undefined);
  if (owner.current?.identity !== identity) owner.current = { identity, journal: new PhoneCommandJournal(local, epoch, deviceId) };
  const currentOwner = owner.current, journal = currentOwner.journal, pending = currentOwner.intent ?? journal.pending;
  const [, redraw] = useState(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && owner.current === currentOwner;
  const [pairing, setPairing] = useState<PhonePairing>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef<typeof currentOwner | undefined>(undefined);
  useEffect(() => { setBusy(false); setState(undefined); setPairing(undefined); setMessage(''); }, [identity]);
  const phone = access?.surface === 'phone', recoveryPaused = !!(access?.recovery || access?.recoveryLocal);
  useEffect(() => {
    if (phone) return;
    let alive = true, reading = false;
    const refresh = async () => { if (reading) return; reading = true; try { const next = await request<PhoneState>('phone/state'); if (alive) setState(next); } catch { if (alive) setMessage('Phone settings are unavailable. Reconnect to your computer.'); } finally { reading = false; } };
    void refresh(); const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [phone, epoch, deviceId]);
  const send = async (path?: string, target?: string) => {
    if (active.current === currentOwner || recoveryPaused || !current()) return;
    const operation = currentOwner.intent ?? journal.pending ?? { path: 'phone/' + path, body: { requestId: crypto.randomUUID(), epoch, ...(target ? { deviceId: target } : {}) } } as PhoneCommand;
    currentOwner.intent = operation;
    if (!journal.keep(operation)) { setMessage(journal.error); redraw(n => n + 1); return; }
    active.current = currentOwner; setBusy(true); setMessage(''); redraw(n => n + 1);
    try {
      const result = await request<PhoneState | PhonePairing>(operation.path, operation.body, undefined, 45000);
      if (!phoneResultValid(operation.path, result)) throw Error('The original phone access result could not be verified.');
      if (!journal.keep({ ...operation, confirmed: true })) throw Error(journal.error);
      if (!current()) return;
      currentOwner.intent = undefined;
      if ('code' in result) setPairing(result);
      else if ('route' in result) setState(result);
      if (operation.path === 'phone/disable') setPairing(undefined);
      const observed = await request<PhoneState>('phone/state'); if (current()) setState(observed);
    } catch (error) {
      if (current()) setMessage(error instanceof Error ? error.message : 'The original change is unconfirmed. Check the same request.');
      // Generic HTTP failures are not proof of non-admission. Keep original bytes.
    } finally { if (active.current === currentOwner) active.current = undefined; if (current()) { setBusy(false); redraw(n => n + 1); } }
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
    {pending && <div className="notice"><span>{busy ? 'Applying phone access change…' : 'The original phone access change is unconfirmed. Check the same request to recover its result.'}</span><button disabled={recoveryPaused || busy} onClick={() => void send()}>Check Original Change</button></div>}
    {(message || journal.error) && <p role="status">{message || journal.error}</p>}
  </section>;
}

export function PhonePairingScreen({ paired, access }: { paired: () => Promise<void>; access?: AccessContext }) {
  const appIcon = useAppIcon(readCachedAppIcon());
  const [journal] = useState(() => new PairingJournal(session));
  const [name, setName] = useState(journal.current?.request.name ?? 'My Phone');
  const [code, setCode] = useState(journal.current?.request.code ?? '');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [, redraw] = useState(0);
  const active = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pair = async () => {
    if (active.current || !alive.current) return;
    if (journal.current?.state !== undefined && journal.current.state !== 'pending') return;
    active.current = true; setBusy(true); setMessage('');
    let operation: ReturnType<typeof phonePairSchema.parse> | undefined, digest: string | undefined;
    try {
      operation = journal.current?.request ?? phonePairSchema.parse({ requestId: crypto.randomUUID(), code, name, expiresAt: Date.now() + 5 * 60000 });
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(operation)));
      digest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
      if (!alive.current) return;
      if (!journal.begin(operation, digest)) throw Error(journal.error || 'The original pairing request could not be retained.');
      redraw(n => n + 1);
      const result = await request('pair', operation);
      if (!journal.settle(operation, digest, result)) throw Error(journal.error || 'The original pairing result could not be verified.');
      if (alive.current) await paired();
    } catch (error) {
      if (operation && digest && error instanceof ApiError && error.code === 'phone_pair_rejected') journal.settle(operation, digest, error.current, true);
      if (alive.current) setMessage(error instanceof Error ? error.message : 'The host could not be reached. The original pairing is kept.');
    } finally { active.current = false; if (alive.current) { setBusy(false); redraw(n => n + 1); } }
  };
  const checkAccess = async () => {
    if (active.current) return; active.current = true; setBusy(true);
    try { await paired(); } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : 'Workspace access could not be checked. The original pairing is kept.'); } finally { active.current = false; if (alive.current) setBusy(false); }
  };
  const review = () => { if (!busy && journal.reviewNewCode()) { setCode(''); setMessage('Enter a fresh owner code. The earlier request is kept.'); } redraw(n => n + 1); };
  const current = journal.current, terminal = current && current.state !== 'pending';
  const reason = access?.pairingReason === 'expired' ? 'This phone’s previous session expired.' : access?.pairingReason === 'revoked' ? 'Access for this phone was removed.' : access?.pairingReason === 'disabled' ? 'Private phone pairing is disabled on the host.' : 'Use an owner code for this optional private-network route.';
  return <main className="startup phone-pairing"><NovaAppMark choice={appIcon} alt="Nova"/><h1>Pair Your Phone</h1><p>{reason}</p><p>On the host, open Settings → Devices and create a code. Owner website sign-in is a separate route.</p>
    <form onSubmit={event => { event.preventDefault(); void pair(); }}><label>Device Name<input value={name} maxLength={80} required disabled={busy || !!current} onChange={event => setName(event.target.value)}/></label>
      <label>Pairing Code<input inputMode="numeric" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} value={code} maxLength={80} required disabled={busy || !!current} onChange={event => setCode(event.target.value)}/></label>
      {!terminal && <button className="primary" disabled={busy || !code.trim() || !name.trim()}>{busy ? 'Checking Original Pairing…' : current ? 'Check Original Pairing' : 'Connect Phone'}</button>}</form>
    {(message || journal.error) && <p role="alert">{journal.error || message}</p>}
    {journal.error && <button disabled={busy} onClick={() => { journal.retryRetention(); redraw(n => n + 1); }}>Retry Keeping Original Pairing</button>}
    {current?.state === 'confirmed' && <><p role="status">The original pairing was confirmed. Current access is checked separately.</p><button className="primary" disabled={busy} onClick={() => void checkAccess()}>Check Workspace Access</button></>}
    {terminal && <button disabled={busy} onClick={review}>Review New Pairing Code</button>}
    <p className="muted">Unsent writing remains on this device. Pairing does not send it or grant companion control.</p></main>;
}
