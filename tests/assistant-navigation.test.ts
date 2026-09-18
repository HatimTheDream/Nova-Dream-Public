import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';

const styles = registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { AssistantNavigation, AssistantSpaceSwitch } = await import('../apps/client/src/AssistantSpaceSwitch');
styles.deregister();

test('Team work stays reachable in both spaces even when switching would interrupt a pending input', () => {
  for (const space of ['chat', 'work'] as const) {
    const buttons: Record<string, string>[] = [];
    const markup = renderToStaticMarkup(createElement(AssistantNavigation, { space, change: () => {}, disabled: true, teamOpen: false, openTeam: () => {} }));
    new Parser({ onopentag(name, attributes) { if (name === 'button') buttons.push(attributes); } }).end(markup);
    assert.equal(buttons.length, 3);
    assert.equal(buttons.filter(button => 'disabled' in button).length, 2);
    assert.equal(buttons.find(button => button.class === 'assistant-team-button')?.disabled, undefined);
    assert.equal(buttons.filter(button => button['aria-pressed'] === 'true').length, 1);
    assert.ok(buttons.every(button => button.type === 'button'));
  }
});

test('keyboard space switching restores its own visible control after remount without stealing focus', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const body = {}, editor = {};
  const found: string[] = [], changed: string[] = [];
  let frame: (() => void) | undefined, focused = 0;
  const document = { body, activeElement: body, getElementById(id: string) { found.push(id); return { querySelector() { return { focus() { focused++; } }; } }; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: () => void) => { frame = callback; return 1; } });
  try {
    const switcher = AssistantSpaceSwitch({ value: 'chat', change: space => changed.push(space), id: 'assistant-navigation-space-switch' });
    const work = (switcher.props.children as ReactElement<{ onClick: (event: { detail: number }) => void }>[]) [1];
    work.props.onClick({ detail: 0 });
    assert.deepEqual(changed, ['work']);
    frame!();
    assert.deepEqual(found, ['assistant-navigation-space-switch']);
    assert.equal(focused, 1);
    document.activeElement = editor;
    work.props.onClick({ detail: 0 }); frame!();
    assert.equal(focused, 1, 'newly focused content retains the keyboard anchor');
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', originalFrame); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
});
