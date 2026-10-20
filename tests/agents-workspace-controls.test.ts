import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const key = Symbol.for('nova.test.agents-controls');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.endsWith('/AgentsWorkspaceControls.tsx')) return { url: 'agents-controls:react', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url === 'agents-controls:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};const f=()=>globalThis[Symbol.for('nova.test.agents-controls')];export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=()=>{},useId=()=>'assignment-search';` };
    return next(url, context);
  },
});
const { AgentWorkControls, AgentsWorkspaceNavigation } = await import('../apps/client/src/AgentsWorkspaceControls');
const nodes = (value: any): any[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
const text = (value: any): string => value == null || typeof value === 'boolean' ? '' : Array.isArray(value) ? value.map(text).join('') : typeof value === 'object' ? text(value.props?.children) : String(value);
const button = (tree: any, name: string) => { const found = nodes(tree).find(row => row.type === 'button' && (row.props['aria-label'] === name || text(row) === name)); assert.ok(found, name); return found; };

test('Agents navigation uses the actual Team/Headquarters destination and moves keyboard focus only after admission', () => {
  const calls: string[] = [], focused: number[] = []; let accepted = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLButtonElement');
  class Button { parentElement: unknown; }
  Object.defineProperty(globalThis, 'HTMLButtonElement', { configurable: true, value: Button });
  try {
    const tree = AgentsWorkspaceNavigation({ view: 'hub', choose(destination) { calls.push(destination); return accepted; } });
    assert.equal(button(tree, 'Team').props['aria-current'], 'page');
    const parent = { querySelectorAll: () => [0, 1, 2, 3].map(index => ({ focus: () => focused.push(index) })) }, target = new Button(); target.parentElement = parent;
    const event = { key: 'ArrowRight', target, currentTarget: parent, preventDefault() {} };
    tree.props.onKeyDown(event); assert.deepEqual(calls, ['routines']); assert.deepEqual(focused, []);
    accepted = true; tree.props.onKeyDown(event); assert.deepEqual(focused, [2]);
    button(tree, 'Work').props.onClick(); assert.equal(calls.at(-1), 'work');
    tree.props.onKeyDown({ ...event, target: { parentElement: parent } }); assert.equal(calls.length, 3);
  } finally { if (original) Object.defineProperty(globalThis, 'HTMLButtonElement', original); else Reflect.deleteProperty(globalThis, 'HTMLButtonElement'); }
});
test('Work disclosure preserves the collection-owned query, labels saved briefs separately and Assign is explicit', () => {
  const slots: any[] = []; let cursor = 0, query = 'Original brief 雪', assigned = 0, focused = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value: {
    state(value: any) { const i = cursor++; if (!slots[i]) slots[i] = { value }; return [slots[i].value, (next: any) => { slots[i].value = next; }]; },
    ref(value: any) { return slots[cursor++] ??= { current: value }; },
  } });
  const render = () => { cursor = 0; return AgentWorkControls({ savedCount: 2, draftCount: 1, query, changeQuery: value => { query = value; }, filterCount: 1, filterSummary: 'Archived', filters: () => null, assign: () => { assigned++; } }); };
  try {
    let tree = render(); assert.match(text(tree), /Saved Briefs2 · 1 Unfinished Device Draft/); assert.equal(assigned, 0);
    const trigger = button(tree, 'Search Assignments'); trigger.props.ref.current = { focus: () => { focused++; } };
    button(tree, 'Search: Original brief 雪').props.onClick(); tree = render();
    const field = nodes(tree).find(row => row.type === 'input'); assert.equal(field.props.value, query);
    field.props.onChange({ target: { value: 'Different saved brief' } }); tree = render();
    nodes(tree).find(row => row.props?.id === 'assignment-search').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    tree = render(); assert.equal(query, 'Different saved brief'); assert.equal(focused, 1); assert.equal(assigned, 0);
    button(tree, 'Clear Assignment Search').props.onClick(); assert.equal(query, ''); assert.equal(focused, 2);
    button(tree, 'Assign').props.onClick(); assert.equal(assigned, 1);
  } finally { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); }
});
