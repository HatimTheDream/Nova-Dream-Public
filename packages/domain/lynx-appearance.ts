import { z } from 'zod';

export const LYNX_CATALOG = 'nova-lynx-pixel-1' as const;
export const LYNX_LEGACY_CATALOG = 'nova-lynx-3d-1' as const;
export const lynxChoices = {
  body: { compact: 'Classic', plush: 'Plush' },
  face: { round: 'Round', tapered: 'Tapered' },
  ears: { tufted: 'Tall tufted', short: 'Short tufted' },
  pattern: { classic: 'Classic markings', soft: 'Soft markings', solid: 'Solid fur' },
  shirt: { 'sage-shirt': 'Sage shirt', 'dress-shirt': 'Ivory dress shirt', none: 'No shirt' },
  outerwear: { 'cream-cardigan': 'Cream cardigan', 'field-jacket': 'Moss field jacket', 'navy-blazer': 'Navy suit jacket', 'charcoal-blazer': 'Charcoal suit jacket', none: 'No outer layer' },
  trousers: { 'olive-trousers': 'Olive trousers', 'navy-trousers': 'Navy suit trousers', 'charcoal-trousers': 'Charcoal suit trousers', none: 'No trousers' },
  accessory: { 'brown-satchel': 'Brown satchel', none: 'No accessory' },
  neckwear: { 'burgundy-tie': 'Burgundy tie', 'navy-tie': 'Navy tie', none: 'No tie' },
} as const;
export const lynxDefaultColors = { furColor: '#24282d', markingsColor: '#e2a350', earsColor: '#cb752e', tailTipColor: '#e5d6b4' } as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const lynxAppearanceSchema = z.object({
  schemaVersion: z.literal(2), catalogRevision: z.enum([LYNX_CATALOG, LYNX_LEGACY_CATALOG]),
  body: z.enum(['compact', 'plush']), face: z.enum(['round', 'tapered']), ears: z.enum(['tufted', 'short']),
  furColor: color, markingsColor: color, earsColor: color, tailTipColor: color,
  pattern: z.enum(['classic', 'soft', 'solid']),
  shirt: z.enum(['sage-shirt', 'dress-shirt', 'none']), outerwear: z.enum(['cream-cardigan', 'field-jacket', 'navy-blazer', 'charcoal-blazer', 'none']),
  trousers: z.enum(['olive-trousers', 'navy-trousers', 'charcoal-trousers', 'none']), accessory: z.enum(['brown-satchel', 'none']),
  neckwear: z.enum(['burgundy-tie', 'navy-tie', 'none']).optional(),
  backgroundId: z.enum(['portrait-stone', 'portrait-mist', 'portrait-lilac', 'portrait-night']),
  frameId: z.enum(['frame-brass', 'frame-ivory', 'frame-graphite', 'frame-none']),
  cropId: z.enum(['crop-head-shoulders', 'crop-upper-torso']),
}).strict();
export type LynxAppearance = z.infer<typeof lynxAppearanceSchema>;

/** Only explicit new selections get defaults. Saved data is never silently migrated. */
export function createLynxAppearance(): LynxAppearance {
  return { schemaVersion: 2, catalogRevision: LYNX_CATALOG, body: 'compact', face: 'round', ears: 'tufted',
    ...lynxDefaultColors, pattern: 'classic', shirt: 'sage-shirt', outerwear: 'cream-cardigan',
    trousers: 'olive-trousers', accessory: 'brown-satchel', backgroundId: 'portrait-stone',
    frameId: 'frame-brass', cropId: 'crop-head-shoulders' };
}
export function resolveLynxAppearance(source: unknown):
  | { status: 'ready'; recipe: LynxAppearance; source: unknown }
  | { status: 'unconfigured' | 'invalid' | 'unsupported' | 'stale'; source: unknown } {
  if (source == null) return { status: 'unconfigured', source };
  if (typeof source !== 'object' || Array.isArray(source)) return { status: 'invalid', source };
  // Do not invoke accessors when reviewing a host-owned value.
  const fields = Object.getOwnPropertyDescriptors(source);
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return { status: 'invalid', source };
  if (fields.schemaVersion?.value !== 2) return { status: 'unsupported', source };
  if (![LYNX_CATALOG, LYNX_LEGACY_CATALOG].includes(fields.catalogRevision?.value)) return { status: 'stale', source };
  const parsed = lynxAppearanceSchema.safeParse(source);
  return parsed.success ? { status: 'ready', recipe: parsed.data, source } : { status: 'invalid', source };
}
