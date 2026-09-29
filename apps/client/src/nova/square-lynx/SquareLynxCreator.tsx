import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createMascotAppearance, defaultMascotAppearance, editableMascotAppearance, mascotOptions, MASCOT_CATALOG, resolveMascotAppearance, type MascotAppearance } from '../../../../../packages/domain/mascot-appearance';
import { MascotSvg } from './MascotSvg';
import './mascot-creator.css';

export interface SquareLynxCreatorProps {
  value: Record<string, unknown> | null;
  change: (value: Record<string, unknown> | null) => void;
  name: string;
}
type SavedAppearance = SquareLynxCreatorProps['value'];
type Choice = keyof typeof mascotOptions;
type Expression = 'idle' | 'listening' | 'speaking';
const CHOICES = ['face', 'pattern', 'outfit', 'glasses'] as const;
const LOCK_GROUPS = [...CHOICES, 'colors'] as const;
type LockGroup = typeof LOCK_GROUPS[number];
const PALETTE_COLOR_KEYS = ['fur', 'markings', 'eyes', 'clothing', 'accent'] as const;
const COLOR_KEYS = [...PALETTE_COLOR_KEYS, 'glassesColor'] as const;
type ColorKey = typeof COLOR_KEYS[number];
type Palette = { name: string; colors: Pick<MascotAppearance, typeof PALETTE_COLOR_KEYS[number]> };
const ROW_COLORS: Record<Choice, readonly ColorKey[]> = { face: ['fur', 'eyes'], pattern: ['markings'], outfit: ['clothing', 'accent'], glasses: ['glassesColor'] };
type History = { past: SavedAppearance[]; future: SavedAppearance[] };
const HEX = /^#[0-9a-f]{6}$/i;
const LABELS: Record<string, string> = {
  face: 'Face', pattern: 'Pattern', outfit: 'Outfit', glasses: 'Glasses', colors: 'Colors',
  signature: 'Signature', freckles: 'Freckles', blaze: 'Blaze', rosettes: 'Rosettes', mask: 'Mask', patches: 'Patches', bands: 'Bands', solid: 'Solid',
  classic: 'Classic', bright: 'Bright', calm: 'Calm', focused: 'Focused', curious: 'Curious', cheerful: 'Cheerful', gentle: 'Gentle', confident: 'Confident',
  suit: 'The Executive', knit: 'Soft Knit', shirt: 'Open Collar', hoodie: 'Off Duty', cardigan: 'Cardigan', vest: 'Vest', turtleneck: 'Turtleneck', utility: 'Utility',
  none: 'No Glasses', round: 'Round', square: 'Square', browline: 'Browline',
  fur: 'Fur', markings: 'Markings', eyes: 'Eyes', clothing: 'Clothing', accent: 'Accent', glassesColor: 'Frame',
};
const PALETTES: readonly Palette[] = [
  { name: 'Nova', colors: { fur: '#f7ecd6', markings: '#cf2c40', eyes: '#edac23', clothing: '#272930', accent: '#cf2c40' } },
  { name: 'Cocoa', colors: { fur: '#f5e2c5', markings: '#886248', eyes: '#bb873e', clothing: '#514137', accent: '#a66a45' } },
  { name: 'Evergreen', colors: { fur: '#f5ecd9', markings: '#517268', eyes: '#cfaa59', clothing: '#263e36', accent: '#c39651' } },
  { name: 'Ocean', colors: { fur: '#eaf0e9', markings: '#376d88', eyes: '#dda447', clothing: '#243d52', accent: '#5b9dae' } },
  { name: 'Plum', colors: { fur: '#f4e7df', markings: '#785073', eyes: '#d4a45b', clothing: '#39303f', accent: '#b9799b' } },
  { name: 'Rose', colors: { fur: '#f8e6de', markings: '#b86472', eyes: '#b98345', clothing: '#68434b', accent: '#df9b99' } },
  { name: 'Arctic', colors: { fur: '#f3f0e9', markings: '#6c8392', eyes: '#78a9b6', clothing: '#364959', accent: '#c8a564' } },
  { name: 'Sunset', colors: { fur: '#f8e8ce', markings: '#ba6343', eyes: '#dba13a', clothing: '#4a3535', accent: '#e29b48' } },
];
const STARTERS: readonly { name: string; appearance: MascotAppearance }[] = [
  { name: 'Classic Nova', appearance: { ...defaultMascotAppearance, ...PALETTES[0].colors, face: 'classic', pattern: 'signature', outfit: 'suit' } },
  { name: 'Sunday Slow', appearance: { ...defaultMascotAppearance, ...PALETTES[1].colors, face: 'calm', pattern: 'freckles', outfit: 'knit' } },
  { name: 'Fresh Start', appearance: { ...defaultMascotAppearance, ...PALETTES[2].colors, face: 'bright', pattern: 'blaze', outfit: 'shirt' } },
  { name: 'Ocean Scout', appearance: { ...defaultMascotAppearance, ...PALETTES[3].colors, face: 'curious', pattern: 'bands', outfit: 'utility', glasses: 'round' } },
  { name: 'Plum Focus', appearance: { ...defaultMascotAppearance, ...PALETTES[4].colors, face: 'focused', pattern: 'mask', outfit: 'turtleneck', glasses: 'browline' } },
  { name: 'Golden Hour', appearance: { ...defaultMascotAppearance, ...PALETTES[7].colors, face: 'cheerful', pattern: 'rosettes', outfit: 'cardigan' } },
];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const copy = (value: SavedAppearance): SavedAppearance => value === null ? null : JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const saved = (appearance: MascotAppearance): SavedAppearance => ({ ...createMascotAppearance(appearance) });
function different<T>(values: readonly T[], current: T): T {
  const candidates = values.filter(value => value !== current);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? current;
}

function CreatorIcon({ kind }: { kind: 'undo' | 'redo' | 'lock' | 'unlock' | 'shuffle' | 'download' | 'previous' | 'next' }) {
  return <svg className="mc-icon" viewBox="0 0 24 24" aria-hidden="true">
    {kind === 'undo' && <path d="M8 5 3 10l5 5M3 10h10a7 7 0 0 1 7 7" />}
    {kind === 'redo' && <path d="m16 5 5 5-5 5m5-5H11a7 7 0 0 0-7 7" />}
    {(kind === 'lock' || kind === 'unlock') && <><rect x="5" y="10" width="14" height="11" rx="3" /><path d={kind === 'lock' ? 'M8 10V7a4 4 0 0 1 8 0v3m-4 5v2' : 'M8 10V7a4 4 0 0 1 7.5-2m-3.5 10v2'} /></>}
    {kind === 'shuffle' && <path d="m17 3 4 4-4 4m4-4h-3c-6 0-6 10-12 10H3m14-4 4 4-4 4m4-4h-3c-6 0-6-10-12-10H3" />}
    {kind === 'download' && <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />}
    {kind === 'previous' && <path d="m14 6-6 6 6 6" />}
    {kind === 'next' && <path d="m10 6 6 6-6 6" />}
  </svg>;
}

function ChoiceSelector({ label, value, index, count, previous, next, lock, choice }: {
  label: string; value: string; index: number; count: number; previous: () => void; next: () => void; lock?: ReactNode; choice: string;
}) {
  return <div className={`mc-selector-row${lock ? ' mc-selector-lockable' : ''}`} data-choice={choice} role="group" aria-label={label}>
    <button type="button" className="mc-arrow" aria-label={`Previous ${label.toLowerCase()}`} onClick={previous}><CreatorIcon kind="previous" /></button>
    <div className="mc-choice-current"><span className="mc-choice-label">{label}</span><strong className="mc-choice-value">{value}</strong><span className="mc-choice-count">{index < 0 ? '—' : index + 1} / {count}</span></div>
    <button type="button" className="mc-arrow" aria-label={`Next ${label.toLowerCase()}`} onClick={next}><CreatorIcon kind="next" /></button>
    {lock}
  </div>;
}

function HexColor({ value, label, change, announce }: { value: string; label: string; change: (color: string) => void; announce: (message: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(value); setInvalid(false); }, [value]);
  return <input className="mc-hex" type="text" value={draft} maxLength={7} spellCheck={false} aria-label={`${label} hex color`} aria-invalid={invalid || undefined}
    onChange={event => { setDraft(event.target.value); setInvalid(false); }}
    onBlur={event => {
      const next = event.currentTarget.value.trim();
      if (!HEX.test(next)) { setInvalid(true); announce('Use a six-digit hex color, such as #cf2c40.'); return; }
      setInvalid(false); setDraft(next.toLowerCase()); change(next.toLowerCase());
    }}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = value; setDraft(value); setInvalid(false); event.currentTarget.blur(); }
    }} />;
}

/** Edits the parent record draft. Opening, previewing, and downloading never save or migrate a record. */
export function SquareLynxCreator({ value, change, name }: SquareLynxCreatorProps) {
  const id = useId();
  const [expression, setExpression] = useState<Expression>('idle');
  const [locks, setLocks] = useState<Record<LockGroup, boolean>>({ pattern: false, face: false, outfit: false, glasses: false, colors: false });
  const [activeColor, setActiveColor] = useState<ColorKey | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const historyRef = useRef(history);
  const valueRef = useRef(value);
  valueRef.current = value;
  const valueKey = JSON.stringify(value);
  const previousKey = useRef(valueKey);
  const emittedKey = useRef<string | undefined>(undefined);
  const colorBefore = useRef<{ value: SavedAppearance } | null>(null);
  const colorInputs = useRef<Partial<Record<ColorKey, HTMLInputElement>>>({});
  const [announcement, announce] = useState('');
  const appearance = editableMascotAppearance(value);
  const resolution = resolveMascotAppearance(value);
  const updateHistory = (next: History) => { historyRef.current = next; setHistory(next); };
  useEffect(() => {
    if (previousKey.current === valueKey) return;
    previousKey.current = valueKey;
    if (emittedKey.current !== valueKey) {
      colorBefore.current = null;
      historyRef.current = { past: [], future: [] };
      setHistory(historyRef.current);
    }
    emittedKey.current = undefined;
  }, [valueKey]);

  const emit = (next: SavedAppearance) => { emittedKey.current = JSON.stringify(next); valueRef.current = next; change(next); };
  const remember = (prior: SavedAppearance) => updateHistory({ past: [...historyRef.current.past, copy(prior)].slice(-60), future: [] });
  const finishColor = () => {
    const before = colorBefore.current;
    colorBefore.current = null;
    if (before && !equal(before.value, valueRef.current)) remember(before.value);
  };
  const commit = (next: SavedAppearance, message: string) => {
    finishColor();
    if (!equal(next, valueRef.current)) { remember(valueRef.current); emit(next); }
    announce(message);
  };
  const pick = (patch: Partial<MascotAppearance>, message: string) => commit(saved({ ...appearance, ...patch }), message);
  const undo = () => {
    finishColor();
    const { past, future } = historyRef.current;
    if (!past.length) return;
    updateHistory({ past: past.slice(0, -1), future: [...future, copy(valueRef.current)] });
    emit(copy(past[past.length - 1])); announce('Change undone.');
  };
  const redo = () => {
    finishColor();
    const { past, future } = historyRef.current;
    if (!future.length) return;
    updateHistory({ past: [...past, copy(valueRef.current)].slice(-60), future: future.slice(0, -1) });
    emit(copy(future[future.length - 1])); announce('Change redone.');
  };
  const shuffle = () => {
    const next = { ...appearance };
    if (!locks.pattern) next.pattern = different(mascotOptions.pattern, appearance.pattern);
    if (!locks.face) next.face = different(mascotOptions.face, appearance.face);
    if (!locks.glasses) next.glasses = different(mascotOptions.glasses, appearance.glasses);
    if (!locks.outfit) next.outfit = different(mascotOptions.outfit, appearance.outfit);
    if (!locks.colors) {
      const alternatives = PALETTES.filter(palette => PALETTE_COLOR_KEYS.some(key => palette.colors[key] !== appearance[key]));
      Object.assign(next, alternatives[Math.floor(Math.random() * alternatives.length)].colors);
    }
    commit(saved(next), 'A new look. Locked sections are unchanged.');
  };
  const download = () => {
    finishColor();
    const recipe = { format: 'nova-mascot-look', version: 2, catalogRevision: MASCOT_CATALOG, appearance };
    const url = URL.createObjectURL(new Blob([JSON.stringify(recipe, null, 2) + '\n'], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'nova-mascot-look.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Your look has been downloaded. Save changes to apply it in Nova.');
  };
  const lockButton = (group: LockGroup) => <button type="button" className="mc-lock" aria-pressed={locks[group]}
    aria-label={`${locks[group] ? 'Unlock' : 'Lock'} ${group === 'colors' ? 'all colors' : `${group} style`} when shuffling`} title={`${locks[group] ? 'Unlock' : 'Lock'} ${group === 'colors' ? 'all colors' : `${group} style`} when shuffling`}
    onClick={() => { setLocks(current => ({ ...current, [group]: !current[group] })); announce(`${LABELS[group]} ${locks[group] ? 'unlocked' : 'locked'} for shuffle.`); }}>
    <CreatorIcon kind={locks[group] ? 'lock' : 'unlock'} />
  </button>;
  const cycleChoice = (key: Choice, direction: number) => {
    const choices: readonly string[] = mascotOptions[key];
    const index = (choices.indexOf(appearance[key]) + direction + choices.length) % choices.length;
    pick({ [key]: choices[index] } as Partial<MascotAppearance>, `${LABELS[key]}: ${LABELS[choices[index]]}, ${index + 1} of ${choices.length}.`);
  };
  const selectedStarter = STARTERS.find(starter => equal(starter.appearance, appearance));
  const starterIndex = selectedStarter ? STARTERS.indexOf(selectedStarter) : -1;
  const paletteIndex = PALETTES.findIndex(palette => PALETTE_COLOR_KEYS.every(key => palette.colors[key] === appearance[key]));
  const cycleStarter = (direction: number) => {
    const index = starterIndex < 0 ? (direction > 0 ? 0 : STARTERS.length - 1) : (starterIndex + direction + STARTERS.length) % STARTERS.length;
    const starter = STARTERS[index];
    commit(saved(starter.appearance), `${starter.name} applied to your draft.`);
  };
  const cyclePalette = (direction: number) => {
    const index = paletteIndex < 0 ? (direction > 0 ? 0 : PALETTES.length - 1) : (paletteIndex + direction + PALETTES.length) % PALETTES.length;
    pick(PALETTES[index].colors, `${PALETTES[index].name} colors applied.`);
  };
  const lockedGroups = LOCK_GROUPS.filter(group => locks[group]);
  const updateColor = (key: ColorKey, color: string) => {
    if (!HEX.test(color)) return;
    if (!colorBefore.current) colorBefore.current = { value: copy(valueRef.current) };
    emit(saved({ ...editableMascotAppearance(valueRef.current), [key]: color.toLowerCase() }));
  };
  const openColor = (key: ColorKey) => {
    finishColor(); setActiveColor(key);
    const input = colorInputs.current[key];
    if (!input) return;
    try { if (input.showPicker) input.showPicker(); else input.click(); }
    catch { announce(`${LABELS[key]} color controls opened.`); }
  };
  const colorPicker = (key: ColorKey) => <div className="mc-color-field">
    <input id={`${id}-color-${key}`} type="color" className="mc-color-picker" value={appearance[key]} aria-label={`${LABELS[key]} color`}
      onChange={event => updateColor(key, event.target.value)} onBlur={finishColor} />
    <label htmlFor={`${id}-color-${key}`}>{LABELS[key]}</label><HexColor key={key} value={appearance[key]} label={LABELS[key]} change={color => pick({ [key]: color }, `${LABELS[key]} color changed.`)} announce={announce} />
  </div>;

  return <section className="mascot-creator" aria-label={`${name || 'Your'} mascot creator`}>
    <div className="mc-header"><div className="mc-title"><span className="mc-avatar mc-brand" aria-hidden="true"><MascotSvg appearance={defaultMascotAppearance} /></span><h4>Mascot Creator</h4></div>
      <div className="mc-history" role="group" aria-label="Edit history">
        <button type="button" className="mc-icon-button" onClick={undo} disabled={!history.past.length && !colorBefore.current} aria-label="Undo mascot change" title="Undo"><CreatorIcon kind="undo" /></button>
        <button type="button" className="mc-icon-button" onClick={redo} disabled={!history.future.length} aria-label="Redo mascot change" title="Redo"><CreatorIcon kind="redo" /></button>
      </div>
    </div>
    <div className="mc-layout">
      <div className="mc-preview">
        <div className="mc-preview-heading"><span>YOUR MASCOT</span><span>{selectedStarter?.name ?? 'Your own kind of Nova'}</span></div>
        <div className="mc-avatar mc-main-preview" role="img" aria-label={`${name || 'Your'} mascot, ${expression} expression preview`}><MascotSvg appearance={appearance} expression={expression} /></div>
        <div className="mc-expressions" role="group" aria-label="Preview expression">
          {(['idle', 'listening', 'speaking'] as const).map(item => <button key={item} type="button" aria-pressed={expression === item} onClick={() => { setExpression(item); announce(`Previewing ${item}. Your appearance is unchanged.`); }}>{item[0].toUpperCase() + item.slice(1)}</button>)}
        </div>
        <div className="mc-context"><span className="mc-avatar mc-context-icon" aria-hidden="true"><MascotSvg appearance={appearance} expression={expression} /></span><div><strong>Still you, at every size.</strong><span>Your icon in Nova</span></div><span className="mc-avatar mc-tiny-icon" aria-hidden="true"><MascotSvg appearance={appearance} expression={expression} /></span></div>
      </div>
      <div className="mc-customizer">
        <div className="mc-customizer-heading"><h4>Make it yours</h4><button type="button" className="mc-secondary" onClick={shuffle} disabled={lockedGroups.length === LOCK_GROUPS.length}><CreatorIcon kind="shuffle" />Shuffle</button></div>
        <div className="mc-choices">{CHOICES.map(key => {
          const colors = key === 'glasses' && appearance.glasses === 'none' ? [] : ROW_COLORS[key];
          return <div key={key} className="mc-choice-block">
            <ChoiceSelector choice={key} label={LABELS[key]} value={LABELS[appearance[key]]}
              index={(mascotOptions[key] as readonly string[]).indexOf(appearance[key])} count={mascotOptions[key].length}
              previous={() => cycleChoice(key, -1)} next={() => cycleChoice(key, 1)} lock={lockButton(key)} />
            {colors.length > 0 && <div className="mc-row-colors" role="group" aria-label={`${LABELS[key]} colors`}>{colors.map(color => <span className="mc-swatch-control" key={color}>
              <button type="button" className="mc-color-swatch" aria-label={`Edit ${color === 'glassesColor' ? 'glasses frame' : color} color`} aria-expanded={activeColor === color} aria-pressed={activeColor === color}
                onClick={() => openColor(color)}><span style={{ backgroundColor: appearance[color] }} aria-hidden="true" /><span>{LABELS[color]}</span></button>
              <input type="color" className="mc-color-launcher" value={appearance[color]} tabIndex={-1} aria-hidden="true"
                ref={input => { if (input) colorInputs.current[color] = input; else delete colorInputs.current[color]; }}
                onChange={event => updateColor(color, event.target.value)} onBlur={finishColor} />
            </span>)}</div>}
            {activeColor && colors.includes(activeColor) && colorPicker(activeColor)}
          </div>;
        })}</div>
        <details className="mc-more"><summary>More options</summary><div className="mc-more-content">
          <ChoiceSelector choice="starter" label="Starter look" value={selectedStarter?.name ?? 'Custom'} index={starterIndex} count={STARTERS.length} previous={() => cycleStarter(-1)} next={() => cycleStarter(1)} />
          <ChoiceSelector choice="palette" label="Palette" value={paletteIndex < 0 ? 'Custom' : PALETTES[paletteIndex].name} index={paletteIndex} count={PALETTES.length} previous={() => cyclePalette(-1)} next={() => cyclePalette(1)} lock={lockButton('colors')} />
          <div className="mc-actions"><button type="button" className="mc-secondary" onClick={download}><CreatorIcon kind="download" />Download look</button><button type="button" className="mc-quiet" onClick={() => commit(saved(defaultMascotAppearance), 'Appearance reset. You can undo this change.')}>Reset</button><button type="button" className="mc-quiet" disabled={value === null} onClick={() => commit(null, 'Avatar cleared. Save changes to apply it.')}>Clear</button></div>
        </div></details>
        {lockedGroups.length > 0 && <p className="mc-lock-note">Kept when shuffling: {lockedGroups.map(group => group === 'colors' ? 'All colors' : `${LABELS[group]} style`).join(', ')}.</p>}
        <p className="mc-save-note">{value && resolution.status !== 'ready' ? 'Your saved avatar stays unchanged until you edit and save.' : 'Changes apply when you save.'}</p>
      </div>
    </div>
    <p className="mc-sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
  </section>;
}
