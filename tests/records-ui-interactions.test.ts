import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const key = Symbol.for('nova.test.records-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Run the real components' handlers and effects with isolated hook state. No
// provider calls, browser storage or workspace data escape these fixtures.
const loader = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:records-ui', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:records-ui') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      export const useState = v => globalThis[Symbol.for('nova.test.records-ui')].state(v);
      export const useRef = v => globalThis[Symbol.for('nova.test.records-ui')].ref(v);
      export const useEffect = (f,d) => globalThis[Symbol.for('nova.test.records-ui')].effect(f,d);
      export const useLayoutEffect = useEffect;
      export const useCallback = (f,d) => globalThis[Symbol.for('nova.test.records-ui')].memo(() => f,d);
      export const useMemo = (f,d) => globalThis[Symbol.for('nova.test.records-ui')].memo(f,d);` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ContentLibrary } = await import('../apps/client/src/ContentLibrary');
const { ContentTagsInput } = await import('../apps/client/src/ContentTagsInput');
const { OrganizationDirectory, ContactTimeline, useContactCrm } = await import('../apps/client/src/ContactCrm');
const { InboxPaneResizer } = await import('../apps/client/src/dreamclaw/pages/Inbox/InboxPaneResizer');
loader.deregister();

const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const field = (tree: any, label: string) => nodes(nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label))).find(node => ['input', 'textarea'].includes(node.type));
const snapshot = { epoch: 'fixture-epoch', deviceId: 'fixture-device', cursor: 1, records: { contact: [] } } as any;
const organization = { id: 'organization:fixture', revision: 1, memberIds: [], value: { name: 'Studio', website: '', phone: '', industry: '', notes: '' } };
const crm = { organizations: [organization], activities: [], relationships: [] };

function host(initialComponent: (props: any) => any, initialProps: any, respond: (path: string, body: any) => unknown | Promise<unknown> = () => crm) {
  let component = initialComponent, props = initialProps, cursor = 0, dirty = true, tree: any;
  let cells: any[] = [], effects: (() => void)[] = [];
  const frames: (() => void)[] = [], intervals = new Set<() => void>(), storage = new Map<string, string>(), calls: { path: string; body: any }[] = [];
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, n) => !Object.is(value, prior.deps[n]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
      memo(read: () => unknown, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, n) => !Object.is(value, prior.deps[n]))) cells[i] = { deps, value: read() }; return cells[i].value; },
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
    setInterval: (run: () => void) => { intervals.add(run); return run; }, clearInterval: (run: () => void) => intervals.delete(run),
    fetch: async (path: string, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body }); return new Response(JSON.stringify(await respond(path, body))); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => { for (let pass = 0; pass < 25; pass++) { if (dirty) { dirty = false; cursor = 0; tree = component(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } while (frames.length) frames.shift()!(); };
  const unmount = () => { for (const cell of cells) cell?.cleanup?.(); };
  return {
    flush, calls, storage, get tree() { return tree; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async mount(nextComponent = component, nextProps = props) { unmount(); cells = []; effects = []; component = nextComponent; props = nextProps; dirty = true; await flush(); },
    async poll() { for (const run of [...intervals]) run(); await flush(); },
    close() { unmount(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}

test('library archive cannot discard edited template or brand writing, including after remount', async () => {
  for (const type of ['template', 'brand']) {
    const item = { id: 'library:fixture', revision: 1, type, name: 'Saved item', archived: false, guidance: 'Original guidance', brief: '', body: 'Original body', platform: 'Document', collection: '', tags: [], brandId: null };
    const app = host(ContentLibrary, { snapshot, close() {} }, path => path === '/api/content/library' ? [item] : {});
    try {
      await app.flush(); button(app.tree, 'Edit').props.onClick(); await app.flush();
      assert.equal(button(app.tree, 'Archive').props.disabled, false);
      field(app.tree, type === 'brand' ? 'Voice, audience' : 'Draft structure').props.onChange({ target: { value: 'Writing that must survive' } }); await app.flush();
      assert.equal(button(app.tree, 'Archive').props.disabled, true);
      await button(app.tree, 'Archive').props.onClick(); await app.flush();
      assert.equal(app.calls.filter(call => call.path === '/api/content/workspace').length, 0);
      await app.mount();
      assert.equal(field(app.tree, type === 'brand' ? 'Voice, audience' : 'Draft structure').props.value, 'Writing that must survive');
      assert.equal(button(app.tree, 'Archive').props.disabled, true);
    } finally { app.close(); }
  }
});

test('tag input retains spaces character by character, deduplicates tags and accepts external replacement', async () => {
  const props = { value: [] as string[], onChange: (tags: string[]) => { props.value = tags; } }, app = host(ContentTagsInput, props);
  try {
    await app.flush();
    for (const character of 'product launch, review, product launch') { app.tree.props.onChange({ target: { value: app.tree.props.value + character } }); await app.flush(); }
    assert.equal(app.tree.props.value, 'product launch, review, product launch'); assert.deepEqual(props.value, ['product launch', 'review']);
    await app.update({ value: ['restored tag'] }); assert.equal(app.tree.props.value, 'restored tag');
  } finally { app.close(); }
});

test('organization validation identifies invalid fields, retains writing and saves only a repaired value', async () => {
  const app = host(OrganizationDirectory, { snapshot, refresh: async () => {}, open() {} });
  try {
    await app.flush(); button(app.tree, 'New organization').props.onClick({ currentTarget: { isConnected: true, focus() {} } }); await app.flush();
    const editor = nodes(app.tree).find(node => node.type?.name === 'OrganizationEditor'); assert.ok(editor);
    await app.mount(editor.type, { ...editor.props, saved: async () => {}, close() {} });
    field(app.tree, 'Name').props.onChange({ target: { value: 'New Studio' } }); await app.flush();
    field(app.tree, 'Website').props.onChange({ target: { value: 'ftp://example.test' } }); await app.flush();
    app.tree.props.onSubmit({ preventDefault() {} }); await app.flush();
    const website = field(app.tree, 'Website'); assert.equal(website.props['aria-invalid'], true);
    assert.equal(website.props['aria-label'], 'Website');
    assert.ok(nodes(app.tree).some(node => node.props.id === website.props['aria-describedby'] && text(node).length));
    assert.equal(app.calls.filter(call => call.path === '/api/contacts/organization').length, 0);
    assert.equal(field(app.tree, 'Name').props.value, 'New Studio');
    field(app.tree, 'Website').props.onChange({ target: { value: 'https://example.test' } }); await app.flush();
    app.tree.props.onSubmit({ preventDefault() {} }); await app.flush();
    const saves = app.calls.filter(call => call.path === '/api/contacts/organization'); assert.equal(saves.length, 1); assert.equal(saves[0].body.value.website, 'https://example.test');
  } finally { app.close(); }
});

test('organization navigation transfers focus into details and restores the activating row', async () => {
  const app = host(OrganizationDirectory, { snapshot, refresh: async () => {}, open() {} }); let focused = '';
  try {
    await app.flush(); const details = nodes(app.tree).find(node => node.props['aria-label'] === 'Organization details');
    assert.equal(details.props.tabIndex, -1); details.props.ref.current = { focus: () => { focused = 'details'; } };
    const row = nodes(app.tree).find(node => node.type === 'button' && node.props.className === 'contact-row'); assert.ok(row);
    row.props.onClick({ currentTarget: { isConnected: true, focus: () => { focused = 'row'; } } }); await app.flush(); assert.equal(focused, 'details');
    button(app.tree, 'Organizations').props.onClick(); await app.flush(); assert.equal(focused, 'row');
    assert.equal(nodes(app.tree).some(node => node.props.className?.includes('has-selection')), false);
  } finally { app.close(); }
});

test('a successful CRM poll clears the earlier read failure without changing the snapshot cursor', async () => {
  let failed = true;
  const app = host(() => useContactCrm(snapshot), {}, () => { if (failed) throw new Error('Synthetic read failure'); return crm; });
  try {
    await app.flush(); assert.ok(app.tree.error); assert.equal(app.tree.data, undefined);
    failed = false; await app.poll(); assert.equal(app.tree.error, ''); assert.deepEqual(app.tree.data, crm);
  } finally { app.close(); }
});

test('an archived timeline excludes external links and reports its actual empty state', async () => {
  const app = host(ContactTimeline, { contact: { value: { archived: false } }, snapshot, activities: [], items: [{ id: 'mail', type: 'email', title: 'Saved mail', at: '', open() {} }], refresh: async () => {} });
  try {
    await app.flush(); assert.equal(nodes(app.tree).find(node => node.props.className === 'crm-timeline').props.children.length, 1);
    button(app.tree, 'Archived entries').props.onClick(); await app.flush();
    assert.equal(nodes(app.tree).find(node => node.props.className === 'crm-timeline').props.children.length, 0);
    assert.ok(nodes(app.tree).some(node => node.props.role === 'status' && text(node).length));
    button(app.tree, 'Show active').props.onClick(); await app.flush(); assert.equal(nodes(app.tree).find(node => node.props.className === 'crm-timeline').props.children.length, 1);
  } finally { app.close(); }
});

test('inbox separator supports bounded keyboard resizing and reset without consuming unrelated keys', () => {
  let width = 420, prevented = 0, starts = 0;
  const render = () => InboxPaneResizer({ width, min: 300, max: 540, defaultWidth: 420, resize: next => { width = next; }, startResize: () => { starts++; }, children: null });
  const press = (key: string) => render().props.onKeyDown({ key, preventDefault: () => { prevented++; } });
  press('ArrowRight'); assert.equal(width, 436); press('ArrowLeft'); assert.equal(width, 420);
  press('Home'); press('ArrowLeft'); assert.equal(width, 300); press('End'); press('ArrowRight'); assert.equal(width, 540);
  press('Enter'); assert.equal(width, 420); const before = prevented; press('Tab'); assert.equal(prevented, before);
  assert.equal(render().props.role, 'separator'); assert.equal(render().props['aria-valuenow'], width);
  render().props.onMouseDown(); assert.equal(starts, 1);
});
