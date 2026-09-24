import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const key = Symbol.for('nova.test.provider-signin-flow');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:provider-signin-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:provider-signin-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useState = value => globalThis[Symbol.for('nova.test.provider-signin-flow')].state(value);
      export const useRef = value => globalThis[Symbol.for('nova.test.provider-signin-flow')].ref(value);
      export const useEffect = (effect, deps) => globalThis[Symbol.for('nova.test.provider-signin-flow')].effect(effect, deps);
    ` };
    return next(url, context);
  },
});
const { ProviderAccounts } = await import('../apps/client/src/ProviderAccounts');
hooks.deregister();
const text = (tree: any): string => (tree == null || typeof tree === 'boolean' ? '' : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children)).replace(/\s+/g, ' ').trim();
function element(tree: any, match: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return;
  if (Array.isArray(tree)) return tree.map(child => element(child, match)).find(Boolean);
  return match(tree) ? tree : element(tree.props?.children, match);
}
const base = { clients: [{ provider: 'google', revision: 1, configured: true, clientId: 'fixture.apps.googleusercontent.com', hasClientSecret: true }, { provider: 'microsoft', revision: 1, configured: true, clientId: 'fixture' }], accounts: [], attempts: [], probes: [] };
const snapshot = { epoch: 'workspace', deviceId: 'device' };
Object.defineProperty(globalThis, key, { configurable: true, value: {
  state: (value: any) => [value === undefined ? base : typeof value === 'function' ? value() : value, () => {}],
  ref: (value: any) => ({ current: value }), effect: () => {},
} });
const card = element(ProviderAccounts({ snapshot: snapshot as any, online: true, active: false }), node => node.type?.name === 'ProviderCard').type;
Reflect.deleteProperty(globalThis, key);

function mount(state: any, options: { provider?: string; respond?: (path: string, body: any) => unknown | Promise<unknown>; refresh?: () => any } = {}) {
  let cursor = 0, dirty = true, tree: any, props: any;
  const cells: any[] = [], effects: (() => void)[] = [], stored = new Map<string, string>(), calls: { path: string; body: any }[] = [];
  let popupAttempts = 0;
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; dirty = true; }]; },
      ref(value: any) { const i = cursor++; return cells[i] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, old = cells[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) { cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
    },
    window: Object.assign(new EventTarget(), { open: () => { popupAttempts++; throw new Error('Browser blocked this popup'); } }),
    localStorage: { getItem: (name: string) => stored.get(name) ?? null, setItem: (name: string, value: string) => stored.set(name, value), removeItem: (name: string) => stored.delete(name) },
    sessionStorage: { getItem: () => 'tab' },
    fetch: async (path: string, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body }); const value = await options.respond?.(path, body); return new Response(JSON.stringify(value ?? {}), { status: 200 }); },
  };
  const originals = Reflect.ownKeys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of Reflect.ownKeys(values)) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  props = { provider: options.provider ?? 'google', state, snapshot, online: true, recoveryPaused: false, refresh: async () => { props = { ...props, state: options.refresh?.() ?? props.state }; dirty = true; } };
  const flush = async () => { for (let pass = 0; pass < 20; pass++) { if (dirty) { dirty = false; cursor = 0; tree = card(props); for (const run of effects.splice(0)) run(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } };
  return {
    calls, stored, flush, get tree() { return tree; }, get popupAttempts() { return popupAttempts; },
    async update(state: any) { props = { ...props, state }; dirty = true; await flush(); },
    close() { for (const cell of cells) cell?.cleanup?.(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}
const attempt = { id: 'attempt', provider: 'google', deviceId: 'device', epoch: 'workspace', createdAt: 1, expiresAt: 600001, state: 'waiting', message: 'Continue in your browser.', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=original-state&code_challenge=original-challenge' };
const help = (tree: any) => element(tree, node => node.type === 'details' && element(node.props.children, child => child.type === 'summary' && text(child) === 'Google sign-in help'));

test('Google help is a closed contextual disclosure and does not label ordinary refusals as Testing', async () => {
  const app = mount({ ...base, attempts: [attempt] });
  try {
    await app.flush(); assert.ok(help(app.tree)); assert.notEqual(help(app.tree).props.open, true);
    assert.match(text(help(app.tree)), /If Google says.*testing/); assert.match(text(help(app.tree)), /Workspace administrator/);
    const guide = element(help(app.tree), node => node.type === 'a');
    assert.equal(guide.props.href, 'https://support.google.com/cloud/answer/15549945?hl=en'); assert.equal(guide.props.rel, 'noopener noreferrer');
    await app.update({ ...base, attempts: [{ ...attempt, state: 'failed', message: 'Google sign-in was not approved.' }] });
    assert.ok(help(app.tree)); assert.equal(app.calls.length, 0); assert.equal(app.popupAttempts, 0);
    await app.update({ ...base, attempts: [{ ...attempt, state: 'completed' }] }); assert.equal(help(app.tree), undefined);
    await app.update(base); assert.equal(help(app.tree), undefined);
  } finally { app.close(); }
  const microsoft = mount({ ...base, attempts: [{ ...attempt, provider: 'microsoft', state: 'failed' }] }, { provider: 'microsoft' });
  try { await microsoft.flush(); assert.equal(help(microsoft.tree), undefined); } finally { microsoft.close(); }
});

test('an unconfirmed start reconciles its original request and keeps browser-link and Stop recovery without popups', async () => {
  const savedAccount = { id: 'existing', provider: 'google', label: 'Existing account', email: 'existing@example.test', revision: 1, generation: 'existing-generation', state: 'connected', scopes: [], capabilities: {}, connectedAt: 'old', updatedAt: 'old' };
  let state: any = { ...base, accounts: [savedAccount] }, starts = 0;
  const app = mount(state, {
    refresh: () => state,
    respond: (path, body) => {
      if (path === '/api/accounts/start') {
        state = { ...state, attempts: [attempt] };
        if (++starts === 1) throw new Error('Connection lost after sign-in was prepared.');
        return attempt;
      }
      assert.equal(path, '/api/accounts/cancel'); assert.equal(body.attemptId, attempt.id);
      state = { ...state, attempts: [{ ...attempt, state: 'cancelled' }] }; return state.attempts[0];
    },
  });
  try {
    await app.flush();
    element(app.tree, node => node.type === 'button' && text(node) === 'Connect Google account').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(app.stored.size, 1);
    assert.match(text(app.tree), /awaiting confirmation/);
    assert.equal(element(app.tree, node => node.type === 'button' && text(node) === 'Connect Google account').props.disabled, true);
    element(app.tree, node => node.type === 'button' && text(node) === 'Reconcile original change').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 2); assert.deepEqual(app.calls[1].body, app.calls[0].body); assert.equal(app.stored.size, 0);
    const link = () => element(app.tree, node => node.type === 'a' && node.props.href === attempt.authorizationUrl);
    assert.ok(link()); assert.equal(link().props.target, '_blank'); assert.equal(link().props.rel, 'noopener noreferrer');
    assert.equal(link().props.onClick, undefined, 'The browser owns the link gesture; opening it cannot consume or duplicate the attempt');
    await app.update(state); assert.ok(link()); assert.equal(app.calls.length, 2); assert.equal(app.popupAttempts, 0);
    assert.equal(element(app.tree, node => node.type === 'button' && text(node) === 'Stop sign-in').props.disabled, false);
    element(app.tree, node => node.type === 'button' && text(node) === 'Stop sign-in').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 3); assert.equal(link(), undefined); assert.deepEqual(state.accounts, [savedAccount]);
    assert.equal(app.stored.size, 0); assert.equal(app.popupAttempts, 0);
  } finally { app.close(); }
});
