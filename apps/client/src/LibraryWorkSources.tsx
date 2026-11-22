import { useEffect, useRef, useState } from 'react';
import type { HomeLibraryState, HomeReference } from '../../../packages/domain/home-library';
import { exactHomeReference, homeReferenceKey, readHomeLibraryState } from '../../../packages/domain/home-library-view';
import type { WorkSourceCheck, WorkSourceMaterial, WorkSourceSelection } from '../../../packages/domain/work-sources';
import { MAX_WORK_SOURCES } from '../../../packages/domain/work-source-limits';
import { request } from './api';
import { HomeSourcePicker } from './HomeSourcePicker';

const names: Record<HomeReference['kind'], string> = {note: 'Library Note', link: 'Library Link', content: 'Content',
  assignment: 'Agent Result', output: 'Assistant Output', widget: 'Home Writing', project: 'Project', task: 'Task'};

export function useWorkSourceChecks(epoch: string, cursor: number, agentId: string | null, agentRevision: number | undefined, sources: WorkSourceSelection[]) {
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([epoch, cursor, agentId, agentRevision, sources, refresh]);
  const [result, setResult] = useState<{key: string; rows?: WorkSourceCheck[]; error?: string}>();
  useEffect(() => {
    const controller = new AbortController();
    if (sources.length && sources.length <= MAX_WORK_SOURCES) {
      void request<{sources: WorkSourceCheck[]}>('assignments/source-checks', {epoch, agentId, sources}, controller.signal)
        .then(value => {
          if (!Array.isArray(value.sources) || value.sources.length !== sources.length || !value.sources.every((row,i) => row && exactHomeReference(row.reference, sources[i].reference)))
            throw Error('The source check did not match the selected versions.');
          if (!controller.signal.aborted) setResult({key, rows: value.sources});
        }).catch(reason => {
          if (!controller.signal.aborted) setResult({key, error: reason instanceof Error ? reason.message : 'The sources could not be checked.'});
        });
    }
    return () => controller.abort();
  }, [key]);
  useEffect(() => {
    const foreground = () => setRefresh(n => n + 1);
    window.addEventListener('focus', foreground);
    return () => window.removeEventListener('focus', foreground);
  }, []);
  return {...(result?.key === key ? result : {}), refresh: () => setRefresh(n => n + 1)};
}

export function WorkSourceList({sources, checks, locked, inspect, remove, choose}: {
  sources: WorkSourceSelection[]; checks?: WorkSourceCheck[]; locked: boolean;
  inspect: (key: string, button: HTMLButtonElement) => void; remove: (key: string) => void; choose: (button: HTMLButtonElement) => void;
}) {
  return <section className="work-source-list" aria-label="Selected Sources">
    <div className="work-section-heading"><h3>Selected Sources <span>{sources.length}</span></h3>
      <button className="compact-action" disabled={locked} onClick={e => choose(e.currentTarget)}>Choose Sources</button></div>
    {!sources.length && <p className="metadata">Choose a saved source from the Library.</p>}
    {sources.map(({reference}, i) => {
      const check = checks?.[i], key = homeReferenceKey(reference);
      const title = check?.selected?.title ?? check?.latest?.title ?? names[reference.kind];
      return <div className="work-source-row" key={key}><div><strong>{title}</strong>
        <small>{names[reference.kind]} · Version {reference.revision}</small>
        {check && <span className={check.ready ? 'work-ready' : 'work-attention'}>{check.ready ? 'Ready' : check.message}</span>}</div>
        <div className="work-row-actions"><button className="compact-action" aria-label={'Inspect ' + title} disabled={!check}
          onClick={e => inspect(key, e.currentTarget)}>{check?.status === 'changed' && !check.ready ? 'Resolve' : 'Inspect'}</button>
          <button className="compact-action" aria-label={'Remove ' + title} disabled={locked} onClick={() => remove(key)}>Remove</button></div>
      </div>;
    })}
  </section>;
}

function Material({value, label, reference}: {value: WorkSourceMaterial; label: string; reference: HomeReference}) {
  return <section className="work-source-material"><h3>{label}</h3><strong>{value.title}</strong>
    <small>{value.representation === 'reference-only' ? 'Reference Only' : value.representation === 'result-text' ? 'Saved Result Text' : 'Saved Text'}</small>
    {value.url && <p className="work-text">{value.url}</p>}
    {value.text !== undefined && <pre className="work-text">{value.text || 'The saved text is empty.'}</pre>}
    {!!value.omissions.length && <ul>{value.omissions.map((item,i) => <li key={i}>{item}</li>)}</ul>}
    <details><summary>Version Details</summary><p className="metadata">Version {reference.revision} · {reference.id}</p>
      {reference.sha256 && <p className="metadata">Source SHA-256 · {reference.sha256}</p>}
      <p className="metadata">Supplied Material SHA-256 · {value.sha256}</p></details>
  </section>;
}

export function WorkSourceInspection({selection, check, locked, change, remove, replace}: {
  selection: WorkSourceSelection; check?: WorkSourceCheck; locked: boolean;
  change: (next: WorkSourceSelection) => void; remove: () => void; replace: () => void;
}) {
  const {reference} = selection;
  return <><h2>Source Check</h2><p className="metadata">{names[reference.kind]} · Selected Version {reference.revision}
    {check?.current && ' · Latest Version ' + check.current.revision}</p>
    <p role="status">{check?.message ?? 'Checking the current source and access…'}</p>
    {check?.selected && <Material label="Selected Version" value={check.selected} reference={reference}/>}
    {check?.latest && check.current && !exactHomeReference(reference, check.current) && <Material label="Latest Version" value={check.latest} reference={check.current}/>}
    <div className="button-row">
      {check?.current && !exactHomeReference(check.current, reference) && <>
        {check.canUseSelected && <button disabled={locked} onClick={() => change({...selection, confirmedAgainst: check.current!})}>Use Selected Version</button>}
        {check.latest && <button disabled={locked} onClick={() => change({reference: check.current!})}>Use Latest Version</button>}
      </>}
      {check?.selected?.representation === 'reference-only' && <label className="check-label"><input type="checkbox"
        checked={selection.allowReferenceOnly === true} disabled={locked} onChange={e => change({...selection, allowReferenceOnly: e.target.checked})}/>Use The Saved Reference Only</label>}
      <button disabled={locked} onClick={replace}>Replace Source</button><button disabled={locked} onClick={remove}>Remove Source</button>
    </div></>;
}

export function WorkSourceChooser({epoch, selections, replaceKey, change, done}: {
  epoch: string; selections: WorkSourceSelection[]; replaceKey?: string; change: (next: WorkSourceSelection[]) => void; done: () => void;
}) {
  const [library, setLibrary] = useState<HomeLibraryState>(), [error, setError] = useState(''), [tryRead, setTryRead] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request<unknown>('home/library', undefined, controller.signal).then(raw => {
      if (controller.signal.aborted) return;
      const value = readHomeLibraryState(raw);
      if (!value || value.epoch !== epoch) throw Error('The Library belongs to a different workspace.');
      setLibrary(value); setError('');
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The Library could not be loaded.'); });
    return () => controller.abort();
  }, [epoch, tryRead]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const refs = selections.map(s => s.reference);
  const pick = (next: HomeReference[]) => {
    if (replaceKey) {
      if (next.length !== 1) return;
      change(selections.map(s => homeReferenceKey(s.reference) === replaceKey ? {reference: next[0]} : s));
      done();
    } else change(next.map(reference => selections.find(s => exactHomeReference(s.reference, reference)) ?? {reference}));
  };
  return <><h2 ref={heading} tabIndex={-1}>{replaceKey ? 'Replace Source' : 'Choose Sources'}</h2>
    {error ? <p role="alert">{error} <button onClick={() => setTryRead(i => i + 1)}>Retry Library</button></p> : !library && <p role="status">Opening Library…</p>}
    {library && <HomeSourcePicker compact resources={library.resources} collections={library.collections}
      selected={replaceKey ? [] : refs} select={pick} disabled={ref => replaceKey ? selections.some(s => homeReferenceKey(s.reference) === homeReferenceKey(ref) && homeReferenceKey(ref) !== replaceKey) :
        selections.length >= MAX_WORK_SOURCES && !selections.some(s => homeReferenceKey(s.reference) === homeReferenceKey(ref))}/>}
    {!replaceKey && <button className="primary" onClick={done}>Done</button>}</>;
}
