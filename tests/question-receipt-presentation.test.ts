import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { AssistantQuestion } from '../packages/domain/questions';

const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return next(url, context);
} });
const { QuestionReceipt } = await import('../apps/client/src/QuestionReceipt');
hooks.deregister();

function question(): AssistantQuestion {
  return {
    id: 'question', revision: 2, epoch: 'epoch', connectionGeneration: 'generation', conversationId: 'conversation', nativeId: 'native', nativeKey: 'key', fingerprint: 'fingerprint', availability: 'live',
    snapshot: { id: 'native-question', sessionKey: 'key', status: 'answered', createdAtMs: 100, expiresAtMs: 200, questions: [
      { questionId: 'format', header: 'Format', question: 'Which formats should I include?', options: [{ label: 'Slides' }, { label: 'Report' }], multiSelect: true },
      { questionId: 'notes', header: 'Notes', question: 'What else matters?', options: [], isOther: true },
    ], answers: { answers: { notes: ['Keep the examples.\nUse <specific> details & context.'], format: ['Slides', 'Report'] } } },
  };
}

function render(item: AssistantQuestion, compact = false) {
  const markup = renderToStaticMarkup(createElement(QuestionReceipt, { item, compact }));
  const tags: { name: string; attrs: Record<string, string> }[] = [];
  const sections: string[] = [];
  let inItem = false, depth = 0;
  new Parser({
    onopentag(name, attrs) {
      tags.push({ name, attrs });
      if (name === 'div') {
        if (attrs.class === 'question-receipt-item') { inItem = true; depth = 0; sections.push(''); }
        if (inItem) depth++;
      }
    },
    ontext(text) { if (inItem) sections[sections.length - 1] += text; },
    onclosetag(name) { if (inItem && name === 'div' && --depth === 0) inItem = false; },
  }).end(markup);
  return { markup, tags, sections };
}

test('saved question answers are paired by question ID in one user bubble without interactive decision controls', () => {
  const view = render(question());
  assert.equal(view.tags.filter(tag => tag.name === 'article' && tag.attrs.class.includes('message-user')).length, 1);
  assert.ok(view.tags.find(tag => tag.name === 'article')!.attrs.class.split(' ').includes('message-text'));
  assert.deepEqual(view.sections, ['Which formats should I include?SlidesReport', 'What else matters?Keep the examples.\nUse <specific> details & context.']);
  assert.ok(!view.tags.some(tag => ['form', 'input', 'textarea', 'button', 'fieldset'].includes(tag.name)));
  assert.match(view.markup, /&lt;specific&gt; details &amp; context/);
});

test('long questions retain discreet keyboard-accessible expansion without visible icons or truncated saved text', () => {
  const item = question();
  const longQuestion = 'Which information matters?\n' + 'Additional context for this decision. '.repeat(60);
  item.snapshot.questions[0].question = longQuestion;
  const view = render(item, true);
  assert.equal(view.tags.filter(tag => tag.name === 'details').length, 2);
  assert.equal(view.tags.filter(tag => tag.name === 'summary').length, 2);
  assert.ok(view.markup.includes(longQuestion));
  assert.ok(!view.tags.some(tag => tag.name === 'details' && 'open' in tag.attrs));
  assert.ok(!view.tags.some(tag => tag.name === 'svg' || 'data-icon' in tag.attrs));
  assert.match(view.markup, /question-receipt-compact/);
});

test('secret answer bytes are never exposed even if native sanitization was missed', () => {
  for (const flag of ['isSecret', 'secretStore'] as const) {
    const item = question();
    const prompt = item.snapshot.questions[0];
    if (flag === 'isSecret') prompt.isSecret = true;
    else prompt.secretStore = { name: 'PRIVATE_TOKEN', kind: 'secret' };
    item.snapshot.answers!.answers.format = ['sensitive-value-<never-render>', 'another-private-value'];
    const view = render(item);
    assert.ok(!view.markup.includes('sensitive-value'));
    assert.ok(!view.markup.includes('another-private-value'));
    assert.ok(!view.markup.includes('PRIVATE_TOKEN'));
    assert.match(view.markup, /Secret stored\. Its value is hidden\./);
    assert.ok(view.sections[1].includes('Keep the examples.'));
  }
});

test('cancelled and expired requests never display stale answers as user replies', () => {
  for (const status of ['cancelled', 'expired'] as const) {
    const item = question();
    item.snapshot.status = status;
    const view = render(item);
    assert.equal(view.tags.filter(tag => tag.name === 'article').length, 0);
    assert.ok(!view.markup.includes('Keep the examples.'));
    assert.match(view.markup, new RegExp(`Question ${status}`));
  }
});

test('pending or uncertain decisions cannot appear as a confirmed user answer', () => {
  const item = question();
  item.snapshot.status = 'pending';
  assert.equal(render(item).markup, '');
  item.snapshot.status = 'answered';
  for (const state of ['sending', 'unknown'] as const) {
    item.action = { requestId: 'request', kind: 'answer', state };
    assert.equal(render(item).markup, '');
  }
  item.action!.state = 'confirmed';
  assert.ok(render(item).markup.includes('Keep the examples.'));
});

test('missing saved answer contents are marked unavailable instead of fabricated', () => {
  const item = question();
  delete item.snapshot.answers!.answers.notes;
  const view = render(item);
  assert.equal(view.sections[1], 'What else matters?Answer unavailable');
});
