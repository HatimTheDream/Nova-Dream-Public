import { commandSchema, layoutSchema, type Command } from '../../../packages/domain/contracts';
import type { HomeItemValue, HomePreservationState } from '../../../packages/domain/home-library';
import { isHomeItemDraft } from '../../../packages/domain/home-library-view';

export type HomeWritingScope = { epoch: string; deviceId: string; windowId: string };
export type HomeWritingStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;
export type HomeWritingForm = { id: string; title: string; text: string; value?: HomeItemValue; problem?: string };
export type HomeWritingEntry = {
 key: string; raw: string; epoch: string; windowId: string; kind: 'widget' | 'layout';
 forms: HomeWritingForm[]; problem?: string; pending?: Command;
};
type RecoveryOrigin = { format: 1; epoch: string; deviceId: string; sourceKey: string; sourceSha256: string; formId: string; initialSha256: string };
export type RecoveredHomeWriter = { id: string; revision: 0; value: HomeItemValue; homeRecovery: RecoveryOrigin };
export type KeptHomeWriting = { key: string; raw: string; writer: RecoveredHomeWriter };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const maxRecord = 512 * 1024, maxRead = 4 * 1024 * 1024, maxEntries = 128, maxKeys = 4096;
const size = (text: string) => new TextEncoder().encode(text).byteLength;
const windowId = (text: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(text);
const uuid = (text: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text);

function keyIdentity(key: string, scope: HomeWritingScope) {
 const layout = `e3:journal:${scope.deviceId}:layout:`;
 if (key.startsWith(layout) && windowId(key.slice(layout.length))) return { kind: 'layout' as const, windowId: key.slice(layout.length), epoch: '' };
 const widget = /^e3:home-widget:([^:]+):/.exec(key);
 if (!widget || !uuid(widget[1])) return;
 const prefix = `${widget[0]}${scope.deviceId}:`;
 if (!key.startsWith(prefix)) return;
 const rest = key.slice(prefix.length), separator = rest.indexOf(':');
 if (separator < 1 || !windowId(rest.slice(0, separator)) || !/^[a-zA-Z0-9:_-]{1,200}$/.test(rest.slice(separator + 1))) return;
 return { kind: 'widget' as const, windowId: rest.slice(0, separator), epoch: widget[1] };
}

function widgetForms(value: unknown, prefix: string): HomeWritingForm[] {
 if (!object(value)) return [{ id: prefix, title: 'Unreadable widget form', text: JSON.stringify(value, null, 2), problem: 'This form needs manual review. Its original text is kept.' }];
 const type = typeof value.type === 'string' ? value.type : value.id;
 const title = typeof value.title === 'string' ? value.title : '';
 const settings = value.settings === undefined ? {} : value.settings;
 if (!object(settings) || typeof value.id !== 'string') return [{ id: prefix, title: title || 'Unreadable widget form', text: JSON.stringify(value, null, 2), problem: 'This form needs manual review. Its original text is kept.' }];
 const accepted = (id: string, proposed: HomeItemValue, text: string): HomeWritingForm => ({
  id, title: proposed.title || (proposed.kind === 'note' ? 'Untitled note' : 'Untitled link'), text,
  ...(isHomeItemDraft(proposed) ? { value: proposed } : { problem: 'This writing exceeds a Library field limit. The complete original remains readable below.' }),
 });
 if (type === 'note' && (settings.text === undefined || typeof settings.text === 'string')) {
  const body = typeof settings.text === 'string' ? settings.text : '';
  return [accepted(prefix + ':note', { kind: 'note', title, body, archived: false }, body)];
 }
 if (type === 'links' && (settings.links === undefined || Array.isArray(settings.links))) {
  const links = (settings.links ?? []) as unknown[];
  if (links.length > 12) return [{ id: prefix, title: title || 'Links', text: JSON.stringify(value, null, 2), problem: 'This retained form has more links than its original supported format.' }];
  if (!links.length) return [accepted(prefix + ':empty-links', { kind: 'note', title, body: '', archived: false }, '')];
  return links.map((link, index) => {
   const id = `${prefix}:link:${index}`;
   if (!object(link) || typeof link.id !== 'string' || typeof link.label !== 'string' || typeof link.url !== 'string') return { id, title: 'Unreadable link', text: JSON.stringify(link, null, 2), problem: 'The exact original link is kept for manual review.' };
   return accepted(id, { kind: 'link', title: link.label, url: link.url, body: '', archived: false }, link.url);
  });
 }
 return [{ id: prefix, title: title || (typeof type === 'string' ? type : 'Widget settings'), text: JSON.stringify(value, null, 2), problem: 'These original settings remain available as reference. Widget customization has retired.' }];
}

export function readHomeWriting(key: string, raw: string, scope: HomeWritingScope): HomeWritingEntry | undefined {
 const identity = keyIdentity(key, scope);
 if (!identity) return;
 const base = { key, raw, ...identity, forms: [] as HomeWritingForm[] };
 if (size(raw) > maxRecord) return { ...base, problem: 'This retained record is too large for recovery here. Its original browser data has not been changed.' };
 let value: unknown;
 try { value = JSON.parse(raw); } catch { return { ...base, problem: 'This retained record cannot be read. The complete original bytes are kept.' }; }
 if (value === null) return;
 if (!object(value)) return { ...base, problem: 'This retained record has an unsupported format. Its original bytes are kept.' };
 let forms: HomeWritingForm[], epoch = identity.epoch, pending: Command | undefined;
 if (identity.kind === 'widget') {
  if (value.version !== 1 || !object(value.forms) || Object.keys(value.forms).length > 24) return { ...base, problem: 'This retained editor format needs review. Its original bytes are kept.' };
  forms = Object.entries(value.forms).flatMap(([type, form]) => widgetForms(form, 'form:' + type));
 } else {
  if (typeof value.epoch !== 'string' || !uuid(value.epoch) || typeof value.dirty !== 'boolean' || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !object(value.value) || !Array.isArray(value.value.widgets) || value.value.widgets.length > 24) return { ...base, problem: 'This retained layout proposal needs review. Its original bytes are kept.' };
  if (!value.dirty && !value.pending && !value.conflict) return;
  epoch = value.epoch;
  forms = value.value.widgets.flatMap((form, index) => widgetForms(form, 'layout:' + index));
  if (value.pending !== undefined) {
   const parsed = commandSchema.safeParse(value.pending);
   if (!parsed.success || parsed.data.kind !== 'layout' || parsed.data.entityId !== 'layout' || parsed.data.epoch !== epoch || parsed.data.expectedRevision !== value.revision || !layoutSchema.safeParse(parsed.data.payload).success) return { ...base, epoch, forms, problem: 'The original pending layout command cannot be verified. No command will be replaced or sent.' };
   pending = parsed.data;
  }
 }
 return { ...base, epoch, forms, pending, ...(epoch !== scope.epoch ? { problem: 'This writing belongs to an earlier workspace. It stays readable here but cannot be adopted into the current workspace.' } : {}) };
}

export function discoverHomeWriting(storage: HomeWritingStorage, scope: HomeWritingScope) {
 const entries: HomeWritingEntry[] = [];
 let notice = '', read = 0;
 try {
  const count = Math.min(storage.length, maxKeys);
  if (storage.length > maxKeys) notice = 'Only part of browser storage could be checked. No writing was removed.';
  for (let i = 0; i < count; i++) {
   const key = storage.key(i); if (!key || !keyIdentity(key, scope)) continue;
   if (entries.length >= maxEntries || read >= maxRead) { notice = 'More retained Home writing exists than this bounded list can show. The original records remain kept.'; break; }
   const raw = storage.getItem(key); if (raw === null) continue;
   read += size(raw);
   const entry = readHomeWriting(key, raw, scope); if (entry) entries.push(entry);
  }
 } catch { notice = 'Browser storage could not be read completely. Keep this window open; original writing remains untouched.'; }
 return { entries, notice };
}

const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
export const homeWriterKey = (scope: HomeWritingScope) => `e3:home-library-writer:${scope.deviceId}:${scope.epoch}:${scope.windowId}:item`;
const empty = (raw: string | null) => raw === null || raw === 'null';

/** One atomic local record contains both the draft and its exact adoption origin. */
export async function keepHomeWriting(storage: HomeWritingStorage, selected: HomeWritingEntry, formId: string, scope: HomeWritingScope, current: () => boolean): Promise<KeptHomeWriting> {
 const source = () => {
  if (!current()) throw Error('The workspace or active editor changed. Reopen Home recovery before continuing.');
  const raw = storage.getItem(selected.key);
  if (raw !== selected.raw) throw Error('The original writing changed. Refresh and review it again.');
  const entry = readHomeWriting(selected.key, raw, scope), form = entry?.forms.find(row => row.id === formId);
  if (!entry || entry.problem || !form?.value || form.problem) throw Error(entry?.problem ?? form?.problem ?? 'This form cannot be adopted. Its original writing is kept.');
  return form.value;
 };
 return keepWriter(storage, selected.key, selected.raw, formId, scope, source);
}

export function preservedHomeForms(state: HomePreservationState, role: 'original' | 'current') {
 return state[role]?.widgets.flatMap((widget, index) => widgetForms(widget, 'saved:' + index)) ?? [];
}
export async function keepSavedHomeWriting(storage: HomeWritingStorage, selected: HomePreservationState, role: 'original' | 'current', formId: string, scope: HomeWritingScope, current: () => HomePreservationState | undefined): Promise<KeptHomeWriting> {
 const original = selected[role];
 if (!original) throw Error('The original saved Home writing is unavailable.');
 const raw = JSON.stringify(original), key = `home-layout:${role}:${original.revision}`;
 const source = () => {
  const latest = current();
  if (!latest || JSON.stringify(latest[role]) !== raw) throw Error('The saved Home source or workspace changed. Refresh and review the original again.');
  const form = preservedHomeForms(latest, role).find(row => row.id === formId);
  if (!form?.value || form.problem) throw Error(form?.problem ?? 'This original form needs manual review.');
  return form.value;
 };
 return keepWriter(storage, key, raw, formId, scope, source);
}

async function keepWriter(storage: HomeWritingStorage, sourceKey: string, sourceRaw: string, formId: string, scope: HomeWritingScope, source: () => HomeItemValue): Promise<KeptHomeWriting> {
 const value = source(), sourceSha256 = await sha256(sourceRaw), initialSha256 = await sha256(JSON.stringify(value));
 source(); // Hashing yielded: recheck exact bytes, scope and current editor.
 const key = homeWriterKey(scope), prefix = key.slice(0, -':item'.length);
 if (!empty(storage.getItem(prefix + ':collection')) || !empty(storage.getItem(`e3:home-library-command:${scope.deviceId}:${scope.epoch}:${scope.windowId}`))) throw Error('Finish or keep the current Library editor and original save before recovering other writing.');
 const existing = storage.getItem(key);
 if (!empty(existing)) {
  let writer: RecoveredHomeWriter | undefined;
  try { writer = JSON.parse(existing!); } catch { /* Preserve unrecognized destination. */ }
  const origin = writer?.homeRecovery;
  if (!writer || writer.revision !== 0 || !isHomeItemDraft(writer.value) || !/^library:[a-f0-9-]{36}$/.test(writer.id) || !origin || origin.format !== 1 || origin.epoch !== scope.epoch || origin.deviceId !== scope.deviceId || origin.sourceKey !== sourceKey || origin.sourceSha256 !== sourceSha256 || origin.formId !== formId || origin.initialSha256 !== initialSha256 || JSON.stringify(writer.value) !== JSON.stringify(value)) throw Error('This window already has different Library writing. Open it before recovering another version.');
  return { key, raw: existing!, writer };
 }
 const writer: RecoveredHomeWriter = { id: 'library:' + crypto.randomUUID(), revision: 0, value, homeRecovery: { format: 1, epoch: scope.epoch, deviceId: scope.deviceId, sourceKey, sourceSha256, formId, initialSha256 } };
 const raw = JSON.stringify(writer);
 storage.setItem(key, raw);
 if (storage.getItem(key) !== raw) throw Error('The kept copy changed before it could open. The original Home writing remains available.');
 return { key, raw, writer };
}

export function readKeptHomeWriting(storage: HomeWritingStorage, kept: KeptHomeWriting, scope: HomeWritingScope, current: () => boolean) {
 if (!current() || kept.key !== homeWriterKey(scope) || storage.getItem(kept.key) !== kept.raw) throw Error('The kept Library writing or workspace changed. Open Library and review the current draft.');
 return kept.writer;
}
