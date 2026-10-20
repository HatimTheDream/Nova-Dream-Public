type HomeDraftGuard = { retain: () => boolean };
const owners = new Set<HomeDraftGuard>();
function beforeUnload(event: BeforeUnloadEvent) {
 if (!mayLeaveHomeDraft()) { event.preventDefault();event.returnValue = ''; }
}

/** Each mounted Home writer owns its value. Navigation never creates a second journal. */
export function registerHomeDraftNavigation(retain: () => boolean): () => void {
 const owner = { retain };
 if (!owners.size && typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload);
 owners.add(owner);
 return () => {
  owners.delete(owner);
  if (!owners.size && typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload);
 };
}
export function mayLeaveHomeDraft(): boolean {
 let retained = true;
 for (const owner of owners) {
  try { if (!owner.retain()) retained = false; } catch { retained = false; }
 }
 return retained;
}
