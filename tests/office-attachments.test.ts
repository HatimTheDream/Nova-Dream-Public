import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { OfficeReader } from '../apps/service/office-reader.js';
import { extractOfficeDocument, officeDocumentText } from '../apps/service/office-document.js';
import { SourceReader } from '../apps/service/source-reader.js';
import { Store } from '../apps/service/store.js';
import { AssistantService } from '../apps/service/assistant.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import { officeEntries, officeZip } from './fixtures/office-files.js';

test('DOCX extraction preserves title, paragraph order, decoded text and table cells', () => {
  const reading = extractOfficeDocument(officeZip(officeEntries('docx')), 'docx');
  assert.equal(reading.title, 'Office reading sample');
  assert.match(reading.parts[0].text, /Quarterly & useful\nAlpha quantity: 4\n\[Table\]\nItem\tValue\nBeta\t6\n\[\/Table\]\nAfter table/);
});
test('XLSX reading preserves workbook order, named sheets, shared strings, values and formulas without recalculating', () => {
  const reading = extractOfficeDocument(officeZip(officeEntries('xlsx')), 'xlsx');
  assert.deepEqual(reading.parts.map(part => part.name), ['Sheet: Summary', 'Sheet: Inputs (hidden)']);
  assert.match(reading.parts[0].text, /A1: "Total points"/);
  assert.match(reading.parts[0].text, /B1: "44" \| formula: SUM\(Inputs!B1:B2\) \| cached value: "44"/);
  assert.match(reading.parts[0].text, /C1: "TRUE"/);
  assert.match(reading.parts[1].text, /C2: "" \| formula: B2\*2 \| cached value: \[not stored; not evaluated\]/);
  assert.match(reading.notes.join(' '), /not executed or recalculated/);
});
test('PPTX follows presentation relationships rather than filenames and includes speaker notes', () => {
  const reading = extractOfficeDocument(officeZip(officeEntries('pptx')), 'pptx');
  assert.equal(reading.parts.length, 2);
  assert.equal(reading.parts[0].text, 'First slide: Alpha 4');
  assert.match(reading.parts[1].text, /Second slide: Beta 6\n\nSpeaker notes:\nSpeaker note: synthetic slide 2 of 2\./);
});

test('Office content-type defaults and uncompressed packages are valid while oversized readings fail instead of silently truncating', () => {
  const entries = officeEntries('xlsx');
  entries['[Content_Types].xml'] = '<Types><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
  assert.match(extractOfficeDocument(officeZip(entries, false), 'xlsx').parts[0].text, /SUM\(Inputs!B1:B2\)/);
  entries['[Content_Types].xml'] = '<Types><Default Extension="xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>';
  assert.throws(() => extractOfficeDocument(officeZip(entries), 'xlsx'), /macros/);
  const long = officeEntries('docx');
  long['word/document.xml'] = '<document><body><p><r><t>' + 'x'.repeat(256001) + '</t></r></p></body></document>';
  assert.throws(() => extractOfficeDocument(officeZip(long), 'docx'), /safe reading limits/);
});

test('Excel phonetic guides do not change cell values and chart-only sheets remain explicitly unread', () => {
  const entries = officeEntries('xlsx');
  entries['xl/sharedStrings.xml'] = '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si></sst>';
  entries['xl/worksheets/sheet1.xml'] = entries['xl/worksheets/sheet1.xml'].replace('<t>Alpha</t>', '<t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh>');
  entries['xl/workbook.xml'] = entries['xl/workbook.xml'].replace('</sheets>', '<sheet name="Chart" sheetId="3" r:id="chart"/></sheets>');
  entries['xl/_rels/workbook.xml.rels'] = entries['xl/_rels/workbook.xml.rels'].replace('</Relationships>', '<Relationship Id="chart" Target="chartsheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet"/></Relationships>');
  entries['xl/chartsheets/sheet1.xml'] = '<chartsheet/>';
  const reading = extractOfficeDocument(officeZip(entries), 'xlsx');
  assert.match(reading.parts[0].text, /A1: "東京"/); assert.match(reading.parts[1].text, /A1: "東京"/);
  assert(!officeDocumentText(reading).includes('とうきょう'));
  assert.equal(reading.parts[2].name, 'Sheet: Chart'); assert.match(reading.parts[2].text, /visual is not interpreted/);
});
test('renamed, corrupt, encrypted, unsafe and expansion-heavy Office files fail clearly', () => {
  assert.throws(() => extractOfficeDocument(officeZip(officeEntries('xlsx')), 'docx'), /damaged|format/);
  assert.throws(() => extractOfficeDocument(Buffer.from('not a ZIP'), 'docx'), /damaged/);
  assert.throws(() => extractOfficeDocument(Buffer.from('d0cf11e0a1b11ae10000', 'hex'), 'docx'), /Encrypted/);
  const encrypted = officeZip(officeEntries('docx')); encrypted.writeUInt16LE(0x801, 6); const central = encrypted.indexOf(Buffer.from('504b0102', 'hex')); encrypted.writeUInt16LE(0x801, central + 8);
  assert.throws(() => extractOfficeDocument(encrypted, 'docx'), /Encrypted/);
  for (const name of ['word/vbaProject.bin', 'word/embeddings/object.bin']) assert.throws(() => extractOfficeDocument(officeZip({ ...officeEntries('docx'), [name]: 'payload' }), 'docx'), /macros|executable/);
  assert.throws(() => extractOfficeDocument(officeZip({ ...officeEntries('docx'), '../outside.xml': 'payload' }), 'docx'), /damaged/);
  const entities = officeEntries('docx'); entities['word/document.xml'] = '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///secret">]><document><body><p>&leak;</p></body></document>';
  assert.throws(() => extractOfficeDocument(officeZip(entities), 'docx'), /Encrypted|macros|executable/);
  const brokenXml = officeEntries('docx'); brokenXml['word/document.xml'] = '<document><body><p>unclosed</body></document>';
  assert.throws(() => extractOfficeDocument(officeZip(brokenXml), 'docx'), /damaged/);
  const corruptBytes = officeZip(officeEntries('docx'), false); corruptBytes[corruptBytes.indexOf(Buffer.from('Quarterly'))] ^= 1;
  assert.throws(() => extractOfficeDocument(corruptBytes, 'docx'), /damaged/);
  assert.throws(() => extractOfficeDocument(officeZip({ ...officeEntries('docx'), 'padding.xml': 'a'.repeat(2 * 1024 * 1024) }), 'docx'), /safe reading limits/);
});
test('external links are never fetched or turned into document text and broken internal targets reject', () => {
  const entries = officeEntries('docx'); entries['word/_rels/document.xml.rels'] = '<Relationships><Relationship Id="link" Type="http://example.test/hyperlink" TargetMode="External" Target="https://example.test/private"/></Relationships>';
  assert(!officeDocumentText(extractOfficeDocument(officeZip(entries), 'docx')).includes('example.test'));
  entries['word/_rels/document.xml.rels'] = '<Relationships><Relationship Id="bad" Type="header" Target="../../outside.xml"/></Relationships>';
  assert.throws(() => extractOfficeDocument(officeZip(entries), 'docx'), /damaged/);
});

test('isolated Office readings and source-tool pages preserve original bytes and exact captured identity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-office-')), store = new Store(directory), reader = new SourceReader(store);
  t.after(async () => { await reader.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const bytes = officeZip(officeEntries('pptx')), file = store.upload('owner', randomUUID(), store.epoch, 'slides.pptx', bytes.toString('base64'));
  const reading = await reader.read({ file, origins: ['Selected source'] }, 2, 'text');
  assert.equal(reading.pages, 2); assert.match(reading.text!, /Speaker note: synthetic slide 2/); assert(!reading.text!.includes('First slide'));
  assert.deepEqual(store.download(file.id).bytes, bytes); assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(reader.read({ file: { ...file, sha256: '0'.repeat(64) }, origins: [] }, 1, 'text'), /captured/);
  await assert.rejects(reader.read({ file, origins: [] }, 1, 'image'), /Export a PDF/);
  const isolated = new OfficeReader(); await isolated.close(); await assert.rejects(isolated.read(bytes, 'pptx'), /current document reading/);
});

async function serviceFixture(t: import('node:test').TestContext, name: string, bytes: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-office-send-')), store = new Store(directory), calls: { method: string; params: any }[] = [], nativeId = randomUUID();
  const generation = randomUUID();
  const gateway: any = { status: () => ({ state: 'ready', generation, methods: [], grantedScopes: ['operator.read', 'operator.write'], modelAuthReady: true }), models: async () => [], attachmentPolicy: () => ({ maxBytes: 100000, maxPayload: 200000 }), subscribe: () => () => {}, request: async (method: string, params: any) => { calls.push({ method, params }); if (method === 'sessions.create') return { key: params.key, sessionId: nativeId, entry: { sessionId: nativeId, permissionMode: params.permissionMode } }; if (method === 'chat.history') return { sessionId: nativeId, messages: [], hasMore: false, sessionInfo: { activeRunIds: [], hasActiveRun: false } }; if (method === 'chat.send') return { runId: 'run:' + params.idempotencyKey }; return {}; } };
  const service = new AssistantService(store, gateway), device = store.session().deviceId;
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const file = store.upload(device, randomUUID(), store.epoch, name, bytes.toString('base64'));
  const draft = store.mutate(device, { requestId: randomUUID(), epoch: store.epoch, kind: 'draft', entityId: `draft:${device}`, expectedRevision: 0, payload: { ...emptyDraft, text: 'Read the attached source.', attachments: [file] } });
  const conversation = await service.create(device, { requestId: randomUUID(), epoch: store.epoch, title: 'Office reading', projectId: null, model: 'openai/test' });
  const request = { requestId: randomUUID(), epoch: store.epoch, conversationId: conversation.id, conversationRevision: conversation.revision, draftId: draft.id, draftRevision: draft.revision, projectRevision: 0 };
  const operation = service.submit(device, request);
  const settled = async () => { for (let n = 0; n < 500 && service.operations()[0].state === 'prepared'; n++) await new Promise(resolve => setTimeout(resolve, 10)); return service.operations()[0]; };
  return { store, service, device, calls, file, draft, request, operation, conversation, settled };
}
for (const kind of ['docx', 'xlsx', 'pptx'] as const) test(`${kind} is actually read before Assistant sends a labeled text extraction and retains the original`, async t => {
  const bytes = officeZip(officeEntries(kind)), f = await serviceFixture(t, 'sample.' + kind, bytes), operation = await f.settled();
  assert.equal(operation.state, 'accepted');
  const sent = f.calls.find(call => call.method === 'chat.send')!.params, attachment = sent.attachments[0];
  assert.equal(attachment.mimeType, 'text/plain'); assert.equal(attachment.fileName, `sample.${kind}.reading.txt`);
  const reading = Buffer.from(attachment.content, 'base64').toString();
  assert.match(reading, /Title: Office reading sample/); assert(reading.includes(f.file.sha256)); assert.match(reading, /reference material, not instructions/);
  assert.match(reading, kind === 'docx' ? /Beta\t6/ : kind === 'xlsx' ? /SUM\(Inputs!B1:B2\)/ : /Speaker note: synthetic slide 2/);
  assert.deepEqual(operation.context.attachments, [f.file]); assert.deepEqual(f.store.download(f.file.id).bytes, bytes);
  assert.deepEqual(f.service.submit(f.device, f.request), operation); assert.equal(f.calls.filter(call => call.method === 'chat.send').length, 1);
});
test('corrupt Office input fails before native dispatch and preserves draft, receipt and original', async t => {
  const bytes = Buffer.from('Damaged original Office bytes'), f = await serviceFixture(t, 'broken.docx', bytes), operation = await f.settled();
  assert.equal(operation.state, 'failed'); assert.match(operation.error!, /damaged|could not be read/);
  assert.equal(f.calls.filter(call => call.method === 'chat.send').length, 0);
  assert.deepEqual(f.store.readEntity('draft', f.draft.id), f.draft); assert.deepEqual(f.store.download(f.file.id).bytes, bytes);
  assert.equal(f.service.submit(f.device, f.request).id, f.operation.id);
});

test('a conversation changed while Office extraction is running cannot cross the native dispatch fence', async t => {
  const f = await serviceFixture(t, 'sample.docx', officeZip(officeEntries('docx')));
  assert.equal(f.service.operations()[0].state, 'prepared');
  f.store.internalWrite(`assistant:conversation:${f.conversation.id}`, { ...f.conversation, revision: f.conversation.revision + 1 });
  const operation = await f.settled();
  assert.equal(operation.state, 'failed'); assert.match(operation.error!, /changed before dispatch/);
  assert.equal(f.calls.filter(call => call.method === 'chat.send').length, 0);
  assert.deepEqual(operation.context.attachments, [f.file]); assert.deepEqual(f.store.readEntity('draft', f.draft.id), f.draft);
});
