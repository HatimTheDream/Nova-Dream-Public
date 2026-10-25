import { useEffect, useRef, useState } from 'react';
import { canonical } from '../../../packages/domain/contracts';
import type { SetupRequestReference, SetupRequestView } from '../../../packages/domain/setup-request';
import { ApiError, request } from './api';
import { retainedWindowId } from './useWorkspace';
import { SetupRequestJournal } from './setup-request-journal';

const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
export function useSetupRequest(epoch: string, deviceId: string, refresh: () => Promise<void>) {
  const identity = `${epoch}:${deviceId}:${retainedWindowId}`;
  const owner = useRef<{ identity: string; journal: SetupRequestJournal } | undefined>(undefined);
  if (owner.current?.identity !== identity) owner.current = { identity, journal: new SetupRequestJournal(storage, `e3:host-setup:${identity}`, epoch) };
  const journal = owner.current.journal;
  const active = useRef<SetupRequestJournal | undefined>(undefined), alive = useRef(true), [, render] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const current = () => alive.current && owner.current?.journal === journal;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setBusy(false); setError(''); }, [identity]);
  const perform = async (action: () => Promise<void>) => {
    if (!current() || active.current === journal) return;
    active.current = journal; setBusy(true); setError('');
    try { await action(); if (current()) await refresh(); }
    catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'The original setup outcome is unconfirmed.'); }
    finally { if (active.current === journal) active.current = undefined; if (current()) { setBusy(false); render(value => value + 1); } }
  };
  const accept = (view: unknown) => { if (!journal.accept(view)) throw Error(journal.error || 'The original setup receipt could not be verified.'); };
  const start = (kind: SetupRequestReference['kind'], details: { url?: string; token?: string } = {}, dispatched?: () => void) => perform(async () => {
    if (journal.pending || journal.error) throw Error('Check the original setup request first.');
    const input = { requestId: crypto.randomUUID(), epoch, ...details };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(input)));
    if (!current()) return;
    const reference = { requestId: input.requestId, epoch, kind, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
    if (!journal.begin(reference) || !journal.dispatch()) throw Error(journal.error || 'The setup request could not be retained.');
    dispatched?.();
    const response = await request<{ setupRequest: SetupRequestView }>(kind === 'runtime-start' ? 'assistant/runtime/start' : 'assistant/connection', input);
    accept(response.setupRequest);
  });
  const check = () => perform(async () => {
    const original = journal.pending;
    if (!original) return;
    accept(await request<SetupRequestView>(`assistant/setup-request?${new URLSearchParams(original.reference)}`));
  });
  const close = () => perform(async () => {
    const command = journal.prepareClose(crypto.randomUUID());
    if (!command) throw Error(journal.error || 'Read the original request before closing it.');
    try { accept(await request<SetupRequestView>('assistant/setup-request/close', command)); }
    catch (reason) {
      // These synchronous refusals performed no review/fence mutation.
      if (reason instanceof ApiError && ['setup_active', 'setup_owner_present', 'setup_changed'].includes(reason.code)) journal.clearRejectedClose();
      throw reason;
    }
  });
  const retain = () => { if (!current() || active.current === journal) return; journal.retryRetention(); render(value => value + 1); };
  return { journal, busy, error: journal.error || error, start, check, close, retain };
}
export function SetupRequestControls({ control, enabled }: { control: ReturnType<typeof useSetupRequest>; enabled: boolean }) {
  const pending = control.journal.pending, view = control.journal.value?.result;
  return <>
    {control.error && <p className="field-error" role="alert">{control.error}</p>}
    {control.journal.retentionPending && <button disabled={control.busy} onClick={control.retain}>Retry Keeping Original Request</button>}
    {pending && <div className="notice setup-original-request" role="status"><span>{view?.message ?? 'The original setup outcome is unconfirmed. It will not be repeated automatically.'}</span>
      <div className="button-row"><button disabled={!enabled || control.busy} onClick={() => void control.check()}>Check Original Setup</button>
        {view && ['not-found', 'unknown'].includes(view.state) && <button disabled={!enabled || control.busy}
          onClick={() => void control.close()}>Close Request Without Repeating</button>}</div>
      {view?.state === 'unknown' && <p>Closing records your review of the unconfirmed result. It does not claim success, undo setup or stop a running owner.</p>}
    </div>}
    {!pending && view && <p className="metadata" role="status">{view.message}</p>}
  </>;
}
