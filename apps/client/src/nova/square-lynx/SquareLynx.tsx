import { defaultSquareLynxAvatar, resolveSquareLynxAppearance } from '../../../../../packages/domain/square-lynx';
import './square-lynx.css';

/** Avatar image URLs, bundled at build time. */
const avatarUrls = import.meta.glob('./assets/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export function squareLynxUrl(avatarId: string): string {
  return avatarUrls[`./assets/${avatarId}.webp`] ?? avatarUrls[`./assets/${defaultSquareLynxAvatar}.webp`];
}

export const SQUARE_LYNX_SIZES = { icon: 40, roster: 72, profile: 220, creator: 300, hub: 84 } as const;
export type SquareLynxSize = keyof typeof SQUARE_LYNX_SIZES;
export type SquareLynxAccessibility = { mode: 'decorative' } | { mode: 'informative'; label: string };

export interface SquareLynxProps {
  /** Saved appearance JSON. Legacy recipes fall back to the Nova original. */
  appearance: unknown;
  accessibility: SquareLynxAccessibility;
  size?: SquareLynxSize;
  className?: string;
}

/** The square lynx avatar: one strict square, illustrated like the logo. */
export function SquareLynx({ appearance, accessibility, size = 'roster', className }: SquareLynxProps) {
  const resolved = resolveSquareLynxAppearance(appearance);
  const avatarId = resolved.status === 'ready' ? resolved.avatar.id : defaultSquareLynxAvatar;
  const alt = accessibility.mode === 'informative' ? accessibility.label.trim() || 'Square lynx avatar' : '';
  const dimension = SQUARE_LYNX_SIZES[size];
  return (
    <img
      src={squareLynxUrl(avatarId)}
      alt={alt}
      width={dimension}
      height={dimension}
      draggable={false}
      className={['square-lynx', `square-lynx-${size}`, className].filter(Boolean).join(' ')}
    />
  );
}
