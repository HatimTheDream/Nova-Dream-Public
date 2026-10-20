import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { assistantGroupSchema } from '../../../packages/domain/assistant-groups';
import type { Snapshot } from '../../../packages/domain/contracts';
import { request } from './api';
import { retainedWindowId } from './useWorkspace';
import { readGroupView, keepGroupView, type GroupViewTarget } from './assistant-group-view';

const listSchema = z.object({ epoch: z.string().uuid(), view: z.literal('groups'),
  groups: z.array(assistantGroupSchema).max(100), next: z.string().uuid().nullable() }).strict();
export function useAssistantGroups(snapshot: Snapshot, originDraftId: string, mayLeave: () => boolean, enabled = true) {
  const scope = { epoch: snapshot.epoch, deviceId: snapshot.deviceId, windowId: retainedWindowId, originDraftId };
  const signature = JSON.stringify(scope);
  const read = () => {
    try { return { signature, owner: readGroupView(scope, localStorage), error: '' }; }
    catch (error) { return { signature, owner: undefined, error: error instanceof Error ? error.message : 'The kept Group view is unavailable.' }; }
  };
  const [state, setState] = useState(read);
  const [list, setList] = useState<{ groups: z.infer<typeof assistantGroupSchema>[]; next: string | null; error: string; busy: boolean }>({ groups: [], next: null, error: '', busy: false });
  const latest = useRef(state); latest.current = state;
  const listRef = useRef(list); listRef.current = list;
  const alive = useRef(true), requests = useRef(0), loading = useRef(false), currentScope = useRef(signature); currentScope.current = signature;
  useEffect(() => { alive.current = true; return () => { alive.current = false; requests.current++; }; }, []);
  const current = () => alive.current && currentScope.current === signature;
  const refresh = async (more = false) => {
    if (!enabled || !current() || loading.current || more && !listRef.current.next) return;
    loading.current = true;
    const serial = ++requests.current, cursor = more ? listRef.current.next : null;
    setList(value => ({ ...value, busy: true, error: '' }));
    try {
      const page = listSchema.parse(await request(`assistant/groups${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`));
      if (!current() || serial !== requests.current) return;
      if (page.epoch !== scope.epoch) throw Error('The workspace changed. The original Group list is kept.');
      setList(value => {
        const groups = cursor ? [...value.groups, ...page.groups] : page.groups;
        if (new Set(groups.map(group => group.id)).size !== groups.length)
          return { ...value, busy: false, error: 'The Group list changed while paging. Refresh it to continue.' };
        return { groups, next: page.next, busy: false, error: '' };
      });
    } catch (error) {
      if (current() && serial === requests.current) setList(value => ({ ...value, busy: false, error: error instanceof Error ? error.message : 'The saved Group list is unavailable.' }));
    } finally { if (serial === requests.current) loading.current = false; }
  };
  useEffect(() => {
    requests.current++; loading.current = false;
    const next = read(); latest.current = next; setState(next);
    const empty = { groups: [], next: null, error: '', busy: false };
    listRef.current = empty; setList(empty);
    void refresh();
  }, [signature, enabled]);
  const select = (target: GroupViewTarget) => {
    const original = latest.current;
    if (!current() || original.signature !== signature || !original.owner || !mayLeave()) return false;
    try {
      const next = { signature, owner: keepGroupView(original.owner, target, localStorage), error: '' };
      latest.current = next; setState(next); return true;
    } catch (error) {
      const next = { ...original, error: error instanceof Error ? error.message : 'The original Group view is kept.' };
      latest.current = next; setState(next); return false;
    }
  };
  return { scope, selection: enabled && state.signature === signature ? state.owner?.view.target ?? null : null,
    error: state.error, readable: !!state.owner && state.signature === signature,
    list, refresh, select, create: () => select({ kind: 'create', groupId: crypto.randomUUID() }),
    reopen: () => { if (current() && mayLeave()) { const next = read(); latest.current = next; setState(next); } } };
}
