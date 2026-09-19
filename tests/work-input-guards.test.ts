import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { browserInputSchema } from '../packages/domain/host-browser';
import { gitBranch, githubName } from '../packages/domain/work-repositories';
import { validBrowserUrl, validGitBranch, validGitHubName } from '../packages/domain/work-input';

const fixtureKey = Symbol.for('nova.test.work.input-hooks');
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Execute the real event handlers without timers, browser effects or a DOM.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:work-input-react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:work-input-react') return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(reactUrl)};
      export const useEffect = () => {};
      export const useCallback = value => value;
      export const useRef = value => ({ current: value });
      export const useState = initial => {
        const fixture = globalThis[Symbol.for('nova.test.work.input-hooks')], index = fixture.index++;
        if (!(index in fixture.values)) fixture.values[index] = typeof initial === 'function' ? initial() : initial;
        return [fixture.values[index], value => { fixture.values[index] = typeof value === 'function' ? value(fixture.values[index]) : value; }];
      };
    ` };
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
const { HostBrowserPanel } = await import('../apps/client/src/HostBrowserPanel');
const { GitHubRepositoryPicker } = await import('../apps/client/src/GitHubRepositoryPicker');
hooks.deregister();

test('lightweight editable field checks agree with their host contracts at boundaries', () => {
  for (const [url, accepted] of [
    ['http://localhost:4384', true], ['https://example.com', true],
    ['https://example.com/' + 'a'.repeat(3980), true], ['https://example.com/' + 'a'.repeat(3982), false],
    ['ftp://example.com', false], ['https://user:password@example.com', false],
    ['not an address', false], ['', false],
  ] as const) {
    assert.equal(validBrowserUrl(url), accepted, url);
    assert.equal(browserInputSchema.safeParse({ action: 'open', url }).success, accepted, url);
  }
  for (const value of ['main', 'feature/change', 'a'.repeat(200), 'a'.repeat(201), '', '-option', 'a..b', 'a b', 'a.lock', '.hidden', 'a//b', 'a@{b', 'a?b', 'a\\b']) {
    assert.equal(validGitBranch(value), gitBranch.safeParse(value).success, value);
  }
  for (const value of ['owner/repository', 'owner/repo-name', 'owner/' + 'a'.repeat(214), 'owner/' + 'a'.repeat(215), '', 'one', 'a/b/c', 'a/b c']) {
    assert.equal(validGitHubName(value), githubName.safeParse(value).success, value);
  }
});

function controls(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  return node && typeof node === 'object' && node.props ? [node, ...controls(node.props.children)] : [];
}
function fixture(t: any, values: unknown[]) {
  const state = { index: 0, values }, storage = new Map<string, string>(), requests: any[] = [];
  for (const [key, value] of [[fixtureKey, state], ['localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.body) requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ code: 'client_update', message: 'Reload first.' }), { status: 409 });
  });
  return { state, storage, requests };
}

test('fresh unsupported browser addresses stay editable without saving or dispatching a request', t => {
  const f = fixture(t, []);
  for (const url of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com/' + 'a'.repeat(4000)]) {
    f.state.index = 0; f.state.values = [{ enabled: true, tabs: [] }, undefined, url, false, '', undefined, undefined];
    const form = controls(HostBrowserPanel({ epoch: randomUUID(), active: false })).find(node => node.type === 'form');
    form.props.onSubmit({ preventDefault() {} });
    assert.equal(f.storage.size, 0); assert.equal(f.requests.length, 0);
    assert.equal(f.state.values[2], url); assert.equal(f.state.values[6], undefined);
    assert.match(String(f.state.values[4]), /HTTP or HTTPS/);
  }
});

test('an already retained browser request bypasses fresh-input validation and preserves its original identity', async t => {
  const epoch = randomUUID(), pending = { requestId: randomUUID(), epoch, input: { action: 'open', url: 'ftp://old-client.example' } };
  const f = fixture(t, [{ enabled: true, tabs: [] }, undefined, 'https://new.example', false, '', undefined, pending]);
  const button = controls(HostBrowserPanel({ epoch, active: false })).find(node => node.type === 'button' && node.props.children === 'Check original request');
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests, [pending]); assert.deepEqual(f.state.values[6], pending);
  assert.deepEqual(JSON.parse(f.storage.get(`e3:host-browser:${epoch}`)!), pending);
});

test('an unsupported checkout branch is rejected before retention and a corrected selection can dispatch', async t => {
  const epoch = randomUUID(), repo = { id: 1, fullName: 'fixture/repository', defaultBranch: 'main', private: true, archived: false, canPush: true, description: '' };
  const f = fixture(t, [[repo], null, '', repo, [], 'a'.repeat(201), null, [], undefined, false, '']);
  const render = () => { f.state.index = 0; return controls(GitHubRepositoryPicker({ epoch, deviceId: 'device', projectId: 'project', onSelect: () => true })); };
  render().find(node => node.type === 'button' && node.props.children === 'Prepare on host').props.onClick();
  assert.equal(f.storage.size, 0); assert.equal(f.requests.length, 0); assert.equal(f.state.values[8], undefined);
  assert.match(String(f.state.values[10]), /supported repository and branch/);
  f.state.values[5] = 'main';
  render().find(node => node.type === 'button' && node.props.children === 'Prepare on host').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].baseBranch, 'main');
  assert.deepEqual(f.state.values[8], f.requests[0]);
});
