import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ComposerMenu } from './ComposerMenu';
import { MoreHorizontal, Pin } from './icons';

export function SidebarRow({ title, icon, pinned, selected, secondary, unread, open, kind = 'menu', onClose, expanded, controls, rowClass = '', children }: { title: string; icon: ReactNode; pinned?: boolean; selected?: boolean; secondary?: ReactNode; expanded?: boolean; controls?: string; rowClass?: string; unread?: boolean; open: () => void; kind?: 'menu' | 'dialog'; onClose?: () => void; children: (close: () => void) => ReactNode }) {
  const [openRequest, setOpenRequest] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), origin = useRef({ x: 0, y: 0 }), suppressClickUntil = useRef(0);
  const cancelHold = () => { clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => cancelHold, []);
  const showMenu = () => { setOpenRequest(value => value + 1); };
  return <div className={`conversation-row ${rowClass}`} onContextMenu={event => { if (!event.currentTarget.contains(event.target as Node)) return; event.preventDefault(); cancelHold(); showMenu(); }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(); } }}
    onPointerDown={event => {
      if (event.pointerType !== 'touch' || !event.currentTarget.contains(event.target as Node)) return;
      cancelHold(); origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => { suppressClickUntil.current = Date.now() + 900; showMenu(); }, 500);
    }} onPointerMove={event => { if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 12) cancelHold(); }} onPointerUp={cancelHold} onPointerCancel={cancelHold}
    onClickCapture={event => { if (Date.now() < suppressClickUntil.current && event.currentTarget.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = 0; } }}>
    <button title={title} aria-current={selected ? 'page' : undefined} aria-expanded={expanded} aria-controls={controls} className={`saved-draft ${selected ? 'selected-conversation' : ''}`} onClick={open}>{icon}<span>{pinned && <Pin size={12} className="sidebar-pin" aria-label="Pinned"/>}{title}{unread && <span className="unread-dot" aria-label="Unread"/>}{secondary != null && <small>{secondary}</small>}</span></button>
    <ComposerMenu label={`Options for ${title}`} icon={<MoreHorizontal size={16}/>} align="right" placement="below" kind={kind} openRequest={openRequest} onOpenChange={isOpen => { if (!isOpen) onClose?.(); }}>{children}</ComposerMenu>
  </div>;
}
