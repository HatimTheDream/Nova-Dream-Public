import { LoadingRing } from './ModuleLoading';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { lazy } from './preload-lazy';
import type { AppIconChoice, Snapshot } from '../../../packages/domain/contracts';
import type { AccessContext } from '../../../packages/domain/phone';
import { Connections } from './Connections';
import { ProviderAccounts } from './ProviderAccounts';
import { AboutSettings } from './AboutSettings';
import { ComposerMenu } from './ComposerMenu';
import { Archive, ArrowLeft, ArrowRight, ChevronDown, Device, Download, Link2, MessageSquare, Settings2, Zap } from './icons';
import './settings.css';

const GitHubConnection = lazy(() => import('./GitHubConnection').then(module => ({ default: module.GitHubConnection })));
const PhoneSettings = lazy(() => import('./Phone').then(module => ({ default: module.PhoneSettings })));
const StorageSettings = lazy(() => import('./StorageSettings').then(module => ({ default: module.StorageSettings })));
const InstallSettings = lazy(() => import('./InstallSettings').then(module => ({ default: module.InstallSettings })));
const UsageSettings = lazy(() => import('./UsageSettings').then(module => ({ default: module.UsageSettings })));
const SoftwareUpdateSettings = lazy(() => import('./SoftwareUpdateSettings').then(module => ({ default: module.SoftwareUpdateSettings })));
const categories = [
  { id: 'general', label: 'Appearance', icon: Settings2, description: 'Theme, text, app icon and home timezone.', scope: 'Shared appearance · Text on this device' },
  { id: 'accounts', label: 'Accounts', icon: Link2, description: 'Provider connections and ChatGPT identities.', scope: 'Connections on this host' },
  { id: 'assistant', label: 'Assistant Setup', icon: MessageSquare, description: 'Host connection, model access and voice readiness.', scope: 'Assistant on this host' },
  { id: 'usage', label: 'Usage', icon: Zap, description: 'Reported allowance and workspace activity.', scope: 'Reported readings · Availability varies' },
  { id: 'phone', label: 'Devices', icon: Device, description: 'Installation, computer access and optional pairing.', scope: 'This device and linked devices' },
  { id: 'data', label: 'Backups & Recovery', icon: Archive, description: 'Storage, encrypted backups and separate recovery copies.', scope: 'Workspace and browser storage' },
  { id: 'updates', label: 'Updates', icon: Download, description: 'Available changes, update progress and version details.', scope: 'Host software · Interface on this device' },
] as const;
export type SettingsSection = typeof categories[number]['id'];
// Existing app actions retain their original six section IDs. Index/Updates are local views.
export type SettingsTab = SettingsSection | 'index';
export type SettingsDraftSummary = { scope: string; changes: number; saving: boolean; retentionFailed: boolean };

// Keep visited forms mounted: secrets and original operations stay with their owner.
export function SettingsPanel({ id, active, eager = false, children }: { id: SettingsSection; active: boolean; eager?: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active || eager);
  useEffect(() => { if (active || eager) setVisited(true); }, [active, eager]);
  return <section id={`settings-panel-${id}`} aria-label={categories.find(item => item.id === id)!.label} hidden={!active} inert={!active} className="settings-panel">
    {(active || visited || eager) && <Suspense fallback={<LoadingRing label="Opening settings…"/>}>{children}</Suspense>}
  </section>;
}

function RetainedConnections(props: Parameters<typeof Connections>[0]) {
  const [visited, setVisited] = useState(props.section !== null);
  useEffect(() => { if (props.section !== null) setVisited(true); }, [props.section]);
  return visited || props.section !== null ? <Connections {...props}/> : null;
}

export function SettingsPage({ appIcon, selected, select, snapshot, online, access, general, openAssistant, returnTo, draft }: {
  appIcon: AppIconChoice; selected: SettingsTab; select: (tab: SettingsTab) => void; snapshot: Snapshot; online: boolean;
  access?: AccessContext; general: ReactNode; openAssistant: () => void; draft?: SettingsDraftSummary;
  returnTo?: { label: string; open: () => void };
}) {
  const phone = access?.surface === 'phone';
  const sections = categories.filter(section => !phone || section.id === 'general' || section.id === 'phone');
  const current = selected === 'index' ? undefined : sections.find(section => section.id === selected) ?? sections.find(section => section.id === 'phone');
  const currentId = current?.id ?? 'index';
  const identity = `${snapshot.epoch}:${snapshot.deviceId}`;
  const recoveryPaused = !!(access?.recovery || access?.recoveryLocal);
  const keptDraft = draft?.scope === identity ? draft : undefined;
  const hasChanges = !!keptDraft && (keptDraft.changes > 0 || keptDraft.saving);
  const heading = useRef<HTMLHeadingElement>(null), page = useRef<HTMLElement>(null);
  const previous = useRef<SettingsTab | undefined>(undefined), positions = useRef(new Map<SettingsTab, number>());
  const indexButtons = useRef(new Map<SettingsSection, HTMLButtonElement>());
  useEffect(() => {
    const prior = previous.current;
    if (prior === currentId) return;
    previous.current = currentId;
    // Internal moves retain each section's scroll position and return to its index card.
    if (page.current) page.current.scrollTop = positions.current.get(currentId) ?? 0;
    if (currentId === 'index' && prior !== undefined && prior !== 'index') indexButtons.current.get(prior)?.focus({ preventScroll: true });
    else if (!document.querySelector('dialog[open]')) heading.current?.focus({ preventScroll: true });
  }, [currentId]);
  const choose = (next: SettingsTab) => select(next);
  return <main ref={page} onScroll={event => positions.current.set(currentId, event.currentTarget.scrollTop)} className="page-scroll settings-page" aria-label="Settings">
    {returnTo && <div className="settings-return"><button className="compact-action compact-utility" onClick={returnTo.open}><ArrowLeft size={16}/>Back To {returnTo.label}</button></div>}
    <header className="settings-titlebar">
      {current && <nav className="settings-section-navigation" aria-label="Settings sections"><button className="compact-action compact-utility" onClick={() => choose('index')}><ArrowLeft size={15}/>All Settings</button><ComposerMenu label="Change Settings Section" text="Change Section" icon={<ChevronDown size={15}/>} placement="below" align="right" kind="menu" className="settings-section-menu">{close => <div className="compact-choice-menu">{sections.map(section => <button className="compact-action" role="menuitemradio" aria-checked={currentId === section.id} key={section.id} onClick={() => { close(); choose(section.id); }}>{section.label}</button>)}</div>}</ComposerMenu></nav>}
      <h1 ref={heading} tabIndex={-1} className="settings-heading">{current?.label ?? 'Settings'}</h1>
      <p className="settings-scope">{current?.scope ?? (phone ? 'Appearance and access for this paired phone.' : 'Shared workspace choices, host connections and preferences for this device.')}</p>
    </header>
    {hasChanges && currentId !== 'general' && <div className="settings-draft-summary" role="status"><span>{keptDraft.saving ? 'Saving appearance changes…' : `${keptDraft.changes} unsaved appearance ${keptDraft.changes === 1 ? 'change' : 'changes'}`}{keptDraft.retentionFailed ? ' · Kept only in this window' : ''}</span><button className="compact-action compact-utility" onClick={() => choose('general')}>Review Changes</button></div>}
    <div className="settings-layout">
      <section className="settings-index" aria-label="All Settings" hidden={!!current} inert={!!current}>
        {sections.map(section => <button type="button" className="settings-destination" key={section.id} ref={node => { if (node) indexButtons.current.set(section.id, node); else indexButtons.current.delete(section.id); }} onClick={() => choose(section.id)}><section.icon size={22} decorative/><span><strong>{section.label}</strong><span>{section.description}</span>{section.id === 'general' && hasChanges && <small>Unsaved changes</small>}{section.id === 'updates' && snapshot.softwareUpdate && <small>Update available</small>}</span><ArrowRight size={16} decorative/></button>)}
      </section>
      <div className="settings-content">
        <SettingsPanel id="general" active={currentId === 'general'} eager>{general}</SettingsPanel>
        {!phone && <SettingsPanel id="accounts" active={currentId === 'accounts'}><section className="card settings-card settings-accounts"><h2>Connected providers</h2>{recoveryPaused && <p className="notice">Connections are paused in this copy. Open Backups & Recovery to review recovery.</p>}<ProviderAccounts snapshot={snapshot} online={online && !recoveryPaused} recoveryPaused={recoveryPaused} active={currentId === 'accounts'}/>{!recoveryPaused && <GitHubConnection epoch={snapshot.epoch}/>}</section></SettingsPanel>}
        {!phone && <RetainedConnections key={identity} section={currentId === 'accounts' || currentId === 'assistant' ? currentId : null} openAccounts={() => choose('accounts')} openSetup={() => choose('assistant')} recoveryPaused={recoveryPaused} remoteHost={access?.surface === 'web'} snapshot={snapshot} online={online} openAssistant={openAssistant}/>}
        {!phone && <SettingsPanel id="usage" active={currentId === 'usage'}><UsageSettings identity={identity} active={currentId === 'usage'} online={online && !recoveryPaused}/></SettingsPanel>}
        <SettingsPanel id="phone" active={currentId === 'phone'}><InstallSettings appIcon={appIcon} epoch={snapshot.epoch} access={access} active={currentId === 'phone'}/>{access?.surface === 'web' ? <details className="settings-disclosure"><summary>Optional Tailscale device pairing</summary><div className="settings-disclosure-body"><PhoneSettings epoch={snapshot.epoch} deviceId={snapshot.deviceId} access={access}/></div></details> : <PhoneSettings epoch={snapshot.epoch} deviceId={snapshot.deviceId} access={access}/>} {phone && <AboutSettings identity={identity} active={currentId === 'phone'} online={online}/>}</SettingsPanel>
        {!phone && <SettingsPanel id="data" active={currentId === 'data'}><StorageSettings remoteHost={access?.surface === 'web'} epoch={snapshot.epoch} deviceId={snapshot.deviceId}/></SettingsPanel>}
        {!phone && <SettingsPanel id="updates" active={currentId === 'updates'}><SoftwareUpdateSettings identity={identity} epoch={snapshot.epoch} active={currentId === 'updates'} online={online} restricted={recoveryPaused ? 'Updates are paused while this copy is in recovery.' : undefined}/><AboutSettings identity={identity} active={currentId === 'updates'} online={online}/></SettingsPanel>}
      </div>
    </div>
  </main>;
}
