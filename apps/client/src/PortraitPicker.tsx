import { LoadingRing } from './ModuleLoading';
import { Suspense } from 'react';
import { lazy } from './preload-lazy';
import { createLynxAppearance, resolveLynxAppearance } from '../../../packages/domain/lynx-appearance';
import { Portrait } from './nova/lynx-portrait/Portrait';
import { createPortraitRecipe, PORTRAIT_BACKGROUNDS, PORTRAIT_FRAMES, resolvePortraitRecipe, type PortraitBackgroundId, type PortraitFrameId, type PortraitCropId } from './nova/lynx-portrait/recipe';
const LynxAppearancePicker = lazy(() => import('./nova/lynx-pixel/LynxAppearancePicker'));

export function PortraitPicker({ value, change, name }: { value: Record<string, unknown> | null; change: (value: Record<string, unknown> | null) => void; name: string }) {
  const resolved = resolvePortraitRecipe(value);
  const lynx = resolveLynxAppearance(value);
  if (lynx.status === 'ready') return <div className="record-portrait-picker"><h3>Character</h3><Suspense fallback={<LoadingRing label="Opening character choices…"/>}><LynxAppearancePicker value={lynx.recipe} change={change} name={name}/></Suspense><details><summary>Original portraits</summary><div className="button-row"><button type="button" onClick={() => change({ ...createPortraitRecipe('nova-original') })}>Nova original</button><button type="button" onClick={() => change({ ...createPortraitRecipe('james-original') })}>James original</button></div></details><button className="text-button" type="button" onClick={() => change(null)}>Clear character selection</button></div>;
  return <div className={`record-portrait-picker${resolved.status === 'ready' ? '' : ' is-unselected'}`}>
    <Portrait recipe={value} size="profile" accessibility={{ mode: 'informative', label: `${name || 'Your'} portrait` }}/>
    <div className="record-portrait-controls"><h3>Portrait</h3>
      <p className="metadata">Create a modular Lynx or choose an original portrait.</p>
      {value && resolved.status !== 'ready' && <p role="status">This saved portrait needs a newer or matching catalog. Your settings stay intact unless you choose a replacement.</p>}
      <div className="button-row"><button type="button" onClick={() => change({ ...createLynxAppearance() })}>Create pixel Lynx</button><button type="button" aria-pressed={resolved.status === 'ready' && resolved.recipe.artId === 'nova-original'} onClick={() => change({ ...createPortraitRecipe('nova-original') })}>Nova original</button><button type="button" aria-pressed={resolved.status === 'ready' && resolved.recipe.artId === 'james-original'} onClick={() => change({ ...createPortraitRecipe('james-original') })}>James original</button></div>
      {resolved.status === 'ready' && <div className="record-field-grid">
        <label>Framing<select value={resolved.recipe.cropId} onChange={event => change({ ...resolved.recipe, cropId: event.target.value as PortraitCropId })}><option value="crop-head-shoulders">Head & shoulders</option><option value="crop-upper-torso">Upper torso</option></select></label>
        <label>Background<select value={resolved.recipe.backgroundId} onChange={event => change({ ...resolved.recipe, backgroundId: event.target.value as PortraitBackgroundId })}>{Object.entries(PORTRAIT_BACKGROUNDS).map(([id, choice]) => <option key={id} value={id}>{choice.label}</option>)}</select></label>
        <label>Frame<select value={resolved.recipe.frameId} onChange={event => change({ ...resolved.recipe, frameId: event.target.value as PortraitFrameId })}>{Object.entries(PORTRAIT_FRAMES).map(([id, choice]) => <option key={id} value={id}>{choice.label}</option>)}</select></label>
      </div>}
      {value && <button className="text-button" type="button" onClick={() => change(null)}>Clear portrait selection</button>}
    </div>
  </div>;
}
