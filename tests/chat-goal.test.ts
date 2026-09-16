import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatGoalSchema, goalElapsedMs, goalElapsedLabel } from '../packages/domain/chat-goal.js';

test('goal elapsed time uses native timestamps across reload, resume and each stop state', () => {
  const goal = chatGoalSchema.parse({ id: 'goal', objective: 'Finish the work', status: 'active', createdAt: 100000, updatedAt: 110000 });
  assert.equal(goalElapsedMs(goal, 129000), 29000);
  assert.equal(goalElapsedMs(JSON.parse(JSON.stringify(goal)), 161000), 61000);
  for (const [status, field] of [['paused', 'pausedAt'], ['blocked', 'blockedAt'], ['usage_limited', 'usageLimitedAt'], ['budget_limited', 'budgetLimitedAt'], ['complete', 'completedAt']]) {
    const stopped = chatGoalSchema.parse({ ...goal, status, [field]: 125000, updatedAt: 130000 });
    assert.equal(goalElapsedMs(stopped, 990000), 25000);
    assert.equal(goalElapsedMs(chatGoalSchema.parse({ ...goal, status, updatedAt: 140000 }), 990000), 40000);
    assert.equal(goalElapsedMs({ ...stopped, status: 'active' }, 180000), 80000);
  }
  assert.equal(goalElapsedMs({ ...goal, createdAt: undefined }, 990000), undefined);
  assert.equal(goalElapsedMs({ ...goal, status: 'paused', updatedAt: undefined }, 990000), undefined);
  assert.equal(goalElapsedMs(goal, 90000), 0);
});
test('goal elapsed labels stay compact and keep minute and hour boundaries accurate', () => {
  for (const [milliseconds, label] of [[0, '0s'], [59999, '59s'], [60000, '1m 00s'], [61000, '1m 01s'], [3599999, '59m 59s'], [3600000, '1h 00m 00s'], [3661000, '1h 01m 01s']] as const) assert.equal(goalElapsedLabel(milliseconds), label);
});
