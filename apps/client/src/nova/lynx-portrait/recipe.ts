/** Presentation-only contract. Host owns identity, consent, persistence and migrations. */
export const PORTRAIT_SCHEMA_VERSION = 1 as const;
export const PORTRAIT_CATALOG_REVISION = 'lynx-portraits-1' as const;
export const PORTRAIT_ART = {
  'nova-original': { width: 1024, height: 1536, alpha: 'extracted-original-rgb',
    crops: { 'crop-head-shoulders': [310, 0, 500, 500], 'crop-upper-torso': [200, 0, 700, 700] } },
  'james-original': { width: 1024, height: 1536, alpha: 'original-with-glow',
    crops: { 'crop-head-shoulders': [320, 0, 510, 510], 'crop-upper-torso': [200, 0, 700, 700] } },
} as const;
export const PORTRAIT_BACKGROUNDS = {
  'portrait-stone': { label: 'Warm stone', color: '#ded6c5' },
  'portrait-mist': { label: 'Pale mist', color: '#bfd5d5' },
  'portrait-lilac': { label: 'Soft lilac', color: '#d4c6df' },
  'portrait-night': { label: 'Slate night', color: '#354556' },
} as const;
export const PORTRAIT_FRAMES = {
  'frame-brass': { label: 'Brass', color: '#b79550' },
  'frame-ivory': { label: 'Ivory', color: '#f5eddc' },
  'frame-graphite': { label: 'Graphite', color: '#404d5b' },
  'frame-none': { label: 'None', color: 'transparent' },
} as const;
export type PortraitArtId = keyof typeof PORTRAIT_ART;
export type PortraitCropId = keyof typeof PORTRAIT_ART['nova-original']['crops'];
export type PortraitBackgroundId = keyof typeof PORTRAIT_BACKGROUNDS;
export type PortraitFrameId = keyof typeof PORTRAIT_FRAMES;
export interface PortraitRecipe {
  readonly schemaVersion: typeof PORTRAIT_SCHEMA_VERSION;
  readonly catalogRevision: typeof PORTRAIT_CATALOG_REVISION;
  readonly artId: PortraitArtId;
  readonly cropId: PortraitCropId;
  readonly backgroundId: PortraitBackgroundId;
  readonly frameId: PortraitFrameId;
}
export interface PortraitIssue {
  readonly path: string;
  readonly code: 'missing' | 'invalid-type' | 'unknown-choice' | 'unknown-field' | 'unsupported-schema' | 'stale-catalog';
}
export type PortraitResolution =
  | { readonly status: 'ready'; readonly recipe: PortraitRecipe; readonly source: unknown; readonly issues: readonly [] }
  | { readonly status: 'unconfigured' | 'invalid' | 'unsupported' | 'stale'; readonly source: unknown; readonly issues: readonly PortraitIssue[] };
const fields = ['schemaVersion', 'catalogRevision', 'artId', 'cropId', 'backgroundId', 'frameId'] as const;
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Resolve untrusted saved JSON without normalization, mutation or a substitute portrait. */
export function resolvePortraitRecipe(source: unknown): PortraitResolution {
  if (source === null || source === undefined) return { status: 'unconfigured', source, issues: [] };
  if (typeof source !== 'object' || Array.isArray(source)) return { status: 'invalid', source, issues: [{ path: '$', code: 'invalid-type' }] };
  const input = source as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const issues: PortraitIssue[] = [];
  for (const key of Object.keys(descriptors)) {
    if (!fields.includes(key as typeof fields[number])) issues.push({ path: key, code: 'unknown-field' });
  }
  for (const key of fields) {
    const descriptor = descriptors[key];
    if (!descriptor) issues.push({ path: key, code: 'missing' });
    else if (!own(descriptor, 'value') || typeof descriptor.value !== (key === 'schemaVersion' ? 'number' : 'string')) issues.push({ path: key, code: 'invalid-type' });
  }
  if (issues.some(i => i.code === 'missing' || i.code === 'invalid-type')) return { status: 'invalid', source, issues };
  if (input.schemaVersion !== PORTRAIT_SCHEMA_VERSION) issues.push({ path: 'schemaVersion', code: 'unsupported-schema' });
  if (input.catalogRevision !== PORTRAIT_CATALOG_REVISION) issues.push({ path: 'catalogRevision', code: 'stale-catalog' });
  for (const [key, choices] of [
    ['artId', PORTRAIT_ART], ['cropId', PORTRAIT_ART['nova-original'].crops],
    ['backgroundId', PORTRAIT_BACKGROUNDS], ['frameId', PORTRAIT_FRAMES],
  ] as const) if (!own(choices, input[key] as string)) issues.push({ path: key, code: 'unknown-choice' });
  if (issues.length) return { status: issues.some(i => i.code !== 'stale-catalog') ? 'unsupported' : 'stale', source, issues };
  return { status: 'ready', source, issues: [], recipe: {
    schemaVersion: PORTRAIT_SCHEMA_VERSION, catalogRevision: PORTRAIT_CATALOG_REVISION,
    artId: input.artId as PortraitArtId, cropId: input.cropId as PortraitCropId,
    backgroundId: input.backgroundId as PortraitBackgroundId, frameId: input.frameId as PortraitFrameId,
  } };
}

/** Only for an explicit NEW selection. Never call this as a saved-data fallback. */
export function createPortraitRecipe(artId: PortraitArtId): PortraitRecipe {
  if (!own(PORTRAIT_ART, artId)) throw new Error('Unknown original portrait art');
  return { schemaVersion: PORTRAIT_SCHEMA_VERSION, catalogRevision: PORTRAIT_CATALOG_REVISION,
    artId, cropId: 'crop-head-shoulders', backgroundId: 'portrait-stone', frameId: 'frame-brass' };
}
