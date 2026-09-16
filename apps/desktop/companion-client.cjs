const { randomUUID, sign } = require('node:crypto');
const { active } = require('./companion-access.cjs');

// The transport owns no UI or operating-system API. Native admission, durable
// receipts and the bounded driver are injected by the desktop host.
class CompanionClient {
  constructor({ connection, request, readReceipt, saveReceipt, execute, status, now = Date.now }) {
    Object.assign(this, { connection, request, readReceipt, saveReceipt, execute, status, now });
    this.lastIssued = 0; this.busy = false; this.stopped = false; this.sending = Promise.resolve();
  }
  send(action, payload) {
    const job = this.sending.catch(() => {}).then(() => this.packet(action, payload));
    this.sending = job; return job;
  }
  async packet(action, payload) {
    const c = this.connection;
    const p = { protocol: 1, deviceId: c.deviceId, epoch: c.epoch, requestId: randomUUID(), issuedAt: this.lastIssued = Math.max(this.now(), this.lastIssued + 1), action, payload };
    p.signature = sign(null, Buffer.from(JSON.stringify([p.protocol, p.deviceId, p.epoch, p.requestId, p.issuedAt, p.action, p.payload])), c.privateKey).toString('base64url');
    return this.request(p);
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      // A completed result whose response was lost is reported again under the
      // same operation; its action is never repeated.
      const pending = this.readReceipt();
      if (pending) {
        const receipt = pending.state === 'started' ? { id: pending.id, state: 'unknown', result: { message: 'The desktop stopped before confirming the effect. Do not repeat this action.' } } : pending;
        await this.send('result', receipt); this.saveReceipt(null);
      }
      const response = await this.send('poll', this.status()), op = response.operation;
      if (!op || this.stopped) return;
      if (op.epoch !== this.connection.epoch || op.call.deviceId !== this.connection.deviceId || op.expiresAt <= this.now()) throw new Error('The desktop request no longer matches this connection.');
      // Record intent before claiming. An interrupted claim has an unknown
      // outcome and must not become another click after restarting the app.
      this.saveReceipt({ id: op.id, state: 'started' });
      const claim = await this.send('claim', { id: op.id });
      if (!claim.claimed || this.stopped) throw new Error('This computer action was not admitted.');
      let receipt;
      try {
        if (!active(this.status().enabledUntil, this.now())) throw new Error('Local computer access is off.');
        const result = await this.execute(op.call, op.expiresAt);
        receipt = { id: op.id, state: result.isError ? 'refused' : 'completed', result };
      } catch (error) { receipt = { id: op.id, state: 'unknown', result: { message: String(error.message || 'Computer result unconfirmed.').slice(0, 500) } }; }
      this.saveReceipt(receipt); await this.send('result', receipt); this.saveReceipt(null);
    } finally { this.busy = false; }
  }
  async disconnect() { this.stopped = true; try { await this.send('disconnect', {}); } catch { /* Local stop still closes admission. */ } }
}
module.exports = { CompanionClient };
