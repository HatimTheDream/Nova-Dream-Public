import { LoadingRing } from './ModuleLoading';
import { useEffect, useRef, useState } from 'react';
import type { AssistantModel, Conversation, PermissionMode } from '../../../packages/domain/assistant';
import { request } from './api';
import { Check, ChevronDown, Reset, Shield, Zap } from './icons';
import { ArrowLeft } from './icons';

export type ResponsePreferences = { model: string | null; thinking: string | null; fastMode: boolean | 'auto' | null };
export const effortLabel = (value: string | null | undefined) => value ? ({ xhigh: 'Extra high' }[value] ?? value[0].toUpperCase() + value.slice(1)) : 'Default';
export const accessLabels: Record<PermissionMode, string> = { 'read-only': 'Read only', guarded: 'Ask first', workspace: 'Workspace access', full: 'Full access' };
export function responseModel(models: AssistantModel[], id: string | null) {
  if (id) return models.find(model => model.id === id);
  const defaults = models.filter(model => model.isDefault);
  return defaults.length === 1 ? defaults[0] : undefined;
}
export function ResponseControls({ value, models, modelStatus, retryModels, blocked, save }: { value: ResponsePreferences; models: AssistantModel[]; modelStatus: 'loading' | 'ready' | 'error' | 'offline'; retryModels: () => Promise<void>; blocked: boolean; save: (value: ResponsePreferences) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [selectingModel, setSelectingModel] = useState(false);
  const model = responseModel(models, value.model), levels = [null, ...(model?.reasoning ?? [])];
  const key = JSON.stringify([value.model, model?.id, value.thinking, model?.reasoning]);
  const [preview, setPreview] = useState<{ key: string; index: number }>();
  const proposed = preview?.key === key ? preview : undefined, level = proposed?.index ?? Math.max(0, levels.indexOf(value.thinking));
  const shown = proposed ? levels[level] : value.thinking, applying = useRef(false);
  const unavailable = blocked || busy || modelStatus !== 'ready';
  const change = async (patch: Partial<ResponsePreferences>) => {
    if (unavailable || applying.current) return;
    applying.current = true; setBusy(true); setError('');
    try { await save({ ...value, ...patch }); } catch (e) { setError(e instanceof Error ? e.message : 'The setting was not confirmed.'); } finally { applying.current = false; setBusy(false); setPreview(undefined); }
  };
  const applyEffort = () => { if (proposed && levels[level] !== undefined && levels[level] !== value.thinking) void change({ thinking: levels[level] }); };
  return <div className="response-picker">
    {selectingModel ? <><button className="text-button" onClick={() => setSelectingModel(false)}><ArrowLeft size={17}/>Response</button><span className="menu-heading">Select model</span><div className="response-model-list" role="group" aria-label="Select model">
      <button disabled={unavailable} aria-pressed={!value.model} onClick={() => { void change({ model: null, thinking: null }); setSelectingModel(false); }}><span>Default<small>{responseModel(models, null)?.name ?? 'Configured model'}</small></span>{!value.model && <Check size={17}/>}</button>
      {models.map(m => <button key={m.id} disabled={unavailable || !m.available} aria-pressed={m.id === value.model} onClick={() => { void change({ model: m.id, thinking: null }); setSelectingModel(false); }}><span>{m.name}{!m.available && <small>Unavailable</small>}</span>{m.id === value.model && <Check size={17}/>}</button>)}
    </div>{modelStatus === 'ready' && !models.some(m => m.available) && <p className="metadata">No models are available for this connection yet.</p>}</> : <>
      <div className="effort-heading"><button className={`response-speed ${value.fastMode === true ? 'enabled' : ''}`} aria-label={`Speed: ${value.fastMode === true ? 'Fast' : value.fastMode === false ? 'Standard' : value.fastMode === 'auto' ? 'Automatic' : 'Default'}`} aria-pressed={value.fastMode === true} title={value.fastMode === true ? 'Use standard speed' : 'Use fast speed'} disabled={unavailable} onClick={() => void change({ fastMode: value.fastMode === true ? false : true })}><Zap size={18}/></button><strong>{effortLabel(shown)}</strong><button aria-label="Reset response settings" title="Reset effort and speed" disabled={unavailable} onClick={() => void change({ thinking: null, fastMode: null })}><Reset size={18}/></button></div>
      <button className="response-model-choice" onClick={() => setSelectingModel(true)}><span>{model?.name ?? value.model ?? 'Default model'}</span><ChevronDown size={16}/></button>
      <input className="effort-slider" type="range" aria-label="Response effort" aria-valuetext={effortLabel(shown)} min={0} max={Math.max(1, levels.length - 1)} step={1} value={level} disabled={unavailable || !model?.available || levels.length < 2} onChange={e => setPreview({ key, index: Number(e.target.value) })} onPointerUp={applyEffort} onKeyUp={applyEffort} onBlur={applyEffort}/>
      {modelStatus === 'ready' && levels.length < 2 && <p className="metadata effort-unavailable">{model ? 'This model does not expose effort settings.' : 'Choose a model to set effort.'}</p>}<div className="effort-scale"><span>{levels.length > 1 ? 'Default' : ''}</span><span>{levels.length > 1 ? effortLabel(levels.at(-1)) : ''}</span></div>
    </>}
    {modelStatus !== 'ready' && <p className="metadata" role="status">{modelStatus === 'loading' ? <LoadingRing label="Loading models"/> : modelStatus === 'offline' ? 'Connect the Assistant to change models.' : <>Models could not load. <button type="button" onClick={() => void retryModels()}>Retry models</button></>}</p>}
    {busy && <p className="metadata" role="status">Applying…</p>}{error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}

export function AccessDetails({ conversation, preference, blocked, save }: { conversation?: Conversation; preference: PermissionMode; blocked: boolean; save: (mode: PermissionMode) => Promise<unknown> }) {
  const [state, setState] = useState<{ mode: PermissionMode; pending: boolean }>(), [error, setError] = useState(''), [retry, setRetry] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true; setState(undefined); setError('');
    if (conversation?.nativeId) void request<{ conversationId: string; nativeId: string; mode: PermissionMode; pending: boolean }>(`assistant/access/${conversation.id}`).then(result => { if (alive && result.conversationId === conversation.id && result.nativeId === conversation.nativeId) setState(result); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Access could not be checked.'); });
    return () => { alive = false; };
  }, [conversation?.id, conversation?.nativeId, conversation?.revision, retry]);
  const current = conversation ? state?.mode : preference;
  const descriptions: Record<PermissionMode, string> = { 'read-only': 'Inspect without changing files.', guarded: 'Ask before running commands.', workspace: 'Work within the app workspace.', full: 'Allow tools beyond the workspace.' };
  const change = async (mode: PermissionMode) => { setBusy(true); setError(''); try { await save(mode); setRetry(n => n + 1); } catch (e) { setError(e instanceof Error ? e.message : 'Access change was not confirmed.'); } finally { setBusy(false); } };
  return <div className="access-picker"><span className="menu-heading">Tool access</span>{(Object.keys(accessLabels) as PermissionMode[]).map(mode => <button key={mode} aria-pressed={current === mode} disabled={blocked || busy || !!conversation && (!state || state.pending)} onClick={() => void change(mode)}><Shield size={18}/><span>{accessLabels[mode]}<small>{descriptions[mode]}</small></span>{current === mode && <Check size={17}/>}</button>)}
    {conversation && !state && !error && <p role="status" className="metadata">Checking access…</p>}{(busy || state?.pending) && <p role="status" className="metadata">Confirming access…</p>}{error && <><p className="field-error" role="alert">{error}</p><button onClick={() => setRetry(n => n + 1)}>Retry</button></>}
  </div>;
}
