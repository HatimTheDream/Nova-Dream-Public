import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hookKey = Symbol.for('nova.test.content-recovery-focus'), react = import.meta.resolve('react');
const loader = registerHooks({
  resolve(name, context, next) { return name === 'react' && context.parentURL?.endsWith('/ContentRecoveryPanel.tsx')
    ? { url: 'nova-test:content-recovery-focus', shortCircuit: true } : next(name, context); },
  load(url, context, next) {
    if (url === 'nova-test:content-recovery-focus') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.content-recovery-focus')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v),useLayoutEffect=(f,d)=>h().effect(f,d);` };
    return next(url, context);
  },
});
const { ContentRecoveryPanel } = await import('../apps/client/src/ContentRecoveryPanel');
loader.deregister();

// Deterministic DOM ports exercise focus/inert ownership, not real responsive browser acceptance.
function fixture(breakpoint=1000) {
  const doc = { activeElement: null as Element | null, body: null as Element | null };
  class Element {
    children: Element[] = []; parentElement: Element | null = null; isConnected = true; inactive = false;
    value = 'Complete original writing'; scrollTop = 144; selectionStart = 8; selectionEnd = 12;
    constructor(readonly name: string, parent?: Element) { if (parent) { this.parentElement = parent; parent.children.push(this); } }
    get inert() { return this.inactive; }
    set inert(value: boolean) { this.inactive = value; if (value && this.contains(doc.activeElement)) doc.activeElement = doc.body; }
    contains(value: Element | null): boolean { return !!value && (value === this || this.children.some(row => row.contains(value))); }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return { width }; }
    closest(selector: string): Element | null { return selector === '[inert]' ? this.inert ? this : this.parentElement?.closest(selector) ?? null
      : selector === '.content-studio' ? container : null; }
    focus(_options?: unknown) { if (this.isConnected && !this.closest('[inert]')) doc.activeElement = this; }
    querySelector(_selector: string): Element | null { return null; }
    querySelectorAll(_selector: string): Element[] { return []; }
  }
  class Details extends Element { open = false; }
  const body = new Element('body'); doc.body = body;
  const shell = new Element('shell', body), nav = new Element('navigation', shell), container = new Element('studio', shell);
  const writing = new Element('writing', container), input = new Element('draft', writing), opener = new Element('details', writing);
  const preexisting = new Element('already inert', shell); preexisting.inert = true;
  const panel = new Element('recovery', container), back = new Element('back', panel), last = new Element('last', panel);
  const disclosure = new Details('closed disclosure', panel), summary = new Element('summary', disclosure), hidden = new Element('hidden copy', disclosure);
  disclosure.querySelector = () => summary;
  panel.querySelector = () => back; panel.querySelectorAll = () => [back, summary, hidden, last];
  opener.focus();
  let width = 1280, cursor = 0, dirty = true, closed = false, cleaned = false, tree: any, disconnected = false;
  let resize: (() => void) | undefined,afterCleanup:(()=>void)|undefined;
  const cells: any[] = [], effects: (() => void)[] = [], frames: (() => void)[] = [];
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(value: any) { const i = cursor++; cells[i] ??= { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (v: any) => { if (!Object.is(v, cells[i].value)) { cells[i].value = v; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, old = cells[i]; if (!old || deps.some((v, k) => !Object.is(v, old.deps[k]))) { cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
    },
    HTMLElement: Element, HTMLDetailsElement: Details, document: doc, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ visibility: 'visible' }), requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    ResizeObserver: class { constructor(fn: () => void) { resize = fn; } observe() {} disconnect() { disconnected = true; } },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  const clean = () => { if (!cleaned) { cleaned = true; for (const cell of cells) cell?.cleanup?.();afterCleanup?.(); } };
  const flush = () => { for (let i = 0; i < 10 && (dirty || frames.length || closed && !cleaned); i++) {
    if (closed) clean();
    else if (dirty) { dirty = false; cursor = 0; tree = ContentRecoveryPanel({ title: 'Save And Recovery', children: null,breakpoint,
      close() { closed = true; }, fallbackFocus: () => input as unknown as HTMLElement });
      tree.props.ref.current = panel; while (effects.length) effects.shift()!(); }
    while (frames.length) frames.shift()!();
  } };
  return { doc, input, opener, nav, writing, back, last, hidden, preexisting,
    handoff(run:()=>void){afterCleanup=run;},
    get tree() { return tree; }, get disconnected() { return disconnected; }, flush,
    resize(value: number) { width = value; resize?.(); flush(); },
    key(key: string, shiftKey = false) { let prevented = false; tree.props.onKeyDown({ key, shiftKey, defaultPrevented: false, preventDefault() { prevented = true; } }); flush(); return prevented; },
    close() { closed = true; flush(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}

test('Content details become a focused workspace at actual available width and return untouched writing/caret/scroll', () => {
  const f = fixture();
  try {
    f.flush(); assert.equal(f.tree.props.role, 'complementary'); f.input.focus();
    f.resize(390); assert.equal(f.tree.props.role, 'dialog'); assert.equal(f.doc.activeElement, f.back);
    assert(f.writing.inert); assert(f.nav.inert);
    assert(f.key('Tab', true)); assert.equal(f.doc.activeElement, f.last);
    assert(f.key('Tab')); assert.equal(f.doc.activeElement, f.back);
    assert(f.key('Escape')); assert.equal(f.doc.activeElement, f.input);
    assert.equal(f.writing.inert, false); assert.equal(f.nav.inert, false); assert(f.preexisting.inert); assert(f.disconnected);
    assert.equal(f.input.value, 'Complete original writing'); assert.equal(f.input.scrollTop, 144);
    assert.deepEqual([f.input.selectionStart, f.input.selectionEnd], [8, 12]);
  } finally { f.close(); }
});

test('Content details resize preserves focused controls and restores each original inert value', () => {
  const f = fixture();
  try {
    f.flush(); f.resize(320); f.last.focus(); f.resize(1280);
    assert.equal(f.doc.activeElement, f.last); assert.equal(f.writing.inert, false);
    f.resize(800); assert.equal(f.doc.activeElement, f.last); assert(f.writing.inert);
    f.key('Escape'); assert.equal(f.preexisting.inert, true); assert.equal(f.doc.activeElement, f.input);
  } finally { f.close(); }
});

test('closing Content details uses the original opener when the former writing field is no longer mounted', () => {
  const f = fixture();
  try {
    f.flush(); f.resize(400); f.input.isConnected = false; f.key('Escape');
    assert.equal(f.doc.activeElement, f.opener); assert.equal(f.writing.inert, false);
  } finally { f.close(); }
});
test('Content tools use their separate 800px focus boundary without changing the recovery boundary',()=>{
 const f=fixture(800);
 try{f.flush();f.resize(801);assert.equal(f.tree.props.role,'complementary');assert.equal(f.writing.inert,false);
  f.resize(800);assert.equal(f.tree.props.role,'dialog');assert(f.writing.inert);f.resize(801);assert.equal(f.writing.inert,false);
  assert.equal(f.input.value,'Complete original writing');assert.deepEqual([f.input.selectionStart,f.input.selectionEnd],[8,12]);
 }finally{f.close();}
});
test('Back uses the visible opener when Preview keeps the original writing field mounted but hidden',()=>{
 const f=fixture(800);
 try{f.flush();f.resize(390);f.input.getClientRects=()=>[];f.key('Escape');assert.equal(f.doc.activeElement,f.opener);}
 finally{f.close();}
});
test('a retired panel cannot steal focus from a newly opened sustained tool',()=>{
 const f=fixture(800);
 try{f.flush();f.resize(390);const original=f.nav.closest.bind(f.nav);f.nav.closest=selector=>selector==='.content-recovery-panel'?f.nav:original(selector);
  f.handoff(()=>f.nav.focus());f.key('Escape');assert.equal(f.doc.activeElement,f.nav);
 }finally{f.close();}
});
