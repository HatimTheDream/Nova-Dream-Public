import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Content } from '../../../packages/domain/workspace-records';
import type { Entity } from '../../../packages/domain/contracts';
import { readRecordJournal } from './record-draft-recovery';
import { contentCopyText, type ContentRecoveryJournal } from './content-recovery';

export function contentRetentionLabel(state: { saving: boolean; pending?: unknown; conflict?: unknown; dirty: boolean; storageError: boolean; revision: number }) {
  return state.storageError ? 'Kept In This Window' : state.saving ? 'Saving' : state.pending ? 'Save Unconfirmed'
    : state.conflict ? 'Newer Or Conflicting Version' : state.dirty ? 'Changes Kept On This Device'
      : state.revision ? `Saved Version ${state.revision}` : 'New Content';
}
export function ContentCopy({ title, value }: { title: string; value: Content }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  return <section className="content-readable-copy"><h3>{title}</h3>
    <h4 className="preserve-case">{value.title || 'Untitled Draft'}</h4>
    <pre className="preserve-case">{value.body || 'No Writing In This Version'}</pre>
    {value.brief && <details><summary>Brief</summary><pre className="preserve-case">{value.brief}</pre></details>}
    <details><summary>Other Captured Fields</summary><dl>
      {Object.entries(value).filter(([key]) => !['title', 'body', 'brief'].includes(key)).map(([key, field]) =>
        <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b[a-z]/g, letter => letter.toUpperCase())}</dt><dd className="preserve-case">{typeof field === 'string' ? field : JSON.stringify(field)}</dd></div>)}
    </dl></details>
    <button onClick={() => void navigator.clipboard.writeText(contentCopyText(value)).then(() => { setCopied(true); setError(''); })
      .catch(() => setError('Copy is unavailable. Select the complete title and writing shown here.'))}>Copy Complete Writing</button>
    {copied && <span role="status">Writing Copied</span>}{error && <p role="alert">{error}</p>}
  </section>;
}

/** Docked sustained details; the same mounted editor remains behind the narrow workspace. */
export function ContentRecoveryPanel({ title, children, close, fallbackFocus, breakpoint=1000, backLabel='Back To Writing',tools=false }: {
  title: string; children: ReactNode; close(): void; fallbackFocus(): HTMLElement | null;breakpoint?:number;backLabel?:string;tools?:boolean;
}) {
  const panel = useRef<HTMLElement>(null), opener = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(() => matchMedia(`(max-width: ${breakpoint}px)`).matches);
  const fallback = useRef(fallbackFocus); fallback.current = fallbackFocus;
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = panel.current?.closest('.content-studio,.records-page-content')??panel.current?.parentElement;
    const resize = () => { if (container) setNarrow(container.getBoundingClientRect().width <= breakpoint); };
    resize(); const observer = new ResizeObserver(resize); if (container) observer.observe(container);
    panel.current?.querySelector<HTMLButtonElement>('.content-recovery-back')?.focus({ preventScroll: true });
    return () => { observer.disconnect(); const closing=panel.current;requestAnimationFrame(() => {
      const active=document.activeElement instanceof HTMLElement?document.activeElement.closest('.content-recovery-panel'):null;
      if(active&&active!==closing)return;
      const preferred = fallback.current();
      const usable=(node:HTMLElement|null)=>!!node?.isConnected&&!!node.getClientRects().length&&!node.closest('[inert],[hidden]')&&getComputedStyle(node).visibility!=='hidden';
      const target = usable(preferred) ? preferred : opener.current;
      if (usable(target)) target!.focus({ preventScroll: true });
    }); };
  }, [breakpoint]);
  useLayoutEffect(() => {
    if (!narrow || !panel.current) return;
    if (!panel.current.contains(document.activeElement)) panel.current.querySelector<HTMLButtonElement>('.content-recovery-back')?.focus({ preventScroll: true });
    const previous: [HTMLElement, boolean][] = [];
    for (let branch: HTMLElement | null = panel.current; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) if (sibling !== branch && sibling instanceof HTMLElement) {
        previous.push([sibling, sibling.inert]); sibling.inert = true;
      }
      if (branch.parentElement === document.body) break;
    }
    return () => { for (const [node, inert] of previous) node.inert = inert; };
  }, [narrow]);
  return <aside ref={panel} className={`content-recovery-panel${tools?' content-tools-panel':''}${narrow ? ' content-recovery-focused' : ''}`}
    role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label={title}
    onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab' || !narrow) return;
      const controls = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),summary,a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(node => {
        if (!node.getClientRects().length || node.closest('[inert]') || getComputedStyle(node).visibility !== 'visible') return false;
        for (let ancestor = node.parentElement; ancestor && ancestor !== panel.current; ancestor = ancestor.parentElement)
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(node)) return false;
        return true;
      });
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header><button className="content-recovery-back" onClick={close}>{narrow ? backLabel : 'Close Details'}</button><h2>{title}</h2></header>
    <div className="content-recovery-body">{children}</div>
  </aside>;
}

export function ContentRecoveryDetails({ editor, online, recovery, latest, prepare, check, retry, canPrepare }: {
  editor: { value: Content; revision: number; dirty: boolean; pending?: unknown; conflict?: { message: string }; saving: boolean; storageError: boolean; networkError: boolean };
  online: boolean; recovery: ContentRecoveryJournal; latest?: Entity<Content>; canPrepare: boolean;
  prepare(saved: boolean): void; check(): void; retry(): void;
}) {
  const [selected, setSelected] = useState<string>();
  const copy = recovery.value.copies.find(row => row.id === selected);
  const original = copy && readRecordJournal(copy.original, 'content', recovery.scope.id);
  return <>
    <p role="status">{contentRetentionLabel(editor)}{!online ? ' · Offline' : editor.networkError ? ' · Host Connection Unconfirmed' : ''}</p>
    {editor.revision > 0 && <p>Version {editor.revision} is the last acknowledged base. Newer edits remain separate until their own save is confirmed.</p>}
    {!online && <p>The locally available writing stays here. Reconnecting does not confirm an earlier save.</p>}
    {editor.storageError && <p role="alert">Browser storage did not keep the latest writing. Keep this window open and copy the complete title and writing before leaving.</p>}
    {editor.pending && <p>The exact original save and payload are kept. Checking that request cannot save newer text as its original payload.</p>}
    {editor.pending && <button disabled={editor.saving} onClick={check}>Check Original Save</button>}
    {(editor.storageError || recovery.error) && <button disabled={editor.saving} onClick={retry}>Retry Keeping Recovery</button>}
    {editor.conflict && <p role="alert">{editor.conflict.message}</p>}
    <ContentCopy title="Your Current Writing" value={editor.value}/>
    {editor.conflict && latest && <ContentCopy title={`Latest Saved Version ${latest.revision}`} value={latest.value}/>}
    {editor.conflict && <div className="button-row">
      <button disabled={!canPrepare} onClick={() => prepare(false)}>Prepare My Kept Writing</button>
      {latest && <button disabled={!canPrepare} onClick={() => prepare(true)}>Prepare The Saved Writing</button>}
      <p>Both original versions are kept before preparing a choice. Review or combine your writing in the editor, then choose Save Version.</p>
    </div>}
    <details><summary>Earlier Kept Comparisons · {recovery.value.copies.length}</summary>
      {recovery.value.copies.map(row => <button key={row.id} aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>
        Comparison From {new Date(row.at).toLocaleString()}</button>)}
      {copy && original && <><ContentCopy title="Original Local Writing" value={original.value}/>
        {copy.saved && <ContentCopy title={`Compared Saved Version ${copy.saved.revision}`} value={copy.saved.value}/>}</>}
    </details>
    {recovery.error && <p role="alert">{recovery.error}</p>}
  </>;
}
