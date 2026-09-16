import type { CSSProperties } from 'react';
import type { LynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { PORTRAIT_SIZES, type PortraitAccessibility, type PortraitSize } from '../lynx-portrait/Portrait';
import { PORTRAIT_BACKGROUNDS, PORTRAIT_FRAMES } from '../lynx-portrait/recipe';
import { PixelLynx } from './PixelLynx';
export default function LynxPortrait({ recipe, size, accessibility, className }: {
  recipe: LynxAppearance; size: PortraitSize; accessibility: PortraitAccessibility; className?: string;
}) {
  return <span className={`lynx-portrait pixel-portrait${className ? ` ${className}` : ''}`} data-art-id="nova-lynx-pixel" data-portrait-size={size}
    style={{ '--lynx-portrait-size': `${PORTRAIT_SIZES[size]}px`, backgroundColor: PORTRAIT_BACKGROUNDS[recipe.backgroundId].color, borderColor: PORTRAIT_FRAMES[recipe.frameId].color } as CSSProperties}>
    <PixelLynx recipe={recipe} size={PORTRAIT_SIZES[size]} portrait animated={false} label={accessibility.mode === 'informative' ? accessibility.label : undefined}/>
  </span>;
}
