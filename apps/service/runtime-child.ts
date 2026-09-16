import { isAbsolute, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// Launch the pinned public CLI in this same process. The IPC descriptor binds
// its lifetime to this exact service, without looking up or killing stored PIDs.
const entry = process.argv[2];
if (!entry || !isAbsolute(entry) || basename(entry) !== 'openclaw.mjs' || !process.send || !process.connected) throw new Error('The owned Assistant runtime requires its live Nova Dream parent.');
let stopping = false;
const stopWithOwner = () => {
  if (stopping) return;
  stopping = true;
  // Let native shutdown abort its active sessions and close child transports.
  // A nonresponsive runtime cannot keep this orphan process alive indefinitely.
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 5000).unref();
  process.kill(process.pid, 'SIGTERM');
};
process.once('disconnect', stopWithOwner);
for (const stream of [process.stdout, process.stderr]) stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') stopWithOwner(); });
process.argv.splice(1, 1);
const { installNativeApprovalCompatibility } = await import(new URL(import.meta.url.endsWith('.ts') ? './openclaw-approval-compat.ts' : './openclaw-approval-compat.js', import.meta.url).href);
installNativeApprovalCompatibility(entry);
await import(pathToFileURL(entry).href);
