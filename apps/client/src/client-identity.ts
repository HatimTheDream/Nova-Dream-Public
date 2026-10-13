declare const __E3_VERSION__: string;
declare const __E3_BUILD__: string;

type Metadata = Pick<Document, 'querySelector'>;
export type ClientIdentity = { version: string; build: string; frontendId?: string };

/** Identity belongs to this loaded document, independently of its running host. */
export function readClientIdentity(target: Metadata | undefined = typeof document === 'undefined' ? undefined : document,
  fallback: ClientIdentity = { version: typeof __E3_VERSION__ === 'undefined' ? 'development' : __E3_VERSION__, build: typeof __E3_BUILD__ === 'undefined' ? 'development' : __E3_BUILD__ }): ClientIdentity {
  const meta = (name: string) => target?.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  const frontendId = meta('e3-frontend');
  return { version: meta('e3-frontend-version') || fallback.version, build: meta('e3-frontend-build') || fallback.build,
    ...(frontendId && /^[a-f0-9]{64}$/.test(frontendId) ? { frontendId } : {}) };
}

export const clientIdentity = readClientIdentity();

/** Only immutable same-origin asset namespaces may override bundled URLs. */
export function readFrontendAssetBase(target: Metadata | undefined = typeof document === 'undefined' ? undefined : document): string {
  const value = target?.querySelector<HTMLMetaElement>('meta[name="e3-assets"]')?.content;
  return value && /^\/__(?:frontend|bundled)\/[a-f0-9]{64}\/$/.test(value) ? value : '/';
}
export const frontendAssetBase = readFrontendAssetBase();
export function frontendAssetPath(relative: string, base = frontendAssetBase): string {
  return base + relative.replace(/^\.\//, '');
}
