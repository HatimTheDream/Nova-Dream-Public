const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
class CompanionMcp {
  constructor(executable, args) {
    this.pending = new Map(); this.next = 0;
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false, env: Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','TMPDIR','SystemRoot','APPDATA','LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]])) });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      if (Buffer.byteLength(line) > 12 * 1024 * 1024) { this.close(); return; }
      let message; try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(String(message.error.message).slice(0, 500))) : pending.resolve(message.result);
    });
    const ended = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('The bounded computer connection ended.')); } this.pending.clear(); };
    this.child.stdin.on('error', ended); this.child.on('error', ended); this.child.on('exit', ended);
  }
  request(method, params, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The computer result was not confirmed before timeout.')); this.close(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async ready() { await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nova-dream-companion', version: '1' } }); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); return this.request('tools/list', {}); }
  close() { this.lines.close(); this.child.stdin.destroy(); if (this.child.exitCode === null) this.child.kill('SIGTERM'); }
}
module.exports = { CompanionMcp };
