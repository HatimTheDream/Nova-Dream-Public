import { useEffect, useRef, useState } from 'react';
import { sameProfileWeek } from '../../../packages/domain/profile-week';
import type { WeekNoteState } from '../../../packages/domain/profile-week-note';
import { request } from './api';
import { WeekNoteDraft, weekNoteDraftKey } from './profile-week-note-client';
import type { WeekNoteRecoveryStorage } from './profile-week-note-recovery';
import { registerRecordDraftNavigation } from './record-draft-navigation';

// Resolve storage inside the guarded read/write, including denied browser getters.
export const weekNoteBrowserStorage: WeekNoteRecoveryStorage = {
  get length() { return localStorage.length; },
  key(index) { return localStorage.key(index); },
  getItem(key) { return localStorage.getItem(key); },
  setItem(key, value) { localStorage.setItem(key, value); },
};

export function useWeekNoteDraft(state: WeekNoteState, deviceId: string, windowId: string) {
  const [, render] = useState(0);
  const scope = { epoch: state.epoch, deviceId, windowId, identity: state.identity };
  const current = useRef(scope); current.current = scope;
  const alive = useRef(true);
  const [draft] = useState(() => {
    const captured = scope;
    return new WeekNoteDraft(weekNoteBrowserStorage, weekNoteDraftKey(deviceId, windowId, state.identity), captured, state,
      command => request('profile/week/note', command), () => render(value => value + 1),
      () => alive.current && captured.epoch === current.current.epoch && captured.deviceId === current.current.deviceId &&
        captured.windowId === current.current.windowId && sameProfileWeek(captured.identity, current.current.identity));
  });
  useEffect(() => {
    alive.current = true; draft.active = true;
    const unregister = registerRecordDraftNavigation(() => draft.retain());
    const leave = (event: BeforeUnloadEvent) => { if (!draft.retain()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => { alive.current = false; draft.retire(); unregister(); window.removeEventListener('beforeunload', leave); };
  }, [draft]);
  return draft;
}
