import {
  createSquareLynxAppearance,
  defaultSquareLynxAvatar,
  resolveSquareLynxAppearance,
  squareLynxAvatars,
  squareLynxClothingStyles,
  squareLynxColorways,
  squareLynxFaces,
  squareLynxPatterns,
  type SquareLynxAvatar,
} from '../../../../../packages/domain/square-lynx';
import { SquareLynx, squareLynxUrl } from './SquareLynx';
import './square-lynx.css';

export interface SquareLynxCreatorProps {
  /** Saved appearance JSON (or null). Unknown shapes keep the Nova original preview. */
  value: Record<string, unknown> | null;
  change: (value: Record<string, unknown> | null) => void;
  name: string;
}

type Module = Pick<SquareLynxAvatar, 'pattern' | 'colorway' | 'clothing'>;

function currentModules(value: Record<string, unknown> | null): Module {
  const resolved = resolveSquareLynxAppearance(value);
  const avatar = resolved.status === 'ready'
    ? resolved.avatar
    : squareLynxAvatars.find(a => a.id === defaultSquareLynxAvatar)!;
  return { pattern: avatar.pattern, colorway: avatar.colorway, clothing: avatar.clothing };
}

function avatarIdFor(modules: Module): string {
  return `${modules.pattern}-${modules.colorway}-${modules.clothing}`;
}

/** One modular avatar builder, shared by agent creation and profile editing.
 *  Each module option previews the real illustration it produces. */
export function SquareLynxCreator({ value, change, name }: SquareLynxCreatorProps) {
  const modules = currentModules(value);
  const resolved = resolveSquareLynxAppearance(value);
  const face = resolved.status === 'ready' ? resolved.avatar.face : 'bold';
  const pick = (patch: Partial<Module>) => {
    change({ ...createSquareLynxAppearance(avatarIdFor({ ...modules, ...patch })) });
  };

  return (
    <div className="square-creator">
      <div className="square-creator-preview">
        <SquareLynx appearance={value} size="creator" accessibility={{ mode: 'informative', label: `${name || 'Your'} square lynx avatar` }} />
        <p className="metadata">{name || 'Your'} avatar · Face: {squareLynxFaces[face]}</p>
      </div>
      <div className="square-creator-modules">
        <fieldset className="square-module">
          <legend>Pattern</legend>
          <div className="square-module-options">
            {(Object.keys(squareLynxPatterns) as (keyof typeof squareLynxPatterns)[]).map(pattern => {
              const id = avatarIdFor({ ...modules, pattern });
              const selected = modules.pattern === pattern;
              return (
                <button type="button" key={pattern} className="square-option" aria-pressed={selected} onClick={() => pick({ pattern })}>
                  <img src={squareLynxUrl(id)} alt="" width={72} height={72} draggable={false} />
                  <span>{squareLynxPatterns[pattern]}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="square-module">
          <legend>Color</legend>
          <div className="square-module-options">
            {(Object.keys(squareLynxColorways) as (keyof typeof squareLynxColorways)[]).map(colorway => {
              const id = avatarIdFor({ ...modules, colorway });
              const selected = modules.colorway === colorway;
              return (
                <button type="button" key={colorway} className="square-option" aria-pressed={selected} onClick={() => pick({ colorway })}>
                  <img src={squareLynxUrl(id)} alt="" width={72} height={72} draggable={false} />
                  <span>{squareLynxColorways[colorway]}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="square-module">
          <legend>Clothing</legend>
          <div className="square-module-options">
            {(Object.keys(squareLynxClothingStyles) as (keyof typeof squareLynxClothingStyles)[]).map(clothing => {
              const id = avatarIdFor({ ...modules, clothing });
              const selected = modules.clothing === clothing;
              return (
                <button type="button" key={clothing} className="square-option" aria-pressed={selected} onClick={() => pick({ clothing })}>
                  <img src={squareLynxUrl(id)} alt="" width={72} height={72} draggable={false} />
                  <span>{squareLynxClothingStyles[clothing]}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
      <div className="button-row">
        <button type="button" className="text-button" onClick={() => change({ ...createSquareLynxAppearance() })}>Reset to Nova original</button>
        <button type="button" className="text-button" onClick={() => change(null)}>Clear avatar</button>
      </div>
    </div>
  );
}
