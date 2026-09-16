import { useState } from 'react';
import { lynxChoices, type LynxAppearance } from '../../../../../packages/domain/lynx-appearance';
import { Portrait } from '../lynx-portrait/Portrait';
import { PORTRAIT_BACKGROUNDS, PORTRAIT_FRAMES } from '../lynx-portrait/recipe';
import LynxStage from './LynxStage';
const categories = ['Body', 'Fur', 'Face & ears', 'Wardrobe', 'Accessories', 'Portrait'] as const;
export default function LynxAppearancePicker({ value, change, name }: {
  value: LynxAppearance; change: (value: Record<string, unknown>) => void; name: string;
}) {
  const [category, setCategory] = useState<typeof categories[number]>('Body');
  const set = (key: keyof LynxAppearance, selected: string) => change({ ...value, [key]: selected });
  const choice = (key: keyof typeof lynxChoices, label: string) => <label>{label}<select value={value[key] ?? 'none'} onChange={event => set(key, event.target.value)}>{Object.entries(lynxChoices[key]).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>;
  return <div className="pixel-creator"><LynxStage recipe={value} label={`${name || 'Your'} character`}/><div className="pixel-creator-controls">
    <div className="pixel-category-tabs" aria-label="Appearance categories">{categories.map(item => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}</div>
    <fieldset className="pixel-category"><legend>{category}</legend>
      {category === 'Body' && <>{choice('body', 'Build')}<p className="metadata">A complete fur-covered body beneath every outfit.</p><button type="button" onClick={() => change({ ...value, shirt: 'none', outerwear: 'none', trousers: 'none', accessory: 'none', neckwear: 'none' })}>Remove outfit</button></>}
      {category === 'Face & ears' && <>{choice('face', 'Face shape')}{choice('ears', 'Ear shape')}</>}
      {category === 'Fur' && <>{choice('pattern', 'Pattern')}<div className="pixel-color-grid">{([
        ['furColor', 'Fur'], ['markingsColor', 'Markings'], ['earsColor', 'Inner ears'], ['tailTipColor', 'Tail tip'],
      ] as const).map(([key, label]) => <label className="pixel-color-row" key={key}>{label}<input aria-label={`${label} color`} type="color" value={value[key]} onChange={event => set(key, event.target.value)}/></label>)}</div></>}
      {category === 'Wardrobe' && <><div className="button-row"><button type="button" onClick={() => change({...value,shirt:'dress-shirt',outerwear:'navy-blazer',trousers:'navy-trousers',neckwear:'burgundy-tie'})}>Navy suit</button><button type="button" onClick={() => change({...value,shirt:'dress-shirt',outerwear:'charcoal-blazer',trousers:'charcoal-trousers',neckwear:'navy-tie'})}>Charcoal suit</button></div>{choice('shirt', 'Shirt')}{choice('outerwear', 'Outer layer')}{choice('trousers', 'Trousers')}</>}
      {category === 'Accessories' && <>{choice('accessory', 'Bag')}{choice('neckwear', 'Tie')}</>}
      {category === 'Portrait' && <><Portrait recipe={value} size="profile" accessibility={{ mode: 'informative', label: `${name || 'Your'} profile portrait` }}/>
        <label>Framing<select value={value.cropId} onChange={event => set('cropId', event.target.value)}><option value="crop-head-shoulders">Head & shoulders</option><option value="crop-upper-torso">Upper torso</option></select></label>
        <label>Background<select value={value.backgroundId} onChange={event => set('backgroundId', event.target.value)}>{Object.entries(PORTRAIT_BACKGROUNDS).map(([id, option]) => <option key={id} value={id}>{option.label}</option>)}</select></label>
        <label>Frame<select value={value.frameId} onChange={event => set('frameId', event.target.value)}>{Object.entries(PORTRAIT_FRAMES).map(([id, option]) => <option key={id} value={id}>{option.label}</option>)}</select></label></>}
    </fieldset>
  </div></div>;
}
