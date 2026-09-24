import test from 'node:test';
import assert from 'node:assert/strict';
import { DictationDraft } from '../apps/client/src/dictation-draft';

test('interim speech appears at the caret and finals replace it without duplication', () => {
  const d = new DictationDraft(); d.begin('Please tomorrow.', 7);
  let text = d.update('Please tomorrow.', 'res', 'one');
  assert.equal(text, 'Please res tomorrow.');
  text = d.update(text, 'reschedule', 'one');
  assert.equal(text, 'Please reschedule tomorrow.');
  assert.equal(d.update(text, 'reschedule', 'one'), text);
  assert.equal(d.update(text, 'reschedule our call', 'one'), 'Please reschedule our call tomorrow.');
});

test('a selected phrase is preserved through silence and replaced only when speech arrives', () => {
  const d = new DictationDraft(); d.begin('Meet Monday.', 5, 11);
  assert.equal(d.update('Meet Monday.', '', 'one'), 'Meet Monday.');
  assert.equal(d.update('Meet Monday.', 'Tuesday', 'one'), 'Meet Tuesday.');
});

test('a bulk draft replacement retires speech rather than guessing which edits to overwrite', () => {
  const d = new DictationDraft(); d.begin('Notes:');
  let text = d.update('Notes:', 'meet Jon', 'one');
  text = 'My ' + text + ' tomorrow'; assert.equal(d.edit(text), false);
  assert.equal(d.update(text, 'meet John', 'one'), text);
});

test('separate surrounding edits rebase the dictated span', () => {
  const d = new DictationDraft(); d.begin('Notes:');
  let text = d.update('Notes:', 'meet Jon', 'one');
  text = 'My ' + text; assert.equal(d.edit(text), true);
  text += ' tomorrow'; assert.equal(d.edit(text), true);
  assert.equal(d.update(text, 'meet John', 'one'), 'My Notes: meet John tomorrow');
});

test('editing or deleting dictated words stops ownership and late finals cannot restore them', () => {
  for (const edited of ['Notes: meet Sam', 'Notes:']) {
    const d = new DictationDraft(); d.begin('Notes:'); d.update('Notes:', 'meet Jon', 'one');
    assert.equal(d.edit(edited), false);
    assert.equal(d.update(edited, 'meet John at noon.', 'one'), edited);
  }
});

test('manual edits stop speech ownership even when repeated text hides the edit location', () => {
  const d = new DictationDraft(); d.begin('Notes: ');
  d.update('Notes: ', 'aaa', 'one');
  d.replace('Notes: aaaa');
  assert.equal(d.update('Notes: aaaa', 'bbb', 'one'), 'Notes: aaaa');
  d.begin('Notes: aaaa');
  assert.equal(d.update('Notes: aaaa', 'next', 'two'), 'Notes: aaaa next');
});

test('a different attempt cannot write through an old span; a fresh recording appends normally', () => {
  const d = new DictationDraft(); let text = d.update('', 'First sentence.', 'one');
  assert.equal(d.update(text, 'stale', 'other'), text);
  d.begin(text); text = d.update(text, 'Second sentence.', 'two');
  assert.equal(text, 'First sentence. Second sentence.');
  assert.equal(d.update(text, 'late first', 'one'), text);
});

test('combined draft limit rejects overflow without truncating or losing the owned span', () => {
  const d = new DictationDraft(), original = 'x'.repeat(99995); d.begin(original);
  const text = d.update(original, 'one', 'one');
  assert.equal(text.length, 99999);
  assert.throws(() => d.update(text, 'one more word', 'one'), /draft is full/);
  assert.equal(d.update(text, 'two', 'one'), original + ' two');
});
