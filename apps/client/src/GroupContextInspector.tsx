import { useEffect, useRef, useState } from 'react';
import type { GroupHistoryRef, GroupResponseRef } from '../../../packages/domain/assistant-group-turns';
import { Dialog } from './ui';
import { request } from './api';
import { inspectGroupContext } from './group-message-reader';

type Reference = GroupHistoryRef | GroupResponseRef;
export function GroupContextInspector({ epoch, groupId, reference, close }: {
  epoch: string; groupId: string; reference: Reference; close(): void;
}) {
  const alive = useRef(true), serial = useRef(0);
  const [stack, setStack] = useState<Reference[]>([reference]);
  const [view, setView] = useState<Awaited<ReturnType<typeof inspectGroupContext>>>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++; }; }, []);
  const read = async (ref: Reference) => {
    const token = ++serial.current; setBusy(true); setError('');
    try {
      const result = await inspectGroupContext(epoch, groupId, ref, path => request(path));
      if (alive.current && token === serial.current) setView(result);
    } catch (e) { if (alive.current && token === serial.current) setError(e instanceof Error ? e.message : 'The original context could not be read.'); }
    finally { if (alive.current && token === serial.current) setBusy(false); }
  };
  const current = stack.at(-1)!;
  useEffect(() => { setView(undefined); void read(current); }, [current]);
  const open = (ref: Reference) => { if (!busy && stack.length < 256) setStack([...stack, ref]); };
  return <Dialog title="Inspect Earlier Context" close={close}>
    {stack.length > 1 && <button disabled={busy} onClick={() => setStack(stack.slice(0, -1))}>Back To Selected Context</button>}
    <p>These are captured versions. Inspection does not include them in a message or share them with another member.</p>
    {busy && <p role="status">Reading The Original Context…</p>}
    {error && <p className="field-error" role="alert">{error} <button disabled={busy} onClick={() => void read(current)}>Check Original Context</button></p>}
    {view && <>
      {view.reply && <section><h3 className="preserve-case">{view.reply.author.name} · {view.reply.author.position}</h3>
        <pre className="group-recovery-writing">{view.reply.text}</pre></section>}
      <section><h3>Original Owner Message</h3><pre className="group-recovery-writing">{view.round.text}</pre></section>
      <p>Captured Recipients: {view.round.recipients.map(row => row.captured.value.name).join(', ')}</p>
      <h3>Captured Sources</h3>
      {!view.round.context.sources.length && <p>No sources were captured.</p>}
      {view.round.context.sources.map(source => <details key={`${source.kind}:${source.id}:${source.revision}`}>
        <summary>{source.kind} · {source.id} · Version {source.revision}</summary>
        <pre className="group-recovery-writing">{JSON.stringify(source.value, null, 2)}</pre>
      </details>)}
      <h3>Earlier Input Included With This Message</h3>
      {!view.round.context.history.length && <p>No earlier owner messages were included.</p>}
      {view.round.context.history.map((ref, i) => <button key={ref.roundId} disabled={busy || stack.length >= 256}
        onClick={() => open(ref)}>Inspect Earlier Message {i + 1}</button>)}
      {'responses' in view.round.context && <section><h3>Earlier Replies Included With This Message</h3>
        {!view.round.context.responses.length && <p>No earlier replies were included.</p>}
        {view.round.context.responses.map(reply => <details key={reply.attemptId}>
          <summary className="preserve-case">{reply.author.name} · {reply.author.position}</summary>
          <pre className="group-recovery-writing">{reply.text}</pre>
          <button disabled={busy || stack.length >= 256} onClick={() => open({ roundId: reply.roundId, attemptId: reply.attemptId,
            terminalSequence: reply.terminalSequence, terminalSha256: reply.terminalSha256 })}>Inspect Original Reply Context</button>
        </details>)}</section>}
    </>}
  </Dialog>;
}
