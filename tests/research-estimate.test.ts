import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileResearchEstimate, researchEstimateFraction, researchEstimateInputSchema, ResearchEstimateError, type ResearchEstimateBinding, type ResearchEstimateInput } from '../packages/domain/research-estimate.js';

const at = '2026-09-24T07:00:00.000Z';
const binding: ResearchEstimateBinding = { operationId: 'execution', epoch: 'epoch', nativeRunId: 'native-run', planId: 'plan', planVersion: 1, planDigest: 'a'.repeat(64) };
const input = (): ResearchEstimateInput => ({ expectedRevision: 0, activity: 'Comparing the two source explanations.', basis: 'Reading the longer report is expected to require more effort than confirming the short source.', items: [
  { id: 'source-a', title: 'Confirm the short primary source', effort: 2, status: 'complete' },
  { id: 'source-b', title: 'Read the longer technical report', effort: 8, status: 'active' },
  { id: 'synthesis', title: 'Compare the claims and prepare the cited report', effort: 5, status: 'pending' },
] });
const update = (previous: Parameters<typeof reconcileResearchEstimate>[0], raw: unknown, scope = binding) => reconcileResearchEstimate(previous, raw, at, 4, scope);

test('concrete unequal effort estimates determine progress and retain their explicit basis', () => {
  const estimate = update(undefined, input());
  assert.equal(estimate.revision, 1); assert.equal(estimate.observedSequence, 4); assert.deepEqual(estimate.binding, binding);
  assert.equal(researchEstimateFraction(estimate), 2 / 15);
  assert.match(estimate.basis, /longer report/);
  const next = update(estimate, { ...input(), expectedRevision: 1, items: input().items.map(item => item.id === 'source-b' ? { ...item, status: 'complete' } : item) });
  assert.equal(next.revision, 2); assert.equal(researchEstimateFraction(next), 10 / 15);
  assert.equal(estimate.revision, 1); assert.equal(estimate.items[1].status, 'active', 'Pure reconciliation does not alter prior observations');
});

test('remaining scope can be revised without inventing a monotonic high-water mark', () => {
  const first = update(undefined, input());
  const expanded = update(first, { ...input(), expectedRevision: 1, basis: 'The new appendix requires a separate evidence review.', items: [...input().items, { id: 'appendix', title: 'Review the newly found appendix', effort: 5, status: 'pending' }] });
  assert.equal(researchEstimateFraction(expanded), 2 / 20);
  const narrowed = update(expanded, { ...input(), expectedRevision: 2, basis: 'The comparison only needs the relevant subsection.', items: input().items.map(item => item.id === 'source-b' ? { ...item, effort: 3 } : item) });
  assert.equal(researchEstimateFraction(narrowed), 2 / 10);
});

test('completed work cannot be removed, reopened, renamed or reweighted by a later estimate', () => {
  const first = update(undefined, input());
  const changes = [
    input().items.slice(1),
    input().items.map(item => item.id === 'source-a' ? { ...item, status: 'active' } : item),
    input().items.map(item => item.id === 'source-a' ? { ...item, title: 'A different task' } : item),
    input().items.map(item => item.id === 'source-a' ? { ...item, effort: 9 } : item),
  ];
  for (const items of changes) assert.throws(() => update(first, { ...input(), expectedRevision: 1, items }), (error: unknown) => error instanceof ResearchEstimateError && error.code === 'completed_item_changed');
});

test('revisions and captured binding cannot be reused for another estimate or native run', () => {
  const first = update(undefined, input());
  assert.throws(() => update(undefined, { ...input(), expectedRevision: 1 }), /current research estimate/);
  assert.throws(() => update(first, input()), /current research estimate/);
  for (const changed of [{ operationId: 'other' }, { epoch: 'other' }, { nativeRunId: 'other' }, { planId: 'other' }, { planVersion: 2 }, { planDigest: 'b'.repeat(64) }]) {
    assert.throws(() => update(first, { ...input(), expectedRevision: 1 }, { ...binding, ...changed }), (error: unknown) => error instanceof ResearchEstimateError && error.code === 'binding_changed');
  }
});

test('only native completion may settle the last unfinished work', () => {
  const first = update(undefined, input());
  assert.throws(() => update(first, { ...input(), expectedRevision: 1, items: input().items.map(item => ({ ...item, status: 'complete' })) }), (error: unknown) => error instanceof ResearchEstimateError && error.code === 'unfinished_work_required');
  assert.equal(researchEstimateFraction({ ...first, items: first.items.map(item => ({ ...item, status: 'complete' })) }), null, 'Invalid saved all-complete estimate is not terminal proof');
  const tiny = update(undefined, { ...input(), items: [{ ...input().items[0], effort: 1000 }, { ...input().items[1], effort: Number.MIN_VALUE }] });
  assert.ok(researchEstimateFraction(tiny)! < 1, 'Floating-point rounding cannot report completion while work remains');
});

test('input is bounded, strict and requires uniquely identified positive-effort work', () => {
  const invalid = [
    { ...input(), expectedRevision: -1 }, { ...input(), expectedRevision: .5 }, { ...input(), activity: ' '.repeat(2) }, { ...input(), activity: 'x'.repeat(241) }, { ...input(), basis: 'x'.repeat(501) }, { ...input(), unknown: true },
    { ...input(), items: [] }, { ...input(), items: Array.from({ length: 81 }, (_, index) => ({ ...input().items[1], id: String(index) })) },
    { ...input(), items: [input().items[0], input().items[0]] },
    ...[0, -1, 1001, Infinity, NaN].map(effort => ({ ...input(), items: [{ ...input().items[1], effort }] })),
    { ...input(), items: [{ ...input().items[1], id: 'unsafe/path' }] }, { ...input(), items: [{ ...input().items[1], title: 'x'.repeat(121) }] }, { ...input(), items: [{ ...input().items[1], fraction: .5 }] },
  ];
  for (const raw of invalid) assert.equal(researchEstimateInputSchema.safeParse(raw).success, false);
  assert.equal(researchEstimateFraction(), null);
});
