import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPoint, reorderCommit, reorderGesture, reorderScrollDelta, reorderTarget } from '../apps/client/src/reorder-motion';

test('Holding a widget surface yields to text selection and touch scrolling before pickup', () => {
  for (const touch of [false, true]) {
    assert.equal(reorderGesture(0, true, touch, true), 'wait');
    assert.equal(reorderGesture(7, true, touch, true), 'wait');
    assert.equal(reorderGesture(9, true, touch, true), 'cancel');
    assert.equal(reorderGesture(100, true, touch, true), 'cancel');
  }
  assert.equal(reorderGesture(7, false, false, true), 'start', 'The dedicated mouse handle picks up immediately when moved');
  assert.equal(reorderGesture(7, false, true, true), 'start', 'The dedicated touch handle does not require a hold');
  assert.equal(reorderGesture(4, false, true, true), 'wait', 'A normal button press is not a drag');
  assert.equal(reorderGesture(7, false, true, false), 'wait', 'Existing touch reorder behavior stays unchanged');
  assert.equal(reorderGesture(9, false, true, false), 'cancel');
});

test('Module icons allow immediate mouse dragging while touch movement scrolls before pickup', () => {
  assert.equal(reorderGesture(4, false, false, true, true), 'wait', 'A small mouse movement is still a normal module click');
  assert.equal(reorderGesture(7, false, false, true, true), 'start', 'Mouse dragging matches a widget move handle');
  assert.equal(reorderGesture(7, false, true, true, true), 'wait', 'Touch waits for the hold timer');
  assert.equal(reorderGesture(9, false, true, true, true), 'cancel', 'Swiping the module rail remains native scrolling');
  assert.equal(reorderGesture(100, false, true, true, true), 'cancel');
});

test('Module icons target measured narrow rail slots and ignore distant content', () => {
  const slots = [
    { id: 'home', left: 9, top: 40, width: 44, height: 47 },
    { id: 'assistant', left: 9, top: 98, width: 44, height: 47 },
    { id: 'tasks', left: 9, top: 156, width: 44, height: 47 },
  ];
  assert.equal(reorderTarget({ x: 30, y: 122 }, slots), 'assistant');
  assert.equal(reorderTarget({ x: 30, y: 154 }, slots), 'tasks');
  assert.equal(reorderTarget({ x: 110, y: 122 }, slots), null);
  assert.equal(reorderTarget({ x: 30, y: 122 }, slots.map(slot => ({ ...slot, top: slot.top - 58 }))), 'tasks', 'Scrolled targets follow their new viewport positions');
});

test('Drag targeting follows actual variable grid sizes and recognizes the landing placeholder', () => {
  const slots = [
    { id: 'wide', left: 10, top: 20, width: 616, height: 352 },
    { id: 'compact', left: 642, top: 20, width: 300, height: 168 },
    { id: 'standard', left: 642, top: 204, width: 300, height: 352 },
    { id: 'landing', left: 10, top: 388, width: 300, height: 168 },
  ];
  assert.equal(reorderTarget({ x: 600, y: 330 }, slots), 'wide');
  assert.equal(reorderTarget({ x: 650, y: 215 }, slots), 'standard');
  assert.equal(reorderTarget({ x: 35, y: 410 }, slots), 'landing');
  assert.equal(reorderTarget({ x: 640, y: 60 }, slots), 'compact');
  assert.equal(reorderTarget({ x: 350, y: 510 }, slots), null, 'Empty grid space far from a card is not an arbitrary move');
  assert.equal(reorderTarget({ x: 30, y: -40 }, slots), null);
  assert.equal(reorderTarget({ x: 30, y: 40 }, []), null);
});

test('Touch and desktop single-column layouts use their measured rows after scrolling', () => {
  const slots = [{ id: 'one', left: 16, top: -200, width: 358, height: 352 }, { id: 'two', left: 16, top: 168, width: 358, height: 720 }];
  assert.equal(reorderTarget({ x: 180, y: 30 }, slots), 'one');
  assert.equal(reorderTarget({ x: 180, y: 700 }, slots), 'two');
  assert.equal(containsPoint(slots[1], { x: 180, y: 400 }), true);
  assert.equal(containsPoint(slots[1], { x: 400, y: 400 }), false);
});

test('Edge scrolling is continuous, proportional, and bounded across slow frames', () => {
  assert.equal(reorderScrollDelta(200, 0, 400, 16), 0);
  assert.ok(reorderScrollDelta(10, 0, 400, 16) < 0);
  assert.ok(reorderScrollDelta(390, 0, 400, 16) > 0);
  assert.ok(Math.abs(reorderScrollDelta(390, 0, 400, 16)) > Math.abs(reorderScrollDelta(350, 0, 400, 16)));
  assert.equal(reorderScrollDelta(400, 0, 400, 1000), 28.8);
  assert.equal(reorderScrollDelta(500, 0, 400, 16), 0);
  assert.equal(reorderScrollDelta(20, 20, 20, 16), 0);
});

test('Only a completed changed drop with the original membership can be persisted', () => {
  const initial = ['note', 'clock', 'tasks'], preview = ['clock', 'tasks', 'note'];
  assert.deepEqual(reorderCommit(initial, [...initial], preview, true), preview);
  assert.notEqual(reorderCommit(initial, initial, preview, true), preview);
  assert.equal(reorderCommit(initial, initial, preview, false), null);
  assert.equal(reorderCommit(initial, initial, initial, true), null);
  assert.equal(reorderCommit(initial, ['tasks', 'note', 'clock'], preview, true), null);
  assert.equal(reorderCommit(initial, ['note', 'clock'], preview, true), null);
  assert.equal(reorderCommit(initial, initial, ['clock', 'note', 'missing'], true), null);
  assert.equal(reorderCommit(initial, initial, ['clock', 'note', 'note'], true), null);
  assert.deepEqual(initial, ['note', 'clock', 'tasks']);
});
