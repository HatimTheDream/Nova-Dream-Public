import { defaultSquareLynxAvatar, defaultSquareLynxModules, parseSquareLynxAvatarId, resolveSquareLynxAppearance } from '../../../../../packages/domain/square-lynx';
import { SquareLynxSvg } from './SquareLynxSvg';
import './square-lynx.css';

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

/** The square lynx avatar: one strict square, drawn live in the logo's hand.
 *  Pattern, colorway, face and clothing are independent layers, so every saved
 *  combination renders exactly as customized. */
export function SquareLynx({ appearance, accessibility, size = 'roster', className }: SquareLynxProps) {
  const resolved = resolveSquareLynxAppearance(appearance);
  const modules = resolved.status === 'ready'
    ? resolved.modules
    : parseSquareLynxAvatarId(defaultSquareLynxAvatar) ?? defaultSquareLynxModules;
  const dimension = SQUARE_LYNX_SIZES[size];
  return (
    <span
      role={accessibility.mode === 'informative' ? 'img' : undefined}
      aria-label={accessibility.mode === 'informative' ? accessibility.label.trim() || 'Square lynx avatar' : undefined}
      aria-hidden={accessibility.mode === 'decorative' ? true : undefined}
      style={{ display: 'inline-block', width: dimension, height: dimension }}
      className={['square-lynx', `square-lynx-${size}`, className].filter(Boolean).join(' ')}
    >
      <SquareLynxSvg modules={modules} className="square-lynx-art" />
    </span>
  );
}
