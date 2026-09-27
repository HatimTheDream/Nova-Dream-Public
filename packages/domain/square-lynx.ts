import { z } from 'zod';

/** Square lynx avatars: illustrated portraits in the Nova Dream logo's hand,
 *  each framed as a square exactly like the logo preview (head, ears, suit).
 *  The creator is modular: pattern x colorway x clothing compose freely, and
 *  every combination is a real illustration. Faces vary per illustration. */
export const SQUARE_LYNX_CATALOG = 'nova-square-lynx-1' as const;

export const squareLynxPatterns = {
  stripes: 'Logo stripes',
  spots: 'Spots',
  blaze: 'Blaze',
  solid: 'Solid',
} as const;
export const squareLynxColorways = {
  red: 'Nova red',
  teal: 'Lagoon teal',
  purple: 'Dusk purple',
  gold: 'Golden',
} as const;
export const squareLynxClothingStyles = {
  tie: 'Tie',
  collar: 'Collar',
} as const;
export const squareLynxFaces = {
  bold: 'Bold',
  sharp: 'Sharp',
  soft: 'Soft',
  calm: 'Calm',
} as const;

export interface SquareLynxAvatar {
  readonly id: string;
  readonly pattern: keyof typeof squareLynxPatterns;
  readonly colorway: keyof typeof squareLynxColorways;
  readonly clothing: keyof typeof squareLynxClothingStyles;
  readonly face: keyof typeof squareLynxFaces;
  readonly label: string;
}

const avatars: SquareLynxAvatar[] = [];
for (const pattern of Object.keys(squareLynxPatterns) as (keyof typeof squareLynxPatterns)[]) {
  for (const colorway of Object.keys(squareLynxColorways) as (keyof typeof squareLynxColorways)[]) {
    for (const clothing of Object.keys(squareLynxClothingStyles) as (keyof typeof squareLynxClothingStyles)[]) {
      avatars.push({ id: `${pattern}-${colorway}-${clothing}`, pattern, colorway, clothing, face: 'bold', label: '' });
    }
  }
}
/** Faces rotate across the catalog so the set has real variety. */
const faceCycle: (keyof typeof squareLynxFaces)[] = ['bold', 'sharp', 'soft', 'calm'];
avatars.forEach((a, i) => { (a as { face: keyof typeof squareLynxFaces }).face = faceCycle[(i * 5 + 1) % 4]; });
/** The Nova original keeps the logo's exact face. */
(avatars.find(a => a.id === 'stripes-red-tie') as { face: keyof typeof squareLynxFaces }).face = 'bold';
const labels: Record<string, string> = {
  'stripes-red-tie': 'Nova original',
};
const patternShort: Record<keyof typeof squareLynxPatterns, string> = {
  stripes: 'stripes', spots: 'spots', blaze: 'blaze', solid: 'solid',
};
avatars.forEach(a => {
  (a as { label: string }).label = labels[a.id]
    ?? `${squareLynxColorways[a.colorway].split(' ')[0]} ${patternShort[a.pattern]}`;
});

/** The full avatar catalog. `file` is the asset stem under nova/square-lynx/assets. */
export const squareLynxAvatars: readonly SquareLynxAvatar[] = avatars;

export const squareLynxAvatarIds = squareLynxAvatars.map(a => a.id);
export const defaultSquareLynxAvatar = 'stripes-red-tie';

/** Signature looks for the built-in team. */
export const squareLynxSignatures: Record<'atlas' | 'mira' | 'vera' | 'felix', string> = {
  atlas: 'stripes-red-tie',
  mira: 'spots-teal-tie',
  vera: 'blaze-purple-tie',
  felix: 'solid-gold-tie',
};

const squareLynxAppearanceSchema = z.object({
  schemaVersion: z.literal(1),
  catalogRevision: z.literal(SQUARE_LYNX_CATALOG),
  avatarId: z.enum(squareLynxAvatarIds as [string, ...string[]]),
}).strict();
export type SquareLynxAppearance = z.infer<typeof squareLynxAppearanceSchema>;

export function createSquareLynxAppearance(avatarId = defaultSquareLynxAvatar): SquareLynxAppearance {
  return { schemaVersion: 1, catalogRevision: SQUARE_LYNX_CATALOG, avatarId };
}

/** Resolve untrusted saved JSON. Legacy portrait/pixel/3D recipes are not
 *  migrated silently: unknown shapes resolve as unconfigured, and the caller
 *  falls back to the Nova original. */
export function resolveSquareLynxAppearance(source: unknown):
  { status: 'ready'; source: unknown; appearance: SquareLynxAppearance; avatar: SquareLynxAvatar } |
  { status: 'unconfigured' | 'invalid' | 'unsupported'; source: unknown } {
  if (source == null) return { status: 'unconfigured', source };
  if (typeof source !== 'object' || Array.isArray(source)) return { status: 'invalid', source };
  const fields = Object.getOwnPropertyDescriptors(source);
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return { status: 'invalid', source };
  if (fields.schemaVersion?.value !== 1) return { status: 'unsupported', source };
  if (fields.catalogRevision?.value !== SQUARE_LYNX_CATALOG) return { status: 'unsupported', source };
  const parsed = squareLynxAppearanceSchema.safeParse(source);
  if (!parsed.success) return { status: 'invalid', source };
  const avatar = squareLynxAvatars.find(a => a.id === parsed.data.avatarId)!;
  return { status: 'ready', source, appearance: parsed.data, avatar };
}
