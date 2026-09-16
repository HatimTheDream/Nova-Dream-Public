import { useEffect, useRef, useState } from 'react';
import { readLocal, saveLocal } from './api';
import { restoreWorkspace, workspaceTabs, type WorkspaceAction } from './workspace-tabs';
export function useWorkspaceTabs(scope: string) {
  const key = `e3:workspace-tabs:${scope}`;
  const [saved, setSaved] = useState(() => ({ key, value: restoreWorkspace(readLocal(key)) }));
  const state = saved.key === key ? saved.value : restoreWorkspace(readLocal(key));
  const opened = useRef(false); if (state.visible) opened.current = true;
  useEffect(() => { if (saved.key === key) saveLocal(key, saved.value); else { opened.current = false; setSaved({ key, value: restoreWorkspace(readLocal(key)) }); } }, [saved, key]);
  const dispatch = (action: WorkspaceAction) => setSaved(current => ({ key, value: workspaceTabs(current.key === key ? current.value : restoreWorkspace(readLocal(key)), action) }));
  return { ...state, opened: opened.current, dispatch };
}
