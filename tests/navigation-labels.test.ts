import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';

const key = Symbol.for('nova.test.navigation-labels');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/NavigationLabels.tsx')) {
      if (specifier === 'react') return { url: 'nova-test:navigation-labels', shortCircuit: true };
      if (specifier === 'react-dom') return { url: 'nova-test:navigation-labels-portal', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:navigation-labels-portal') return { format: 'module', shortCircuit: true, source: 'export const createPortal = child => child;' };
    if (url === 'nova-test:navigation-labels') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = initial => globalThis[Symbol.for('nova.test.navigation-labels')].state(initial);
      export const useRef = initial => globalThis[Symbol.for('nova.test.navigation-labels')].ref(initial);
      export const useEffect = (run,deps) => globalThis[Symbol.for('nova.test.navigation-labels')].effect(run,deps);
      export const useLayoutEffect = useEffect;` };
    return next(url, context);
  },
});
const { NavigationLabels } = await import('../apps/client/src/NavigationLabels');
hooks.deregister();

function host() {
  let cursor = 0, dirty = true, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [];
  const listeners = new Map<string, Set<(event?: any) => void>>();
  class Button {
    left = 700; top = 900; visible = true;
    dataset = { navigationLabel: 'Settings · update available' };
    closest(selector: string) { return selector.startsWith('button') ? this : null; }
    contains(element: unknown) { return element === this; }
    getClientRects() { return this.visible ? [{}] : []; }
    getBoundingClientRect() { return { left: this.left, right: this.left + 44, top: this.top, bottom: this.top + 44, width: 44, height: 44 }; }
  }
  const button = new Button(), doc = { activeElement: null as Button | null, body: {} };
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(initial: any) { const index = cursor++; const cell = cells[index] ??= { value: initial }; return [cell.value, (next: any) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; } }]; },
      ref(initial: any) { return cells[cursor++] ??= { current: initial }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const index = cursor++, prior = cells[index]; if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) { cells[index] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    window: {
      innerWidth: 1000, innerHeight: 1000,
      addEventListener(name: string, callback: (event?: any) => void) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); },
      removeEventListener(name: string, callback: (event?: any) => void) { listeners.get(name)?.delete(callback); },
    },
    document: doc, Element: Button, Node: Button,
  };
  const originals = Reflect.ownKeys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  const label = () => tree.props.children[1];
  const flush = () => {
    while (dirty) {
      dirty = false; cursor = 0; tree = NavigationLabels({ children: createElement('nav') });
      if (label()) label().props.ref.current = {
        getBoundingClientRect: () => ({ left: label().props.style.left - 50, right: label().props.style.left + 50, top: label().props.style.top - 30, bottom: label().props.style.top }),
      };
      while (effects.length) effects.shift()!();
    }
  };
  flush();
  return {
    button, doc, label,
    focus() { doc.activeElement = button; tree.props.children[0].props.onFocusCapture({ target: button }); flush(); },
    hover() { tree.props.children[0].props.onPointerOver({ target: button, pointerType: 'mouse' }); flush(); },
    emit(name: string, event?: any) { for (const callback of [...(listeners.get(name) ?? [])]) callback(event); flush(); },
    get listeners() { return [...listeners.values()].reduce((count, set) => count + set.size, 0); },
    close() { for (const cell of cells) cell?.cleanup?.(); for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); },
  };
}

test('a focused destination keeps its label attached while the dock reveals it by scrolling', () => {
  const h = host();
  try {
    h.focus();
    assert.equal(h.label().props.children, 'Settings · update available');
    assert.equal(h.label().props.style.left, 722);
    h.button.left = 300; h.emit('scroll');
    assert.equal(h.label().props.children, 'Settings · update available');
    assert.equal(h.label().props.style.left, 322);
    h.button.left = 200; h.emit('resize');
    assert.equal(h.label().props.style.left, 222);
  } finally { h.close(); }
});

test('scrolling dismisses hover labels and a resize hides a focused label whose dock is no longer visible', () => {
  const h = host();
  try {
    h.hover(); assert.ok(h.label());
    h.emit('scroll'); assert.equal(h.label(), null);
    h.focus(); assert.ok(h.label());
    h.button.visible = false; h.emit('resize');
    assert.equal(h.label(), null);
  } finally { h.close(); }
});

test('Escape dismisses the keyboard label and later scrolls do not resurrect it', () => {
  const h = host();
  try {
    h.focus(); assert.equal(h.listeners, 3);
    h.emit('keydown', { key: 'Escape' });
    assert.equal(h.label(), null);
    h.emit('scroll'); assert.equal(h.label(), null);
    assert.equal(h.listeners, 0);
  } finally { h.close(); }
});
