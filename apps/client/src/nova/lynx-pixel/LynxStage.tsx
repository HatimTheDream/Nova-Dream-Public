import { useState } from 'react';
import type { LynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { lynxDirections, type LynxDirection, type LynxExpression, type LynxMotion } from '../../../../../packages/domain/lynx-motion';
import { PixelLynx } from './PixelLynx';
const facingNames: Record<LynxDirection, string> = { N: 'Back', NE: 'Back right', E: 'Right', SE: 'Front right', S: 'Front', SW: 'Front left', W: 'Left', NW: 'Back left' };
export default function LynxStage({ recipe, label }: { recipe: LynxAppearance; label: string }) {
  const [direction, setDirection] = useState<LynxDirection>('SE'), [motion, setMotion] = useState<LynxMotion>('idle');
  const [expression, setExpression] = useState<LynxExpression>('neutral'), [paused, setPaused] = useState(false);
  const turn = (amount: number) => setDirection(d => lynxDirections[(lynxDirections.indexOf(d) + amount + 8) % 8]);
  return <div className="pixel-stage"><div className="pixel-stage-art" tabIndex={0} aria-label={`${label}. Left and right arrows turn the character.`} onKeyDown={e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); turn(e.key === 'ArrowLeft' ? -1 : 1); }
  }}><span className="pixel-stage-shadow"/><PixelLynx recipe={recipe} direction={direction} motion={motion} expression={expression} label={`${label}, ${facingNames[direction].toLowerCase()}`} size={300} animated={!paused}/></div>
    <div className="pixel-facings" aria-label="Character direction">{lynxDirections.map(d => <button type="button" key={d} aria-label={facingNames[d]} title={facingNames[d]} aria-pressed={d === direction} onClick={() => setDirection(d)}>{d}</button>)}</div>
    <div className="record-field-grid pixel-preview-controls"><label>Motion<select value={motion} onChange={e => setMotion(e.target.value as LynxMotion)}><option value="idle">At rest</option><option value="walk">Walk</option><option value="sit-down">Sit down</option><option value="seated-work">Seated work</option><option value="stand-up">Stand up</option><option value="wave">Wave</option></select></label><label>Expression<select value={expression} onChange={e => setExpression(e.target.value as LynxExpression)}><option value="neutral">Neutral</option><option value="happy">Happy</option><option value="focused">Focused</option><option value="blink">Eyes closed</option></select></label></div>
    <button type="button" className="text-button" onClick={() => setPaused(value => !value)}>{paused ? 'Play preview' : 'Pause preview'}</button>
  </div>;
}
