import type { CalendarHost } from '@dreamclaw/stores/calendarStore';
import type { DeliveryChannel } from './calendarTypes';

export interface DeliveryChannelOption {
  id: DeliveryChannel;
  label: string;
  configured: boolean;
  running: boolean;
}

const FALLBACK_CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  last: 'Last active channel',
  telegram: 'Telegram',
  discord: 'Discord',
  imessage: 'iMessage',
  googlechat: 'Google Chat',
  matrix: 'Matrix',
  bluebubbles: 'BlueBubbles',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  slack: 'Slack',
};

const FALLBACK_CHANNEL_ORDER: DeliveryChannel[] = [
  'last',
  'telegram',
  'discord',
  'imessage',
  'googlechat',
  'matrix',
  'bluebubbles',
  'whatsapp',
  'signal',
  'slack',
];

function asDeliveryChannel(value: string): DeliveryChannel | null {
  return (FALLBACK_CHANNEL_ORDER as string[]).includes(value) ? (value as DeliveryChannel) : null;
}

export function getFallbackDeliveryChannels(selected?: string): DeliveryChannelOption[] {
  const options: DeliveryChannelOption[] = FALLBACK_CHANNEL_ORDER.map((id) => ({
    id,
    label: FALLBACK_CHANNEL_LABELS[id],
    configured: false,
    running: false,
  }));

  const selectedChannel = selected ? asDeliveryChannel(selected) : null;
  if (selectedChannel && !options.some((option) => option.id === selectedChannel)) {
    options.push({
      id: selectedChannel,
      label: FALLBACK_CHANNEL_LABELS[selectedChannel] || selectedChannel,
      configured: false,
      running: false,
    });
  }

  return options;
}

export async function fetchDeliveryChannels(host: CalendarHost, selected?: string): Promise<DeliveryChannelOption[]> {
  const fallback = getFallbackDeliveryChannels(selected);
  try {
    const options = await host.deliveryChannels();
    const selectedOption = fallback.find(option => option.id === selected);
    return selectedOption && !options.some(option => option.id === selected) ? [...options, selectedOption] : options.length ? options : fallback;
  } catch { return fallback; }
}
