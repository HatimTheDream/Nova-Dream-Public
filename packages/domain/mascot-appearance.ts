import { resolveSquareLynxAppearance } from './square-lynx.js';

export const MASCOT_CATALOG = 'nova-mascot-1' as const;

export const mascotOptions = Object.freeze({
  face: Object.freeze(['classic', 'bright', 'calm', 'focused', 'curious', 'cheerful', 'gentle', 'confident'] as const),
  pattern: Object.freeze(['signature', 'freckles', 'blaze', 'rosettes', 'mask', 'patches', 'bands', 'solid'] as const),
  outfit: Object.freeze(['suit', 'knit', 'shirt', 'hoodie', 'cardigan', 'vest', 'turtleneck', 'utility'] as const),
  glasses: Object.freeze(['none', 'round', 'square', 'browline'] as const),
});

export type MascotAppearance = {
  face: typeof mascotOptions.face[number];
  pattern: typeof mascotOptions.pattern[number];
  outfit: typeof mascotOptions.outfit[number];
  glasses: typeof mascotOptions.glasses[number];
  fur: string;
  markings: string;
  eyes: string;
  clothing: string;
  accent: string;
};

export const defaultMascotAppearance: Readonly<MascotAppearance> = Object.freeze({
  face: 'classic', pattern: 'signature', outfit: 'suit', glasses: 'none',
  fur: '#f7ecd6', markings: '#cf2c40', eyes: '#edac23',
  clothing: '#272930', accent: '#cf2c40',
});

export type MascotAppearanceRecord = {
  schemaVersion: 1;
  catalogRevision: typeof MASCOT_CATALOG;
  appearance: MascotAppearance;
};

const choiceKeys = ['face', 'pattern', 'outfit', 'glasses'] as const;
const colorKeys = ['fur', 'markings', 'eyes', 'clothing', 'accent'] as const;
const appearanceKeys = [...choiceKeys, ...colorKeys];
const envelopeKeys = ['schemaVersion', 'catalogRevision', 'appearance'];
const colorPattern = /^#[a-f\d]{6}$/i;

/** Inspect data properties without invoking getters, including on malformed
 * in-memory records. JSON-like objects may have a null prototype. */
function dataFields(source: unknown): Record<string, PropertyDescriptor> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  try {
    if (Array.isArray(source)) return undefined;
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const fields = Object.getOwnPropertyDescriptors(source);
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype' ||
          !Object.hasOwn(fields[key], 'value')) return undefined;
    }
    return fields;
  } catch {
    // Revoked proxies and throwing reflection traps are invalid input too.
    return undefined;
  }
}

function hasExactly(fields: Record<string, PropertyDescriptor>, keys: readonly string[]): boolean {
  return Object.keys(fields).length === keys.length && keys.every(key => Object.hasOwn(fields, key));
}

/** A safe editable value: missing or invalid fields use the original look.
 * Saved records use stricter validation below rather than silently repairing. */
export function normalizeMascotAppearance(input: unknown): MascotAppearance {
  const appearance: MascotAppearance = { ...defaultMascotAppearance };
  const fields = dataFields(input);
  if (!fields) return appearance;
  for (const key of choiceKeys) {
    const value: unknown = fields[key]?.value;
    if (typeof value === 'string' && (mascotOptions[key] as readonly string[]).includes(value)) {
      // The key's own catalog, rather than another choice's catalog, validated it.
      Object.assign(appearance, { [key]: value });
    }
  }
  for (const key of colorKeys) {
    const value: unknown = fields[key]?.value;
    if (typeof value === 'string' && value.length === 7 && colorPattern.test(value)) appearance[key] = value.toLowerCase();
  }
  return appearance;
}

export function createMascotAppearance(input: unknown = defaultMascotAppearance): MascotAppearanceRecord {
  return { schemaVersion: 1, catalogRevision: MASCOT_CATALOG, appearance: normalizeMascotAppearance(input) };
}

export function resolveMascotAppearance(source: unknown):
  { status: 'ready'; appearance: MascotAppearance; source: unknown } |
  { status: 'unconfigured' | 'invalid' | 'unsupported'; source: unknown } {
  if (source == null) return { status: 'unconfigured', source };
  const fields = dataFields(source);
  if (!fields) return { status: 'invalid', source };
  if (fields.schemaVersion?.value !== 1 || fields.catalogRevision?.value !== MASCOT_CATALOG) {
    return { status: 'unsupported', source };
  }
  if (!hasExactly(fields, envelopeKeys)) return { status: 'invalid', source };
  const appearance = fields.appearance.value as unknown;
  const choices = dataFields(appearance);
  if (!choices || !hasExactly(choices, appearanceKeys)) return { status: 'invalid', source };
  for (const key of choiceKeys) {
    const value: unknown = choices[key].value;
    if (typeof value !== 'string' || !(mascotOptions[key] as readonly string[]).includes(value)) {
      return { status: 'invalid', source };
    }
  }
  for (const key of colorKeys) {
    const value: unknown = choices[key].value;
    if (typeof value !== 'string' || value.length !== 7 || !colorPattern.test(value)) return { status: 'invalid', source };
  }
  return { status: 'ready', appearance: normalizeMascotAppearance(appearance), source };
}

const legacyPatterns = { stripes: 'signature', spots: 'freckles', blaze: 'blaze', solid: 'solid' } as const;
const legacyFaces = { bold: 'classic', sharp: 'focused', soft: 'gentle', calm: 'calm' } as const;
const legacyMarkings = { red: '#cf2e3b', teal: '#1f9e8e', purple: '#7a5af8', gold: '#d9a41b' } as const;

/** Convert only for the editor. Merely opening it must not write a migration:
 * callers keep the original source/renderer until the user chooses a change. */
export function editableMascotAppearance(source: unknown): MascotAppearance {
  const resolved = resolveMascotAppearance(source);
  if (resolved.status === 'ready') return resolved.appearance;
  const fields = dataFields(source);
  if (!fields || !hasExactly(fields, ['schemaVersion', 'catalogRevision', 'avatarId'])) {
    return { ...defaultMascotAppearance };
  }
  const legacy = resolveSquareLynxAppearance({
    schemaVersion: fields.schemaVersion.value as unknown,
    catalogRevision: fields.catalogRevision.value as unknown,
    avatarId: fields.avatarId.value as unknown,
  });
  if (legacy.status !== 'ready') return { ...defaultMascotAppearance };
  const modules = legacy.modules;
  return {
    face: legacyFaces[modules.face],
    pattern: legacyPatterns[modules.pattern],
    outfit: modules.clothing === 'tie' ? 'suit' : 'shirt',
    glasses: 'none',
    fur: '#f6e9d2',
    markings: legacyMarkings[modules.colorway],
    eyes: '#e8a020',
    clothing: modules.clothing === 'tie' ? '#232327' : '#2e3d5c',
    accent: legacyMarkings[modules.colorway],
  };
}
