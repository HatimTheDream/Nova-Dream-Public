import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical, layoutSchema, type Entity, type Layout } from '../../packages/domain/contracts.js';
import { homeItemValueSchema, type HomeItem, type HomeItemValue, type HomePreservationState, type HomeReference } from '../../packages/domain/home-library.js';
import type { Store } from './store.js';

export const homeWidgetPreservationKey = 'home:widget-preservation:v1';
const itemKey = 'home:library:item:', versionKey = 'home:library:version:item-save:';
const maxBytes = 2 * 1024 * 1024;
const failedInitialization = new WeakSet<Store>();
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
type Mapping = { widgetId: string; linkId?: string; itemId: string; initialSha256: string };
type Manifest = {
 format: 1; kind: 'home-widget-preservation'; sourceEpoch: string; source: Entity<Layout>;
 sourceSha256: string; mappings: Mapping[]; allowance: { items: number; bodyCharacters: number };
};
type Derived = { manifest: Manifest; items: HomeItem[] };
const sourceSchema = z.object({
 id: z.literal('layout'), revision: z.number().int().positive(), updatedAt: z.iso.datetime(),
 deviceId: z.string().min(1).max(200), value: layoutSchema,
}).strict();

/** Pure derivation. Source text, link ordering and identities are never normalized or deduplicated. */
export function deriveHomeWidgetPreservation(source: Entity<Layout>, sourceEpoch: string): Derived {
 if (Buffer.byteLength(canonical(source), 'utf8') > maxBytes || !z.uuid().safeParse(sourceEpoch).success || !sourceSchema.safeParse(source).success) throw Error('The original Home layout needs review. Its saved contents have not been replaced.');
 const items: HomeItem[] = [], mappings: Mapping[] = [];
 const add = (widgetId: string, linkId: string | undefined, value: HomeItemValue) => {
  // Include the original epoch and source revision so another generation cannot earn this allowance.
  const id = 'library:home:' + digest({ sourceEpoch, revision: source.revision, widgetId, linkId: linkId ?? null });
  if (!homeItemValueSchema.safeParse(value).success) throw Error('Original Home writing cannot be represented safely. It remains in its original layout.');
  const item = { ...value, id, revision: 1, updatedAt: source.updatedAt } as HomeItem;
  items.push(item); mappings.push({ widgetId, ...(linkId ? { linkId } : {}), itemId: id, initialSha256: digest(item) });
 };
 for (const widget of source.value.widgets) {
  if (widget.type === 'note') add(widget.id, undefined, { kind: 'note', title: widget.title || 'Recovered Note', body: widget.settings?.text ?? '', archived: false });
  if (widget.type === 'links') {
   const links = widget.settings?.links ?? [];
   if (!links.length) add(widget.id, undefined, { kind: 'note', title: widget.title || 'Recovered Links', body: '', archived: false });
   for (const link of links) add(widget.id, link.id, { kind: 'link', title: link.label, url: link.url, body: '', archived: false });
  }
 }
 const allowance = { items: items.length, bodyCharacters: items.reduce((sum, item) => sum + item.body.length, 0) };
 if (allowance.items > 288 || allowance.bodyCharacters > 240_000) throw Error('Original Home writing exceeds the supported preservation boundary. Nothing was replaced.');
 const manifest: Manifest = { format: 1, kind: 'home-widget-preservation', sourceEpoch, source: structuredClone(source), sourceSha256: digest(source), mappings, allowance };
 if (Buffer.byteLength(canonical(manifest), 'utf8') > maxBytes) throw Error('Original Home provenance exceeds its supported boundary. Nothing was replaced.');
 return { manifest, items };
}

/** Authenticate the complete fixed mapping against native history and immutable initial item versions. */
export function verifiedHomeWidgetPreservation(store: Store): Derived | undefined {
 const raw = store.internalRead<Manifest>(homeWidgetPreservationKey);
 if (raw === undefined) return;
 if (!raw || typeof raw !== 'object' || raw.format !== 1 || raw.kind !== 'home-widget-preservation' || !raw.source) throw Error('Home preservation needs review. Original writing is kept.');
 const derived = deriveHomeWidgetPreservation(raw.source, raw.sourceEpoch);
 if (!equal(raw, derived.manifest)) throw Error('Home preservation provenance changed. Original writing is kept.');
 const history = store.readEntityVersion('layout', 'layout', raw.source.revision);
 if (!history || !equal(history, raw.source)) throw Error('The exact original Home history is unavailable. Original writing is kept.');
 for (const item of derived.items) {
  const initial = store.internalRead<HomeItem>(`${versionKey}${item.id}:1`);
  const current = store.internalRead<HomeItem>(itemKey + item.id);
  if (!initial || !equal(initial, item) || !current || current.id !== item.id || current.kind !== item.kind || !Number.isSafeInteger(current.revision) || current.revision < 1) throw Error('A preserved Home item needs review. No saved item was replaced.');
  if (!equal(store.internalRead(`${versionKey}${item.id}:${current.revision}`), current)) throw Error('A preserved item version needs review. No saved item was replaced.');
 }
 return derived;
}

function sourceView(source: Entity<Layout>) { return { revision: source.revision, updatedAt: source.updatedAt, widgets: structuredClone(source.value.widgets) }; }
export function homeWidgetPreservationState(store: Store): HomePreservationState {
 try {
  const current = store.readEntity('layout', 'layout');
  const preserved = verifiedHomeWidgetPreservation(store);
  if (!preserved) return { status: store.recoveryHeld || store.updateMaintenanceHeld ? 'held' : failedInitialization.has(store) ? 'needs-review' : 'pending', message: 'Original Home writing is kept. Preservation has not completed.', ...(current ? { current: sourceView(current) } : {}), mappings: [] };
  const changed = !current || !equal(current.value.widgets, preserved.manifest.source.value.widgets);
  return { status: changed ? 'changed' : 'ready',
   message: changed ? 'An older Home editor saved different writing. Both the original Library copies and this later layout are kept for explicit recovery.' : 'Original Home writing is preserved as editable Library items.',
   original: sourceView(preserved.manifest.source), ...(changed && current ? { current: sourceView(current) } : {}),
   mappings: preserved.manifest.mappings.map((mapping, index) => ({ widgetId: mapping.widgetId, ...(mapping.linkId ? { linkId: mapping.linkId } : {}), reference: { kind: preserved.items[index].kind, id: mapping.itemId, revision: 1 } })),
  };
 } catch {
  // A failed preservation record must not make the rest of the workspace unusable.
  let current: Entity<Layout> | undefined;
  try { current = store.readEntity('layout', 'layout'); } catch { /* Keep unreadable originals untouched. */ }
  return { status: 'needs-review', message: 'Home preservation could not be verified. Existing Library items and original writing are kept; no automatic replacement was attempted.', ...(current ? { current: sourceView(current) } : {}), mappings: [] };
 }
}

/** Explicit service lifecycle boundary; never invoked by a GET or in a held/review-only copy. */
export function preserveHomeWidgets(store: Store): HomePreservationState {
 if (store.recoveryHeld || store.updateMaintenanceHeld) return homeWidgetPreservationState(store);
 try {
  store.internalAtomic(() => {
   if (store.internalRead(homeWidgetPreservationKey) !== undefined) { verifiedHomeWidgetPreservation(store); return; }
   const source = store.readEntity('layout', 'layout');
   if (!source) throw Error('Original Home layout unavailable.');
   const { manifest, items } = deriveHomeWidgetPreservation(source, store.epoch);
   for (const item of items) {
    if (store.internalRead(itemKey + item.id) !== undefined || store.internalList(`${versionKey}${item.id}:`).length) throw Error('A preservation identity already exists. Its original data is kept.');
   }
   for (const item of items) {
    store.internalWrite(`${versionKey}${item.id}:1`, item);
    store.internalWrite(itemKey + item.id, item);
   }
   store.internalWrite(homeWidgetPreservationKey, manifest);
  });
  failedInitialization.delete(store);
 } catch { failedInitialization.add(store); /* Transaction rollback preserves every original. */ }
 return homeWidgetPreservationState(store);
}

/** Capacity is earned only by authenticated initial mappings, never a client marker or current body size. */
export function homeLibraryWithinCapacity(store: Store, items: readonly HomeItem[]): boolean {
 let preserved: Derived | undefined;
 try { preserved = verifiedHomeWidgetPreservation(store); } catch { /* No unverified allowance; ordinary Library capacity remains usable. */ }
 const ids = new Set(preserved?.items.map(item => item.id) ?? []);
 return items.filter(item => !ids.has(item.id)).length <= 300 &&
  items.length <= 300 + ids.size &&
  items.reduce((sum, item) => sum + item.body.length, 0) <= 2_000_000 + (preserved?.manifest.allowance.bodyCharacters ?? 0);
}

export function originalHomeWidget(store: Store, reference: HomeReference) {
 if (reference.kind !== 'widget' || reference.sha256 !== undefined) return;
 const layout = store.readEntityVersion('layout', 'layout', reference.revision);
 const widget = layout?.value.widgets.find(widget => widget.id === reference.id && (widget.type === 'note' || widget.type === 'links'));
 if (!layout || !widget) return;
 return { layout, widget, text: widget.type === 'note' ? widget.settings?.text ?? '' : (widget.settings?.links ?? []).map(link => `${link.label}\n${link.url}`).join('\n\n') };
}
