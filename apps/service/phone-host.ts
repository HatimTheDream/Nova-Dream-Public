import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { PhoneRoute, PhoneState } from '../../packages/domain/phone.js';
import { PhoneAccess } from './phone-access.js';
import { TailscalePhoneTransport, type PhoneTransport } from './phone-transport.js';
import QRCode from 'qrcode';

export class PhoneHost {
  private server?: Server;
  private route: PhoneRoute = { state: 'off', message: 'Phone access is off.' };
  private target = '';
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly access: PhoneAccess, private handle: (request: IncomingMessage, response: ServerResponse) => void, private port = 4385, private transport: PhoneTransport = new TailscalePhoneTransport()) {}
  state(): PhoneState { return { enabled: this.access.enabled, route: this.route, devices: this.access.devices() }; }
  get origin() { return this.route.state === 'ready' ? this.route.origin : undefined; }
  get localOrigin() { return this.target; }
  reconcile(configure = false): Promise<PhoneState> {
    const job = this.serial.then(async () => {
      if (this.closed) return this.state();
      if (!this.access.enabled) {
        this.route = { state: 'off', message: 'Phone access is off. Pair devices again after enabling it.' };
        await this.stopListener();
        if (this.target) try { await this.transport.disable(this.target); } catch { this.route = { state: 'off', message: 'Phone access is blocked. The old private route could not be removed; retry after Tailscale reconnects.' }; }
        return this.state();
      }
      this.route = { state: 'checking', message: 'Checking the private phone route…' };
      try {
        if (!this.server) {
          const server = createServer(this.handle); server.requestTimeout = 15000; server.headersTimeout = 10000;
          await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
          this.server = server;
          const address = server.address(); if (!address || typeof address === 'string') throw new Error('listener');
          this.target = `http://127.0.0.1:${address.port}`;
        }
        const route = await this.transport.reconcile(this.target, configure);
        // Encode only the verified address locally; pairing credentials stay separate.
        const qrCodeDataUrl = route.state === 'ready' && route.origin
          ? await QRCode.toDataURL(route.origin, { margin: 4, width: 256, errorCorrectionLevel: 'M' }).catch(() => undefined)
          : undefined;
        // Disable admission immediately even if an earlier enable is in flight.
        this.route = this.closed || !this.access.enabled ? { state: 'off', message: 'Phone access is off.' } : { ...route, ...(qrCodeDataUrl ? { qrCodeDataUrl } : {}) };
        if (this.route.state !== 'ready') await this.stopListener();
      } catch { this.route = { state: 'error', message: 'The private phone listener could not start. Close the conflicting phone host and retry.' }; await this.stopListener(); }
      return this.state();
    });
    this.serial = job.catch(() => {}); return job;
  }
  private async stopListener() {
    const server = this.server; this.server = undefined;
    if (!server) return;
    const timer = setTimeout(() => server.closeAllConnections(), 1000);
    try { await new Promise<void>(accept => server.close(() => accept())); } finally { clearTimeout(timer); }
  }
  async close() { this.closed = true; this.route = { state: 'off', message: 'The host is restarting.' }; await this.serial; await this.stopListener(); }
}
