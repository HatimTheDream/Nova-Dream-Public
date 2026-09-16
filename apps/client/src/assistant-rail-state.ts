import { useCallback, useEffect, useState } from 'react';
import { readLocal, saveLocal } from './api';
import { ASSISTANT_RAIL_DEFAULT_WIDTH, clampAssistantRailWidth } from './dreamclaw/services/assistant/railLayout';

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query), update = () => setMatches(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
type Preferences = { open: boolean; width: number; expandedProjects: string[]; projectScope?: string };
export function useAssistantRail(deviceId: string) {
  const key = `e3:assistant-rail:${deviceId}`;
  const [preferences, setPreferences] = useState<Preferences>(() => {
    const kept = readLocal<Partial<Preferences>>(key);
    return { open: kept?.open !== false, width: clampAssistantRailWidth(kept?.width ?? ASSISTANT_RAIL_DEFAULT_WIDTH), expandedProjects: Array.isArray(kept?.expandedProjects) ? kept.expandedProjects.filter(id => typeof id === 'string') : kept?.projectScope && kept.projectScope !== 'all' ? [kept.projectScope] : [] };
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktop = useMediaQuery('(min-width: 1001px)');
  const wide = useMediaQuery('(min-width: 1201px)');
  const keep = useCallback((patch: Partial<Preferences>) => setPreferences(current => {
    const next = { ...current, ...patch }; saveLocal(key, next); return next;
  }), [key]);
  // A click can arrive between a viewport resize and React's media update. Use
  // the current viewport so it cannot overwrite the other layout's preference.
  const setOpen = useCallback((open: boolean) => { if (matchMedia('(min-width: 1001px)').matches) keep({ open }); else setMobileOpen(open); }, [keep]);
  const setWidth = useCallback((width: number) => keep({ width: clampAssistantRailWidth(width) }), [keep]);
  const toggleProject = useCallback((id: string) => setPreferences(current => {
    const next = { ...current, expandedProjects: current.expandedProjects.includes(id) ? current.expandedProjects.filter(value => value !== id) : [...current.expandedProjects, id] };
    saveLocal(key, next); return next;
  }), [key]);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  return { open: desktop ? preferences.open : mobileOpen, width: preferences.width, expandedProjects: preferences.expandedProjects,
    desktop, wide, setOpen, setWidth, toggleProject, closeMobile };
}
export type AssistantRailState = ReturnType<typeof useAssistantRail>;
