export const typographyStorageKey = 'e3:typography:v1';
export const fontChoices = [
  { value: 'system', label: 'System' },
  { value: 'sora', label: 'Sora' },
  { value: 'serif', label: 'Serif' },
] as const;
export const textSizeChoices = [
  { value: 'small', label: 'Small' },
  { value: 'standard', label: 'Standard' },
  { value: 'large', label: 'Large' },
  { value: 'extra-large', label: 'Extra large' },
] as const;
export type TypographyPreferences = {
  font: typeof fontChoices[number]['value'];
  textSize: typeof textSizeChoices[number]['value'];
};
export const defaultTypography: Readonly<TypographyPreferences> = { font: 'system', textSize: 'standard' };
type TypographyStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): TypographyStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function resolveTypography(value: unknown): TypographyPreferences {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    font: fontChoices.find(choice => choice.value === saved.font)?.value ?? defaultTypography.font,
    textSize: textSizeChoices.find(choice => choice.value === saved.textSize)?.value ?? defaultTypography.textSize,
  };
}

export function readTypography(storage = browserStorage()): TypographyPreferences {
  try { return resolveTypography(JSON.parse(storage?.getItem(typographyStorageKey) ?? 'null')); }
  catch { return { ...defaultTypography }; }
}

export function applyDocumentTypography(value: TypographyPreferences, target: Document = document): void {
  const preferences = resolveTypography(value);
  target.documentElement.dataset.font = preferences.font;
  target.documentElement.dataset.textSize = preferences.textSize;
}

/** Device appearance never mutates the shared workspace or changes browser zoom. */
export function createTypographyStore(storage: TypographyStorage | undefined, apply: (value: TypographyPreferences) => void) {
  let current = readTypography(storage);
  const listeners = new Set<() => void>();
  const publish = (next: TypographyPreferences) => {
    apply(next);
    if (current.font === next.font && current.textSize === next.textSize) return;
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    apply: () => apply(current),
    update: (value: TypographyPreferences): boolean => {
      const next = resolveTypography(value);
      let saved = false;
      try { if (storage) { storage.setItem(typographyStorageKey, JSON.stringify(next)); saved = true; } } catch { /* Keep the preference in this window. */ }
      publish(next);
      return saved;
    },
    receiveStorageChange: (key: string | null) => {
      if (key === typographyStorageKey || key === null) publish(readTypography(storage));
    },
  };
}

export const typographyStore = createTypographyStore(browserStorage(), value => applyDocumentTypography(value));

/** Called before the first React render, including loading and pairing screens. */
export function initializeTypography(target: Window = window): () => void {
  typographyStore.apply();
  const changed = (event: StorageEvent) => {
    let storage: Storage | undefined;
    try { storage = target.localStorage; } catch { return; }
    if (event.storageArea === storage) typographyStore.receiveStorageChange(event.key);
  };
  target.addEventListener('storage', changed);
  return () => target.removeEventListener('storage', changed);
}
