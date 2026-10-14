import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { SoftwareUpdateStatus } from '../../packages/domain/software-update.js';

export class UpdateHostRejected extends Error {}

type UpdateHostDiagnostic = 'request_too_large' | 'controller_rejected' | 'controller_failed' | 'response_invalid' | 'response_too_large' | 'request_timeout' | 'transport_unavailable';
function recordUpdateHostFailure(action: string, code: UpdateHostDiagnostic) {
  // Private service diagnostics contain only fixed labels. Never log a socket,
  // request/response body, error text, workspace identity or credentials.
  const label = ['status', 'check', 'install', 'cancel', 'heartbeat'].includes(action) ? action : 'unknown';
  try { console.warn('[nova-update-host]', label, code); } catch { /* Logging cannot change update request semantics. */ }
}

/** Only the locally provisioned updater socket is addressable. Browser input
 * never supplies an origin, path, program or updater credential. */
export class UpdateHostClient {
  constructor(private readonly socket: string) {
    if (!isAbsolute(socket) || socket.length > 1000) throw new Error('Use an absolute managed update socket.');
  }
  call<T>(action: 'status' | 'check' | 'install' | 'cancel' | 'heartbeat', value: unknown = {}): Promise<T> {
    const bytes = Buffer.from(JSON.stringify(value));
    let reported = false;
    const diagnose = (code: UpdateHostDiagnostic) => { if (!reported) { reported = true; recordUpdateHostFailure(action, code); } };
    if (bytes.length > 65536) { diagnose('request_too_large'); return Promise.reject(new Error('Update request is too large.')); }
    return new Promise((resolve, reject) => {
      const fail = (code: UpdateHostDiagnostic, error: unknown) => { diagnose(code); reject(error); };
      const req = request({ socketPath: this.socket, path: '/v1/' + action, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', part => { size += part.length; if (size > 65536) { diagnose('response_too_large'); res.destroy(new Error('Invalid update response.')); return; } chunks.push(part); });
        res.on('error', error => fail('transport_unavailable', error));
        res.on('end', () => { try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) {const message=typeof result.message === 'string' && result.message.length < 300 ? result.message : 'The host could not complete this update request.';diagnose(res.statusCode && res.statusCode>=400&&res.statusCode<500?'controller_rejected':'controller_failed');throw res.statusCode && res.statusCode>=400&&res.statusCode<500?new UpdateHostRejected(message):new Error(message);}
          resolve(result as T);
        } catch (error) { fail('response_invalid', error); } });
      });
      req.setTimeout(action === 'check' ? 20000 : 5000, () => { diagnose('request_timeout'); req.destroy(new Error('The update service did not respond.')); });
      req.on('error', error => fail('transport_unavailable', error)); req.end(bytes);
    });
  }
}

export const updateHeartbeatSchema = z.object({
  candidateId: z.string().regex(/^[a-f0-9]{64}$/), epoch: z.string().uuid(),
  heldFor: z.string().uuid().nullable(), blockers: z.array(z.object({ code: z.string().max(80), message: z.string().max(200) }).strict()).max(30),
  nativeSuspended: z.boolean(),
}).strict();
export type UpdateHeartbeat = z.infer<typeof updateHeartbeatSchema>;
export type UpdateHostView = Pick<SoftwareUpdateStatus, 'availability' | 'checkedAt' | 'release' | 'error' | 'installation' | 'job' | 'blocker' | 'agentUpdate'> & { holdFor: string | null };
