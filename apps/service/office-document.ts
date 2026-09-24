import type { OfficeKind } from '../../packages/domain/office-attachments.js';
import { attr, children, corrupt, descendants, officeArchive, OfficeReadError, relationships, text, tooLarge, xml, type Xml } from './office-archive.js';

export type OfficeDocument = { kind: OfficeKind; title?: string; parts: { name: string; text: string }[]; notes: string[] };
const expectedTypes: Record<OfficeKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};
const content = (node: Xml): string => node.children.map(child => {
  if (typeof child === 'string') return '';
  if (child.name === 't') return text(child);
  if (child.name === 'tab') return '\t';
  if (child.name === 'br' || child.name === 'cr') return '\n';
  if (child.name === 'del') return '';
  return content(child);
}).join('');
function blocks(node: Xml): string {
  return children(node).map(child => {
    if (child.name === 'p') return content(child);
    if (child.name === 'tbl') return '[Table]\n' + children(child, 'tr').map(row => children(row, 'tc').map(cell => blocks(cell).replace(/\n/g, ' / ')).join('\t')).join('\n') + '\n[/Table]';
    return child.name === 'del' ? '' : blocks(child);
  }).filter(Boolean).join('\n');
}
const drawingText = (node: Xml) => descendants(node, 'p').map(content).filter(Boolean).join('\n');
// Phonetic guides annotate a string; they are not part of its actual value.
const spreadsheetText = (node: Xml): string => children(node).map(child => child.name === 'rPh' ? '' : child.name === 't' ? text(child) : spreadsheetText(child)).join('');

/** Complete bounded textual extraction, never a rendering or formula evaluation. */
export function extractOfficeDocument(bytes: Buffer, kind: OfficeKind): OfficeDocument {
  const files = officeArchive(bytes), types = xml(files.get('[Content_Types].xml'));
  if (types.name !== 'Types') throw corrupt();
  if (children(types).some(node => /macroEnabled|vbaProject|activeX|oleObject/i.test(node.attrs.ContentType ?? ''))) throw new OfficeReadError('office_unsafe', 'This document contains macros or executable embedded content. Supply a macro-free copy.');
  const roots = [...relationships(files, '').values()], main = roots.find(rel => /\/officeDocument$/.test(rel.type));
  if (!main || main.external) throw corrupt();
  const declared = children(types, 'Override').find(node => node.attrs.PartName === '/' + main.target)?.attrs.ContentType
    ?? children(types, 'Default').find(node => node.attrs.Extension === main.target.split('.').pop())?.attrs.ContentType;
  if (declared !== expectedTypes[kind]) throw corrupt();
  const metadata = roots.find(rel => /\/core-properties$/.test(rel.type));
  const title = metadata && !metadata.external ? descendants(xml(files.get(metadata.target)), 'title').map(text).join(' ').trim() : '';
  const notes = ['Textual extraction only: visual layout, pictures, charts and embedded objects are not interpreted. Original file bytes are unchanged.'];
  if ([...files.keys()].some(name => /\/media\//.test(name))) notes.push('This file includes media; its pixels are not part of this text reading.');
  const parts: OfficeDocument['parts'] = []; let characters = title.length;
  const add = (name: string, value: string) => {
    characters += name.length + value.length;
    if (characters > 256000 || parts.length >= 1000) throw tooLarge();
    parts.push({ name, text: value });
  };
  const document = xml(files.get(main.target));
  if (kind === 'docx') {
    if (document.name !== 'document') throw corrupt();
    const body = children(document, 'body')[0]; if (!body) throw corrupt();
    add('Document', blocks(body));
    for (const rel of relationships(files, main.target).values()) {
      if (!rel.external && /\/(header|footer|footnotes|endnotes)$/.test(rel.type)) add(rel.type.split('/').pop()!, blocks(xml(files.get(rel.target))));
    }
    notes.push('Paragraph and table order is preserved. Word pagination, tracked deletions and comments are not included.');
  } else if (kind === 'xlsx') {
    if (document.name !== 'workbook') throw corrupt();
    const links = relationships(files, main.target);
    const stringsRel = [...links.values()].find(rel => /\/sharedStrings$/.test(rel.type));
    const strings = stringsRel && !stringsRel.external ? children(xml(files.get(stringsRel.target)), 'si').map(spreadsheetText) : [];
    const sheets = descendants(document, 'sheet'); if (!sheets.length) throw corrupt();
    for (const sheet of sheets) {
      const rel = links.get(attr(sheet, 'id') ?? '');
      if (!rel || rel.external) throw corrupt();
      const name = `Sheet: ${sheet.attrs.name ?? rel.target}${sheet.attrs.state && sheet.attrs.state !== 'visible' ? ` (${sheet.attrs.state})` : ''}`;
      if (/\/chartsheet$/.test(rel.type)) {
        if (xml(files.get(rel.target)).name !== 'chartsheet') throw corrupt();
        add(name, '[Chart sheet: no worksheet cells. The chart visual is not interpreted.]');
        continue;
      }
      if (!/\/worksheet$/.test(rel.type)) throw corrupt();
      const page = xml(files.get(rel.target)); if (page.name !== 'worksheet') throw corrupt();
      const cells = descendants(page, 'c'); if (cells.length > 50000) throw tooLarge();
      const shared = new Map<string, { address: string; formula: string }>();
      for (const cell of cells) {
        const formula = children(cell, 'f')[0];
        if (formula?.attrs.t === 'shared' && text(formula)) shared.set(formula.attrs.si, { address: cell.attrs.r, formula: text(formula) });
      }
      const seen = new Set<string>();
      const values = cells.map(cell => {
        const address = cell.attrs.r;
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address ?? '') || seen.has(address)) throw corrupt();
        seen.add(address);
        const stored = children(cell, 'v')[0], formula = children(cell, 'f')[0], raw = stored ? text(stored) : undefined;
        let value = raw ?? '';
        if (cell.attrs.t === 's') {
          if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) >= strings.length) throw corrupt();
          value = strings[Number(raw)];
        } else if (cell.attrs.t === 'inlineStr') value = spreadsheetText(cell);
        else if (cell.attrs.t === 'b') { if (raw !== '0' && raw !== '1') throw corrupt(); value = raw === '1' ? 'TRUE' : 'FALSE'; }
        let expression = formula ? text(formula) : '';
        if (formula?.attrs.t === 'shared' && !expression) {
          const origin = shared.get(formula.attrs.si); if (!origin) throw corrupt();
          expression = `[shared from ${origin.address}: ${origin.formula}; relative references not expanded]`;
        }
        return `${address}: ${JSON.stringify(value)}${formula ? ` | formula: ${expression || '[formula text not stored]'} | cached value: ${raw === undefined ? '[not stored; not evaluated]' : JSON.stringify(value)}` : ''}`;
      });
      const merges = descendants(page, 'mergeCell').map(node => node.attrs.ref).filter(Boolean);
      add(name, values.join('\n') + (merges.length ? '\nMerged cells: ' + merges.join(', ') : ''));
    }
    notes.push('Cell addresses, stored values, sheet names and formulas are preserved. Formulas are not executed or recalculated; cached results may be stale. Numeric date serials and display formatting are not converted.');
  } else {
    if (document.name !== 'presentation') throw corrupt();
    const links = relationships(files, main.target), slides = descendants(document, 'sldId');
    if (!slides.length) throw corrupt();
    for (const [index, slide] of slides.entries()) {
      // The numeric slide id and relationship id have different namespaces.
      const id = Object.entries(slide.attrs).find(([name]) => name.includes(':') && name.endsWith(':id'))?.[1];
      const rel = links.get(id ?? ''); if (!rel || rel.external || !/\/slide$/.test(rel.type)) throw corrupt();
      const page = xml(files.get(rel.target)); if (page.name !== 'sld') throw corrupt();
      const note = [...relationships(files, rel.target).values()].find(value => /\/notesSlide$/.test(value.type));
      if (note?.external) throw corrupt();
      const notesText = note ? drawingText(xml(files.get(note.target))) : '';
      add(`Slide ${index + 1}`, drawingText(page) + (note ? '\n\nSpeaker notes:\n' + notesText : ''));
    }
    notes.push('Slides follow presentation order. Text and speaker notes are included; animations, layout and visual-only diagrams are not interpreted.');
  }
  if (!parts.some(part => part.text.trim())) notes.push('No readable text was found. Do not infer missing content from the file name.');
  return { kind, ...(title ? { title } : {}), parts, notes };
}

export function officeDocumentText(document: OfficeDocument): string {
  return [document.title ? `Title: ${document.title}` : '', ...document.notes, ...document.parts.map((part, index) => `\n[${index + 1}/${document.parts.length} ${part.name}]\n${part.text}`)].filter(Boolean).join('\n');
}
