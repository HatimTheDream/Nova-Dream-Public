import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createMascotAppearance, defaultMascotAppearance, mascotOptions, resolveMascotAppearance } from '../packages/domain/mascot-appearance';
import { creatorChoices, creatorColors, creatorLabels } from '../apps/client/src/nova/square-lynx/creator-state';
import { creatorColorPosition } from '../apps/client/src/nova/square-lynx/creator-position';

const key = Symbol.for('nova.test.creator-controls'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:creator-controls-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:creator-controls-react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const f=()=>globalThis[Symbol.for('nova.test.creator-controls')];
      export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);
      export const useEffect=(fn,deps)=>f().effect(fn,deps);export const useLayoutEffect=useEffect;export const useId=()=>'creator-test';` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { SquareLynxCreator } = await import('../apps/client/src/nova/square-lynx/SquareLynxCreator');
loader.deregister();
const nodes = (value: any): any[] => Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : [];
type Appearance = Record<string, unknown> | null;
function fixture(initial: Appearance, saved: Appearance = initial) {
  let value = initial, index = 0, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [], changes: Appearance[] = [], saves: Appearance[] = [], values = new Map<string, string>();
  const environment: Record<PropertyKey, unknown> = {
    [key]: {
      state(v: any) { const i = index++;if (!(i in cells)) cells[i] = { value: typeof v === 'function' ? v() : v };return [cells[i].value, (next: any) => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; }]; },
      ref(v: any) { const i = index++;return cells[i] ??= { current: v }; },
      effect(fn: () => void | (() => void), deps: unknown[]) { const i = index++, old = cells[i];if (!old || deps.some((v, n) => v !== old.deps[n])) effects.push(() => { old?.cleanup?.();cells[i] = { deps, cleanup: fn() }; }); },
    },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    window: Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 700 }),
    document: Object.assign(new EventTarget(), { activeElement: null }),
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  const previous = Reflect.ownKeys(environment).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(environment)) Object.defineProperty(globalThis, name, { configurable: true, value: environment[name] });
  const props: Parameters<typeof SquareLynxCreator>[0] = { value, savedValue: saved, name: 'Original Name', preferenceKey: 'isolated-locks', change(next) { value = next;changes.push(next); }, onSaveLook: next => { saves.push(next); } };
  const render = () => { index = 0;tree = SquareLynxCreator({ ...props, value });for (const run of effects.splice(0)) run();return tree; };
  const find = (label: string) => { const node = nodes(tree).find(n => n.props['aria-label'] === label);assert.ok(node, label);return node; };
  return {
    props, changes, saves, render, find, get value() { return value; }, get tree() { return tree; },
    select(label: string, next: string) { find(label).props.onChange({ target: { value: next } });render(); },
    click(label: string) { find(label).props.onClick();render(); },
    close() { for (const cell of cells) cell?.cleanup?.();for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor);else Reflect.deleteProperty(globalThis, name); } },
  };
}

test('the real creator exposes every named choice and preserves the four independent style rows', () => {
  const f = fixture({ ...createMascotAppearance() });
  try {
    f.render();
    for (const key of creatorChoices) {
      const label = creatorLabels[key];
      assert.deepEqual(nodes(f.find(`${label} Style`)).filter(n => n.type === 'option').map(n => n.props.value), [...mascotOptions[key]]);
      assert.ok(f.find(`Previous ${label}`));assert.ok(f.find(`Next ${label}`));
      for (const option of mascotOptions[key]) {
        f.select(`${label} Style`, option);
        assert.equal(f.find(`${label} Style`).props.value, option);
        assert.equal(resolveMascotAppearance(f.value).status, 'ready');
      }
    }
    assert.equal(f.saves.length, 0, 'Selecting never saves the parent record');
    const before = f.value;f.select('Face Style', 'not-a-catalog-entry');assert.equal(f.value, before);
  } finally { f.close(); }
});

test('opening, previewing and changing Shuffle locks never migrates an unsupported saved recipe', () => {
  const original = { catalogRevision: 'future-catalog', appearance: { future: 'Keep every byte' } };
  const f = fixture(original);
  try {
    f.render();f.select('Preview Expression', 'speaking');
    nodes(f.tree).find(n => n.type === 'button' && n.props.children === 'Saved')!.props.onClick();f.render();
    f.click('Lock Face Style For Shuffle');
    assert.equal(f.value, original);assert.equal(f.changes.length, 0);assert.equal(f.saves.length, 0);
    f.select('Face Style', 'adventurous');assert.equal(resolveMascotAppearance(f.value).status, 'ready');
    f.click('Undo Appearance Change');assert.deepEqual(f.value, original);
    f.click('Redo Appearance Change');assert.equal(f.find('Face Style').props.value, 'adventurous');
  } finally { f.close(); }
});

test('ten Shuffle locks remain independent and explicit style choices still work while locked', () => {
  const f = fixture({ ...createMascotAppearance({ ...defaultMascotAppearance, glasses: 'round', glassesColor: '#123456' }) });
  try {
    f.render();
    for (const key of creatorChoices) f.click(`Lock ${creatorLabels[key]} Style For Shuffle`);
    for (const key of creatorColors) f.click(`Lock ${creatorLabels[key]} Color For Shuffle`);
    assert.equal(f.find('Shuffle Appearance').props.disabled, true);
    f.select('Face Style', 'adventurous');assert.equal(f.find('Face Style').props.value, 'adventurous');
    f.select('Glasses Style', 'none');assert.equal(nodes(f.tree).some(n => n.props['aria-label'] === 'Frame Color'), false);
    f.select('Glasses Style', 'round');
    assert.equal(f.find('Frame Color').props.children[0].props.style.backgroundColor, '#123456');
    assert.equal(f.find('Unlock Frame Color For Shuffle').props['aria-pressed'], true);
  } finally { f.close(); }
});

test('Saved preview and Save Look use different exact recipes without replacing creator controls', async () => {
  const saved = { ...createMascotAppearance() }, edited = { ...createMascotAppearance({ ...defaultMascotAppearance, face: 'adventurous' }) };
  const f = fixture(edited, saved);
  try {
    f.render();nodes(f.tree).find(n => n.type === 'button' && n.props.children === 'Saved')!.props.onClick();f.render();
    assert.equal(nodes(f.tree).find(n => n.type?.name === 'MascotSvg')!.props.appearance.face, defaultMascotAppearance.face);
    const save = nodes(f.tree).find(n => n.type === 'button' && n.props.children === 'Save Look')!;
    await save.props.onClick();f.render();assert.deepEqual(f.saves, [edited]);assert.ok(f.find('Face Style'));
    assert.equal(f.value, edited);assert.equal(f.changes.length, 0);
    f.props.saveDisabled = true;f.render();
    assert.equal(nodes(f.tree).find(n => n.type === 'button' && n.props.children === 'Save Look')!.props.disabled, true);
  } finally { f.close(); }
});

test('color popup fits the visible editor at desktop, phone, short and zoomed viewport bounds', () => {
  for (const [viewport, editor, target, popup] of [
    [{ left: 0, top: 0, right: 1920, bottom: 1080 }, { left: 700, top: 200, right: 1232, bottom: 800 }, { left: 1200, bottom: 750 }, { width: 216, height: 280 }],
    [{ left: 0, top: 0, right: 320, bottom: 640 }, { left: 12, top: 72, right: 308, bottom: 570 }, { left: 290, bottom: 540 }, { width: 304, height: 390 }],
    [{ left: 0, top: 0, right: 640, bottom: 300 }, { left: 20, top: 60, right: 620, bottom: 240 }, { left: 500, bottom: 210 }, { width: 304, height: 390 }],
    [{ left: 100, top: 200, right: 420, bottom: 500 }, { left: 20, top: 70, right: 600, bottom: 700 }, { left: 90, bottom: 300 }, { width: 304, height: 390 }],
  ] as const) {
    const position = creatorColorPosition(target, popup, viewport, editor)!;
    assert.ok(position.left >= Math.max(viewport.left, editor.left) + 4);
    assert.ok(position.top >= Math.max(viewport.top, editor.top) + 4);
    assert.ok(position.left + Math.min(popup.width, position.maxWidth) <= Math.min(viewport.right, editor.right) - 4);
    assert.ok(position.top + Math.min(popup.height, position.maxHeight) <= Math.min(viewport.bottom, editor.bottom) - 4);
  }
  assert.equal(creatorColorPosition({ left: 0, bottom: 50 }, { width: 304, height: 390 }, { left: 0, right: 320, top: 0, bottom: 300 }, { left: 0, right: 300, top: 400, bottom: 600 }), undefined);
});
