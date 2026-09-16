/** Inspect dimensions before allowing the browser to decode an untrusted image. */
export function imagePreviewType(bytes: Buffer, maximumPixels = 16_777_216): string | undefined {
  const bounded = (width: number, height: number) => width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= maximumPixels;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    if (!bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return;
    // Multiple animation frames multiply the decode budget. Keep APNG as an
    // original download, just like animated WebP.
    let offset = 8, pixels = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') return;
      if (kind === 'IDAT') pixels = true;
      if (kind === 'IEND') return length === 0 && pixels ? 'image/png' : undefined;
      offset += length + 12;
    }
    return;
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return !(bytes[20] & 2) && bounded(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1) ? 'image/webp' : undefined;
    if (kind === 'VP8L' && bytes[20] === 0x2f) { const packed = bytes.readUInt32LE(21); return bounded((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1) ? 'image/webp' : undefined; }
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return bounded(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff) ? 'image/webp' : undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return length >= 8 && bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)) ? 'image/jpeg' : undefined;
      offset += length;
    }
  }
  return undefined;
}
