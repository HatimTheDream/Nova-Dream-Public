import { crc32, deflateRawSync } from 'node:zlib';
import type { OfficeKind } from '../../packages/domain/office-attachments.js';

/** Original synthetic OOXML fixtures. No captured owner files or QA evidence. */
export function officeZip(entries: Record<string, string | Buffer>, compressed = true): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const raw = Buffer.from(value), bytes = compressed ? deflateRawSync(raw) : raw, path = Buffer.from(name), checksum = crc32(raw);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(compressed ? 8 : 0, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(path.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); header.copy(entry, 8, 6, 26); entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, path, bytes); central.push(entry, path); offset += header.length + path.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const relBase = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const officeRels = (items: [string, string, string][]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, target, type]) => `<Relationship Id="${id}" Target="${target}" Type="${relBase + type}"/>`).join('')}</Relationships>`;
export function officeEntries(kind: OfficeKind): Record<string, string> {
  const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[kind];
  const subtype = { docx: 'wordprocessingml.document', xlsx: 'spreadsheetml.sheet', pptx: 'presentationml.presentation' }[kind];
  const common = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${subtype}.main+xml"/></Types>`,
    '_rels/.rels': officeRels([['main', main, 'officeDocument'], ['core', 'docProps/core.xml', 'core-properties']]),
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Office reading sample</dc:title></cp:coreProperties>',
  };
  if (kind === 'docx') return { ...common,
    [main]: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly &amp; useful</w:t></w:r></w:p><w:p><w:r><w:t>Alpha quantity: 4</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Beta</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>6</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After table</w:t></w:r></w:p></w:body></w:document>',
  };
  if (kind === 'xlsx') return { ...common,
    [main]: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="summary"/><sheet name="Inputs" sheetId="2" state="hidden" r:id="inputs"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': officeRels([['summary', 'worksheets/sheet2.xml', 'worksheet'], ['inputs', 'worksheets/sheet1.xml', 'worksheet'], ['strings', 'sharedStrings.xml', 'sharedStrings']]),
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Total </t></r><r><t>points</t></r></si></sst>',
    'xl/worksheets/sheet2.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(Inputs!B1:B2)</f><v>44</v></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Alpha</t></is></c><c r="B1"><v>12</v></c></row><row r="2"><c r="B2"><v>32</v></c><c r="C2"><f>B2*2</f></c></row></sheetData></worksheet>',
  };
  return { ...common,
    [main]: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="first"/><p:sldId id="257" r:id="second"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': officeRels([['first', 'slides/slide2.xml', 'slide'], ['second', 'slides/slide1.xml', 'slide']]),
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First slide: Alpha 4</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second slide: Beta 6</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': officeRels([['notes', '../notesSlides/notesSlide1.xml', 'notesSlide']]),
    'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note: synthetic slide 2 of 2.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
  };
}
