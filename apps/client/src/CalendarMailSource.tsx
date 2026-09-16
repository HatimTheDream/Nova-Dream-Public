import { useEffect, useState } from 'react';
import type { LocalCalendarDetail } from '../../../packages/domain/calendar';
import { request } from './api';
import { Mail, ArrowRight } from './dreamclaw/components/icons';
export function CalendarMailSource({ eventId, epoch, navigate, close }: { eventId: string; epoch: string; navigate(route: string): void; close(): void }) {
  const [read, setRead] = useState<{ eventId: string; epoch: string; detail?: LocalCalendarDetail; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    void request<LocalCalendarDetail>(`calendar/local/${encodeURIComponent(eventId)}`, undefined, controller.signal).then(detail => {
      if (detail.epoch !== epoch || detail.event.id !== eventId) throw new Error('Review this Calendar event after reconnecting before opening its source.');
      if (active) setRead({ eventId, epoch, detail });
    }).catch(error => { if (active) setRead({ eventId, epoch, error: error instanceof Error ? error.message : 'The linked email could not be checked.' }); });
    return () => { active = false; controller.abort(); };
  }, [eventId, epoch, attempt]);
  const current = read?.eventId === eventId && read.epoch === epoch ? read : undefined, source = current?.detail?.mailSource;
  if (current?.error) return <div className="dc-calendar-mail-source" role="alert"><span>{current.error}</span><button type="button" onClick={() => setAttempt(value => value + 1)}>Check source again</button></div>;
  if (!source) return null;
  return <div className="dc-calendar-mail-source"><span><Mail size={16}/>Linked email · {source.provider === 'google' ? 'Gmail' : 'Outlook'}</span><button type="button" onClick={() => {
    try { navigate('/inbox?' + new URLSearchParams({ event: eventId, provider: source.provider, account: source.accountId, thread: source.threadId })); close(); }
    catch (error) { setRead({ eventId, epoch, error: error instanceof Error ? error.message : 'Your source email could not open.' }); }
  }}>Open original email <ArrowRight size={16}/></button></div>;
}
