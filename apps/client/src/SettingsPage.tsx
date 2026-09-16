import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { AccessContext } from '../../../packages/domain/phone';
import { Connections } from './Connections';
import { ProviderAccounts } from './ProviderAccounts';
import { ArrowLeft } from './icons';
import './settings.css';

const PhoneSettings = lazy(() => import('./Phone').then(module => ({ default: module.PhoneSettings })));
const StorageSettings = lazy(() => import('./StorageSettings').then(module => ({ default: module.StorageSettings })));
const categories = [
  { id: 'general', label: 'General', description: 'Appearance, Home preferences and app information.' },
  { id: 'accounts', label: 'Accounts', description: 'Google and Microsoft connections for mail, calendars and contacts.' },
  { id: 'assistant', label: 'Assistant & voice', description: 'ChatGPT sign-in, voice readiness and your Assistant connection.' },
  { id: 'phone', label: 'Phone & devices', description: 'Private access to this workspace from your other devices.' },
  { id: 'data', label: 'Data & recovery', description: 'Workspace protection, imports, backups and recovery.' },
] as const;
export type SettingsTab = typeof categories[number]['id'];

// Keep visited forms mounted while switching tabs. Secrets stay in component
// memory, and in-progress sign-in, pairing and recovery keep their own journals.
function SettingsPanel({ id, active, children }: { id: SettingsTab; active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  return <section id={`settings-panel-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} tabIndex={0} hidden={!active} className="settings-panel">
    {(active || visited) && <Suspense fallback={<p role="status">Opening settings…</p>}>{children}</Suspense>}
  </section>;
}

export function SettingsPage({ selected, select, snapshot, online, access, general, openAssistant, returnTo }: {
  selected: SettingsTab; select: (tab: SettingsTab) => void; snapshot: Snapshot; online: boolean;
  access?: AccessContext; general: ReactNode; openAssistant: () => void;
  returnTo?: { label: string; open: () => void };
}) {
  const phone = access?.surface === 'phone';
  const tabs = categories.filter(tab => !phone || tab.id === 'general' || tab.id === 'phone');
  const current = tabs.find(tab => tab.id === selected) ?? tabs.find(tab => tab.id === 'phone')!;
  const buttons = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const recoveryPaused = !!(access?.recovery || access?.recoveryLocal);
  useEffect(() => {
    const button = buttons.current.get(current.id);
    if (!button?.parentElement) return;
    const reveal = () => button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const resize = new ResizeObserver(reveal);
    resize.observe(button.parentElement); reveal();
    return () => resize.disconnect();
  }, [current.id]);
  return <main className="page-scroll settings-page">
    {returnTo && <div className="settings-return"><button onClick={returnTo.open}><ArrowLeft size={16}/>Back to {returnTo.label}</button></div>}
    <div className="page-intro"><div><h1>Settings</h1><p>Make this workspace work for you.</p></div></div>
    <div className="settings-navigation">
      <div className="settings-tabs" role="tablist" aria-label="Settings categories">
        {tabs.map((tab, index) => <button key={tab.id} id={`settings-tab-${tab.id}`} role="tab" aria-selected={current.id === tab.id} aria-controls={`settings-panel-${tab.id}`} tabIndex={current.id === tab.id ? 0 : -1} ref={node => { if (node) buttons.current.set(tab.id, node); else buttons.current.delete(tab.id); }} onClick={() => select(tab.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault(); select(tabs[next].id); buttons.current.get(tabs[next].id)?.focus();
        }}>{tab.label}</button>)}
      </div>
    </div>
    <p className="settings-description">{phone && current.id === 'phone' ? 'Your phone shares the workspace saved on your host.' : current.description}</p>
    <SettingsPanel id="general" active={current.id === 'general'}>{general}</SettingsPanel>
    {!phone && <SettingsPanel id="accounts" active={current.id === 'accounts'}><section className="card settings-card settings-accounts">
      <h2>Connected accounts</h2>
      {recoveryPaused && <p className="notice">Connections are paused in this copy. Open Data & recovery to review connections after recovery.</p>}
      <ProviderAccounts snapshot={snapshot} online={online && !recoveryPaused} recoveryPaused={recoveryPaused}/>
    </section></SettingsPanel>}
    {!phone && <SettingsPanel id="assistant" active={current.id === 'assistant'}><Connections recoveryPaused={recoveryPaused} remoteHost={access?.surface === 'web'} snapshot={snapshot} online={online} openAssistant={openAssistant}/></SettingsPanel>}
    <SettingsPanel id="phone" active={current.id === 'phone'}><PhoneSettings epoch={snapshot.epoch} deviceId={snapshot.deviceId} access={access}/></SettingsPanel>
    {!phone && <SettingsPanel id="data" active={current.id === 'data'}><StorageSettings remoteHost={access?.surface === 'web'} epoch={snapshot.epoch} deviceId={snapshot.deviceId}/></SettingsPanel>}
  </main>;
}
