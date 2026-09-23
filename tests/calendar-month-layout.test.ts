import test from 'node:test';
import assert from 'node:assert/strict';
import { monthEventGeometry, monthEventLayout } from '../apps/client/src/calendar-month-layout';

test('a short month cell reserves an honest count instead of clipping its third event', () => {
  assert.deepEqual(monthEventLayout(3, 40), { visible: 1, hidden: 2, inlineOverflow: false });
  assert.deepEqual(monthEventLayout(2, 40), { visible: 1, hidden: 1, inlineOverflow: false });
  assert.deepEqual(monthEventLayout(1, 40), { visible: 1, hidden: 0, inlineOverflow: false });
});

test('resizing reveals complete rows and retains the existing three-event summary limit', () => {
  assert.deepEqual(monthEventLayout(3, 64), { visible: 3, hidden: 0, inlineOverflow: false });
  assert.deepEqual(monthEventLayout(4, 64), { visible: 2, hidden: 2, inlineOverflow: false });
  assert.deepEqual(monthEventLayout(7, 200), { visible: 3, hidden: 4, inlineOverflow: false });
  assert.deepEqual(monthEventLayout(3, 63.9), { visible: 2, hidden: 1, inlineOverflow: false });
});

test('a cell too short for even the summary moves its complete count to the date control', () => {
  assert.deepEqual(monthEventLayout(3, 15), { visible: 0, hidden: 3, inlineOverflow: true });
  assert.deepEqual(monthEventLayout(3, 16), { visible: 0, hidden: 3, inlineOverflow: false });
  assert.deepEqual(monthEventLayout(0, 0), { visible: 0, hidden: 0, inlineOverflow: false });
});

test('every ordinary-height result fits complete rows and accounts for every saved event', () => {
  const { event, more, gap } = monthEventGeometry;
  for (let count = 0; count <= 20; count++) for (let height = 0; height <= 150; height++) {
    const result = monthEventLayout(count, height);
    assert.equal(result.visible + result.hidden, count);
    if (result.inlineOverflow) { assert.equal(result.visible, 0); assert.ok(height < more); }
    else {
      const rows = result.visible + Number(result.hidden > 0);
      assert.ok(result.visible * event + (result.hidden ? more : 0) + Math.max(0, rows - 1) * gap <= height);
    }
  }
});
