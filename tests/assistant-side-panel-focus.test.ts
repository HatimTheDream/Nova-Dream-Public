import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const hookKey = Symbol.for('nova.test.workspace-focus');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && ['/AssistantSidePanel.tsx', '/AssistantOrganizationRailFrame.tsx'].some(name => context.parentURL?.endsWith(name))) return { url: 'nova-test:workspace-focus', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url === 'nova-test:workspace-focus') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = value => globalThis[Symbol.for('nova.test.workspace-focus')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.workspace-focus')].ref(value);
      export const useLayoutEffect = (run,deps) => globalThis[Symbol.for('nova.test.workspace-focus')].effect(run,deps,true);
      export const useEffect = (run,deps) => globalThis[Symbol.for('nova.test.workspace-focus')].effect(run,deps);` };
    return next(url, context);
  },
});
const { AssistantSidePanel } = await import('../apps/client/src/AssistantSidePanel');
const { AssistantOrganizationRailFrame } = await import('../apps/client/src/dreamclaw/components/Chat/AssistantOrganizationRailFrame');
loader.deregister();

function workspace() {
  const doc = { activeElement: null as ElementFixture | null, body: null as ElementFixture | null };
  class ElementFixture {
    children: ElementFixture[] = [];
    parentElement: ElementFixture | null = null;
    hidden = false;
    isConnected = true;
    private inactive = false;
    constructor(readonly name: string, parent?: ElementFixture) { if (parent) { this.parentElement = parent; parent.children.push(this); } }
    get inert() { return this.inactive; }
    set inert(value: boolean) {
      this.inactive = value;
      // Becoming inert removes focus from a descendant, as the browser does.
      if (value && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    }
    contains(element: ElementFixture | null): boolean { return !!element && (element === this || this.children.some(child => child.contains(element))); }
    getClientRects(): unknown[] { return this.hidden || this.parentElement && !this.parentElement.getClientRects().length ? [] : [{}]; }
    closest(selector: string): ElementFixture | null {
      if (selector === '[inert]') return this.inert ? this : this.parentElement?.closest(selector) ?? null;
      return null;
    }
    focus() { if (this.getClientRects().length && !this.closest('[inert]')) doc.activeElement = this; }
    querySelector(_selector: string): ElementFixture | null { return null; }
    querySelectorAll(_selector: string): ElementFixture[] { return []; }
  }
  class DetailsFixture extends ElementFixture { open = false; }
  const body = new ElementFixture('body'); doc.body = body;
  const shell = new ElementFixture('shell', body);
  const navigation = new ElementFixture('navigation', shell);
  const opener = new ElementFixture('open workspace', navigation);
  const sidebarOpener = new ElementFixture('show sidebar', navigation);
  const fallback = new ElementFixture('conversation menu', navigation);
  const main = new ElementFixture('main', shell);
  const writing = new ElementFixture('writing', main);
  const composer = new ElementFixture('composer', writing);
  const panel = new ElementFixture('workspace', main);
  const selected = new ElementFixture('selected tab', panel);
  const editor = new ElementFixture('workspace input', panel);
  const hide = new ElementFixture('hide workspace', panel);
  const alreadyInert = new ElementFixture('already inactive', shell); alreadyInert.inert = true;
  panel.querySelector = selector => selector === '[role="tab"][aria-selected="true"]' ? selected : null;
  panel.querySelectorAll = () => [selected, editor, hide];
  opener.focus();

  let cursor = 0, dirty = true, tree: any, closeCount = 0;
  const cells: any[] = [], effects: (() => void)[] = [], layouts: (() => void)[] = [], frames: (() => void)[] = [];
  let sidebarFocusPending = false;
  const changes = new Set<() => void>();
  const media = { matches: false, addEventListener: (_name: string, change: () => void) => changes.add(change), removeEventListener: (_name: string, change: () => void) => changes.delete(change) };
  let props = { tabs: [{ id: 'tab', view: { kind: 'home' as const } }], active: 'tab', visible: true, expanded: false, select() {}, closeTab() {}, addTab() {}, expand() {}, close() { closeCount++; props = { ...props, visible: false }; dirty = true; }, fallbackFocus: () => fallback as unknown as HTMLElement, children: null };
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(value: any) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof value === 'function' ? value() : value }; return [cells[index].value, (next: any) => { cells[index].value = typeof next === 'function' ? next(cells[index].value) : next; dirty = true; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[], layout = false) { const index = cursor++, old = cells[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) { cells[index] = { deps, cleanup: old?.cleanup }; (layout ? layouts : effects).push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    document: doc, HTMLElement: ElementFixture, HTMLDetailsElement: DetailsFixture,
    matchMedia: () => media, getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = () => {
    while (dirty || frames.length) {
      if (dirty) {
        dirty = false; cursor = 0; tree = AssistantSidePanel(props);
        tree.props.ref.current = panel; panel.hidden = tree.props.hidden;
        while (layouts.length) layouts.shift()!();
        // The organization rail closes at this breakpoint and tries to restore
        // its own opener in a passive effect, before workspace passive effects.
        if (sidebarFocusPending) { sidebarFocusPending = false; sidebarOpener.focus(); }
        while (effects.length) effects.shift()!();
      }
      while (frames.length) frames.shift()!();
    }
  };
  return {
    doc, composer, opener, fallback, selected, editor, hide, navigation, writing, alreadyInert,
    get tree() { return tree; }, get closeCount() { return closeCount; },
    flush,
    resize(narrow: boolean, sidebarCloses = false) { media.matches = narrow; sidebarFocusPending = sidebarCloses; for (const change of changes) change(); flush(); },
    expand() { props = { ...props, expanded: true }; dirty = true; flush(); },
    key(key: string, shiftKey = false) {
      let prevented = false;
      // Keyboard events reach the aside only when focus is inside its DOM branch.
      if (panel.contains(doc.activeElement)) tree.props.onKeyDown({ key, shiftKey, target: doc.activeElement, defaultPrevented: false, preventDefault() { prevented = true; } });
      flush(); return prevented;
    },
    close() {
      for (const cell of cells) cell?.cleanup?.();
      while (frames.length) frames.shift()!();
      for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('resizing a docked workspace moves composer focus into the modal, contains Tab, and restores focus after Escape', () => {
  const h = workspace();
  try {
    h.flush(); h.composer.focus();
    assert.equal(h.tree.props.role, undefined);
    h.resize(true);
    assert.equal(h.tree.props.role, 'dialog');
    assert.equal(h.doc.activeElement, h.selected);
    assert.equal(h.writing.inert, true); assert.equal(h.navigation.inert, true);
    assert.equal(h.key('Tab', true), true); assert.equal(h.doc.activeElement, h.hide);
    assert.equal(h.key('Tab'), true); assert.equal(h.doc.activeElement, h.selected);
    assert.equal(h.key('Escape'), true); assert.equal(h.closeCount, 1);
    assert.equal(h.writing.inert, false); assert.equal(h.navigation.inert, false);
    assert.equal(h.alreadyInert.inert, true);
    assert.equal(h.doc.activeElement, h.composer);
  } finally { h.close(); }
});

test('crossing the breakpoint preserves focus already inside the workspace and its original return target', () => {
  const h = workspace();
  try {
    h.flush(); h.editor.focus(); h.resize(true);
    assert.equal(h.doc.activeElement, h.editor);
    h.resize(false);
    assert.equal(h.doc.activeElement, h.editor); assert.equal(h.writing.inert, false);
    h.resize(true);
    assert.equal(h.doc.activeElement, h.editor);
    h.key('Escape');
    assert.equal(h.doc.activeElement, h.opener);
  } finally { h.close(); }
});

test('expanding a docked workspace also transfers outside focus and restores the background on close', () => {
  const h = workspace();
  try {
    h.flush(); h.composer.focus(); h.expand();
    assert.equal(h.doc.activeElement, h.selected); assert.equal(h.writing.inert, true);
    h.key('Escape');
    assert.equal(h.doc.activeElement, h.composer); assert.equal(h.writing.inert, false);
  } finally { h.close(); }
});

test('workspace owns focus before the closing sidebar passive effect can replace its composer return target', () => {
  const h = workspace();
  try {
    h.flush(); h.composer.focus(); h.resize(true, true);
    assert.equal(h.doc.activeElement, h.selected);
    h.key('Escape');
    assert.equal(h.doc.activeElement, h.composer);
    assert.equal(h.navigation.inert, false);
  } finally { h.close(); }
});

test('a hidden original opener falls back to a visible conversation control when the workspace closes', () => {
  const h = workspace();
  try {
    h.flush(); h.resize(true); h.opener.hidden = true; h.key('Escape');
    assert.equal(h.doc.activeElement, h.fallback);
  } finally { h.close(); }
});

test('responsive rail closing preserves composer or modal focus, but restores focus lost inside the rail', () => {
  const outside = { name: 'composer' }, modal = { name: 'workspace' }, inside = { name: 'rail search' }, body = { name: 'body' };
  const doc = { activeElement: outside, body, querySelector: () => ({ focus() { doc.activeElement = toggle; } }) }, toggle = { name: 'show sidebar' };
  const rail = { contains: (element: unknown) => element === inside, querySelector: () => null };
  let cursor = 0, open = true, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [];
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(value: any) { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof value === 'function' ? value() : value }; return [cells[index].value, (next: any) => { cells[index].value = next; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const index = cursor++, old = cells[index]; if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) { cells[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = run(); }); } },
    },
    document: doc, window: Object.assign(new EventTarget(), { innerWidth: 1000 }),
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const render = () => {
    cursor = 0; tree = AssistantOrganizationRailFrame({ open, width: 272, setWidth() {}, onToggle() {}, onNewDraft() {}, onSearch() {}, children: null, spaceSwitch: null });
    tree.props.children.find((node: any) => node?.type === 'aside').props.ref.current = rail;
    while (effects.length) effects.shift()!();
  };
  try {
    for (const current of [outside, modal, inside, body]) {
      open = true; render(); doc.activeElement = current; open = false; render();
      assert.equal(doc.activeElement, current === inside || current === body ? toggle : current);
    }
  } finally {
    for (const cell of cells) cell?.cleanup?.();
    for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
