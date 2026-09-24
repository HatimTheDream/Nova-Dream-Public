import { Worker } from 'node:worker_threads';
import type { OfficeKind } from '../../packages/domain/office-attachments.js';
import type { OfficeDocument } from './office-document.js';
import { Fault } from './store.js';

/** Parsing happens off the service thread; hostile archives cannot hold it open. */
export class OfficeReader {
  private workers = new Set<Worker>();
  private closed = false;
  async read(bytes: Buffer, kind: OfficeKind): Promise<OfficeDocument> {
    if (this.closed || this.workers.size >= 2) throw new Fault(409, 'office_reader_busy', 'Wait for the current document reading to finish.');
    if (bytes.length > 8 * 1024 * 1024) throw new Fault(413, 'office_large', 'Office attachments support files up to 8 MB. The original file is kept.');
    const sourceRun = import.meta.url.endsWith('.ts');
    const worker = new Worker(new URL('./office-reader-worker' + (sourceRun ? '.ts' : '.js'), import.meta.url), { workerData: { bytes, kind }, execArgv: sourceRun ? ['--import', 'tsx'] : [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    this.workers.add(worker);
    try {
      return await new Promise<OfficeDocument>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: OfficeDocument) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value!); };
        const timer = setTimeout(() => finish(new Fault(408, 'office_timeout', 'This Office document took too long to read. Supply a smaller copy. The original file is kept.')), 10000);
        worker.once('message', result => result?.ok ? finish(undefined, result.value) : finish(new Fault(result?.code === 'office_large' ? 413 : 400, String(result?.code ?? 'office_corrupt'), String(result?.message ?? 'This Office document could not be read. The original file is kept.'))));
        worker.once('error', () => finish(new Fault(400, 'office_unreadable', 'This Office document could not be read within safe limits. The original file is kept.')));
        worker.once('exit', () => { if (!settled) finish(new Fault(503, 'office_interrupted', 'Document reading stopped before completion. The original file is kept.')); });
      });
    } finally { await worker.terminate(); this.workers.delete(worker); }
  }
  async close() { this.closed = true; await Promise.all([...this.workers].map(worker => worker.terminate())); }
}
