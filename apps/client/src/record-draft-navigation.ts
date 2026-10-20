const owners = new Set<() => boolean>();

/** Each mounted writer retains its own value and original pending command.
 * Search never saves a record or reconstructs a journal on the writer's behalf. */
export function registerRecordDraftNavigation(retain: () => boolean) {
  owners.add(retain);
  return () => { owners.delete(retain); };
}
export function mayLeaveRecordDrafts() {
  for (const retain of owners) if (!retain()) return false;
  return true;
}
