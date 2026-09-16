import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../apps/service/store.js';
import { MailImages, referencedEmailImages } from '../apps/service/mail-images.js';
import { emailImageType, fetchEmailImage, publicImageAddress } from '../apps/service/email-image-fetch.js';
import { emailImageUrl, mapEmailImageCss } from '../packages/domain/email-images.js';
import { accountCapabilities } from '../apps/service/providers.js';
import type { ConnectedAccount } from '../packages/domain/accounts.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function fixture(html: string) {
  const dir = mkdtempSync(join(tmpdir(), 'edition3-mail-images-')), store = new Store(dir);
  let account: ConnectedAccount = { id: 'google:' + randomUUID(), generation: randomUUID(), provider: 'google', subject: 'fixture', email: 'image@example.test', label: 'Images', state: 'connected', revision: 1, scopes: [], capabilities: accountCapabilities('google', ['https://www.googleapis.com/auth/gmail.readonly']), connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const input = { epoch: store.epoch, accountId: account.id, generation: account.generation, threadId: 'thread', messageId: 'selected' };
  const calls: string[] = [];
  const accounts = { state: () => ({ accounts: [account], clients: [], attempts: [], probes: [] }), mailRead: async () => ({ value: { thread: { id: 'thread', messages: [
    { id: 'other', payload: { mimeType: 'text/html', body: { data: Buffer.from('<img src="https://other.example/private.png">').toString('base64') } } },
    { id: 'selected', payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64') } } },
  ] } } }) };
  return { store, input, calls, accounts, changeAccount: () => { account = { ...account, generation: randomUUID() }; },
    service: (load = async (url: string) => { calls.push(url); return { bytes: pixel, mimeType: 'image/png' }; }) => new MailImages(store, accounts, load),
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('image discovery preserves message image references, backgrounds and head CSS without hidden pixels or active URLs', () => {
  const html = '<head><style>.hero{background:url("https://cdn.example/hero.png")}</style></head><body background="//cdn.example/bg.png"><img src="https://cdn.example/photo.png?a=1&amp;b=2"><img src="https://cdn.example/photo.png?a=1&amp;b=2"><img width="1" height="1" src="https://tracking.example/pixel"><img style="display: none" src="https://tracking.example/hidden"><img src="cid:logo"><img src="javascript:bad"></body>';
  assert.deepEqual(referencedEmailImages(html), ['https://cdn.example/hero.png', 'https://cdn.example/bg.png', 'https://cdn.example/photo.png?a=1&b=2']);
  assert.equal(emailImageUrl('https://user:secret@example.com/a.png'), undefined);
  assert.equal(emailImageUrl('file:///private/image'), undefined);
  assert.equal(mapEmailImageCss('background:url(https://cdn.example/a);color:red', () => undefined), 'background:none;color:red');
});

test('image bytes are loaded only for the exact current message and unavailable images preserve successful results', async () => {
  const f = fixture('<img src="https://cdn.example/good.png"><img src="https://cdn.example/gone.png">');
  try {
    const service = f.service(async url => { f.calls.push(url); if (url.endsWith('gone.png')) throw Error('private upstream response'); return { bytes: pixel, mimeType: 'image/png' }; });
    const result = await service.read('owner', f.input);
    assert.equal(result.messageId, 'selected'); assert.equal(result.unavailable, 1);
    assert.equal(Object.keys(result.images).length, 1); assert.match(result.images['https://cdn.example/good.png'], /^data:image\/png;base64,/);
    assert.ok(!f.calls.some(url => url.includes('other.example')));
    assert.doesNotMatch(JSON.stringify(result), /private upstream response/);
    await assert.rejects(service.read('owner', { ...f.input, messageId: 'missing' }), /selected message/);
    await assert.rejects(service.read('owner', { ...f.input, url: 'http://localhost/' }));
    const calls = f.calls.length; f.changeAccount();
    await assert.rejects(service.read('owner', f.input), /account connection/); assert.equal(f.calls.length, calls);
  } finally { f.close(); }
});

test('newsletter stylesheet imports and web fonts never become required email images', async () => {
  const css = `@import url(https://fonts.example/custom_fonts.css);
    @IMPORT "https://fonts.example/another;sheet.css" screen;
    @font-face {font-family: "Brand; }"; src: url('https://fonts.example/brand.woff2') format('woff2');}
    /* url(https://fonts.example/comment.png) */
    @media (min-width:480px) {.hero {background-image:url(https://cdn.example/hero.png)}}
    .title {font-family:Brand,Arial,sans-serif;color:red}`;
  const html = `<head><style>${css}</style></head><body><img src="https://cdn.example/photo.png"></body>`;
  assert.deepEqual(referencedEmailImages(html), ['https://cdn.example/hero.png', 'https://cdn.example/photo.png']);
  const sources: string[] = [];
  const rendered = mapEmailImageCss(css, src => { sources.push(src); return 'data:image/png;base64,' + pixel.toString('base64'); });
  assert.deepEqual(sources, ['https://cdn.example/hero.png']);
  assert.doesNotMatch(rendered, /@import|@font-face|fonts\.example/i);
  assert.match(rendered, /@media.*background-image:url\("data:image\/png;base64,/);
  assert.match(rendered, /font-family:Brand,Arial,sans-serif;color:red/);
  const f = fixture(html);
  try {
    const result = await f.service(async url => {
      f.calls.push(url); if (!url.startsWith('https://cdn.example/')) throw Error('Not an image');
      return { bytes: pixel, mimeType: 'image/png' };
    }).read('owner', f.input);
    assert.equal(result.unavailable, 0); assert.equal(Object.keys(result.images).length, 2);
  } finally { f.close(); }
});

test('account changes during image loading fence the response and image decode limits reject active or oversized content', async () => {
  const f = fixture('<img src="https://cdn.example/image.png">');
  try {
    await assert.rejects(f.service(async () => { f.changeAccount(); return { bytes: pixel, mimeType: 'image/png' }; }).read('owner', f.input), /account connection/);
    assert.equal(emailImageType(Buffer.from('<svg onload="bad()"/>')), undefined);
    const large = Buffer.from(pixel); large.writeUInt32BE(100000, 16); assert.equal(emailImageType(large), undefined);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    assert.equal(emailImageType(gif), 'image/gif'); assert.equal(emailImageType(gif.subarray(0, gif.length - 1)), undefined);
  } finally { f.close(); }
});

test('image fetch rejects local, private, relay, metadata and non-image addresses before a request', async () => {
  for (const ip of ['127.0.0.1','10.0.0.5','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1']) assert.equal(publicImageAddress(ip), false, ip);
  assert.equal(publicImageAddress('8.8.8.8'), true);
  for (const url of ['http://127.0.0.1/image.png','http://169.254.169.254/image.png','file:///etc/passwd','https://user:secret@example.com/a.png','http://example.com:4383/api/snapshot']) await assert.rejects(fetchEmailImage(url, AbortSignal.timeout(1000)));
});

const turn = () => new Promise(resolve => setImmediate(resolve));
test('four image downloads overlap, duplicate readers share work, and repeat opens reuse original bytes', async () => {
  const f = fixture(Array.from({length: 9}, (_, i) => `<img src="https://cdn.example/${i}.png">`).join(''));
  const waiting: (() => void)[] = []; let active = 0, peak = 0, reads = 0;
  const read = f.accounts.mailRead; f.accounts.mailRead = async () => { reads++; return read(); };
  const service = f.service(async url => { f.calls.push(url); peak = Math.max(peak, ++active); await new Promise<void>(resolve => waiting.push(resolve)); active--; return { bytes: pixel, mimeType: 'image/png' }; });
  try {
    const first = service.read('owner', f.input), duplicate = service.read('other-device', f.input);
    await turn(); assert.equal(active, 4); assert.equal(reads, 1);
    while (waiting.length) { waiting.splice(0).forEach(resolve => resolve()); await turn(); }
    const [result, shared] = await Promise.all([first, duplicate]);
    assert.equal(peak, 4); assert.deepEqual(shared, result); assert.equal(f.calls.length, 9);
    assert.equal(Object.values(result.images)[0], `data:image/png;base64,${pixel.toString('base64')}`);
    assert.deepEqual(await service.read('owner', f.input), result); assert.equal(reads, 1); assert.equal(f.calls.length, 9);
    f.changeAccount(); await assert.rejects(service.read('owner', f.input), /account connection/);
  } finally { f.close(); }
});

test('reader body warming avoids another provider request and a changed body cannot reuse old image references', async () => {
  const f = fixture('<img src="https://cdn.example/old.png">'); const service = f.service(); let reads = 0;
  const read = f.accounts.mailRead; f.accounts.mailRead = async () => { reads++; return read(); };
  const remember = (html: string) => service.remember('owner', f.input.epoch, { ...f.input, kind: 'gmail.thread', value: { thread: { id: f.input.threadId, messages: [{ id: f.input.messageId, payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } } }] } } });
  try {
    remember('<img src="https://cdn.example/first.png">');
    const first = await service.read('owner', f.input); assert.equal(reads, 0); assert.equal(first.unavailable, 0);
    remember('<img src="https://cdn.example/replacement.png">');
    const changed = await service.read('owner', f.input);
    assert.deepEqual(Object.keys(changed.images), ['https://cdn.example/replacement.png']); assert.equal(reads, 0);
    await assert.rejects(service.read('owner', { ...f.input, epoch: randomUUID() }), /workspace recovery/);
  } finally { f.close(); }
});

test('image caches expire, partial retries preserve successful bytes, and entry bounds evict older messages', async () => {
  const f = fixture('<img src="https://cdn.example/good.png"><img src="https://cdn.example/retry.png">');
  let now = 0, fail = true, reads = 0;
  const read = f.accounts.mailRead; f.accounts.mailRead = async () => { reads++; return read(); };
  const service = new MailImages(f.store, f.accounts, async url => { f.calls.push(url); if (fail && url.endsWith('retry.png')) throw Error('Unavailable'); return { bytes: pixel, mimeType: 'image/png' }; }, () => now);
  try {
    assert.equal((await service.read('owner', f.input)).unavailable, 1);
    fail = false; assert.equal((await service.read('owner', f.input)).unavailable, 0);
    assert.equal(f.calls.filter(u => u.endsWith('good.png')).length, 1);
    assert.equal(f.calls.filter(u => u.endsWith('retry.png')).length, 2);
    now = 300001; await service.read('owner', f.input); assert.equal(reads, 2); assert.equal(f.calls.length, 5);
    for (let i = 0; i < 65; i++) service.remember('owner', f.input.epoch, { ...f.input, kind: 'gmail.thread', value: { thread: { id: 'cache-' + i, messages: [{ id: 'm-' + i, payload: {} }] } } });
    await service.read('owner', f.input); assert.equal(reads, 3); assert.equal(f.calls.length, 7);
  } finally { f.close(); }
});

test('parallel completion respects the combined byte cap and warm Outlook bodies use the same exact message binding', async () => {
  const f = fixture(Array.from({length: 6}, (_, i) => `<img src="https://cdn.example/${i}.png">`).join(''));
  try {
    const large = Buffer.alloc(5 * 1024 * 1024); pixel.copy(large);
    const service = f.service(async () => ({ bytes: large, mimeType: 'image/png' }));
    const result = await service.read('owner', f.input);
    assert.equal(Object.keys(result.images).length, 4); assert.equal(result.unavailable, 2);
    const ms = { ...f.accounts.state().accounts[0], provider: 'microsoft' as const };
    const accounts = { state: () => ({ ...f.accounts.state(), accounts: [ms] }), mailRead: async () => { throw Error('Unexpected extra provider read'); } };
    const images = new MailImages(f.store, accounts, async () => ({ bytes: pixel, mimeType: 'image/png' }));
    images.remember('owner', f.input.epoch, { ...f.input, kind: 'microsoft.conversation', value: { messages: [{ id: 'selected', conversationId: 'thread', bodyHtml: '<img src="https://cdn.example/outlook.png">' }] } });
    assert.deepEqual(Object.keys((await images.read('owner', f.input)).images), ['https://cdn.example/outlook.png']);
    await assert.rejects(images.read('owner', { ...f.input, messageId: 'different' }), /Unexpected extra provider read/);
  } finally { f.close(); }
});
