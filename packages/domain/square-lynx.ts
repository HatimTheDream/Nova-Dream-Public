import { z } from 'zod';

/** Square lynx avatars: one lynx drawn as independent layers in the Nova Dream
 *  logo's hand — pattern x colorway x face x clothing compose freely, and the
 *  face is never outlined: it is implied by ears, markings and features on one
 *  seamless cream ground, exactly like the logo. Every combination is drawn
 *  live from the same layered vector artwork, so changing one choice never
 *  changes the others. */
export const SQUARE_LYNX_CATALOG = 'nova-square-lynx-2' as const;
/** First-generation catalog: 32 baked portraits, face fused into each image. */
const SQUARE_LYNX_CATALOG_V1 = 'nova-square-lynx-1' as const;

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
export const squareLynxFaces = {
  bold: 'Bold',
  sharp: 'Sharp',
  soft: 'Soft',
  calm: 'Calm',
} as const;
export const squareLynxClothingStyles = {
  tie: 'Tie',
  collar: 'Collar',
} as const;

export type SquareLynxPattern = keyof typeof squareLynxPatterns;
export type SquareLynxColorway = keyof typeof squareLynxColorways;
export type SquareLynxFace = keyof typeof squareLynxFaces;
export type SquareLynxClothing = keyof typeof squareLynxClothingStyles;

export interface SquareLynxModules {
  readonly pattern: SquareLynxPattern;
  readonly colorway: SquareLynxColorway;
  readonly face: SquareLynxFace;
  readonly clothing: SquareLynxClothing;
}

export function squareLynxAvatarId(modules: SquareLynxModules): string {
  return `${modules.pattern}-${modules.colorway}-${modules.face}-${modules.clothing}`;
}

export function parseSquareLynxAvatarId(id: string): SquareLynxModules | undefined {
  const [pattern, colorway, face, clothing] = id.split('-');
  if (!pattern || !colorway || !face || !clothing) return undefined;
  if (!(pattern in squareLynxPatterns) || !(colorway in squareLynxColorways) ||
      !(face in squareLynxFaces) || !(clothing in squareLynxClothingStyles)) return undefined;
  return {
    pattern: pattern as SquareLynxPattern,
    colorway: colorway as SquareLynxColorway,
    face: face as SquareLynxFace,
    clothing: clothing as SquareLynxClothing,
  };
}

export const defaultSquareLynxModules: SquareLynxModules = {
  pattern: 'stripes', colorway: 'red', face: 'bold', clothing: 'tie',
};
export const defaultSquareLynxAvatar = squareLynxAvatarId(defaultSquareLynxModules);

/** Signature looks for the built-in team. */
export const squareLynxSignatures: Record<'atlas' | 'mira' | 'vera' | 'felix', string> = {
  atlas: squareLynxAvatarId({ pattern: 'stripes', colorway: 'red', face: 'bold', clothing: 'tie' }),
  mira: squareLynxAvatarId({ pattern: 'spots', colorway: 'teal', face: 'sharp', clothing: 'tie' }),
  vera: squareLynxAvatarId({ pattern: 'blaze', colorway: 'purple', face: 'soft', clothing: 'tie' }),
  felix: squareLynxAvatarId({ pattern: 'solid', colorway: 'gold', face: 'calm', clothing: 'tie' }),
};

/** Legacy v1 face assignments, reproduced so saved v1 avatars keep their face. */
function legacyV1Face(avatarId: string): SquareLynxFace | undefined {
  const parts = avatarId.split('-');
  if (parts.length !== 3) return undefined;
  const [pattern, colorway, clothing] = parts;
  const patterns = Object.keys(squareLynxPatterns);
  const colorways = Object.keys(squareLynxColorways);
  const clothings = Object.keys(squareLynxClothingStyles);
  const pi = patterns.indexOf(pattern), ci = colorways.indexOf(colorway), ti = clothings.indexOf(clothing);
  if (pi < 0 || ci < 0 || ti < 0) return undefined;
  if (avatarId === 'stripes-red-tie') return 'bold';
  const faces = Object.keys(squareLynxFaces) as SquareLynxFace[];
  return faces[((pi * colorways.length * clothings.length + ci * clothings.length + ti) * 5 + 1) % 4];
}

/** Migrate a v1 baked-portrait id to the modular v2 id, preserving its face. */
export function migrateV1SquareLynxAvatarId(avatarId: string): string | undefined {
  const parts = avatarId.split('-');
  if (parts.length !== 3) return undefined;
  const [pattern, colorway, clothing] = parts;
  const face = legacyV1Face(avatarId);
  if (!face) return undefined;
  return squareLynxAvatarId({
    pattern: pattern as SquareLynxPattern,
    colorway: colorway as SquareLynxColorway,
    face,
    clothing: clothing as SquareLynxClothing,
  });
}

const squareLynxAvatarIds: string[] = [];
for (const pattern of Object.keys(squareLynxPatterns) as SquareLynxPattern[])
  for (const colorway of Object.keys(squareLynxColorways) as SquareLynxColorway[])
    for (const face of Object.keys(squareLynxFaces) as SquareLynxFace[])
      for (const clothing of Object.keys(squareLynxClothingStyles) as SquareLynxClothing[])
        squareLynxAvatarIds.push(squareLynxAvatarId({ pattern, colorway, face, clothing }));

const squareLynxAppearanceSchema = z.object({
  schemaVersion: z.literal(1),
  catalogRevision: z.literal(SQUARE_LYNX_CATALOG),
  avatarId: z.enum(squareLynxAvatarIds as [string, ...string[]]),
}).strict();
export type SquareLynxAppearance = z.infer<typeof squareLynxAppearanceSchema>;

export function createSquareLynxAppearance(avatarId = defaultSquareLynxAvatar): SquareLynxAppearance {
  return { schemaVersion: 1, catalogRevision: SQUARE_LYNX_CATALOG, avatarId };
}

/** Resolve untrusted saved JSON. v1 baked-portrait saves migrate to the
 *  modular catalog, keeping their face. Legacy portrait/pixel/3D recipes are
 *  not migrated silently: unknown shapes resolve as unconfigured, and the
 *  caller falls back to the Nova original. */
export function resolveSquareLynxAppearance(source: unknown):
  { status: 'ready'; source: unknown; appearance: SquareLynxAppearance; modules: SquareLynxModules } |
  { status: 'unconfigured' | 'invalid' | 'unsupported'; source: unknown } {
  if (source == null) return { status: 'unconfigured', source };
  if (typeof source !== 'object' || Array.isArray(source)) return { status: 'invalid', source };
  const fields = Object.getOwnPropertyDescriptors(source);
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return { status: 'invalid', source };
  if (fields.schemaVersion?.value !== 1) return { status: 'unsupported', source };
  const revision = fields.catalogRevision?.value;
  if (revision === SQUARE_LYNX_CATALOG_V1) {
    const avatarId = (source as { avatarId?: unknown }).avatarId;
    if (typeof avatarId !== 'string') return { status: 'invalid', source };
    const migrated = migrateV1SquareLynxAvatarId(avatarId);
    if (!migrated) return { status: 'invalid', source };
    const modules = parseSquareLynxAvatarId(migrated)!;
    return { status: 'ready', source, appearance: createSquareLynxAppearance(migrated), modules };
  }
  if (revision !== SQUARE_LYNX_CATALOG) return { status: 'unsupported', source };
  const parsed = squareLynxAppearanceSchema.safeParse(source);
  if (!parsed.success) return { status: 'invalid', source };
  const modules = parseSquareLynxAvatarId(parsed.data.avatarId)!;
  return { status: 'ready', source, appearance: parsed.data, modules };
}
