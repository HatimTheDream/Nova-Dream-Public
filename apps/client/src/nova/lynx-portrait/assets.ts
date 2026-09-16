import type { PortraitArtId } from './recipe';
/** Static bundled URLs only. Callers cannot inject a remote artwork URL. */
export const PORTRAIT_ASSET_URLS: Readonly<Record<PortraitArtId, string>> = {
  'nova-original': new URL('./assets/nova-detailed-transparent-v1.png', import.meta.url).href,
  'james-original': new URL('./assets/james-detailed-original-v1.png', import.meta.url).href,
};
