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
  interfaceFont: typeof fontChoices[number]['value'];
  interfaceTextSize: typeof textSizeChoices[number]['value'];
  messageFont: typeof fontChoices[number]['value'];
  messageTextSize: typeof textSizeChoices[number]['value'];
};
export const defaultTypography: Readonly<TypographyPreferences> = { interfaceFont: 'system', interfaceTextSize: 'standard', messageFont: 'system', messageTextSize: 'standard' };
type TypographyStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): TypographyStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function resolveTypography(value: unknown): TypographyPreferences {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  // Keep the original device preference when upgrading from the shared font control.
  const font = (value: unknown) => fontChoices.find(choice => choice.value === value)?.value ?? 'system';
  const size = (value: unknown) => textSizeChoices.find(choice => choice.value === value)?.value ?? 'standard';
  return {
    interfaceFont: font('interfaceFont' in saved ? saved.interfaceFont : saved.font),
    interfaceTextSize: size(saved.interfaceTextSize),
    messageFont: font('messageFont' in saved ? saved.messageFont : saved.font),
    messageTextSize: size('messageTextSize' in saved ? saved.messageTextSize : saved.textSize),
  };
}

export function readTypography(storage = browserStorage()): TypographyPreferences {
  try { return resolveTypography(JSON.parse(storage?.getItem(typographyStorageKey) ?? 'null')); }
  catch { return { ...defaultTypography }; }
}

export function applyDocumentTypography(value: TypographyPreferences, target: Document = document): void {
  const preferences = resolveTypography(value);
  Object.assign(target.documentElement.dataset, preferences);
  delete target.documentElement.dataset.font;
  delete target.documentElement.dataset.textSize;
}

/** Device appearance never mutates the shared workspace or changes browser zoom. */
export function createTypographyStore(storage: TypographyStorage | undefined, apply: (value: TypographyPreferences) => void) {
  let current = readTypography(storage);
  const listeners = new Set<() => void>();
  const publish = (next: TypographyPreferences) => {
    apply(next);
    if (Object.keys(next).every(key => current[key as keyof TypographyPreferences] === next[key as keyof TypographyPreferences])) return;
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
