import { createStore } from 'zustand/vanilla';
import { readLocal, saveLocal } from '../api';

type Fields = Record<string, string | boolean>;
type Disk = { read(key: string): Fields | undefined; write(key: string, fields: Fields): boolean };
const activeKey = JSON.stringify(['compose-workspace', 'active']);
export const inboxWritingKey = (source: string, field: string) => JSON.stringify([source, field]);
const isComposeSource = (source: unknown): source is string => typeof source === 'string' && (source === 'compose' || /^compose:[a-f0-9-]{36}$/.test(source));

export function inboxComposeSources(fields: Fields): string[] {
  const sources = new Set(['compose']); // Preserve the original single-message writer.
  for (const key of Object.keys(fields)) {
    try { const value: unknown = JSON.parse(key); if (Array.isArray(value) && value.length === 2 && isComposeSource(value[0])) sources.add(value[0]); } catch { /* Other retained fields are not composer identities. */ }
  }
  return [...sources];
}
export function inboxActiveCompose(fields: Fields): string {
  const active = fields[activeKey];
  return isComposeSource(active) && inboxComposeSources(fields).includes(active) ? active : 'compose';
}
export type InboxWriting = {
  fields: Fields; storageError: boolean;
  change(key: string, value: string | boolean): void;
  newMessage(accountKey: string): string;
  selectMessage(source: string): void;
  importDraft(source:string,operationId:string,fields:Fields):void;
};

/** Text and the selected composer share one durable write. Delivery journals
 * retain their own original source identities, including cloned-window sends. */
export function createInboxWriting(deviceId: string, windowId: string, previousWindowId?: string, disk: Disk = { read: readLocal, write: saveLocal }) {
  const keyFor = (id: string) => `e3:inbox-writing:${deviceId}:${id}`;
  const key = keyFor(windowId), kept = disk.read(key), copied = !kept && previousWindowId ? disk.read(keyFor(previousWindowId)) : undefined;
  const initial = structuredClone(kept ?? copied ?? {});
  return createStore<InboxWriting>((set, get) => {
    const select = (fields: Fields) => {
      if (!disk.write(key, fields)) {
        set({ storageError: true });
        throw new Error('Free browser storage before switching messages. Your current writing stays open.');
      }
      set({ fields, storageError: false });
    };
    return { fields: initial, storageError: !!copied && !disk.write(key, initial),
      change(name, value) {
        const fields = { ...get().fields, [name]: value };
        set({ fields, storageError: !disk.write(key, fields) });
      },
      newMessage(accountKey) {
        const source = `compose:${crypto.randomUUID()}`;
        select({ ...get().fields, [activeKey]: source,
          [inboxWritingKey(source, 'composeAccountKey')]: accountKey,
          [inboxWritingKey(source, 'composeSubject')]: '',
        });
        return source;
      },
      selectMessage(source) {
        if (!inboxComposeSources(get().fields).includes(source)) throw new Error('This kept message is unavailable. Your current writing stays open.');
        select({ ...get().fields, [activeKey]: source });
      },
      importDraft(source,operationId,values) {
        const current=get().fields, marker=inboxWritingKey(source,'composeImportedOperation');
        if(current[marker])return;
        if(!inboxComposeSources(current).includes(source))throw new Error('Open this draft in its kept message.');
        if(['composeTo','composeCc','composeBcc','composeSubject','composeBody'].some(field=>current[inboxWritingKey(source,field)]))throw new Error('This message already has writing. It was kept instead of being replaced.');
        const fields={...current,...Object.fromEntries(Object.entries(values).map(([field,value])=>[inboxWritingKey(source,field),value])),[marker]:operationId};
        // Keep an already received draft in memory if disk storage fills. Its
        // original open request remains recoverable in the delivery journal.
        set({fields,storageError:!disk.write(key,fields)});
      },
    };
  });
}
