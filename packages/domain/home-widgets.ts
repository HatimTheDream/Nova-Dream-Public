import { z } from 'zod';
import { homeWeatherLocationSchema, homeWeatherUnitsSchema } from './home-weather.js';

export const legacyHomeWidgetIds = ['welcome', 'next', 'draft', 'attention', 'setup'] as const;
export const homeWidgetTypes = [...legacyHomeWidgetIds, 'note', 'links', 'clock', 'next-action', 'weather', 'next-appointment', 'daily-routines'] as const;
export type HomeWidgetType = typeof homeWidgetTypes[number];
export const homeWidgetSizes = ['compact', 'square', 'wide', 'large'] as const;
export const homeWidgetColors = ['default', 'cream', 'sky', 'sage', 'rose', 'lavender', 'slate'] as const;
export const homeWidgetLimit = 24;
export const homeWidgetNames: Record<HomeWidgetType, string> = {
  welcome: 'Your Day', next: 'Tasks', draft: 'Assistant', attention: 'Task Attention', setup: 'Quick Actions', note: 'Note', links: 'Quick Links', clock: 'Clock', 'next-action': 'Next Action', weather: 'Weather', 'next-appointment': 'Next Appointment', 'daily-routines': 'Daily Routines',
};

const timezoneSchema = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Choose a valid timezone.');
export const homeQuickLinkSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2048).url().refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }, 'Use an absolute http or https address without embedded credentials.'),
}).strict();
export type HomeQuickLink = z.infer<typeof homeQuickLinkSchema>;

const settingsSchema = z.object({
  view: z.enum(['ready', 'all', 'attention', 'upcoming']).optional(),
  projectId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/).nullable().optional(),
  limit: z.number().int().min(1).max(12).optional(),
  text: z.string().max(10000).optional(),
  links: z.array(homeQuickLinkSchema).max(12).refine(links => new Set(links.map(link => link.id)).size === links.length, 'Each link needs its own identity.').optional(),
  timezone: timezoneSchema.optional(),
  location: homeWeatherLocationSchema.optional(),
  units: homeWeatherUnitsSchema.optional(),
}).strict();
const allowedSettings: Record<HomeWidgetType, readonly string[]> = {
  welcome: ['timezone'], next: ['view', 'projectId', 'limit'], attention: ['projectId', 'limit'], draft: [], setup: [], note: ['text'], links: ['links'], clock: ['timezone'], 'next-action': ['projectId'], weather: ['location', 'units'], 'next-appointment': [], 'daily-routines': ['limit'],
};
const legacyType = (id: string): HomeWidgetType | undefined => legacyHomeWidgetIds.find(type => type === id);

export const homeWidgetSchema = z.object({
  id: z.string().max(100).refine(value => Boolean(legacyType(value)) || value.startsWith('widget:') && z.uuid().safeParse(value.slice(7)).success, 'Use an original widget identity or widget:<uuid>.'),
  type: z.enum(homeWidgetTypes).optional(),
  size: z.enum(homeWidgetSizes),
  hidden: z.boolean(),
  title: z.string().trim().max(80).optional(),
  color: z.enum(homeWidgetColors).optional(),
  settings: settingsSchema.optional(),
}).strict().superRefine((widget, context) => {
  const original = legacyType(widget.id);
  const type = widget.type ?? original;
  if (!type) {
    context.addIssue({ code: 'custom', path: ['type'], message: 'New widgets need a type.' });
    return;
  }
  if (original && widget.type && widget.type !== original) context.addIssue({ code: 'custom', path: ['type'], message: 'Keep the original widget type for this identity.' });
  for (const [key, value] of Object.entries(widget.settings ?? {})) {
    if (value !== undefined && !allowedSettings[type].includes(key)) context.addIssue({ code: 'custom', path: ['settings', key], message: `This setting does not apply to ${type} widgets.` });
  }
});
export type HomeWidget = z.infer<typeof homeWidgetSchema>;

/** Resolve old persisted entries in place; do not regenerate their identities. */
export function resolveWidgetType(widget: Pick<HomeWidget, 'id' | 'type'>): HomeWidgetType {
  const type = widget.type ?? legacyType(widget.id);
  if (!type) throw new Error('This widget is missing its type.');
  return type;
}
export function widgetTitle(widget: Pick<HomeWidget, 'id' | 'type' | 'title'>): string {
  return widget.title?.trim() || homeWidgetNames[resolveWidgetType(widget)];
}

/** Each call owns a fresh identity and settings, including an independent link list. */
export function createHomeWidget(type: HomeWidgetType): HomeWidget {
  const settings: NonNullable<HomeWidget['settings']> = type === 'next' ? { view: 'ready', projectId: null, limit: 5 }
    : type === 'attention' ? { projectId: null, limit: 5 }
      : type === 'note' ? { text: '' } : type === 'links' ? { links: [] } : type === 'next-action' ? { projectId: null } : type === 'weather' ? { units: 'celsius' } : type === 'daily-routines' ? { limit: 5 } : {};
  return { id: `widget:${crypto.randomUUID()}`, type, size: type === 'clock' ? 'compact' : ['welcome', 'next', 'setup'].includes(type) ? 'wide' : 'square', hidden: false, settings };
}

/** Reset arrangement, never content. Removed originals are not recreated. */
export function resetHomeWidgets(widgets: HomeWidget[]): HomeWidget[] {
  const originals = legacyHomeWidgetIds.flatMap(id => {
    const widget = widgets.find(item => item.id === id);
    return widget ? [{ ...widget, size: ['welcome', 'next', 'setup'].includes(id) ? 'wide' as const : 'square' as const, hidden: false }] : [];
  });
  return [...originals, ...widgets.filter(widget => !legacyType(widget.id))];
}
