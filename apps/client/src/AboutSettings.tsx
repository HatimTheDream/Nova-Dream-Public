import { useEffect, useRef, useState } from 'react';
import type { AgentServiceInfo } from '../../../packages/domain/agent-service';
import { request } from './api';
import { RefreshReader } from './refresh-reader';
import { pollReader } from './polling';
import { clientIdentity } from './client-identity';

export function AboutSettings({ identity, active, online }: { identity: string; active: boolean; online: boolean }) {
  const [open, setOpen] = useState(false);
  const [service, setService] = useState<AgentServiceInfo>();
  const [hostVersion, setHostVersion] = useState<string>();
  const [failed, setFailed] = useState(false);
  const context = useRef(identity); context.current = identity;
  const [reader] = useState(() => new RefreshReader({
    identity: () => context.current,
    read: async signal => {
      const [service, health] = await Promise.all([request<AgentServiceInfo>('assistant/service', undefined, signal), request<{ version?: string }>('health', undefined, signal)]);
      return { service, hostVersion: health.version };
    },
    accept: value => { setService(value.service); setHostVersion(value.hostVersion); setFailed(false); },
    fail: () => { setService(undefined); setHostVersion(undefined); setFailed(true); },
  }));
  useEffect(() => {
    setService(undefined); setHostVersion(undefined); setFailed(false);
    if (!open || !active || !online) return;
    const stop = pollReader(reader, () => 60000);
    return () => { stop(); reader.cancel(); };
  }, [identity, open, active, online, reader]);
  const version = !online ? 'Offline' : failed ? 'Unavailable' : !service ? 'Checking…'
    : service.state === 'ready' ? service.version ?? 'Version unavailable'
    : service.state === 'connecting' ? 'Connecting…'
    : service.state === 'unconfigured' || service.state === 'disconnected' ? 'Not connected' : 'Unavailable';
  return <details className="settings-about" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>About Nova Dream <span>{clientIdentity.version}</span></summary>
    <dl className="settings-versions">
      <div><dt>Nova Dream interface</dt><dd>{clientIdentity.version}</dd></div>
      {online && !failed && hostVersion && hostVersion !== clientIdentity.version && <div><dt>Nova Dream service</dt><dd>{hostVersion}</dd></div>}
      <div><dt>{service?.name ?? 'Agent service'}</dt><dd aria-live="polite">{version}</dd></div>
    </dl>
  </details>;
}
