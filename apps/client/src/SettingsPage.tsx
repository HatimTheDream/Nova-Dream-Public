import { LoadingRing } from './ModuleLoading';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { lazy } from './preload-lazy';
import type { AppIconChoice, Snapshot } from '../../../packages/domain/contracts';
import type { AccessContext } from '../../../packages/domain/phone';
import { Connections } from './Connections';
import { ProviderAccounts } from './ProviderAccounts';
import { ArrowLeft } from './icons';
import './settings.css';

const GitHubConnection = lazy(() => import('./GitHubConnection').then(module => ({ default: module.GitHubConnection })));
const PhoneSettings = lazy(() => import('./Phone').then(module => ({ default: module.PhoneSettings })));
const StorageSettings = lazy(() => import('./StorageSettings').then(module => ({ default: module.StorageSettings })));
const InstallSettings = lazy(() => import('./InstallSettings').then(module => ({ default: module.InstallSettings })));
const UsageSettings = lazy(() => import('./UsageSettings').then(module => ({ default: module.UsageSettings })));
const categories = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'usage', label: 'Usage' },
  { id: 'phone', label: 'Devices' },
  { id: 'data', label: 'Data' },
] as const;
export type SettingsTab = typeof categories[number]['id'];

// Keep visited forms mounted while switching tabs. Secrets stay in component
// memory, and in-progress sign-in, pairing and recovery keep their own journals.
function SettingsPanel({ id, active, children }: { id: SettingsTab; active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  return <section id={`settings-panel-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} tabIndex={0} hidden={!active} className="settings-panel">
    {(active || visited) && <Suspense fallback={<LoadingRing label="Opening settings…"/>}>{children}</Suspense>}
  </section>;
}

export function SettingsPage({ appIcon, selected, select, snapshot, online, access, general, openAssistant, returnTo }: {
  appIcon: AppIconChoice; selected: SettingsTab; select: (tab: SettingsTab) => void; snapshot: Snapshot; online: boolean;
  access?: AccessContext; general: ReactNode; openAssistant: () => void;
  returnTo?: { label: string; open: () => void };
}) {
  const phone = access?.surface === 'phone';
  const tabs = categories.filter(tab => !phone || tab.id === 'general' || tab.id === 'phone');
  const current = tabs.find(tab => tab.id === selected) ?? tabs.find(tab => tab.id === 'phone')!;
  const buttons = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const tablist = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  const recoveryPaused = !!(access?.recovery || access?.recoveryLocal);
  useEffect(() => {
    const list = tablist.current;
    const button = buttons.current.get(current.id);
    if (!list || !button) return;
    const update = () => {
      setOrientation(getComputedStyle(list).flexDirection === 'column' ? 'vertical' : 'horizontal');
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    const resize = new ResizeObserver(update);
    resize.observe(list); update();
    return () => resize.disconnect();
  }, [current.id]);
  return <main className="page-scroll settings-page">
    {returnTo && <div className="settings-return"><button onClick={returnTo.open}><ArrowLeft size={16}/>Back to {returnTo.label}</button></div>}
    <div className="page-intro"><h1>Settings</h1></div>
    <div className="settings-layout">
    <div className="settings-navigation">
      <div ref={tablist} className="settings-tabs" role="tablist" aria-label="Settings categories" aria-orientation={orientation}>
        {tabs.map((tab, index) => <button type="button" key={tab.id} id={`settings-tab-${tab.id}`} role="tab" aria-selected={current.id === tab.id} aria-controls={`settings-panel-${tab.id}`} tabIndex={current.id === tab.id ? 0 : -1} ref={node => { if (node) buttons.current.set(tab.id, node); else buttons.current.delete(tab.id); }} onClick={() => select(tab.id)} onKeyDown={event => {
          const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
          const backward = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
          const next = event.key === forward ? (index + 1) % tabs.length : event.key === backward ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault(); select(tabs[next].id); buttons.current.get(tabs[next].id)?.focus();
        }}><span>{tab.label}</span></button>)}
      </div>
    </div>
    <div className="settings-content">
    <SettingsPanel id="general" active={current.id === 'general'}>{general}</SettingsPanel>
    {!phone && <SettingsPanel id="accounts" active={current.id === 'accounts'}><section className="card settings-card settings-accounts">
      <h2>Connected accounts</h2>
      {recoveryPaused && <p className="notice">Connections are paused in this copy. Open Data to review recovery.</p>}
      <ProviderAccounts snapshot={snapshot} online={online && !recoveryPaused} recoveryPaused={recoveryPaused}/>{!recoveryPaused && <GitHubConnection epoch={snapshot.epoch}/>}
    </section></SettingsPanel>}
    {!phone && <SettingsPanel id="assistant" active={current.id === 'assistant'}><Connections recoveryPaused={recoveryPaused} remoteHost={access?.surface === 'web'} snapshot={snapshot} online={online} openAssistant={openAssistant}/></SettingsPanel>}
    {!phone && <SettingsPanel id="usage" active={current.id === 'usage'}><UsageSettings identity={`${snapshot.epoch}:${snapshot.deviceId}`} active={current.id === 'usage'} online={online && !recoveryPaused}/></SettingsPanel>}
    <SettingsPanel id="phone" active={current.id === 'phone'}><InstallSettings appIcon={appIcon} epoch={snapshot.epoch} access={access}/>{access?.surface === 'web' ? <details className="settings-disclosure"><summary>Optional Tailscale device pairing</summary><div className="settings-disclosure-body"><PhoneSettings epoch={snapshot.epoch} deviceId={snapshot.deviceId} access={access}/></div></details> : <PhoneSettings epoch={snapshot.epoch} deviceId={snapshot.deviceId} access={access}/>}</SettingsPanel>
    {!phone && <SettingsPanel id="data" active={current.id === 'data'}><StorageSettings remoteHost={access?.surface === 'web'} epoch={snapshot.epoch} deviceId={snapshot.deviceId}/></SettingsPanel>}
    </div></div>
  </main>;
}
