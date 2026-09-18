import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeInboxPreviewText, pickThreadPreviewText } from '../apps/client/src/dreamclaw/services/inbox/previewText';

test('Inbox previews decode complete named and numeric entities once as literal text', () => {
  assert.equal(normalizeInboxPreviewText('Tom &amp; Zo&euml; &mdash; &copy; &#169; &#x1F680; &NotEqualTilde; &semi;'), 'Tom & Zoë — © © 🚀 ≂̸ ;');
  assert.equal(normalizeInboxPreviewText('&#60;img src=x onerror=alert(1)&#62; &lt;script&gt;alert(1)&lt;/script&gt;'), '<img src=x onerror=alert(1)> <script>alert(1)</script>');
  assert.equal(normalizeInboxPreviewText('<team@example.test> 2 < 3 &amp;lt;b&amp;gt;'), '<team@example.test> 2 < 3 &lt;b&gt;');
});

test('Inbox previews preserve malformed, unknown and incomplete entities', () => {
  const literal = '&notARealEntity; &unknown; &amp &copy &#; &#xZZ; &#xD800; &#1114112; &#0; &#128; &AMPERSAND; A&B';
  assert.equal(normalizeInboxPreviewText(literal), literal);
  assert.equal(normalizeInboxPreviewText(`&#${'9'.repeat(400)};`), `&#${'9'.repeat(400)};`);
});

test('Inbox previews collapse encoded and raw repeated preheader padding', () => {
  assert.equal(normalizeInboxPreviewText(`Offer${'&zwnj;&nbsp;'.repeat(40)}Details`), 'Offer Details');
  assert.equal(normalizeInboxPreviewText(`Offer${'\u034f\u200b\u200c\u200d\u2060\u00ad\ufeff\u00a0'.repeat(20)}Details`), 'Offer Details');
  assert.equal(normalizeInboxPreviewText(' \r\nOffer\t&#160;today\n\n Details '), 'Offer today Details');
  assert.equal(normalizeInboxPreviewText('&zwnj; &nbsp;'), '');
  assert.equal(normalizeInboxPreviewText('\u200b\u200b\u200b'), '');
});

test('Inbox previews preserve meaningful international text, joins, emoji and combining marks', () => {
  const international = '👩🏽‍💻 👨‍👩‍👧‍👦 می\u200cروم क्\u200dष ภาษา\u200bไทย e\u0301 a\u034f\u0301 中文 日本語';
  assert.equal(normalizeInboxPreviewText(international), international);
  assert.equal(normalizeInboxPreviewText('می&zwnj;روم &#x1F469;&#x200D;&#x1F4BB; क्&zwj;ष'), 'می\u200cروم 👩‍💻 क्\u200dष');
  assert.equal(normalizeInboxPreviewText('ب\u200d '), 'ب\u200d');
});

test('Inbox preview selection skips cleaned duplicates and filler, retaining provider strings', () => {
  const thread = Object.freeze({ subject: 'News &amp; updates', from: 'Zo&euml;', summary: 'News & updates', latestBody: '&zwnj;&nbsp;'.repeat(20), latestSnippet: 'Details &amp; next steps' });
  assert.equal(pickThreadPreviewText(thread), 'Details & next steps');
  assert.equal(thread.latestBody, '&zwnj;&nbsp;'.repeat(20));
  assert.equal(thread.latestSnippet, 'Details &amp; next steps');
  assert.equal(pickThreadPreviewText({ ...thread, summary: 'Zoë', latestBody: 'Body &copy;', latestSnippet: 'Fallback' }), 'Body ©');
  assert.equal(pickThreadPreviewText({ ...thread, summary: 'News &amp; updates\nRead this next' }), 'Read this next');
  assert.equal(pickThreadPreviewText({ ...thread, summary: 'News & updates - Zoë', latestBody: '', latestSnippet: '' }), '');
});
