import { z } from 'zod';
import type { AgentUpdateStatus } from '../../packages/domain/software-update.js';

const source = 'https://api.github.com/repos/openclaw/openclaw/releases/latest';
const stable = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const cacheSchema = z.object({ version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/).optional(), checkedAt: z.number().nonnegative().optional(), attemptedAt: z.number().nonnegative(), error: z.boolean() }).strict();
type Cache = z.infer<typeof cacheSchema>;
export function newerAgentVersion(candidate: string, installed: string): boolean {
  const a = stable.exec(candidate), b = stable.exec(installed);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +a[i] > +b[i];
  return false;
}

/** Public release discovery is informational. Only the separate signed Nova
 * manifest can authorize installing an exact compatible pair. */
export class OpenClawUpdateFeed {
  private cache: Cache = { attemptedAt: 0, error: false };
  private pending?: Promise<void>;
  private controller?: AbortController;
  constructor(private readonly options: { installed(): string | undefined; read(): unknown; write(value: unknown): void; fetch?: typeof globalThis.fetch; now?: () => number }) {
    try { const saved = cacheSchema.safeParse(options.read()); if (saved.success) this.cache = saved.data; } catch { this.cache.error = true; }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  status(): AgentUpdateStatus {
    const installed = this.options.installed(), checkedAt = this.cache.checkedAt;
    if (this.pending) return { state: 'checking', ...(checkedAt === undefined ? {} : { checkedAt }) };
    if (this.cache.error || !installed || !stable.test(installed) || !this.cache.version || checkedAt === undefined || this.now() < checkedAt || this.now() - checkedAt > 36 * 3_600_000) return { state: 'unavailable', ...(checkedAt === undefined ? {} : { checkedAt }) };
    return { state: newerAgentVersion(this.cache.version, installed) ? 'available' : 'current', version: this.cache.version, checkedAt, releaseNotesUrl: `https://github.com/openclaw/openclaw/releases/tag/v${this.cache.version}` };
  }
  check(manual = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.cache.attemptedAt && this.now() - this.cache.attemptedAt < (manual ? 5 * 60_000 : 24 * 3_600_000)) return Promise.resolve();
    this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load() {
    this.cache.attemptedAt = this.now();
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10_000); timer.unref?.();
    try {
      this.options.write(this.cache);
      const response = await (this.options.fetch ?? globalThis.fetch)(source, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (response.status !== 200 || response.redirected || response.url && response.url !== source || !response.body) throw Error('Release check unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 128 * 1024) throw Error('Release response too large'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (value.draft !== false || value.prerelease !== false || typeof value.tag_name !== 'string' || !stable.test(value.tag_name)) throw Error('Invalid stable release');
      const version = value.tag_name.replace(/^v/, '');
      if (value.html_url !== `https://github.com/openclaw/openclaw/releases/tag/v${version}`) throw Error('Unexpected release origin');
      this.cache = { version, checkedAt: this.now(), attemptedAt: this.cache.attemptedAt, error: false };
      this.options.write(this.cache);
    } catch { this.cache.error = true; try { this.options.write(this.cache); } catch { /* Do not claim a successful check. */ } }
    finally { clearTimeout(timer); if (this.controller === controller) this.controller = undefined; }
  }
  stop() { this.controller?.abort(); }
}
