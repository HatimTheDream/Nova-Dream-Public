import type { InboxSource } from './inbox-source';
import type {InboxFollowups} from './inbox-followups';
import type {CalendarFollowupResult,MailCalendarSource} from '../../../../packages/domain/calendar-followups';
import type {InboxFileJournal} from './inbox-file-journal';
import type { InboxTriageJournal } from './inbox-triage-journal';
import { createContext, useCallback, useContext, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { InboxWriting } from './inbox-writing';
export { createInboxWriting } from './inbox-writing';
import type { CalendarWrite } from './stores/calendarStore';
import type { CalendarSettings } from './pages/Calendar/calendarTypes';
import type { MailActionKind, MailActionPlan, MailActionReceipt, MailActionStatus } from './types/RenderBlock';
import type { PageViewState } from './types/missionControl';
import type { InboxDeliveryJournal } from './inbox-delivery-journal';

export type InboxNotice = { category?: string; severity?: string; title: string; body: string; route?: string; showToast?: boolean };
type FileInput = { fileName: string; mimeType: string; base64: string };
type ActionResult = { status: MailActionStatus; message: string; errors?: string[]; receipt?: MailActionReceipt };
export type InboxHost = {
  openContact?(source: MailCalendarSource, messageId: string): void;
  source: InboxSource; followups: InboxFollowups; openCalendar(eventId: string): void;
  epoch: string; files:InboxFileJournal; delivery: InboxDeliveryJournal; triage: InboxTriageJournal;
  scopeVersion: string; portal: HTMLElement; searchParams: URLSearchParams; writing: StoreApi<InboxWriting>;
  view: PageViewState; patchPageView(page: 'inbox', patch: Partial<PageViewState>): void;
  preferences: Pick<Storage, 'getItem' | 'setItem'>;
  calendarSettings: CalendarSettings;
  addCalendarEvent(data: CalendarWrite, context: {source:MailCalendarSource;startAt:string;endAt:string}): Promise<CalendarFollowupResult>;
  addNotification(notice: InboxNotice): void;
  openSettings(): void;
  api: {
    markDisplayed(input:{provider:'gmail'|'microsoft';accountId:string;generation:string;threadId:string;messageIds:string[]}):Promise<void>;
    file: { saveAttachmentData(input: FileInput): Promise<{ success: boolean; canceled?: boolean; path?: string }>; openAttachmentData(input: FileInput): Promise<{ success: boolean; error?: string }> };
    mailAssistant?: {
      senderState(input: { provider: string; accountId: string; threadId: string }): Promise<{ sender?: string; blocked?: boolean; canManage?: boolean; error?: string }>;
      prepareSelection(input: { action: MailActionKind; organization?: string; targets: { provider: string; accountId: string; threadId: string }[] }): Promise<{ success: boolean; plan?: MailActionPlan; clarification?: string; error?: string }>;
      apply(input: { planId: string; digest: string }): Promise<ActionResult & {plan:MailActionPlan}>;
      undo(input: { receiptId: string; digest: string }): Promise<ActionResult & {plan:MailActionPlan}>;
      cancel(input: { planId: string; digest: string }): Promise<ActionResult & {plan:MailActionPlan}>;
      check(input: {planId:string}): Promise<ActionResult & {plan:MailActionPlan}>;
      acknowledge(input: {planId:string;digest:string}): Promise<ActionResult & {plan:MailActionPlan}>;
    };
  };
};
const Context = createContext<InboxHost | null>(null);
export function InboxHostProvider({ host, children }: { host: InboxHost; children: ReactNode }) { return <Context.Provider value={host}>{children}</Context.Provider>; }
export function useInboxHost() { const host = useContext(Context); if (!host) throw new Error('Inbox host is not connected.'); return host; }
export function useInboxWriting<T extends string | boolean>(source: string, field: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const store = useInboxHost().writing, key = JSON.stringify([source, field]);
  const value = useStore(store, state => state.fields[key] as T | undefined) ?? initial;
  const change = useCallback<Dispatch<SetStateAction<T>>>(update => {
    const current = store.getState().fields[key] as T | undefined;
    store.getState().change(key, typeof update === 'function' ? update(current ?? initial) : update);
  }, [store, key, initial]);
  return [value, change];
}
function attachmentBlob(input: FileInput, overrideType?: string) {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(input.base64) || input.base64.length > 14 * 1024 * 1024) throw new Error('The attachment bytes could not be verified.');
  const binary = atob(input.base64.replaceAll('-', '+').replaceAll('_', '/'));
  if (binary.length > 10 * 1024 * 1024) throw new Error('The attachment exceeds the 10 MB file limit.');
  return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: overrideType ?? input.mimeType });
}
function filename(value: string) { return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'attachment'; }
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename(name); document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const inboxFiles: InboxHost['api']['file'] = {
  async saveAttachmentData(input) { download(attachmentBlob(input), input.fileName); return { success: true }; },
  async openAttachmentData(input) {
    const viewType = input.mimeType === 'application/pdf' || /^(audio|video)\//.test(input.mimeType) ? input.mimeType : input.mimeType.startsWith('text/') ? 'text/plain' : undefined;
    if (!viewType) { download(attachmentBlob(input), input.fileName); return { success: true }; }
    const url = URL.createObjectURL(attachmentBlob(input, viewType)); window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60000); return { success: true };
  },
};
export async function saveInboxImage(src: string, suggestedName: string) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(src);
  if (!match) throw new Error('The image bytes are unavailable.');
  await inboxFiles.saveAttachmentData({ fileName: suggestedName, mimeType: match[1], base64: match[2] });
}
