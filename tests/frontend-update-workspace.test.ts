import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

test('compatible frontend promotion keeps the workspace online and saving; a backend change still requires reload', async t => {
  const candidate = 'a'.repeat(64), frontend = 'b'.repeat(64), nextFrontend = 'c'.repeat(64);
  const key = Symbol.for('nova.test.frontend-workspace-hooks');
  const fixture = { index: 0, values: [] as any[], effects: [] as (() => (() => void) | void)[] };
  const properties = [key, 'document', 'window', 'localStorage', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const document = Object.assign(new EventTarget(), { hidden: false, querySelector: (selector: string) => {
    if (selector.includes('e3-candidate')) return { content: candidate };
    if (selector.includes('e3-frontend"')) return { content: frontend };
    return null;
  } });
  const window = new EventTarget(), storage = new Map([['retained-proposal', JSON.stringify({ requestId: 'kept-request', text: 'unsent writing' })]]);
  const store = { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value) };
  for (const [name, value] of [[key, fixture], ['document', document], ['window', window], ['localStorage', store], ['sessionStorage', store]] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/useWorkspace')) return { url: 'nova-test:frontend-workspace-react', shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === 'nova-test:frontend-workspace-react') return { format: 'module', shortCircuit: true, source: `
        const fixture = globalThis[Symbol.for('nova.test.frontend-workspace-hooks')];
        export const useEffect = effect => { fixture.effects.push(effect); };
        export const useCallback = value => value;
        export const useState = initial => {
          const index = fixture.index++;
          if (!(index in fixture.values)) fixture.values[index] = typeof initial === 'function' ? initial() : initial;
          return [fixture.values[index], value => { fixture.values[index] = typeof value === 'function' ? value(fixture.values[index]) : value; }];
        };
        export const useRef = value => useState(() => ({ current: value }))[0];
      ` };
      return next(url, context);
    },
  });
  const cleanups: (() => void)[] = [];
  t.after(() => {
    cleanups.forEach(cleanup => cleanup()); hooks.deregister();
    for (const [name, previous] of properties) { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); }
  });
  let backend = candidate, selected = frontend;
  const commands: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (url === '/api/access/context') return Response.json({ surface: 'desktop', workspaceEpoch: 'workspace' });
    if (url === '/api/session') return Response.json({ deviceId: 'device', apiVersion: 1 });
    if (url === '/api/health') return Response.json({ application: 'nova-dream-edition-3', status: 'ready', candidateId: backend, frontend: { id: selected, source: 'frontend' } });
    assert.equal((options.headers as Record<string, string>)['X-Edition3-Candidate'], candidate);
    if (backend !== candidate) return Response.json({ code: 'client_update', message: 'Reload this window.' }, { status: 409 });
    if (url === '/api/snapshot') return Response.json({ epoch: 'workspace', cursor: 1, deviceId: 'device' });
    assert.equal(url, '/api/commands'); commands.push(options); return Response.json({ accepted: true });
  });
  const { useWorkspace } = await import('../apps/client/src/useWorkspace');
  const { request } = await import('../apps/client/src/api');
  const render = () => { fixture.index = 0; fixture.effects = []; return useWorkspace(); };
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  render();
  for (const effect of fixture.effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  await settle();
  assert.equal(render().online, true);
  selected = nextFrontend; window.dispatchEvent(new Event('focus')); await settle();
  const updated = render();
  assert.equal(updated.frontendUpdate, nextFrontend); assert.equal(updated.online, true); assert.equal(updated.updateRequired, false);
  assert.equal(commands.length, 0, 'observing an update dispatches no user command');
  const retained = storage.get('retained-proposal');
  assert.deepEqual(await request('commands', JSON.parse(retained!)), { accepted: true });
  assert.equal(commands.length, 1); assert.equal(commands[0].body, retained);
  assert.equal(storage.get('retained-proposal'), retained);
  backend = 'd'.repeat(64); window.dispatchEvent(new Event('focus')); await settle();
  const stale = render();
  assert.equal(stale.frontendUpdate, null); assert.equal(stale.online, false); assert.equal(stale.updateRequired, true);
  assert.equal(storage.get('retained-proposal'), retained);
});
