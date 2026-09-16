import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { z } from 'zod';
import { emailImageUrl, mapEmailImageCss, type EmailImages } from '../../packages/domain/email-images.js';
import type { MailReadResult } from '../../packages/domain/mail.js';
import { accountIdSchema } from '../../packages/domain/accounts.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { fetchEmailImage, emailImageType, MAX_EMAIL_IMAGE_BYTES } from './email-image-fetch.js';

const id = z.string().min(1).max(2000);
const inputSchema = z.object({ epoch: z.string().uuid(), accountId: accountIdSchema, generation: z.string().uuid(), threadId: id, messageId: id }).strict();
type Input = z.infer<typeof inputSchema>;
export type EmailImageLoader = typeof fetchEmailImage;
export function referencedEmailImages(html: string): string[] {
  const sources = new Set<string>(); let style = false;
  const add = (value: string) => { const url = emailImageUrl(value); if (url) sources.add(url); return undefined; };
  const parser = new Parser({
    onopentag(tag, attrs) {
      style = tag === 'style';
      // Invisible tracking pixels have no useful visual content.
      if (tag === 'img' && !(Number(attrs.width) <= 1 && Number(attrs.height) <= 1) && !/display\s*:\s*none/i.test(attrs.style || '')) add(attrs.src || '');
      if (attrs.background) add(attrs.background);
      if (attrs.style) mapEmailImageCss(attrs.style, add);
    },
    ontext(text) { if (style) mapEmailImageCss(text, add); },
    onclosetag(tag) { if (tag === 'style') style = false; },
  }, { decodeEntities: true });
  parser.end(html); return [...sources];
}

export class MailImages {
  private active = 0;
  private pending = new Map<string, Promise<EmailImages>>();
  private cache = new Map<string, { value: unknown; bytes: number; expires: number }>();
  private cacheBytes = 0;
  constructor(private store: Store, private accounts: Pick<Accounts, 'state' | 'mailRead'>, private load: EmailImageLoader = fetchEmailImage, private now: () => number = Date.now) {}
  private account(device: string, input: Input) {
    if (this.store.epoch !== input.epoch) throw new Fault(409, 'epoch_changed', 'Reopen this email after workspace recovery.');
    const account = this.accounts.state(device).accounts.find(item => item.id === input.accountId);
    if (!account || account.generation !== input.generation || !account.capabilities.mailRead || !['connected','refreshing'].includes(account.state)) throw new Fault(409, 'account_changed', 'Reopen this email after the account connection changes.');
    return account;
  }
  private key(input: Input) { return JSON.stringify([input.epoch, input.accountId, input.generation, input.threadId, input.messageId]); }
  private trim() {
    for (const [key, entry] of this.cache) if (entry.expires <= this.now()) this.remove(key);
  }
  private remove(key: string) {
    this.cacheBytes -= this.cache.get(key)?.bytes ?? 0; this.cache.delete(key);
  }
  private get<T>(key: string): T | undefined {
    this.trim(); const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key); this.cache.set(key, entry); return entry.value as T;
  }
  private keep(key: string, value: unknown, ttl: number, maximum: number) {
    this.trim(); this.remove(key);
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
    if (bytes > maximum) return;
    while (this.cache.size && (this.cacheBytes + bytes > 40 * 1024 * 1024 || this.cache.size >= 64)) this.remove(this.cache.keys().next().value!);
    this.cache.set(key, { value, bytes, expires: this.now() + ttl }); this.cacheBytes += bytes;
  }
  // Only successful authenticated provider reads can warm the body cache. No
  // image hosts are contacted here, including for protected or off-screen mail.
  remember(device: string, epoch: string, result: Pick<MailReadResult, 'accountId' | 'generation' | 'kind' | 'value'>) {
    if (!['gmail.thread', 'microsoft.conversation'].includes(result.kind)) return;
    const value = result.value as any;
    const messages = result.kind === 'gmail.thread' ? value.thread?.messages : value.messages;
    for (const message of messages ?? []) {
      const input = inputSchema.parse({ epoch, accountId: result.accountId, generation: result.generation,
        threadId: result.kind === 'gmail.thread' ? value.thread?.id : message.conversationId, messageId: message.id });
      this.account(device, input);
      const body = result.kind === 'gmail.thread' ? { payload: message.payload } : { html: message.bodyHtml || '' };
      this.keep('body:' + this.key(input), body, 2 * 60000, 4 * 1024 * 1024);
    }
  }
  async read(device: string, raw: unknown): Promise<EmailImages> {
    const input = inputSchema.parse(raw); this.account(device, input);
    const key = this.key(input);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.active >= 4) throw new Fault(429, 'images_busy', 'Other email images are loading. Try again shortly.');
      this.active++;
      pending = this.readMessage(device, input).finally(() => { this.active--; this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    const result = await pending;
    this.account(device, input); return { ...result, images: { ...result.images } };
  }
  private async readMessage(device: string, input: Input): Promise<EmailImages> {
    const signal = AbortSignal.timeout(45000), provider = this.account(device, input).provider;
    let body = this.get<{ payload?: any; html?: string }>('body:' + this.key(input));
    if (!body) {
      const selector = provider === 'google' ? { kind: 'gmail.thread' as const, threadId: input.threadId } : { kind: 'microsoft.conversation' as const, conversationId: input.threadId, messageId: input.messageId };
      const page = await this.accounts.mailRead(input.accountId, input.generation, selector, undefined, signal);
      this.account(device, input);
      const value = page.value as any;
      const matches = provider === 'google'
        ? value.thread?.id === input.threadId && value.thread?.messages?.filter((m: any) => m.id === input.messageId)
        : value.messages?.filter((m: any) => m.id === input.messageId && m.conversationId === input.threadId);
      if (!matches || matches.length !== 1) throw new Fault(409, 'message_changed', 'Reopen the selected message before showing images.');
      this.remember(device, input.epoch, { ...input, kind: selector.kind, value: page.value });
      body = provider === 'google' ? { payload: matches[0].payload } : { html: matches[0].bodyHtml || '' };
    }
    let html = body.html || '';
    const collect = async (part: any): Promise<void> => {
      if (!part || part.filename) return;
      if (part.mimeType?.toLowerCase() === 'text/html') {
        let data = part.body?.data;
        if (!data && part.body?.attachmentId && part.body?.size <= 2 * 1024 * 1024) {
          const loaded = await this.accounts.mailRead(input.accountId, input.generation, { kind: 'gmail.attachment', messageId: input.messageId, attachmentId: part.body.attachmentId }, undefined, signal);
          this.account(device, input); data = (loaded.value as {base64?:string}).base64;
        }
        if (data) html += Buffer.from(data, 'base64url').toString('utf8');
      }
      for (const child of part.parts ?? []) await collect(child);
    };
    if (provider === 'google') await collect(body.payload);
    this.account(device, input);
    // Include current body content so a refreshed/edited message cannot reuse a
    // different set of images merely because its provider ID stayed the same.
    const imageKey = 'images:' + this.key(input) + ':' + createHash('sha256').update(html).digest('hex');
    const cached = this.get<EmailImages>(imageKey);
    if (cached?.unavailable === 0) return cached;
    const sources = referencedEmailImages(html), images = { ...cached?.images };
    let total = Object.values(images).reduce((sum, image) => sum + Buffer.byteLength(image.split(',')[1], 'base64'), 0);
    let unavailable = Math.max(0, sources.length - 40), next = 0;
    const selected = sources.slice(0, 40).filter(src => !images[src]);
    const worker = async () => {
      while (next < selected.length) {
        const src = selected[next++]; this.account(device, input);
        if (signal.aborted || total >= 20 * 1024 * 1024) { unavailable++; continue; }
        try {
          const image = await this.load(src, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
          this.account(device, input);
          const type = emailImageType(image.bytes);
          if (!type || image.bytes.length > MAX_EMAIL_IMAGE_BYTES || total + image.bytes.length > 20 * 1024 * 1024) { unavailable++; continue; }
          total += image.bytes.length; images[src] = `data:${type};base64,${image.bytes.toString('base64')}`;
        } catch { this.account(device, input); unavailable++; }
      }
    };
    // Four bounded workers, retaining the exact source bytes and all existing
    // host checks. Wait for every worker before releasing request admission.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, selected.length) }, worker));
    this.account(device, input);
    for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
    const result = { accountId: input.accountId, generation: input.generation, threadId: input.threadId, messageId: input.messageId, images, unavailable };
    this.keep(imageKey, result, 5 * 60000, 28 * 1024 * 1024);
    return result;
  }
}
