type SettingsDraftGuard = { leave: (resume: () => void) => boolean };
let active: SettingsDraftGuard | undefined;
/** The mounted General form owns the unsaved proposal and its leave dialog. */
export function registerSettingsDraftNavigation(leave: SettingsDraftGuard['leave']): () => void {
 const guard={leave};active=guard;return()=>{if(active===guard)active=undefined;};
}
export function mayLeaveSettingsDraft(resume: () => void = () => {}): boolean { return active?.leave(resume) ?? true; }
