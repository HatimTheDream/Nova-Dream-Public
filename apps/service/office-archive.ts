import { crc32, inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { Parser } from 'htmlparser2';

export class OfficeReadError extends Error {
  constructor(public code: 'office_corrupt' | 'office_unsafe' | 'office_large', message: string) { super(message + ' The original file is kept.'); }
}
export const corrupt = () => new OfficeReadError('office_corrupt', 'This Office document is damaged or its contents do not match its format.');
export const tooLarge = () => new OfficeReadError('office_large', 'This Office document exceeds the safe reading limits. Split it into smaller files.');
const unsafe = () => new OfficeReadError('office_unsafe', 'Encrypted documents, macros and embedded executable objects cannot be read. Supply an unlocked, macro-free DOCX, XLSX or PPTX copy.');
const utf8 = (bytes: Uint8Array) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw corrupt(); } };
const entryLimit = 8 * 1024 * 1024, expandedLimit = 32 * 1024 * 1024;

/** Parse in memory only. No archive member is written, executed, or fetched. */
export function officeArchive(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > 8 * 1024 * 1024) throw tooLarge();
  if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw unsafe();
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw corrupt();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw corrupt();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (count > 2048) throw tooLarge();
  if (!count || count !== bytes.readUInt16LE(end + 8) || start + size !== end) throw corrupt();
  const files = new Map<string, Buffer>(), ranges: [number, number][] = []; let at = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw corrupt();
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), checksum = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(at + 24), nameLength = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    if (flags & 0x41 || ((bytes.readUInt32LE(at + 38) >>> 16) & 0xf000) === 0xa000) throw unsafe();
    if (next > end || !nameLength || bytes.readUInt16LE(at + 34) || ![0, 8].includes(method)) throw corrupt();
    if (length > entryLimit || (expanded += length) > expandedLimit || length > 1024 * 1024 && length > Math.max(1, compressed) * 200) throw tooLarge();
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength), name = utf8(rawName);
    if (/[\\\0:]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || files.has(name)) throw corrupt();
    if (/(?:^|\/)(?:vbaProject\b|activeX\/|embeddings\/)/i.test(name)) throw unsafe();
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) throw corrupt();
    const localNameLength = bytes.readUInt16LE(offset + 26), data = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (data + compressed > start || !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)) throw corrupt();
    if (!(flags & 8) && (bytes.readUInt32LE(offset + 14) !== checksum || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== length)) throw corrupt();
    if (ranges.some(([from, to]) => offset < to && data + compressed > from)) throw corrupt();
    ranges.push([offset, data + compressed]);
    let output: Buffer;
    try { output = method === 0 ? bytes.subarray(data, data + compressed) : inflateRawSync(bytes.subarray(data, data + compressed), { maxOutputLength: Math.min(entryLimit, length + 1) }); }
    catch { throw corrupt(); }
    if (output.length !== length || crc32(output) !== checksum) throw corrupt();
    files.set(name, output); at = next;
  }
  if (at !== end) throw corrupt();
  return files;
}

export type Xml = { name: string; attrs: Record<string, string>; children: (Xml | string)[] };
export const localName = (name: string) => name.split(':').pop()!;
export const children = (node: Xml, name?: string): Xml[] => node.children.filter((child): child is Xml => typeof child !== 'string' && (!name || child.name === name));
export const descendants = (node: Xml, name: string): Xml[] => children(node).flatMap(child => [...(child.name === name ? [child] : []), ...descendants(child, name)]);
export const text = (node: Xml): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
export const attr = (node: Xml, name: string): string | undefined => Object.entries(node.attrs).find(([key]) => localName(key) === name)?.[1];

const xmlCharacter = (code: number) => code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff;
function xmlValue(bytes: Buffer): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) encoding = 'utf-16be';
  let value: string;
  try { value = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { throw corrupt(); }
  const declared = /^<\?xml\s[^?]*?\bencoding\s*=\s*(['"])([^'"]+)\1/.exec(value)?.[2].toLowerCase();
  if (declared && declared !== encoding && !(declared === 'utf-16' && encoding.startsWith('utf-16'))) throw corrupt();
  for (const character of value) if (!xmlCharacter(character.codePointAt(0)!)) throw corrupt();
  return value;
}

/** Check XML 1.0 tokens before the tolerant tree builder can recover bad input.
 * This checks well-formed tokens and nesting, not the Office schemas. */
function validateXml(value: string): void {
  const name = /[:A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}][:A-Z_a-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c-\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd\u{10000}-\u{effff}\-.0-9\u00b7\u0300-\u036f\u203f-\u2040]*/uy;
  const reference = /&(?:amp|lt|gt|apos|quot|#(?:[0-9]+|x[0-9a-fA-F]+));/y;
  const stack: string[] = []; let at = 0, roots = 0, nodes = 0;
  const whitespace = () => { const start = at; while (at < value.length && /[ \t\r\n]/.test(value[at])) at++; return at > start; };
  const readName = () => { name.lastIndex = at; const match = name.exec(value); if (!match) throw corrupt(); at = name.lastIndex; return match[0]; };
  const references = (content: string) => {
    for (let index = content.indexOf('&'); index !== -1; index = content.indexOf('&', reference.lastIndex)) {
      reference.lastIndex = index; const match = reference.exec(content); if (!match) throw corrupt();
      if (match[0][1] === '#') {
        const hexadecimal = match[0][2] === 'x', number = Number.parseInt(match[0].slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
        if (!xmlCharacter(number)) throw corrupt();
      }
    }
  };
  while (at < value.length) {
    if (value[at] !== '<') {
      const end = value.indexOf('<', at), content = value.slice(at, end < 0 ? value.length : end);
      if (content.includes(']]>') || !stack.length && /[^ \t\r\n]/.test(content)) throw corrupt();
      references(content); at += content.length; continue;
    }
    if (value.startsWith('<!--', at)) {
      const end = value.indexOf('-->', at + 4), content = value.slice(at + 4, end);
      if (end < 0 || content.includes('--') || content.endsWith('-')) throw corrupt();
      at = end + 3; continue;
    }
    if (value.startsWith('<![CDATA[', at)) {
      const end = value.indexOf(']]>', at + 9); if (!stack.length || end < 0) throw corrupt();
      at = end + 3; continue;
    }
    if (value.startsWith('<?', at)) {
      const start = at; at += 2; const target = readName(), end = value.indexOf('?>', at);
      if (end < 0 || at !== end && !/[ \t\r\n]/.test(value[at])) throw corrupt();
      if (target.toLowerCase() === 'xml' && (target !== 'xml' || start !== 0 || !/^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(['"])1\.0\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(['"])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(['"])(?:yes|no)\3)?[ \t\r\n]*\?>$/.test(value.slice(start, end + 2)))) throw corrupt();
      at = end + 2; continue;
    }
    if (value.startsWith('<!', at)) { if (/^<!(?:DOCTYPE|ENTITY)\b/i.test(value.slice(at, at + 12))) throw unsafe(); throw corrupt(); }
    if (value.startsWith('</', at)) {
      at += 2; const closing = readName(); whitespace();
      if (value[at++] !== '>' || stack.pop() !== closing) throw corrupt();
      continue;
    }
    at++; const opening = readName(), attributes = new Set<string>();
    if (++nodes > 150000 || stack.length >= 100) throw tooLarge();
    if (!stack.length && ++roots !== 1) throw corrupt();
    while (true) {
      const separated = whitespace();
      if (value.startsWith('/>', at)) { at += 2; break; }
      if (value[at] === '>') { at++; stack.push(opening); break; }
      if (!separated) throw corrupt();
      const attribute = readName(); if (attributes.has(attribute)) throw corrupt(); attributes.add(attribute); whitespace();
      if (value[at++] !== '=') throw corrupt(); whitespace();
      const quote = value[at++]; if (quote !== '"' && quote !== "'") throw corrupt();
      const end = value.indexOf(quote, at), content = value.slice(at, end);
      if (end < 0 || content.includes('<')) throw corrupt(); references(content); at = end + 1;
    }
  }
  if (stack.length || roots !== 1) throw corrupt();
}

/** Decode safe XML text only; DTDs, entity declarations and recovery reject. */
export function xml(bytes: Buffer | undefined): Xml {
  if (!bytes) throw corrupt();
  if (bytes.length > 4 * 1024 * 1024) throw tooLarge();
  const value = xmlValue(bytes); validateXml(value);
  const root: Xml = { name: '#root', attrs: {}, children: [] }, stack = [root]; let nodes = 0;
  const parser = new Parser({
    onopentag(name, attrs) { if (++nodes > 150000 || stack.length > 100) throw tooLarge(); const node = { name: localName(name), attrs, children: [] }; stack.at(-1)!.children.push(node); stack.push(node); },
    ontext(value) { stack.at(-1)!.children.push(value); },
    onclosetag(_name, implied) { if (implied && !value.slice(parser.startIndex, parser.endIndex + 1).endsWith('/>')) throw corrupt(); if (stack.length < 2) throw corrupt(); stack.pop(); },
    onerror() { throw corrupt(); },
  }, { xmlMode: true, decodeEntities: true });
  parser.end(value);
  if (stack.length !== 1 || children(root).length !== 1 || root.children.some(child => typeof child === 'string' && child.trim())) throw corrupt();
  return children(root)[0];
}

export function relationships(files: Map<string, Buffer>, part: string): Map<string, { target: string; type: string; external: boolean }> {
  const path = part ? posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels') : '_rels/.rels';
  if (!files.has(path)) return new Map();
  const root = xml(files.get(path)); if (root.name !== 'Relationships') throw corrupt();
  const result = new Map<string, { target: string; type: string; external: boolean }>();
  for (const rel of children(root, 'Relationship')) {
    const { Id: id, Target: rawTarget, Type: type, TargetMode: mode } = rel.attrs;
    if (!id || !rawTarget || !type || result.has(id)) throw corrupt();
    if (/\/(?:vbaProject|oleObject|control)$/i.test(type)) throw unsafe();
    if (mode === 'External') { result.set(id, { target: rawTarget, type, external: true }); continue; }
    let target: string; try { target = decodeURIComponent(rawTarget); } catch { throw corrupt(); }
    if (/[\\\0:?#]/.test(target)) throw corrupt();
    target = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(part), target));
    if (target.startsWith('../') || target === '..' || !files.has(target)) throw corrupt();
    result.set(id, { target, type, external: false });
  }
  return result;
}
