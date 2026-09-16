import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

// One isolated, bounded parse per request. PDF bytes never become a URL, script,
// external link, attachment command, or filesystem-selected input.
const input = workerData as { bytes: Uint8Array; pdf: boolean; page: number; view: 'text' | 'image' };
try {
  if (!input.pdf) {
    if (input.page !== 1) throw new Error('Images have one page.');
    const { data, info } = await sharp(Buffer.from(input.bytes), { limitInputPixels: 25000000, failOn: 'warning', animated: false }).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (data.length > 700000) throw new Error('This image is too detailed for one bounded source reading.');
    parentPort!.postMessage({ ok: true, value: { page: 1, pages: 1, view: 'image', image: { mimeType: 'image/jpeg', data: data.toString('base64'), width: info.width, height: info.height }, truncated: false, notes: ['Image pixels supplied at a maximum 1400-pixel edge. Original file bytes are unchanged.'] } });
  } else {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const resources = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    const task = getDocument({ data: new Uint8Array(input.bytes), useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true, verbosity: 0, maxImageSize: 25000000, standardFontDataUrl: join(resources, 'standard_fonts') + '/', cMapUrl: join(resources, 'cmaps') + '/', cMapPacked: true, wasmUrl: join(resources, 'wasm') + '/' });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 1000 || input.page > pdf.numPages) throw new Error('Choose a page within this document (up to 1000 pages).');
      const page = await pdf.getPage(input.page);
      if (input.view === 'text') {
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        parentPort!.postMessage({ ok: true, value: { page: input.page, pages: pdf.numPages, view: 'text', text: text.slice(0,24000), truncated: text.length > 24000, notes: [text.trim() ? 'Text from this page only. Use image view for charts, diagrams and layout; request other pages separately.' : 'This page has no extractable text. Use image view to inspect its pixels; no OCR text was inferred.', ...(text.length > 24000 ? ['This page exceeds 24,000 characters; the excerpt is incomplete.'] : [])] } });
      } else {
        const { createCanvas } = await import('@napi-rs/canvas');
        const natural = page.getViewport({ scale: 1 }), scale = Math.min(2, 1400 / Math.max(natural.width, natural.height));
        const viewport = page.getViewport({ scale });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 1 || viewport.height < 1) throw new Error('This PDF page has an unsupported size.');
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        const bytes = canvas.toBuffer('image/jpeg', 85);
        if (bytes.length > 700000) throw new Error('This PDF page is too detailed for one bounded image reading.');
        parentPort!.postMessage({ ok: true, value: { page: input.page, pages: pdf.numPages, view: 'image', image: { mimeType: 'image/jpeg', data: bytes.toString('base64'), width: canvas.width, height: canvas.height }, truncated: false, notes: ['Rendered pixels from this PDF page only, at a maximum 1400-pixel edge. No other pages have been inspected.'] } });
      }
    } finally { await task.destroy(); }
  }
} catch (error) {
  const password = error instanceof Error && error.name === 'PasswordException';
  parentPort!.postMessage({ ok: false, message: password ? 'This PDF requires a password. Supply an unlocked copy before asking the agent to read it.' : 'This file or page could not be read within the supported format and size limits. Its original bytes are kept.' });
}
