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
    if (url === 'nova-test:bottom-navigation') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)}; export const useState = initial => globalThis[Symbol.for('nova.test.bottom-navigation')].state(initial); export const useSyncExternalStore = (...args) => globalThis[Symbol.for('nova.test.bottom-navigation')].externalStore(...args);` };
    return next(url, context);
  },
});
const { BottomNavigation } = await import('../apps/client/src/BottomNavigation');
hooks.deregister();

const nodes = (node: any): any[] => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const button = (tree: any, label: string) => { const found = nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || (label === 'More' && node.props['aria-label']?.startsWith('More sections')))); assert.ok(found, `${label} is available`); return found; };
const dialog = (tree: any) => nodes(tree).find(node => node.props?.title === 'More sections' && node.type !== 'button');
const icon = () => null;
const order: ModuleId[] = ['inbox', 'home', 'tasks', 'assistant', 'calendar', 'contacts', 'agents', 'content', 'profile'];

function host(route: ModuleId | 'settings' = 'home', initialWidth = 600, server = false) {
  let shown = false, width = initialWidth, allow = true, wideFocus = 0;
  let unsubscribe: (() => void) | undefined, mediaValue = false;
  const mediaListeners = new Map<string, Set<() => void>>();
  const matches = (query: string) => width <= Number(query.match(/max-width: (\d+)px/)?.[1]);
  const opened: (ModuleId | 'settings')[] = [];
  const props = { items: order.map(id => ({ id, label: id, icon })), route, updateAvailable: true,
    open: (next: ModuleId | 'settings') => { opened.push(next); return allow; },
    returnToWideNavigation: () => { wideFocus++; },
  };
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state: () => [shown, (value: boolean) => { shown = value; }],
      externalStore: (subscribe: (notify: () => void) => () => void, snapshot: () => boolean, serverSnapshot: () => boolean) => {
        if (server) return serverSnapshot();
        if (!unsubscribe) { mediaValue = snapshot(); unsubscribe = subscribe(() => { mediaValue = snapshot(); }); }
        return mediaValue;
      },
    },
    window: server ? undefined : { matchMedia: (query: string) => ({
      get matches() { return matches(query); },
      addEventListener: (_event: string, listener: () => void) => { const listeners = mediaListeners.get(query) ?? new Set(); listeners.add(listener); mediaListeners.set(query, listeners); },
      removeEventListener: (_event: string, listener: () => void) => { mediaListeners.get(query)?.delete(listener); },
    }) },
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
  };
  const original = Reflect.ownKeys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  return {
    props, opened, render: () => BottomNavigation(props), setAllowed: (value: boolean) => { allow = value; }, get wideFocus() { return wideFocus; },
    setWidth: (value: number) => {
      const previous = new Map([...mediaListeners.keys()].map(query => [query, matches(query)]));
      width = value;
      for (const [query, listeners] of mediaListeners) if (matches(query) !== previous.get(query)) for (const listener of listeners) listener();
    },
    get subscriptions() { return [...mediaListeners.values()].reduce((count, listeners) => count + listeners.size, 0); },
    unmount: () => { unsubscribe?.(); unsubscribe = undefined; },
    close: () => { unsubscribe?.(); for (const [name, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); },
  };
}

test('saved custom order reaches every destination without changing that order', () => {
  const h = host(), before = [...h.props.items];
  try {
    for (const id of order.slice(0, 4)) button(h.render(), id).props.onClick();
    for (const id of order.slice(4)) { button(h.render(), 'More').props.onClick(); button(h.render(), id).props.onClick(); }
    button(h.render(), 'More').props.onClick(); button(h.render(), 'Settings').props.onClick();
    assert.deepEqual(h.opened, [...order, 'settings']);
    assert.deepEqual(h.props.items, before);
  } finally { h.close(); }
});

test('a rejected navigation keeps More open until the existing route guard allows leaving', () => {
  const h = host('assistant');
  try {
    button(h.render(), 'More').props.onClick(); h.setAllowed(false);
    button(h.render(), 'calendar').props.onClick();
    assert.ok(dialog(h.render()));
    assert.equal(button(h.render(), 'assistant').props['aria-current'], 'page');
    h.setAllowed(true); button(h.render(), 'calendar').props.onClick();
    assert.equal(dialog(h.render()), undefined);
    assert.deepEqual(h.opened, ['calendar', 'calendar']);
  } finally { h.close(); }
});

test('a destination under More keeps its current-page identity and Settings update information', () => {
  const h = host('settings');
  try {
    assert.match(button(h.render(), 'More').props['aria-label'], /Current page: Settings/);
    button(h.render(), 'More').props.onClick();
    const settings = button(h.render(), 'Settings');
    assert.equal(settings.props['aria-current'], 'page');
    assert.equal(settings.props['aria-description'], 'Software update available');
  } finally { h.close(); }
});

test('closing More after widening delegates focus to visible desktop navigation', () => {
  const h = host();
  try {
    button(h.render(), 'More').props.onClick();
    dialog(h.render()).props.close();
    assert.equal(h.wideFocus, 0);
    button(h.render(), 'More').props.onClick(); h.setWidth(900);
    dialog(h.render()).props.close();
    assert.equal(h.wideFocus, 1);
    assert.equal(dialog(h.render()), undefined);
    assert.deepEqual(h.opened, []);
  } finally { h.close(); }
});

test('at 400 px and below, three saved destinations stay primary and every other section is reachable in More', () => {
  const h = host('assistant', 320), before = [...h.props.items];
  try {
    assert.equal(nodes(h.render()).find(node => node.type === 'button' && node.props['aria-label'] === 'assistant'), undefined);
    assert.match(button(h.render(), 'More').props['aria-label'], /Current page: assistant/);
    for (const id of order.slice(0, 3)) button(h.render(), id).props.onClick();
    for (const id of order.slice(3)) { button(h.render(), 'More').props.onClick(); button(h.render(), id).props.onClick(); }
    assert.deepEqual(h.opened, order);
    assert.deepEqual(h.props.items, before);
  } finally { h.close(); }
});

test('resizing across 400 px keeps More open, moves the fourth destination and removes its listener on unmount', () => {
  const h = host('assistant', 401), before = [...h.props.items];
  try {
    assert.equal(button(h.render(), 'assistant').props['aria-current'], 'page');
    button(h.render(), 'More').props.onClick();
    assert.equal(nodes(dialog(h.render())).find(node => node.type === 'button' && node.props['aria-label'] === 'assistant'), undefined);
    h.setWidth(400);
    assert.ok(dialog(h.render()));
    assert.equal(button(dialog(h.render()), 'assistant').props['aria-current'], 'page');
    assert.match(button(h.render(), 'More').props['aria-label'], /Current page: assistant/);
    h.setWidth(401);
    assert.ok(dialog(h.render()));
    assert.equal(nodes(dialog(h.render())).find(node => node.type === 'button' && node.props['aria-label'] === 'assistant'), undefined);
    assert.equal(button(h.render(), 'More').props['aria-label'], 'More sections');
    assert.deepEqual(h.props.items, before);
    assert.deepEqual(h.opened, []);
    assert.equal(h.subscriptions, 1);
    h.unmount();
    assert.equal(h.subscriptions, 0);
  } finally { h.close(); }
});

test('server rendering has a stable primary group without accessing browser media queries', () => {
  const h = host('assistant', 320, true);
  try {
    assert.equal(button(h.render(), 'assistant').props['aria-current'], 'page');
    assert.equal(h.subscriptions, 0);
  } finally { h.close(); }
});
