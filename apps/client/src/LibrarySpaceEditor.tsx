import { useEffect, useRef, useState } from 'react';
import type { HomeShelves, HomeShelvesCommand, HomeShelvesReceipt } from '../../../packages/domain/home-library';
import { homeSpaceNameKey, isHomeShelvesCommand, isHomeShelvesReceipt } from '../../../packages/domain/home-library-view';
import type { HomeLibraryController } from './HomeLibrary';
import { LibrarySpaceDraftOwner, type LibrarySpaceDraft, type LibrarySpaceScope } from './library-space-draft';
import { registerHomeDraftNavigation } from './home-draft-navigation';
import { Dialog } from './ui';
import { draftBrowserStorage } from './draft-browser-storage';

export type SpaceEditorRequest = LibrarySpaceScope & { nonce: string; draft: LibrarySpaceDraft; restoreFocus?: () => void };
export function LibrarySpaceEditor({ scope, shelves, request, controller, prepareFocus }: {
 scope: LibrarySpaceScope; shelves?: HomeShelves; request?: SpaceEditorRequest; controller: HomeLibraryController; prepareFocus?: () => () => void;
}) {
 const life = useRef({ active: true }), [owner] = useState(() => new LibrarySpaceDraftOwner(draftBrowserStorage, scope, () => life.current.active));
 const [, repaint] = useState(0), [visible, setVisible] = useState(false), [message, setMessage] = useState('');
 const known = useRef<{ command: HomeShelvesCommand; result: HomeShelvesReceipt } | undefined>(undefined);
 const finishFocus = useRef<(() => void) | undefined>(undefined);
 const seen = useRef<string | undefined>(undefined);
 const refresh = () => repaint(value => value + 1);
 useEffect(() => {
  life.current.active = true;
  const release = registerHomeDraftNavigation(() => {
   if (!owner.value) return true;
   const kept = owner.keep();if (!kept) { setVisible(true);refresh(); }return kept;
  });
  return () => { life.current.active = false;release(); };
 }, [owner]);
 useEffect(() => {
  if (!request || seen.current === request.nonce || request.epoch !== scope.epoch || request.deviceId !== scope.deviceId || request.windowId !== scope.windowId) return;
  seen.current = request.nonce;owner.open(request.draft);finishFocus.current = request.restoreFocus ?? prepareFocus?.();setVisible(true);refresh();
 }, [request?.nonce, owner]);
 const adopt = (command: HomeShelvesCommand, result: HomeShelvesReceipt) => {
  if (!life.current.active || !owner.value || command.type !== 'space-save' || owner.value.id !== command.id) return;
  known.current = { command, result };
  if (owner.acknowledge(command, result)) { known.current = undefined;setMessage('Space saved.');if (!owner.value) { setVisible(false);finishFocus.current?.();finishFocus.current = undefined; } }
  refresh();
 };
 useEffect(() => {
  const saved = controller.lastSave;
  if (saved && isHomeShelvesCommand(saved.command) && isHomeShelvesReceipt(saved.result)) adopt(saved.command, saved.result);
 }, [controller.lastSave, owner]);
 const close = () => { if (!owner.value || owner.keep()) { setVisible(false);finishFocus.current = undefined; }refresh(); };
 const blocked = controller.busy || !!controller.pending || !!controller.journalError;
 const value = owner.value, outdated = !!value && !!shelves && value.expectedRevision !== shelves.revision;
 const nameConflict = !!value && !!shelves && shelves.spaces.some(space => space.id !== value.id && homeSpaceNameKey(space.name) === homeSpaceNameKey(value.name));
 const save = async () => {
  if (!life.current.active) return;
  finishFocus.current ??= prepareFocus?.();
  if (known.current) { adopt(known.current.command, known.current.result);return; }
  const current = owner.value;
  if (blocked || !shelves || !current || current.expectedRevision !== shelves.revision || !current.name.trim() || nameConflict || !owner.keep()) { refresh();return; }
  const command: HomeShelvesCommand = { type: 'space-save', requestId: crypto.randomUUID(), epoch: scope.epoch, ...current };
  const result = await controller.run(command);
  if (isHomeShelvesReceipt(result)) adopt(command, result);
 };
 return <>
  {owner.invalid && <p className="notice warning" role="alert">{owner.error}</p>}
  {owner.value && !visible && <button className="compact-action compact-utility" onClick={() => { finishFocus.current = prepareFocus?.();setVisible(true); }}>Resume Space Name</button>}
  {visible && value && <Dialog title={shelves?.spaces.some(space => space.id === value.id) ? 'Rename Space' : 'New Space'} close={close} size="choice">
   <form onSubmit={event => { event.preventDefault();void save(); }}>
    <label>Space Name<input value={value.name} maxLength={100} onChange={event => { owner.edit(event.target.value);refresh(); }}/></label>
    <p className="metadata">Collections keep their original sources. Archived Spaces keep their assignments.</p>
    {(owner.error || message) && <p role={owner.error ? 'alert' : 'status'}>{owner.error || message}</p>}
    {nameConflict && <p role="alert">An active or archived Space already uses this name.</p>}
    {outdated && !known.current && <div className="notice"><span>Library organization changed. Your name is kept. Current saved name: <span className="preserve-case">{shelves?.spaces.find(space => space.id === value.id)?.name ?? 'This Space has not been created.'}</span></span><button type="button" disabled={blocked} onClick={() => { if (shelves) owner.reviewRevision(shelves.revision);refresh(); }}>Use Current Organization</button></div>}
    {controller.pending && <p role="status">The original Library request is kept. Check it in Library before making another change.</p>}
    <div className="compact-actions">
     <button type="button" onClick={close}>Keep For Later</button>
     <button type="button" disabled={blocked || !!known.current} onClick={() => { if (owner.discard()) setVisible(false);refresh(); }}>Discard Name</button>
     <button type="submit" className="primary" disabled={!known.current && (blocked || outdated || !shelves || !value.name.trim() || nameConflict)}>{known.current ? 'Keep Confirmed Save' : 'Save Space'}</button>
    </div>
   </form>
  </Dialog>}
 </>;
}
