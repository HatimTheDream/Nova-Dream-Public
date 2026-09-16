import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PhoneRoute } from '../../packages/domain/phone.js';

export interface PhoneTransport { reconcile(target: string, configure: boolean): Promise<PhoneRoute>; disable(target: string): Promise<void> }
export type TailscaleCommand = (args: string[]) => Promise<string>;
const run: TailscaleCommand = args => new Promise((accept, reject) => {
  const binary = process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : process.platform === 'win32' && existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
  execFile(binary, args, { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false }, (error, stdout) => error ? reject(error) : accept(stdout));
});
type Config = { TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string; HTTP?: boolean }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean>; Foreground?: Record<string, Config> };
const port = '8443';
// Match parsed fields, never output substrings. E3 owns only a dedicated HTTPS
// port, preserving predecessor /dream-claw and every other Serve route.
export function routeOwnership(config: Config, host: string, target: string): 'empty' | 'owned' | 'conflict' {
  const key = `${host}:${port}`;
  if (Object.values(config.Foreground ?? {}).some(item => routeOwnership(item, host, target) !== 'empty')) return 'conflict';
  if (Object.entries(config.AllowFunnel ?? {}).some(([name, enabled]) => name.endsWith(':' + port) && enabled)) return 'conflict';
  const web = Object.entries(config.Web ?? {}).filter(([name]) => name.endsWith(':' + port));
  const tcp = config.TCP?.[port];
  if (!tcp && !web.length) return 'empty';
  const handlers = web.length === 1 && web[0][0] === key ? web[0][1].Handlers : undefined;
  if (tcp?.HTTPS === true && !tcp.TCPForward && !tcp.HTTP && handlers && Object.keys(handlers).length === 1 && handlers['/']?.Proxy?.replace(/\/$/, '') === target) return 'owned';
  return 'conflict';
}
export class TailscalePhoneTransport implements PhoneTransport {
  constructor(private command: TailscaleCommand = run) {}
  private async inspect(connect = false) {
    let status = JSON.parse(await this.command(['status', '--json']));
    if (connect && status.BackendState === 'Stopped') {
      // An explicit reconnect resumes the saved network without changing its settings.
      // Startup/status reads must never turn a deliberately stopped VPN back on.
      try { await this.command(['up']); } catch { /* Read back after an uncertain command outcome. */ }
      status = JSON.parse(await this.command(['status', '--json']));
    }
    if (status.BackendState !== 'Running') throw new Error('signed-out');
    const host = String(status.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(host)) throw new Error('hostname');
    const config = JSON.parse(await this.command(['serve', 'status', '--json'])) as Config;
    return { host, config };
  }
  async reconcile(target: string, configure: boolean): Promise<PhoneRoute> {
    try {
      let { host, config } = await this.inspect(configure);
      let ownership = routeOwnership(config, host, target);
      if (ownership === 'conflict') return { state: 'error', message: 'The phone address is used by another route or public sharing. Keep that configuration intact and free the dedicated phone port before retrying.' };
      if (ownership === 'empty' && configure) {
        try { await this.command(['serve', '--yes', '--bg', '--https=' + port, target]); } catch { /* Observe the actual route after a lost or late command response. */ }
        ({ host, config } = await this.inspect()); ownership = routeOwnership(config, host, target);
      }
      if (ownership !== 'owned') return { state: 'unavailable', message: 'The private phone route is not ready. Enable HTTPS and Serve in Tailscale, then retry here.' };
      return { state: 'ready', origin: `https://${host}:${port}`, message: 'Private phone access is ready. Connect this computer and your phone to Tailscale, then pair your phone.' };
    } catch (error) {
      return { state: 'unavailable', message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Install Tailscale on this computer and your phone, sign in to the same private network, then retry here.' : 'Tailscale is unavailable or signed out. Connect this computer to your private network, then retry here.' };
    }
  }
  async disable(target: string) {
    const { host, config } = await this.inspect();
    if (routeOwnership(config, host, target) === 'owned') await this.command(['serve', '--https=' + port, 'off']);
  }
}
