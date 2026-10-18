const writing = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]';
const overlays = 'dialog[open], [role="dialog"], [aria-modal="true"], [role="menu"], details.task-row-menu[open]';

/** Only the mounted Tasks screen owns this shortcut; never redirect writing. */
export function bindTaskSearchShortcut(search: () => HTMLInputElement | null, owner: Window = window) {
  const document = owner.document;
  const element = (target: EventTarget | null): Element | null =>
    target && 'closest' in target ? target as Element : null;
  const visible = (node: Element) => node.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]')
    && node.getClientRects().length > 0 && !['hidden', 'collapse'].includes(owner.getComputedStyle(node).visibility);
  const editing = (target: EventTarget | null) => {
    const node = element(target);
    return node && ((node as HTMLElement).isContentEditable || node.closest(writing));
  };
  const handle = (event: KeyboardEvent) => {
    if (event.key !== '/' || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey || editing(event.target) || editing(document.activeElement)) return;
    if ([...document.querySelectorAll(overlays)].some(visible)) return;
    const input = search();
    if (!input || input.disabled || input.readOnly || !visible(input)) return;
    input.focus();
    if (document.activeElement === input) event.preventDefault();
  };
  owner.addEventListener('keydown', handle);
  return () => owner.removeEventListener('keydown', handle);
}
