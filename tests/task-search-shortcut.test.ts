import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTaskSearchShortcut, handleTaskSearchEscape } from '../apps/client/src/task-search-shortcut';

test('search Escape clears normally but preserves query and selection while IME consumes the key', () => {
  for (const { composing, preserved } of [
    { composing: { isComposing: true, keyCode: 27 }, preserved: true },
    { composing: { isComposing: false, keyCode: 229 }, preserved: true },
    { composing: { isComposing: false, keyCode: 27 }, preserved: false },
  ]) {
    let query = 'unfinished search', selected = ['saved-task'], prevented = false;
    handleTaskSearchEscape({ key: 'Escape', nativeEvent: composing, preventDefault() { prevented = true; } },
      query, () => { query = ''; selected = []; });
    assert.equal(query, preserved ? 'unfinished search' : '');
    assert.deepEqual(selected, preserved ? ['saved-task'] : []);
    assert.equal(prevented, !preserved);
  }
});

test('empty search and unrelated keys do not reset selection or consume the key', () => {
  for (const [key, query] of [['Escape', ''], ['Enter', 'kept query']]) {
    let cleared = false, prevented = false;
    handleTaskSearchEscape({ key, nativeEvent: { isComposing: false, keyCode: 27 },
      preventDefault() { prevented = true; } }, query, () => { cleared = true; });
    assert.equal(cleared, false);
    assert.equal(prevented, false);
  }
});

function fixture() {
  class Element {
    isConnected = true; hidden = false; visible = true; visibility = 'visible';
    isContentEditable = false; writing = false; disabled = false; readOnly = false;
    value = ''; focused = 0;
    closest(selector: string) { return (selector.includes('[hidden]') ? this.hidden : this.writing) ? this : null; }
    getClientRects() { return this.visible ? [{}] : []; }
    focus() { this.focused++; document.activeElement = this; }
  }
  const input = new Element(), quick = new Element(), body = new Element();
  input.writing = quick.writing = true; input.value = 'kept search'; quick.value = 'unsent writing';
  const document = { activeElement: body, overlays: [] as Element[], querySelectorAll() { return this.overlays; } };
  const listeners = new Set<(event: any) => void>();
  const owner = { document, getComputedStyle: (node: Element) => ({ visibility: node.visibility }),
    addEventListener: (_: string, callback: (event: any) => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: (event: any) => void) => listeners.delete(callback) };
  let current: Element | null = input;
  const close = bindTaskSearchShortcut(() => current as unknown as HTMLInputElement | null, owner as unknown as Window);
  const press = (options: Record<string, unknown> = {}) => {
    const event = { key: '/', target: body, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const listener of listeners) listener(event);
    return event;
  };
  return { input, quick, body, document, press, close, listeners, Element, remove: () => { current = null; } };
}

test('slash focuses existing search without changing the query or unsent writing; unmount releases the shortcut', () => {
  const h = fixture();
  assert.equal(h.press().defaultPrevented, true);
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.input.value, 'kept search');
  assert.equal(h.quick.value, 'unsent writing');
  h.close(); assert.equal(h.listeners.size, 0);
  h.document.activeElement = h.body;
  assert.equal(h.press().defaultPrevented, false);
  assert.equal(h.document.activeElement, h.body);
});

test('writing, composition, other shortcuts, repeated and consumed events keep their focus and key', () => {
  for (const options of [{ key: 'x' }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true },
    { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    const h = fixture(); h.press(options); assert.equal(h.input.focused, 0); h.close();
  }
  for (const activeOnly of [false, true]) {
    const h = fixture(); h.document.activeElement = h.quick;
    assert.equal(h.press({ target: activeOnly ? h.body : h.quick }).defaultPrevented, false);
    assert.equal(h.input.focused, 0); assert.equal(h.quick.value, 'unsent writing'); h.close();
  }
  const h = fixture(); h.body.isContentEditable = true;
  assert.equal(h.press().defaultPrevented, false); assert.equal(h.input.focused, 0); h.close();
});

test('shift producing slash is supported on international keyboards', () => {
  const h = fixture(); assert.equal(h.press({ shiftKey: true }).defaultPrevented, true);
  assert.equal(h.document.activeElement, h.input); h.close();
});

test('visible modal and menu overlays retain keyboard control; hidden overlays do not block Tasks', () => {
  const h = fixture(), overlay = new h.Element(); h.document.overlays.push(overlay);
  assert.equal(h.press().defaultPrevented, false); assert.equal(h.input.focused, 0);
  overlay.hidden = true; assert.equal(h.press().defaultPrevented, true); h.close();
});

test('missing, detached, disabled, read-only or hidden search never consumes the shortcut', () => {
  for (const patch of [{ isConnected: false }, { disabled: true }, { readOnly: true }, { hidden: true },
    { visible: false }, { visibility: 'hidden' }, { visibility: 'collapse' }]) {
    const h = fixture(); Object.assign(h.input, patch);
    assert.equal(h.press().defaultPrevented, false); assert.equal(h.input.focused, 0); h.close();
  }
  const h = fixture(); h.remove(); assert.equal(h.press().defaultPrevented, false); h.close();
});
