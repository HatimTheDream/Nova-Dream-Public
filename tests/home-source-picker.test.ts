import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { HomeReference, HomeResource } from '../packages/domain/home-library.js';

// Exercise the component's own event handlers with retained hook state. This is
// the same isolated hook boundary used by home-library-lifecycle.test.ts; it
// does not replace the picker, its filtering, or its selection callbacks.
const fixtureKey = Symbol.for('nova.test.home-source-picker');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) {
  if (specifier === 'react' && /\/apps\/client\/src\/HomeSourcePicker\./.test(context.parentURL ?? '')) return { url: 'nova-source-picker:react', shortCircuit: true };
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url === 'nova-source-picker:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   export const useState = initial => globalThis[Symbol.for('nova.test.home-source-picker')].state(initial);` };
  return next(url, context);
 },
});
const { HomeSourcePicker } = await import('../apps/client/src/HomeSourcePicker.js');
test.after(() => { loader.deregister(); delete (globalThis as any)[fixtureKey]; });

type Element = ReactElement<any>;
function elements(node: ReactNode): Element[] {
 return Children.toArray(node).flatMap(child => isValidElement<any>(child) ? [child, ...elements((child as Element).props.children)] : []);
}
function text(node: ReactNode): string {
 return Children.toArray(node).map(child => isValidElement<any>(child) ? text((child as Element).props.children) : String(child)).join('');
}
const sources: HomeResource[] = Array.from({ length: 100 }, (_, index) => ({
 reference: { kind: 'note', id: `note:${index + 1}`, revision: index + 7 },
 title: `Source ${String(index + 1).padStart(3, '0')}`, subtitle: `Unique subtitle ${String(index + 1).padStart(3, '0')}`,
 updatedAt: '2026-10-19T00:00:00.000Z', availability: 'current',
}));

class Picker {
 slots: unknown[] = []; index = 0; selected: HomeReference[] = []; calls: HomeReference[][] = [];
 resources = sources; busy = false; otherSelections = 0; selectionLimit?: number; disabled?: (ref: HomeReference) => boolean;
 state(initial: any) {
  const index = this.index++;
  if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial;
  return [this.slots[index], (next: any) => { this.slots[index] = typeof next === 'function' ? next(this.slots[index]) : next; }];
 }
 render() {
  (globalThis as any)[fixtureKey] = this; this.index = 0;
  const props: ComponentProps<typeof HomeSourcePicker> = {
   resources: this.resources, selected: this.selected, busy: this.busy, disabled: this.disabled,
   selectionLimit: this.selectionLimit, selectionCount: this.otherSelections + this.selected.length,
   select: refs => { this.calls.push(refs); this.selected = refs; },
  };
  return HomeSourcePicker(props);
 }
 catalog() {
  const list = elements(this.render()).filter(element => element.type === 'div' && element.props.className === 'home-source-picker').at(-1);
  assert.ok(list, 'The current source catalog must render'); return list;
 }
 checkbox(number: number) {
  const title = `Source ${String(number).padStart(3, '0')}`;
  const label = elements(this.catalog()).find(element => element.type === 'label' && elements(element.props.children).some(child => child.type === 'strong' && text((child as Element).props.children) === title));
  assert.ok(label, `${title} must be reachable`);
  const input = elements(label.props.children).find(element => element.type === 'input' && element.props.type === 'checkbox');
  assert.ok(input, `${title} needs a checkbox`); return input;
 }
 choose(number: number, checked = true) {
  const input = this.checkbox(number); assert.ok(!input.props.disabled, 'A normal click must be allowed');
  input.props.onChange({ target: { checked } });
 }
 search(value: string) {
  const input = elements(this.render()).find(element => element.type === 'input' && element.props.type === 'search');
  assert.ok(input, 'Source search must be available'); input.props.onChange({ target: { value } });
 }
 more() {
  const button = elements(this.render()).find(element => element.type === 'button' && /show more/i.test(text(element.props.children)));
  assert.ok(button, 'More matching sources must be reachable'); button.props.onClick();
 }
 checkboxes() { return elements(this.catalog()).filter(element => element.type === 'input' && element.props.type === 'checkbox'); }
}

test('all 100 sources are reachable and selections cross the former 80-source boundary', () => {
 const picker = new Picker();
 assert.equal(picker.checkboxes().length, 40); picker.choose(1); picker.more();
 assert.equal(picker.checkboxes().length, 80); picker.choose(80); picker.more();
 assert.equal(picker.checkboxes().length, 100); picker.choose(81); picker.choose(100);
 assert.deepEqual(picker.selected, [sources[0].reference, sources[79].reference, sources[80].reference, sources[99].reference]);
 for (const number of [1, 80, 81, 100]) assert.equal(picker.checkbox(number).props.checked, true);
 assert.ok(!elements(picker.render()).some(element => element.type === 'button' && /show more/i.test(text(element.props.children))));
 const markup = renderToStaticMarkup(picker.render()); assert.match(markup, /Source 100/); assert.match(markup, /type="checkbox"[^>]*checked=""/);
});

test('title and subtitle search reach older sources without dropping hidden selections', () => {
 const picker = new Picker(); picker.choose(1); picker.search('sOuRcE 100');
 assert.equal(picker.checkboxes().length, 1); picker.choose(100);
 picker.search('UNIQUE SUBTITLE 081'); assert.equal(picker.checkboxes().length, 1); picker.choose(81);
 const before = [...picker.selected], callbacks = picker.calls.length;
 picker.search('no source matches this phrase'); assert.equal(picker.checkboxes().length, 0);
 assert.deepEqual(picker.selected, before); assert.equal(picker.calls.length, callbacks);
 picker.search(''); assert.equal(picker.checkbox(1).props.checked, true);
 picker.more(); picker.more(); assert.equal(picker.checkbox(81).props.checked, true); assert.equal(picker.checkbox(100).props.checked, true);
 picker.search('Source 100');
 const summary = elements(picker.render()).find(element => element.type === 'details'); assert.ok(summary);
 const first = elements(summary).find(element => element.type === 'label' && text(element.props.children).includes('Source 001')); assert.ok(first);
 const remove = elements(first).find(element => element.type === 'input' && element.props.type === 'checkbox'); assert.ok(remove);
 remove.props.onChange({ target: { checked: false } });
 assert.deepEqual(picker.selected, [sources[99].reference, sources[80].reference]);
});

test('the combined task and source limit blocks only additions and keeps removal available', () => {
 const picker = new Picker(); picker.otherSelections = 16; picker.selectionLimit = 18;
 picker.choose(1); picker.choose(2); assert.equal(picker.selected.length + picker.otherSelections, 18);
 assert.equal(picker.checkbox(3).props.disabled, true); assert.equal(picker.checkbox(1).props.disabled, false);
 picker.choose(1, false); assert.equal(picker.checkbox(3).props.disabled, false); picker.choose(3);
 assert.deepEqual(picker.selected, [sources[1].reference, sources[2].reference]);
 picker.busy = true;
 assert.ok(picker.checkboxes().every(input => input.props.disabled));
 assert.deepEqual(picker.selected, [sources[1].reference, sources[2].reference]);
});

test('selection emits the exact clicked reference and a resource refresh does not silently replace it', () => {
 const picker = new Picker(); picker.otherSelections = 17; picker.selectionLimit = 18;
 const original: HomeReference = { kind: 'output', id: 'output:exact', revision: 7, sha256: 'a'.repeat(64) };
 picker.resources = [{ ...sources[0], reference: original }]; picker.choose(1);
 assert.equal(picker.selected[0], original); assert.deepEqual(picker.calls, [[original]]);
 const updated = { ...original, revision: 8, sha256: 'b'.repeat(64) };
 picker.resources = [{ ...sources[0], reference: updated }]; picker.search('Source 001');
 assert.equal(picker.selected[0], original); assert.equal(picker.calls.length, 1);
 assert.equal(picker.checkbox(1).props.checked, false); assert.ok(!picker.checkbox(1).props.disabled);
 assert.match(renderToStaticMarkup(picker.render()), /Changed or unavailable/);
 picker.choose(1);
 assert.equal(picker.selected[0], updated); assert.equal(picker.selected.length, 1);
 assert.equal(picker.selected.length + picker.otherSelections, 18);
});

test('unavailable sources are excluded and caller-disabled collection members stay unselectable', () => {
 const picker = new Picker();
 picker.resources = [sources[0], sources[1], { ...sources[2], availability: 'changed', currentRevision: 99 }];
 picker.disabled = reference => reference.id === sources[0].reference.id;
 assert.equal(picker.checkboxes().length, 2); assert.equal(picker.checkbox(1).props.disabled, true);
 assert.equal(picker.checkbox(2).props.disabled, false); picker.choose(2);
 assert.deepEqual(picker.selected, [sources[1].reference]);
});


test('a missing selected source stays visible and removable without rewriting the kept reference', () => {
 const picker = new Picker(), original = sources[99].reference;
 picker.selected = [original]; picker.resources = []; picker.search('different words');
 assert.equal(picker.checkboxes().length, 0); assert.equal(picker.selected[0], original); assert.equal(picker.calls.length, 0);
 const rendered = picker.render(); assert.match(renderToStaticMarkup(rendered), /Unavailable saved source/);
 const summary = elements(rendered).find(element => element.type === 'details'); assert.ok(summary);
 const remove = elements(summary).find(element => element.type === 'input' && element.props.type === 'checkbox'); assert.ok(remove);
 assert.equal(remove.props.checked, true); assert.equal(remove.props.disabled, false);
 remove.props.onChange({ target: { checked: false } }); assert.deepEqual(picker.selected, []);
});
