import { Suspense, useState, type CSSProperties, type ReactNode } from 'react';
import { lazy } from '../../preload-lazy';
import { resolveLynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { PORTRAIT_ART, PORTRAIT_BACKGROUNDS, PORTRAIT_FRAMES, resolvePortraitRecipe, type PortraitRecipe } from './recipe';
import { PORTRAIT_ASSET_URLS } from './assets';
import './portrait.css';
const LynxPortrait = lazy(() => import('../lynx-pixel/LynxPortrait'));

export const PORTRAIT_SIZES = { icon: 48, roster: 80, profile: 240, creator: 320 } as const;
export type PortraitSize = keyof typeof PORTRAIT_SIZES;
export type PortraitAccessibility = { mode: 'decorative' } | { mode: 'informative'; label: string };
export type PortraitHostStatus = 'ready' | 'loading' | 'unavailable' | 'stale';
export type PortraitDisplayStatus = PortraitHostStatus | 'unconfigured' | 'invalid' | 'unsupported';
export const PORTRAIT_STATUS_LABELS: Readonly<Record<Exclude<PortraitDisplayStatus, 'ready'>, string>> = {
  loading: 'Portrait loading', unavailable: 'Portrait unavailable', stale: 'Portrait needs review',
  unconfigured: 'Portrait not selected', invalid: 'Portrait settings invalid', unsupported: 'Portrait settings unsupported',
};
export interface PortraitProps {
  /** Saved presentation JSON. Unknown values are retained by the host, not normalized here. */
  recipe: unknown;
  /** Identity Name/Position remain outside this state; provide an accessible label separately. */
  accessibility: PortraitAccessibility;
  size?: PortraitSize;
  status?: PortraitHostStatus;
  /** Explicitly retry a failed bundled image. Does not alter recipe or saved state. */
  retryKey?: string | number;
  className?: string;
}
interface FrameProps extends Pick<PortraitProps, 'accessibility'> {
  size: PortraitSize;
  state: PortraitDisplayStatus;
  className?: string | undefined;
  recipe?: PortraitRecipe | undefined;
  children?: ReactNode;
}
function Frame({ accessibility, size, state, recipe, className, children }: FrameProps) {
  const label = accessibility.mode === 'informative' ? accessibility.label.trim() || 'Character portrait' : '';
  const message = state === 'ready' ? '' : PORTRAIT_STATUS_LABELS[state];
  const compactMessages = { loading: 'Loading', unavailable: 'No image', stale: 'Needs review', unconfigured: 'Not set', invalid: 'Check settings', unsupported: 'Check settings' } as const;
  const visibleMessage = size === 'roster' && state !== 'ready' ? compactMessages[state] : message;
  const style = {
    '--lynx-portrait-size': `${PORTRAIT_SIZES[size]}px`,
    ...(recipe && state === 'ready' ? {
      backgroundColor: PORTRAIT_BACKGROUNDS[recipe.backgroundId].color,
      borderColor: PORTRAIT_FRAMES[recipe.frameId].color,
    } : {}),
  } as CSSProperties;
  return <span className={`lynx-portrait${className ? ` ${className}` : ''}`}
    style={style} data-portrait-state={state} data-portrait-size={size}
    data-art-id={state === 'ready' ? recipe?.artId : undefined}
    role={accessibility.mode === 'informative' ? 'img' : undefined}
    aria-label={accessibility.mode === 'informative' ? `${label}${message ? ` — ${message}` : ''}` : undefined}
    aria-hidden={accessibility.mode === 'decorative' ? true : undefined}
    aria-busy={state === 'loading' ? true : undefined}
    title={message || undefined}>
    {children}
    {state !== 'ready' && <span className="lynx-portrait__placeholder" aria-hidden="true">
      <span className="lynx-portrait__placeholder-mark">—</span>
      <span className="lynx-portrait__placeholder-text">{visibleMessage}</span>
    </span>}
  </span>;
}
function OriginalImage({ recipe, accessibility, size, className }: {
  recipe: PortraitRecipe; accessibility: PortraitAccessibility; size: PortraitSize; className?: string | undefined;
}) {
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const art = PORTRAIT_ART[recipe.artId];
  return <Frame accessibility={accessibility} size={size} state={imageState} recipe={recipe} className={className}>
    {imageState !== 'unavailable' && <svg className="lynx-portrait__image" aria-hidden="true" focusable="false"
      viewBox={art.crops[recipe.cropId].join(' ')} preserveAspectRatio="xMidYMid meet"
      style={{ visibility: imageState === 'ready' ? 'visible' : 'hidden' }}>
      <image href={PORTRAIT_ASSET_URLS[recipe.artId]} width={art.width} height={art.height}
        onLoad={() => setImageState('ready')} onError={() => setImageState('unavailable')} />
    </svg>}
  </Frame>;
}
/** Reusable creator/Profile/roster presentation. No storage, identity or activation effects. */
export function Portrait({ recipe: source, accessibility, size = 'profile', status = 'ready', retryKey = 0, className }: PortraitProps) {
  const lynx = resolveLynxAppearance(source);
  const resolution = resolvePortraitRecipe(source);
  if (status !== 'ready') return <Frame accessibility={accessibility} size={size} state={status} className={className} />;
  if (lynx.status === 'ready') return <Suspense fallback={<Frame accessibility={accessibility} size={size} state="loading" className={className}/>}><LynxPortrait key={retryKey} recipe={lynx.recipe} size={size} accessibility={accessibility} className={className}/></Suspense>;
  if (resolution.status !== 'ready') return <Frame accessibility={accessibility} size={size} state={resolution.status} className={className} />;
  const recipe = resolution.recipe;
  return <OriginalImage key={`${recipe.catalogRevision}:${recipe.artId}:${retryKey}`} recipe={recipe}
    accessibility={accessibility} size={size} className={className} />;
}
