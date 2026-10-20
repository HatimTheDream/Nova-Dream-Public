/** Restore only a confirmed Library action's own focus; never take it from a newer control. */
export function captureLibraryActionFocus(root: HTMLElement | null, current: () => boolean): () => void {
 if (!root || typeof document === 'undefined') return () => {};
 const origin = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
 const row = origin?.closest<HTMLElement>('.home-library-resource');
 return () => {
  requestAnimationFrame(() => {
   if (!current() || !root.isConnected) return;
   const active = document.activeElement;
   if (active && active !== document.body && active !== origin) return;
   const usable = (node: HTMLElement | null | undefined): node is HTMLElement => !!node && node.isConnected && root.contains(node) && !node.matches(':disabled');
   const fallback = row?.querySelector<HTMLElement>('.home-library-inspect') ?? root.querySelector<HTMLElement>('.home-library-title h1');
   const target = usable(origin) ? origin : usable(fallback) ? fallback : root.querySelector<HTMLElement>('.home-library-title h1');
   if (usable(target)) target.focus({ preventScroll: true });
  });
 };
}
