import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLibraryActionFocus } from '../apps/client/src/library-action-focus';

test('confirmed Library focus uses the original control, then row details or heading, and never takes newer focus', () => {
 class Element {
  isConnected = true; disabled = false; focused = 0; member = true; hidden = false; row?: Element; detail?: Element;
  contains(node: Element) { return node.member; }
  matches() { return this.disabled; }
  closest(selector: string) { return selector === '.home-library-resource' ? this.row : this.hidden ? this : null; }
  querySelector(selector: string) { return selector === '.home-library-inspect' ? this.detail : heading; }
  focus() { this.focused++; }
 }
 const root = new Element(), origin = new Element(), row = new Element(), details = new Element(), heading = new Element(), body = new Element(), other = new Element();
 origin.row = row;row.detail = details;let active = true, frame: (() => void) | undefined;
 const doc = { activeElement: origin, body }, names = ['document', 'HTMLElement', 'requestAnimationFrame'] as const;
 const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
 Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
 Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Element });
 Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (run: () => void) => { frame = run; } });
 try {
  const restore = captureLibraryActionFocus(root as unknown as HTMLElement, () => active);
  restore();frame!();assert.equal(origin.focused, 1);
  origin.disabled = true;doc.activeElement = body;restore();frame!();assert.equal(details.focused, 1);
  row.isConnected = false;details.isConnected = false;origin.isConnected = false;restore();frame!();assert.equal(heading.focused, 1);
  doc.activeElement = other;restore();frame!();assert.equal(heading.focused, 1);
  doc.activeElement = body;root.hidden = true;restore();frame!();assert.equal(heading.focused, 1);root.hidden = false;
  heading.hidden = true;restore();frame!();assert.equal(heading.focused, 1);heading.hidden = false;
  doc.activeElement = body;active = false;restore();frame!();assert.equal(heading.focused, 1);
  active = true;root.isConnected = false;restore();frame!();assert.equal(heading.focused, 1);
 } finally {
  for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor);else Reflect.deleteProperty(globalThis, name); }
 }
});
