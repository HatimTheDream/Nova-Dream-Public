import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser, type EmailAddress } from 'mailparser';

const recipients = (rows: EmailAddress[]): string[] => rows.flatMap(row =>
  row.group ? recipients(row.group) : typeof row.address === 'string' ? [row.address] : []);

// Inbound headers are untrusted. Comments and quoted text must not become
// different recipients (GHSA-8c8m-p3m8-cjg8, m943-m63m-w62w, 85x2-q946-cp5h).
const cases = [
  { name: 'nested comments', header: 'Victim (x(y) <evil@evil.example>) <v@victim.example>', expected: /^v@victim\.example$/ },
  { name: 'semicolons inside group comments', header: 'G: (a; <evil@evil.example>) <v@victim.example>;', expected: /^v@victim\.example$/ },
  { name: 'angle brackets inside quoted local parts', header: '<"a@evil.example>"@good.example>', expected: /^(?:"a@evil\.example>"|a@evil\.example>)@good\.example$/ },
];
for (const value of cases) test(`Inbound mail preserves the real address across ${value.name}`, async () => {
  const mail = await simpleParser(Buffer.from(`From: ${value.header}\r\nTo: recipient@example.com\r\nSubject: Isolated Parsing Fixture\r\n\r\nFixture body.`));
  assert(mail.from);
  const actual = recipients(mail.from.value);
  assert.equal(actual.length, 1, 'Comments must not introduce an extra sender');
  assert.match(actual[0], value.expected, 'Quoted/comment text must not redirect the parsed address');
});
