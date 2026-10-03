import { useState, useSyncExternalStore } from 'react';
import type { ModuleId } from '../../../packages/domain/contracts';
import { MoreHorizontal, Settings, type Icon } from './icons';
import { Dialog } from './ui';

type Destination = { id: ModuleId; label: string; icon: Icon };
type Props = {
  items: Destination[];
  route: ModuleId | 'settings';
  open: (route: ModuleId | 'settings') => boolean;
  returnToWideNavigation: () => void;
  updateAvailable?: boolean;
};

const compactQuery = '(max-width: 400px)';
const subscribeCompact = (notify: () => void) => {
  const media = window.matchMedia(compactQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const readCompact = () => window.matchMedia(compactQuery).matches;
const readServerCompact = () => false;

/** The saved navigation order determines placement; responsive layout never saves it. */
export function BottomNavigation({ items, route, open, returnToWideNavigation, updateAvailable = false }: Props) {
  const [more, setMore] = useState(false);
  const compact = useSyncExternalStore(subscribeCompact, readCompact, readServerCompact);
  const primaryCount = compact ? 3 : 4;
  const primary = items.slice(0, primaryCount), remaining = items.slice(primaryCount);
  const currentInMore = !primary.some(item => item.id === route);
  const currentLabel = route === 'settings' ? 'Settings' : items.find(item => item.id === route)?.label;
  const close = () => {
    setMore(false);
    // Dialog restores its trigger normally. After a resize that trigger is
    // hidden, so return to the visible desktop navigation after unmount.
    if (!window.matchMedia('(max-width: 800px)').matches) requestAnimationFrame(returnToWideNavigation);
  };
  const choose = (id: ModuleId | 'settings') => { if (open(id)) close(); };
  return <>
    <nav className="bottom-navigation" aria-label="Main navigation">
      {primary.map(item => { const Icon = item.icon; return <button type="button" key={item.id} className={`bottom-navigation-item${route === item.id ? ' active' : ''}`} aria-current={route === item.id ? 'page' : undefined} onClick={() => open(item.id)}><Icon size={22}/><span>{item.label}</span></button>; })}
      <button type="button" className={`bottom-navigation-item${currentInMore ? ' active' : ''}`} aria-label={currentInMore && currentLabel ? `More sections. Current page: ${currentLabel}` : 'More sections'} aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}><span className="bottom-navigation-more-icon"><MoreHorizontal size={22}/>{updateAvailable && <span className="settings-update-dot" aria-hidden="true"/>}</span><span>More</span></button>
    </nav>
    {more && <Dialog title="More sections" close={close}><nav className="navigation-destinations" aria-label="More sections">
      {remaining.map(item => { const Icon = item.icon; return <button type="button" key={item.id} className={route === item.id ? 'active' : undefined} aria-current={route === item.id ? 'page' : undefined} onClick={() => choose(item.id)}><Icon size={22}/><span>{item.label}</span></button>; })}
      <button type="button" className={route === 'settings' ? 'active' : undefined} aria-current={route === 'settings' ? 'page' : undefined} aria-description={updateAvailable ? 'Software update available' : undefined} onClick={() => choose('settings')}><Settings size={22}/><span>Settings{updateAvailable && <small>Update available</small>}</span></button>
    </nav></Dialog>}
  </>;
}
