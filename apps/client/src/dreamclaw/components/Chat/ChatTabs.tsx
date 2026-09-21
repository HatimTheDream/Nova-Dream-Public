import { useEffect } from 'react';
import { PanelLeftOpen, Plus } from '../../../icons';

// Original reopen control and Ctrl/Cmd+Shift+O shortcut; E3 supplies draft creation.
export function ChatTabs({ organizationOpen, onToggleOrganization, onCreateConversation, newDraftLabel = 'New chat', shortcutOwner = true }: { organizationOpen: boolean; onToggleOrganization: () => void; onCreateConversation: () => void; newDraftLabel?: string; shortcutOwner?: boolean }) {
  useEffect(() => {
    if (!shortcutOwner) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      const create = !event.shiftKey && event.key.toLowerCase() === 'n';
      const toggle = event.shiftKey && event.key.toLowerCase() === 'o';
      if (!create && !toggle) return;
      event.preventDefault();
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      if (create) onCreateConversation();
      else onToggleOrganization();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCreateConversation, onToggleOrganization, shortcutOwner]);

  if (organizationOpen) return null;
  return <>
    <button
      type="button"
      data-assistant-sidebar-toggle
      onClick={onToggleOrganization}
      className="dc-assistant-sidebar-reopen"
      aria-label="Show assistant sidebar"
      aria-expanded="false"
      aria-controls="assistant-organization"
      title="Show sidebar (Ctrl+Shift+O)"
    >
      <PanelLeftOpen size={18} />
    </button>
    <button type="button" className="dc-assistant-sidebar-reopen" aria-label={newDraftLabel} title={`${newDraftLabel} (Ctrl/Cmd+N)`} onClick={onCreateConversation}><Plus size={18}/></button>
  </>;
}
