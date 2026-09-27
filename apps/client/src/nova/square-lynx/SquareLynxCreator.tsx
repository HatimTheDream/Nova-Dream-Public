import { useState } from 'react';
import {
  createSquareLynxAppearance,
  defaultSquareLynxModules,
  resolveSquareLynxAppearance,
  squareLynxAvatarId,
  squareLynxClothingStyles,
  squareLynxColorways,
  squareLynxFaces,
  squareLynxPatterns,
  type SquareLynxModules,
} from '../../../../../packages/domain/square-lynx';
import { SquareLynx } from './SquareLynx';
import { SquareLynxSvg, squareLynxMarkingColors } from './SquareLynxSvg';
import './square-lynx.css';

export interface SquareLynxCreatorProps {
  /** Saved appearance JSON (or null). Unknown shapes keep the Nova original preview. */
  value: Record<string, unknown> | null;
  change: (value: Record<string, unknown> | null) => void;
  name: string;
}

function currentModules(value: Record<string, unknown> | null): SquareLynxModules {
  const resolved = resolveSquareLynxAppearance(value);
  if (resolved.status === 'ready') return resolved.modules;
  return defaultSquareLynxModules;
}

const TABS = ['pattern', 'colorway', 'face', 'clothing'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { pattern: 'Pattern', colorway: 'Color', face: 'Face', clothing: 'Clothing' };

/** One modular avatar builder, shared by agent creation and profile editing.
 *  Pattern, color, face and clothing are independent layers: picking one never
 *  changes the others. The preview always shows the live artwork. */
export function SquareLynxCreator({ value, change, name }: SquareLynxCreatorProps) {
  const modules = currentModules(value);
  const [tab, setTab] = useState<Tab>('pattern');
  const pick = (patch: Partial<SquareLynxModules>) => {
    change({ ...createSquareLynxAppearance(squareLynxAvatarId({ ...modules, ...patch })) });
  };

  const thumbnails = <K extends keyof SquareLynxModules>(
    key: K,
    choices: Record<SquareLynxModules[K], string>,
  ) => (
    <div className="square-module-options" role="group" aria-label={TAB_LABELS[key as Tab]}>
      {(Object.keys(choices) as (keyof typeof choices)[]).map(option => {
        const preview = { ...modules, [key]: option } as SquareLynxModules;
        const selected = modules[key] === option;
        return (
          <button type="button" key={option} className="square-option" aria-pressed={selected} onClick={() => pick({ [key]: option } as Partial<SquareLynxModules>)}>
            <SquareLynxSvg modules={preview} />
            <span>{choices[option]}</span>
          </button>
        );
      })}
    </div>
  );

  const swatches = (
    <div className="square-swatches" role="group" aria-label="Color">
      {(Object.keys(squareLynxColorways) as (keyof typeof squareLynxColorways)[]).map(option => {
        const selected = modules.colorway === option;
        return (
          <button
            type="button"
            key={option}
            className="square-swatch"
            aria-pressed={selected}
            aria-label={squareLynxColorways[option]}
            title={squareLynxColorways[option]}
            style={{ background: squareLynxMarkingColors[option] }}
            onClick={() => pick({ colorway: option })}
          />
        );
      })}
    </div>
  );

  return (
    <div className="square-creator">
      <div className="square-creator-preview">
        <SquareLynx appearance={value} size="creator" accessibility={{ mode: 'informative', label: `${name || 'Your'} square lynx avatar` }} />
        <p className="metadata">{squareLynxPatterns[modules.pattern]} · {squareLynxColorways[modules.colorway]} · {squareLynxFaces[modules.face]} face · {squareLynxClothingStyles[modules.clothing]}</p>
      </div>
      <div className="square-tabs" role="tablist" aria-label="Avatar layers">
        {TABS.map(t => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="square-tab"
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="square-tab-panel" role="tabpanel">
        {tab === 'pattern' && thumbnails('pattern', squareLynxPatterns)}
        {tab === 'colorway' && swatches}
        {tab === 'face' && thumbnails('face', squareLynxFaces)}
        {tab === 'clothing' && thumbnails('clothing', squareLynxClothingStyles)}
      </div>
      <div className="button-row square-creator-actions">
        <button type="button" className="text-button" onClick={() => change({ ...createSquareLynxAppearance() })}>Reset</button>
        <button type="button" className="text-button" onClick={() => change(null)}>Clear</button>
      </div>
    </div>
  );
}
