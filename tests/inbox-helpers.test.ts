// Unit tests for Inbox domain helpers.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeEmail, extractEmail, parseAddressList, isValidEmailAddress, sanitizeEmailHref, escapeHtml, buildManualSignatureHtml,
} from '../apps/client/src/dreamclaw/pages/Inbox/inbox-address.js';
import {
  formatMessageDate, formatThreadListDate, ensureReplySubject, toCalendarDateValue, toCalendarTimeValue,
} from '../apps/client/src/dreamclaw/pages/Inbox/inbox-format.js';
import {
  normalizeInboxBucket, normalizeInboxDensity, normalizeInboxCategoryFilter,
  bucketLabel, bucketDescription, categoryLabel, triageCategoryLabel,
} from '../apps/client/src/dreamclaw/pages/Inbox/inbox-classify.js';

describe('inbox-address', () => {
  it('normalizes email case and whitespace', () => {
    assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  });
  it('extracts email from angle brackets', () => {
    assert.equal(extractEmail('Hatim <hatim@example.com>'), 'hatim@example.com');
  });
  it('extracts plain email', () => {
    assert.equal(extractEmail('hatim@example.com'), 'hatim@example.com');
  });
  it('parses comma-separated address lists', () => {
    assert.deepEqual(parseAddressList('a@example.com, B <b@example.com>'), ['a@example.com', 'b@example.com']);
  });
  it('validates email addresses', () => {
    assert.equal(isValidEmailAddress('hatim@example.com'), true);
    assert.equal(isValidEmailAddress('not-an-email'), false);
    assert.equal(isValidEmailAddress('missing@tld'), false);
  });
  it('sanitizes hrefs to safe protocols', () => {
    assert.equal(sanitizeEmailHref('mailto:a@example.com'), 'mailto:a@example.com');
    assert.equal(sanitizeEmailHref('https://example.com'), 'https://example.com/');
    assert.equal(sanitizeEmailHref('javascript:alert(1)'), null);
    assert.equal(sanitizeEmailHref(''), null);
  });
  it('escapes HTML entities', () => {
    assert.equal(escapeHtml('<a href="x">&\'test\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;test&#39;');
  });
  it('builds signature HTML with line breaks', () => {
    assert.equal(buildManualSignatureHtml('Line one\nLine two'), '<div dir="ltr">Line one<br>Line two</div>');
    assert.equal(buildManualSignatureHtml(''), '');
    assert.equal(buildManualSignatureHtml('  '), '');
  });
});

describe('inbox-format', () => {
  it('formats message dates', () => {
    const formatted = formatMessageDate('2026-09-26T10:30:00Z');
    assert.match(formatted, /Sep 26/);
  });
  it('returns fallback for missing message date', () => {
    assert.equal(formatMessageDate(undefined), 'Unknown time');
    assert.equal(formatMessageDate(''), 'Unknown time');
  });
  it('formats thread list dates', () => {
    assert.equal(formatThreadListDate(undefined), '');
    assert.equal(formatThreadListDate(''), '');
    const today = formatThreadListDate(new Date().toISOString());
    assert.match(today, /:/); // time format for today
  });
  it('ensures reply subject has Re: prefix', () => {
    assert.equal(ensureReplySubject('Hello'), 'Re: Hello');
    assert.equal(ensureReplySubject('Re: Hello'), 'Re: Hello');
    assert.equal(ensureReplySubject(''), 'Re: (no subject)');
  });
  it('formats calendar date and time values', () => {
    const date = new Date(2026, 8, 26, 14, 30); // Sep 26, 2026 2:30 PM local
    assert.equal(toCalendarDateValue(date), '2026-09-26');
    assert.equal(toCalendarTimeValue(date), '14:30');
  });
});

describe('inbox-classify', () => {
  it('normalizes bucket values', () => {
    assert.equal(normalizeInboxBucket('urgent'), 'urgent');
    assert.equal(normalizeInboxBucket('bogus'), 'all');
    assert.equal(normalizeInboxBucket(null), 'all');
  });
  it('normalizes density values', () => {
    assert.equal(normalizeInboxDensity('spacious'), 'spacious');
    assert.equal(normalizeInboxDensity('bogus'), 'compact');
  });
  it('normalizes category filter values', () => {
    assert.equal(normalizeInboxCategoryFilter('personal_outreach'), 'personal_outreach');
    assert.equal(normalizeInboxCategoryFilter('bogus'), 'all');
  });
  it('labels buckets', () => {
    assert.equal(bucketLabel('urgent'), 'Urgent');
    assert.equal(bucketLabel('needs_reply'), 'Needs reply');
    assert.equal(bucketLabel('all'), 'All');
  });
  it('describes buckets', () => {
    assert.match(bucketDescription('urgent'), /attention/i);
    assert.match(bucketDescription('all'), /every/i);
  });
  it('labels categories', () => {
    assert.equal(categoryLabel('personal_outreach'), 'Outreach');
    assert.equal(categoryLabel('all'), 'All categories');
    assert.equal(triageCategoryLabel('all'), 'All triage');
    assert.equal(triageCategoryLabel('calendar_logistics'), 'Calendar');
  });
});
