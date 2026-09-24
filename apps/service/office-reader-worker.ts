import { parentPort, workerData } from 'node:worker_threads';
import { extractOfficeDocument } from './office-document.js';
import { OfficeReadError } from './office-archive.js';
try {
  parentPort!.postMessage({ ok: true, value: extractOfficeDocument(Buffer.from(workerData.bytes), workerData.kind) });
} catch (error) {
  parentPort!.postMessage({ ok: false, code: error instanceof OfficeReadError ? error.code : 'office_corrupt', message: error instanceof OfficeReadError ? error.message : 'This Office document could not be read safely. Its original file is kept.' });
}
