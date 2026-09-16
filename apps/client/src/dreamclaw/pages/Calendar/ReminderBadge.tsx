// ═══════════════════════════════════════════════════════════
// ReminderBadge — Cron job status indicator for events
// ═══════════════════════════════════════════════════════════

import { useTranslation } from 'react-i18next';
import { CheckCircle, Circle, CircleAlert, Clock, type IconParkIconComponent, type IconParkTone } from '@dreamclaw/components/icons';
import type { ReminderStatus } from './calendarTypes';

interface ReminderBadgeProps {
  status: ReminderStatus;
  size?: 'sm' | 'md';
}

const STATUS_CONFIG: Record<ReminderStatus, { icon: IconParkIconComponent; tone: IconParkTone; colorClass: string; key: string; label?: string }> = {
  scheduled: { icon: Clock,       tone: 'success', colorClass: 'text-green-400', key: 'calendar.reminder.scheduled' },
  pending:   { icon: Circle,      tone: 'warning', colorClass: 'text-amber-400', key: 'calendar.reminder.pending' },
  fired:     { icon: CheckCircle, tone: 'success', colorClass: 'text-green-400', key: 'calendar.reminder.fired' },
  failed:    { icon: CircleAlert, tone: 'danger',  colorClass: 'text-red-400',   key: 'calendar.reminder.failed' },
  ready: { icon: Clock, tone: 'warning', colorClass: 'text-amber-400', key: '', label: 'Ready to review' },
  missed: { icon: CircleAlert, tone: 'warning', colorClass: 'text-amber-400', key: '', label: 'Time passed without confirmed display' },
  unavailable: { icon: CircleAlert, tone: 'danger', colorClass: 'text-red-400', key: '', label: 'Reminder time needs review' },
  dismissed: { icon: CheckCircle, tone: 'sky', colorClass: 'text-aegis-text-dim', key: '', label: 'Reminder dismissed' },
  cancelled: { icon: Circle, tone: 'sky', colorClass: 'text-aegis-text-dim', key: '', label: 'Reminder cancelled' },
  none:      { icon: Circle,      tone: 'sky',     colorClass: '',                key: '' },
};

export function ReminderBadge({ status, size = 'md' }: ReminderBadgeProps) {
  const { t } = useTranslation();

  if (status === 'none') return null;

  const cfg = STATUS_CONFIG[status];
  const sizeClass = size === 'sm' ? 'text-[8px]' : 'text-[10px]';
  const StatusIcon = cfg.icon;

  return (
    <span className={`${sizeClass} ${cfg.colorClass} shrink-0`} title={cfg.label ?? t(cfg.key)}>
      <StatusIcon size={size === 'sm' ? 11 : 14} tone={cfg.tone} decorative />
    </span>
  );
}
