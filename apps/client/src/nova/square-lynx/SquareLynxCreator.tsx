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
import { SquareLynxSvg } from './SquareLynxSvg';
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

/** One modular avatar builder, shared by agent creation and profile editing.
 *  Pattern, color, face and clothing are independent layers: picking one never
 *  changes the others. Each option previews the live artwork it produces. */
export function SquareLynxCreator({ value, change, name }: SquareLynxCreatorProps) {
  const modules = currentModules(value);
  const pick = (patch: Partial<SquareLynxModules>) => {
    change({ ...createSquareLynxAppearance(squareLynxAvatarId({ ...modules, ...patch })) });
  };

  const group = <K extends keyof SquareLynxModules>(
    key: K,
    legend: string,
    choices: Record<SquareLynxModules[K], string>,
  ) => (
    <fieldset className="square-module">
      <legend>{legend}</legend>
      <div className="square-module-options">
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
    </fieldset>
  );

  return (
    <div className="square-creator">
      <div className="square-creator-preview">
        <SquareLynx appearance={value} size="creator" accessibility={{ mode: 'informative', label: `${name || 'Your'} square lynx avatar` }} />
        <p className="metadata">{name || 'Your'} avatar · {squareLynxPatterns[modules.pattern]} · {squareLynxColorways[modules.colorway]} · {squareLynxFaces[modules.face]} face · {squareLynxClothingStyles[modules.clothing]}</p>
      </div>
      <div className="square-creator-modules">
        {group('pattern', 'Pattern', squareLynxPatterns)}
        {group('colorway', 'Color', squareLynxColorways)}
        {group('face', 'Face', squareLynxFaces)}
        {group('clothing', 'Clothing', squareLynxClothingStyles)}
      </div>
      <div className="button-row">
        <button type="button" className="text-button" onClick={() => change({ ...createSquareLynxAppearance() })}>Reset to Nova original</button>
        <button type="button" className="text-button" onClick={() => change(null)}>Clear avatar</button>
      </div>
    </div>
  );
}
