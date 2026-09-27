import { SquareLynx, type SquareLynxAccessibility } from './SquareLynx';
import './square-lynx.css';

export interface SquareLynxSpriteProps {
  appearance: unknown;
  name: string;
  /** Walking squares lean into the glide; idle squares float gently. */
  motion?: 'idle' | 'walk';
  selected?: boolean;
}

/** A hub agent as its square avatar: the square itself moves, bobs and leans. */
export function SquareLynxSprite({ appearance, name, motion = 'idle', selected }: SquareLynxSpriteProps) {
  const accessibility: SquareLynxAccessibility = { mode: 'informative', label: `${name}'s avatar` };
  return (
    <span
      className={['square-hub-sprite', `square-hub-${motion}`, selected ? 'square-hub-selected' : '']
        .filter(Boolean).join(' ')}
      role="img"
      aria-label={accessibility.label}
    >
      <SquareLynx appearance={appearance} size="hub" accessibility={{ mode: 'decorative' }} />
    </span>
  );
}
