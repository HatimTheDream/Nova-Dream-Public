import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ModuleId } from '../packages/domain/contracts';

const key = Symbol.for('nova.test.bottom-navigation');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.endsWith('/BottomNavigation.tsx')) return { url: 'nova-test:bottom-navigation', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:bottom-navigation') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = initial => globalThis[Symbol.for('nova.test.bottom-navigation')].state(initial);
      export const useRef = initial => globalThis[Symbol.for('nova.test.bottom-navigation')].ref(initial);
      export const useEffect = (run, deps) => globalThis[Symbol.for('nova.test.bottom-navigation')].effect(run, deps);` };
    return next(url, context);
  },
});
const { BottomNavigation } = await import('../apps/client/src/BottomNavigation');
hooks.deregister();

const nodes = (node: any): any[] => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const icon = () => null;
const order: ModuleId[] = ['inbox', 'home', 'tasks', 'assistant', 'calendar', 'contacts', 'agents', 'content', 'profile'];

function host(route: ModuleId | 'settings' = 'home', initialWidth = 390, direction = 'ltr', reducedMotion = false, server = false) {
  let width = initialWidth, allow = true, wideFocus = 0, dirty = true, cursor = 0, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [], observed = new Set<() => void>();
  const listeners = new Map<string, Set<() => void>>();
  const opened: (ModuleId | 'settings')[] = [], scrolls: { left: number; behavior: string }[] = [];
  const doc = { activeElement: null as ButtonFixture | null };
  class ButtonFixture {
    constructor(readonly label: string, public index: number, public props: any) {}
    closest() { return this; }
    getBoundingClientRect() {
      const left = direction === 'rtl' ? 14 + strip.clientWidth - this.index * 52 - 44 - strip.scrollLeft : 14 + this.index * 52 - strip.scrollLeft;
      return { left, right: left + 44, width: 44 };
    }
    focus() { doc.activeElement = this; stripTree().props.onFocusCapture({ currentTarget: strip, target: this }); }
  }
  const buttons = new Map<string, ButtonFixture>(), captures = new Set<number>(), classes = new Set<string>();
  let left = 0;
  const strip = {
    get clientWidth() { return width > 800 ? 0 : width - 28; },
    get scrollWidth() { return buttons.size * 52 - 8; },
    get scrollLeft() { return left; },
    set scrollLeft(value: number) { const max = Math.max(0, this.scrollWidth - this.clientWidth); left = direction === 'rtl' ? Math.max(-max, Math.min(0, value)) : Math.max(0, Math.min(max, value)); },
    getBoundingClientRect() { return { left: 14, right: 14 + this.clientWidth }; },
    scrollBy(options: { left: number; behavior: string }) { scrolls.push(options); this.scrollLeft += options.left; },
    querySelector() { return [...buttons.values()].find(button => button.props['aria-current'] === 'page') ?? null; },
    querySelectorAll() { return [...buttons.values()]; },
    contains(element: ButtonFixture | null) { return !!element && buttons.get(element.label) === element; },
    hasPointerCapture: (pointer: number) => captures.has(pointer),
    setPointerCapture: (pointer: number) => captures.add(pointer),
    releasePointerCapture: (pointer: number) => captures.delete(pointer),
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) },
  };
  const props = { items: order.map(id => ({ id, label: id, icon })), route, updateAvailable: true,
    open: (next: ModuleId | 'settings') => { opened.push(next); if (allow) { props.route = next; dirty = true; } return allow; },
    returnToWideNavigation: () => { wideFocus++; doc.activeElement = null; },
  };
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(initial: any) { const index = cursor++; const cell = cells[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cell.value, (next: any) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; } }]; },
      ref(initial: any) { return cells[cursor++] ??= { current: initial }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const index = cursor++, prior = cells[index]; if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) { cells[index] = { deps, cleanup: prior?.cleanup }; if (!server) effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    window: server ? undefined : {
      matchMedia: (query: string) => ({ matches: query.includes('reduced-motion') ? reducedMotion : width <= 800 }),
      addEventListener: (name: string, callback: () => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); },
      removeEventListener: (name: string, callback: () => void) => listeners.get(name)?.delete(callback),
    },
    ResizeObserver: class { constructor(readonly callback: () => void) {} observe() { observed.add(this.callback); } disconnect() { observed.delete(this.callback); } },
    document: doc, Element: ButtonFixture, getComputedStyle: () => ({ direction }),
  };
  const originals = Reflect.ownKeys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  function stripTree() { return nodes(tree).find(node => node.props?.className === 'bottom-navigation-strip'); }
  function flush() {
    while (dirty) {
      dirty = false; cursor = 0; tree = BottomNavigation(props);
      stripTree().props.ref.current = strip;
      nodes(tree).filter(node => node.type === 'button').forEach((node, index) => {
        const label = node.props['aria-label'];
        const button = buttons.get(label) ?? new ButtonFixture(label, index, node.props);
        button.props = node.props; button.index = index; buttons.set(label, button);
      });
      while (effects.length) effects.shift()!();
    }
  }
  const pointer = (type: string, x: number, y = 0, pointerType = 'mouse', pointerId = 1) => {
    let prevented = false;
    const handlers: Record<string, string> = { pointerdown: 'onPointerDown', pointermove: 'onPointerMove', pointerup: 'onPointerUp', pointercancel: 'onPointerCancel', lostpointercapture: 'onLostPointerCapture' };
    stripTree().props[handlers[type]]({ type, currentTarget: strip, pointerType, pointerId, isPrimary: true, button: 0, clientX: x, clientY: y, preventDefault() { prevented = true; } });
    flush(); return prevented;
  };
  flush();
  return {
    props, opened, scrolls, strip, captures, classes, doc, buttons,
    get tree() { return tree; }, get wideFocus() { return wideFocus; }, get subscriptions() { return observed.size + [...listeners.values()].reduce((count, set) => count + set.size, 0); },
    setAllowed(value: boolean) { allow = value; },
    click(label: string, detail = 1) { let stopped = false; stripTree().props.onClickCapture({ detail, preventDefault() {}, stopPropagation() { stopped = true; } }); if (!stopped) buttons.get(label)!.props.onClick(); flush(); return !stopped; },
    pointer,
    key(label: string, key: string) { let prevented = false; stripTree().props.onKeyDown({ key, target: buttons.get(label), currentTarget: strip, preventDefault() { prevented = true; } }); flush(); return prevented; },
    focus(label: string) { buttons.get(label)!.focus(); flush(); },
    route(next: ModuleId | 'settings') { props.route = next; dirty = true; flush(); },
    rerender() { props.items = [...props.items]; dirty = true; flush(); },
    resize(next: number) { width = next; strip.scrollLeft = strip.scrollLeft; for (const callback of observed) callback(); for (const callback of listeners.get('resize') ?? []) callback(); flush(); },
    blur() { for (const callback of listeners.get('blur') ?? []) callback(); flush(); },
    scroll(value: number) { strip.scrollLeft = value; stripTree().props.onScroll(); flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); },
  };
}

test('every saved destination and Settings is reachable in order at 320 px, with no overflow menu', () => {
  const h = host('home', 320), before = [...h.props.items];
  try {
    assert.deepEqual([...h.buttons.keys()], [...order, 'Settings']);
    for (const id of order) h.click(id);
    h.click('Settings');
    assert.deepEqual(h.opened, [...order, 'settings']);
    assert.deepEqual(h.props.items, before);
    assert.equal(h.buttons.get('Settings')!.props['aria-current'], 'page');
    assert.equal(h.buttons.get('Settings')!.props['aria-description'], 'Software update available');
  } finally { h.close(); }
});

test('a rejected navigation preserves the selected route until the existing draft guard allows leaving', () => {
  const h = host('assistant');
  try {
    h.setAllowed(false); h.click('calendar');
    assert.equal(h.buttons.get('assistant')!.props['aria-current'], 'page');
    assert.equal(h.buttons.get('calendar')!.props['aria-current'], undefined);
    h.setAllowed(true); h.click('calendar');
    assert.equal(h.buttons.get('calendar')!.props['aria-current'], 'page');
    assert.deepEqual(h.opened, ['calendar', 'calendar']);
  } finally { h.close(); }
});

test('a horizontal mouse drag scrolls, snaps and suppresses its release click without changing modules', () => {
  const h = host();
  try {
    h.pointer('pointerdown', 250);
    assert.equal(h.pointer('pointermove', 150), true);
    assert.equal(h.strip.scrollLeft, 100);
    assert.equal(h.captures.has(1), true);
    h.pointer('pointerup', 150);
    assert.equal(h.strip.scrollLeft, 104);
    assert.equal(h.captures.size, 0);
    assert.equal(h.classes.has('dragging'), false);
    assert.equal(h.click('calendar'), false);
    assert.deepEqual(h.opened, []);
    h.pointer('pointerdown', 200); h.pointer('pointerup', 200);
    assert.equal(h.click('calendar'), true);
    assert.deepEqual(h.opened, ['calendar']);
  } finally { h.close(); }
});

test('small mouse movement remains a click; vertical movement and touch retain native behavior', () => {
  const h = host();
  try {
    h.pointer('pointerdown', 250); assert.equal(h.pointer('pointermove', 244), false); h.pointer('pointerup', 244);
    assert.equal(h.click('tasks'), true);
    const left = h.strip.scrollLeft;
    h.pointer('pointerdown', 250); assert.equal(h.pointer('pointermove', 240, 60), false); h.pointer('pointercancel', 240, 60);
    h.pointer('pointerdown', 250, 0, 'touch'); assert.equal(h.pointer('pointermove', 120, 0, 'touch'), false); h.pointer('pointerup', 120, 0, 'touch');
    assert.equal(h.strip.scrollLeft, left);
    assert.equal(h.captures.size, 0);
  } finally { h.close(); }
});

test('pointer cancellation or window blur releases a drag; keyboard activation is never swallowed', () => {
  for (const end of ['pointercancel', 'lostpointercapture', 'blur']) {
    const h = host();
    try {
      h.pointer('pointerdown', 250); h.pointer('pointermove', 150);
      if (end === 'blur') h.blur(); else h.pointer(end, 150);
      assert.equal(h.captures.size, 0);
      assert.equal(h.classes.has('dragging'), false);
      assert.equal(h.click('tasks', 0), true);
      assert.deepEqual(h.opened, ['tasks']);
    } finally { h.close(); }
  }
});

test('keyboard navigation reveals buttons, respects the finite ends, and waits for activation', () => {
  const h = host();
  try {
    h.focus('home');
    assert.equal(h.key('home', 'End'), true);
    assert.equal(h.doc.activeElement, h.buttons.get('Settings'));
    assert.equal(h.strip.scrollLeft, h.strip.scrollWidth - h.strip.clientWidth);
    h.key('Settings', 'ArrowRight');
    assert.equal(h.doc.activeElement, h.buttons.get('Settings'));
    h.key('Settings', 'Home');
    assert.equal(h.doc.activeElement, h.buttons.get('inbox'));
    assert.equal(h.strip.scrollLeft, 0);
    assert.equal(h.key('inbox', 'Tab'), false);
    assert.deepEqual(h.opened, []);
    h.focus('profile'); // Tab focus uses the same nearest-item visibility path.
    const bounds = h.buttons.get('profile')!.getBoundingClientRect();
    assert.ok(bounds.right <= h.strip.getBoundingClientRect().right);
  } finally { h.close(); }
});

test('RTL arrows follow visual direction; revealing and dragging reach the final module without wrapping', () => {
  const h = host('home', 320, 'rtl');
  try {
    h.focus('home'); h.key('home', 'ArrowLeft');
    assert.equal(h.doc.activeElement, h.buttons.get('tasks'));
    h.key('tasks', 'ArrowRight');
    assert.equal(h.doc.activeElement, h.buttons.get('home'));
    h.key('home', 'End');
    assert.equal(h.strip.scrollLeft, -(h.strip.scrollWidth - h.strip.clientWidth));
    h.key('Settings', 'Home');
    assert.equal(h.strip.scrollLeft, 0);
    h.pointer('pointerdown', 100); h.pointer('pointermove', 200); h.pointer('pointerup', 200);
    assert.equal(h.strip.scrollLeft, -104);
    assert.equal(h.click('calendar'), false);
    assert.deepEqual(h.opened, []);
  } finally { h.close(); }
});

test('selected modules remain visible on entry, route changes and resize; polling does not reset a browsed strip', () => {
  const h = host('settings', 320);
  try {
    assert.equal(h.strip.scrollLeft, h.strip.scrollWidth - h.strip.clientWidth);
    h.route('inbox'); assert.equal(h.strip.scrollLeft, 0);
    h.scroll(100); h.rerender();
    assert.equal(h.strip.scrollLeft, 100);
    h.route('settings'); h.resize(390);
    assert.equal(h.strip.scrollLeft, h.strip.scrollWidth - h.strip.clientWidth);
    h.focus('Settings'); h.resize(900);
    assert.equal(h.wideFocus, 1);
    h.resize(320);
    assert.equal(h.strip.scrollLeft, h.strip.scrollWidth - h.strip.clientWidth);
    assert.deepEqual(h.opened, []);
  } finally { h.close(); }
});

test('reduced motion uses immediate reveal and snap; no overflowing destinations hides the progress cue', () => {
  const h = host('home', 600, 'ltr', true);
  try {
    const progress = () => nodes(h.tree).find(node => node.props?.className === 'bottom-navigation-progress');
    assert.equal(progress().props.hidden, true);
    h.resize(320); h.focus('Settings');
    assert.equal(progress().props.hidden, false);
    h.pointer('pointerdown', 100); h.pointer('pointermove', 200); h.pointer('pointerup', 200);
    assert.ok(h.scrolls.length > 0);
    assert.ok(h.scrolls.every(item => item.behavior === 'auto'));
  } finally { h.close(); }
});

test('unmount releases drag capture and resize listeners; server render does not access browser APIs', () => {
  const h = host();
  h.pointer('pointerdown', 250); h.pointer('pointermove', 150);
  assert.equal(h.subscriptions, 3);
  h.close();
  assert.equal(h.subscriptions, 0);
  assert.equal(h.captures.size, 0);
  const ssr = host('settings', 320, 'ltr', false, true);
  try { assert.equal(ssr.buttons.get('Settings')!.props['aria-current'], 'page'); assert.equal(ssr.subscriptions, 0); }
  finally { ssr.close(); }
});
