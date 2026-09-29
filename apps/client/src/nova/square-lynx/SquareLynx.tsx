import { resolveSquareLynxAppearance } from '../../../../../packages/domain/square-lynx';
import { defaultMascotAppearance, resolveMascotAppearance } from '../../../../../packages/domain/mascot-appearance';
import { MascotSvg } from './MascotSvg';
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

/** New recipes use the approved creator artwork. Existing square lynx recipes
 * retain their original renderer until explicitly edited and saved. */
export function SquareLynx({ appearance, accessibility, size = 'roster', className }: SquareLynxProps) {
  const resolved = resolveMascotAppearance(appearance);
  const legacy = resolved.status === 'unsupported' ? resolveSquareLynxAppearance(appearance) : undefined;
  const dimension = SQUARE_LYNX_SIZES[size];
  return (
    <span
      role={accessibility.mode === 'informative' ? 'img' : undefined}
      aria-label={accessibility.mode === 'informative' ? accessibility.label.trim() || 'Square lynx avatar' : undefined}
      aria-hidden={accessibility.mode === 'decorative' ? true : undefined}
      style={{ display: 'inline-block', width: dimension, height: dimension }}
      className={['square-lynx', `square-lynx-${size}`, className].filter(Boolean).join(' ')}
    >
      {legacy?.status === 'ready'
        ? <SquareLynxSvg modules={legacy.modules} className="square-lynx-art" />
        : <MascotSvg appearance={resolved.status === 'ready' ? resolved.appearance : defaultMascotAppearance} className="square-lynx-art" />}
    </span>
  );
}
