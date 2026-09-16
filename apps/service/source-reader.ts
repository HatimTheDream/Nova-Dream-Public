import { Worker } from 'node:worker_threads';
import { canonical } from '../../packages/domain/contracts.js';
import { readableSourceLimit, type CapturedSourceFile, type SourceReading } from '../../packages/domain/source-reader.js';
import { Fault, Store } from './store.js';

/** Read only an already-authorized immutable blob; model arguments never name
 * paths. Parsing is isolated from the service with bounded memory and lifetime. */
export class SourceReader {
  private workers = new Set<Worker>();
  private closed = false;
  constructor(private store: Store) {}
  async read(source: CapturedSourceFile, page: number, view: 'text' | 'image'): Promise<SourceReading> {
    if (this.closed || this.workers.size >= 2) throw new Fault(409, 'source_reader_busy', 'Wait for the current source reading to finish.');
    const saved = this.store.download(source.file.id);
    if (canonical(saved.metadata) !== canonical(source.file)) throw new Fault(409, 'source_changed', 'The saved source bytes do not match the captured file.');
    if (saved.bytes.length > readableSourceLimit) throw new Fault(413, 'source_large', 'Source reading supports files up to 8 MB.');
    if (/\.(txt|md|csv|json)$/i.test(source.file.name)) {
      if (page !== 1) throw new Fault(400, 'source_page', 'Text sources have one page.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes); if (text.includes('\0')) throw new Error(); }
      catch { throw new Fault(400, 'source_encoding', 'This source is not complete UTF-8 text.'); }
      return { ...source, page: 1, pages: 1, view: 'text', text: text.slice(0,24000), truncated: text.length > 24000, notes: text.length > 24000 ? ['Only the first 24,000 characters are included. This is an incomplete excerpt.'] : ['Complete text.'] };
    }
    if (!/\.(pdf|png|jpe?g|webp)$/i.test(source.file.name)) throw new Fault(400, 'source_format', 'Choose a PDF, PNG, JPEG, WebP or supported text source.');
    const pdf = /\.pdf$/i.test(source.file.name);
    if (pdf && !saved.bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Fault(400, 'source_format', 'This file does not contain a PDF header.');
    const worker = new Worker(new URL('./source-reader-worker' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url), { workerData: { bytes: saved.bytes, pdf, page, view }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
    this.workers.add(worker);
    try {
      return await new Promise<SourceReading>((accept, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: SourceReading) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(value!); };
        const timer = setTimeout(() => finish(new Fault(408, 'source_timeout', 'This source took too long to read. Try a smaller document or image.')), 15000);
        worker.once('message', result => result?.ok ? finish(undefined, { ...source, ...result.value }) : finish(new Fault(400, 'source_unreadable', String(result?.message ?? 'This source could not be read.'))));
        worker.once('error', () => finish(new Fault(400, 'source_unreadable', 'This source could not be read within the supported limits.')));
        worker.once('exit', () => { if (!settled) finish(new Fault(503, 'source_interrupted', 'Source reading stopped before completion.')); });
      });
    } finally { await worker.terminate(); this.workers.delete(worker); }
  }
  async close() { this.closed = true; await Promise.all([...this.workers].map(worker => worker.terminate())); }
}
