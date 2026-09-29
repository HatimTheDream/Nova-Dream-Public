import { useId, useMemo } from 'react';
import type { MascotAppearance } from '../../../../../packages/domain/mascot-appearance';
import { renderMascot, type MascotExpression } from './mascot-art';

/** Fixed, local SVG artwork, with strictly validated colors and catalog choices. */
export function MascotSvg({ appearance, expression = 'idle', className }: {
  appearance: MascotAppearance;
  expression?: MascotExpression;
  className?: string;
}) {
  const uid = useId();
  const markup = useMemo(() => renderMascot(appearance, { expression, uid }), [appearance, expression, uid]);
  return <span className={['nova-mascot-art', className].filter(Boolean).join(' ')} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
}
