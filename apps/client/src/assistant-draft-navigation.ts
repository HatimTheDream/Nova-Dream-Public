type DraftNavigationGuard = { retain: () => boolean };
let active: DraftNavigationGuard | undefined;

/** The mounted editor owns its in-memory draft. Check it before replacing that
 * editor; a stale storage-error flag cannot establish that the latest text is safe. */
export function registerAssistantDraftNavigation(retain: () => boolean): () => void {
  const guard = { retain };
  active = guard;
  return () => { if (active === guard) active = undefined; };
}

export function mayLeaveAssistantDraft(): boolean {
  return active?.retain() ?? true;
}
