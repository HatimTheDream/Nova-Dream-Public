import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import type { ConnectedAccount } from '../../packages/domain/accounts.js';
import { mailIndexCommandSchema, mailIndexReadSchema, type MailIndexRead, type MailIndexResult } from '../../packages/domain/mail-index.js';
import { createMailIndexSnapshot, mergeIndexedMailThreads, normalizeGmailIndexThreads, MAX_INDEXED_THREADS, type IndexedMailThread, type MailIndexSnapshot, type MailIndexProvider } from '../../packages/domain/dreamclaw/mail-index.js';
import type { MailReadSelector } from '../../packages/domain/mail.js';
import { Accounts } from './accounts.js';
import { Fault, Store } from './store.js';
import { ProviderError } from './providers.js';

type Run = { runId: string; pages: number };
type Head = Omit<MailIndexSnapshot, 'threads' | 'schemaVersion' | 'query'> & {
  scope: string; epoch: string; generation: string; runId: string; revision: number; count: number;
  seen: string[]; base?: Run; retired: string[];
};
type Page = { threads: IndexedMailThread[]; readRevision:number; nextCursor?: string; exhausted: boolean; message?: string; totalMessageCount?: number; totalThreadCount?: number };
type Job = { runId: string; controller: AbortController; done: Promise<void> };
type Options = { now?: () => number; pageDelayMs?: number; retryDelayMs?: number; maxThreads?: number; maxPages?: number; wait?: (milliseconds: number, signal: AbortSignal) => Promise<void> };
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const headKey = (scope: string) => `mail:index:head:${scope}`;
const dataPrefix = (scope: string, runId: string) => `mail:index:data:${scope}:${runId}:`;
const pageKey = (scope: string, runId: string, n: number) => `${dataPrefix(scope, runId)}p:${String(n).padStart(8, '0')}`;
const token = (head: Head) => `${head.runId}.${head.revision}`;
const available = (account?: ConnectedAccount) => !!account && ['connected', 'refreshing'].includes(account.state) && account.capabilities.mailRead;

/** Original Dream Claw paging/merge lifecycle, using Nova Dream authority and storage.
 * Each immutable page is encrypted and committed with its cursor. Completed refreshes
 * replace the old crawl; partial refreshes keep its searchable rows until then. */
export class MailIndexService {
  private closed = false;
  private jobs = new Map<string, Job>();
  private reads = new Map<string, Promise<MailIndexResult>>();
  private readers = 0;
  private cleaning = false;
  private readRevision = 0;
  private readChanges = new Map<string, Map<string, {revision:number;unread:boolean}>>();
  private cleanup?: Promise<void>;
  private now: () => number;
  constructor(private store: Store, private accounts: Pick<Accounts, 'state' | 'mailRead'>, private options: Options = {}) {
    this.now = options.now ?? Date.now;
  }
  start() { this.pump(); this.prune(); }
  private wait(milliseconds: number, signal: AbortSignal) { return this.options.wait ? this.options.wait(milliseconds, signal) : delay(milliseconds, undefined, { signal }); }
  private stamp() { return new Date(this.now()).toISOString(); }
  private open() { if (this.closed) throw new Fault(503, 'mail_index_closed', 'Mail indexing is restarting. Saved mail remains available.'); }
  private account(input: Pick<MailIndexRead, 'epoch' | 'accountId' | 'generation'>): ConnectedAccount {
    this.open();
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Reopen Inbox after workspace recovery.');
    const account = this.accounts.state('').accounts.find(account => account.id === input.accountId);
    if (!available(account) || account!.generation !== input.generation) throw new Fault(409, 'account_changed', 'This mail connection changed. Reopen its current Inbox.');
    return account!;
  }
  private scope(input: Pick<MailIndexRead, 'epoch' | 'accountId' | 'generation'>) { return hash(JSON.stringify([input.epoch, input.accountId, input.generation])); }
  private head(scope: string) { return this.store.internalRead<Head>(headKey(scope)); }
  private heads() { return this.store.internalList<Head>('mail:index:head:'); }
  private write(head: Head) { return this.store.internalWrite(headKey(head.scope), { ...head, revision: head.revision + 1, updatedAt: this.stamp() }); }
  private current(head: Head, signal?: AbortSignal) {
    this.account(head); signal?.throwIfAborted();
    const current = this.head(head.scope);
    if (!current || current.runId !== head.runId || current.status !== 'indexing') throw new Fault(409, 'mail_index_changed', 'This index job has stopped or been replaced.');
    return current;
  }
  private create(input: MailIndexRead, provider: MailIndexProvider, previous?: Head, refresh = false): Head {
    const snapshot = createMailIndexSnapshot(provider, input.accountId, this.stamp());
    const { threads: _threads, schemaVersion: _schema, query: _query, ...fields } = snapshot;
    return { ...fields, scope: this.scope(input), epoch: input.epoch, generation: input.generation,
      runId: randomUUID(), revision: previous?.revision ?? 0, count: 0, status: 'indexing', startedAt: this.stamp(), seen: [],
      ...(provider === 'microsoft' ? { microsoftIdType: 'immutable' } : {}),
      ...(refresh && previous ? { base: { runId: previous.runId, pages: previous.pagesIndexed }, completedAt: previous.completedAt } : {}),
      retired: [...new Set([...(previous?.retired ?? []), ...(!refresh && previous ? [previous.runId, ...(previous.base ? [previous.base.runId] : [])] : [])])],
    };
  }
  async read(_device: string, raw: unknown): Promise<MailIndexResult> {
    const input = mailIndexReadSchema.parse(raw), account = this.account(input), scope = this.scope(input), head = this.head(scope);
    if (!head) return { accountId: account.id, generation: account.generation, revision: 'none', snapshot: createMailIndexSnapshot(account.provider === 'google' ? 'gmail' : 'microsoft', account.id, this.stamp()) };
    if (input.revision === token(head)) return { accountId: account.id, generation: account.generation, runId: head.runId, revision: token(head), unchanged: true };
    const key = scope + ':' + token(head);
    let reading = this.reads.get(key);
    if (!reading) {
      reading = this.snapshot(head); this.reads.set(key, reading);
      void reading.finally(() => this.reads.delete(key)).catch(() => {});
    }
    const result = await reading; this.account(input); return result;
  }
  private async readRun(head: Head, run: Run) {
    const threads: IndexedMailThread[] = [];
    for (let page = 0; page < run.pages; page++) {
      const value = this.store.internalRead<IndexedMailThread[]>(pageKey(head.scope, run.runId, page));
      if (!value) throw new Fault(409, 'mail_index_page_missing', 'A saved index page is unavailable. Rebuild this index; provider mail is unchanged.');
      threads.push(...value);
      if (page % 8 === 7) { await yieldTurn(); this.account(head); }
    }
    return mergeIndexedMailThreads([], threads);
  }
  private async snapshot(head: Head): Promise<MailIndexResult> {
    this.readers++;
    try {
      const base = head.base ? await this.readRun(head, head.base) : [], current = await this.readRun(head, { runId: head.runId, pages: head.pagesIndexed });
      // Fresh rows replace old labels/metadata, while unseen cached rows remain
      // searchable until a whole new crawl completes successfully.
      const byId = new Map(base.map(thread => [thread.id, thread]));
      current.forEach(thread => byId.set(thread.id, thread));
      const threads = mergeIndexedMailThreads([], [...byId.values()]);
      this.account(head);
      const latest = this.head(head.scope);
      if (!latest || latest.runId !== head.runId) throw new Fault(409, 'mail_index_changed', 'The index changed while loading. Open its current view.');
      return { accountId: head.accountId, generation: head.generation, runId: head.runId, revision: token(head), snapshot: {
        ...createMailIndexSnapshot(head.provider, head.accountId, head.updatedAt), threads, status: head.status,
        exhausted: head.exhausted, microsoftIdType: head.microsoftIdType, pagesIndexed: head.pagesIndexed,
        startedAt: head.startedAt, updatedAt: head.updatedAt, completedAt: head.completedAt,
        lastSuccessfulPageAt: head.lastSuccessfulPageAt, totalMessageCount: head.totalMessageCount,
        totalThreadCount: head.totalThreadCount, error: head.error,
      } };
    } finally { this.readers--; this.prune(); }
  }
  async command(device: string, raw: unknown): Promise<MailIndexResult> {
    const cmd = mailIndexCommandSchema.parse(raw), account = this.account(cmd), scope = this.scope(cmd);
    const admission = this.store.admit(device, cmd, { type: 'mail-index', ...cmd }, () => {
      const existing = this.head(scope);
      if (cmd.expectedRunId && cmd.expectedRunId !== existing?.runId) throw new Fault(409, 'mail_index_changed', 'Another index job is active. Review its current state.');
      if (cmd.action === 'pause') {
        if (!existing) throw new Fault(409, 'mail_index_changed', 'There is no index job to pause.');
        if (existing.status !== 'complete') this.write({ ...existing, status: 'paused', error: undefined });
        return { runId: existing.runId, action: 'pause' };
      }
      if (existing && cmd.mode !== 'rebuild' && existing.status === 'indexing') return { runId: existing.runId, action: 'sync' };
      if (existing?.exhausted && cmd.mode === 'resume') return { runId: existing.runId, action: 'sync' };
      const fresh = !existing || cmd.mode === 'rebuild' || (cmd.mode === 'refresh' && existing.exhausted);
      const next = fresh ? this.create(cmd, account.provider === 'google' ? 'gmail' : 'microsoft', existing, cmd.mode === 'refresh' && !!existing?.exhausted)
        : { ...existing!, status: 'indexing' as const, error: undefined };
      this.write(next); return { runId: next.runId, action: 'sync' };
    });
    if (admission.fresh) {
      const job = this.jobs.get(scope), current = this.head(scope);
      if (job && (current?.status !== 'indexing' || current.runId !== job.runId)) job.controller.abort();
      this.pump(); this.prune();
    }
    return this.read(device, { epoch: cmd.epoch, accountId: cmd.accountId, generation: cmd.generation });
  }
  /** Queue a fresh pass after provider writes, preserving a user's paused job
   * and the existing readable index until its replacement is complete. */
  async providerChanged(identity: {epoch:string;accountId:string;generation:string},threadId?:string,unread?:boolean) {
    this.account(identity);const scope=this.scope(identity);
    if(threadId&&unread!==undefined){
      const changes=this.readChanges.get(scope)??new Map();changes.set(threadId,{revision:++this.readRevision,unread});this.readChanges.set(scope,changes);
      if(changes.size>2000)changes.delete(changes.keys().next().value!);
      const head=this.head(scope);if(!head)return;
      const entries:{id:string;value:unknown}[]=[];
      for(const run of [{runId:head.runId,pages:head.pagesIndexed},...(head.base?[head.base]:[])])for(let page=0;page<run.pages;page++){
        const id=pageKey(scope,run.runId,page),rows=this.store.internalRead<IndexedMailThread[]>(id);
        if(rows?.some(row=>row.id===threadId))entries.push({id,value:rows.map(row=>row.id===threadId?{...row,labels:unread?[...new Set([...row.labels,'UNREAD'])]:row.labels.filter(label=>label!=='UNREAD')}:row)});
      }
      entries.push({id:headKey(scope),value:{...head,revision:head.revision+1,updatedAt:this.stamp()}});this.store.internalBatch(entries);
      return;
    }
    this.store.internalWrite(`mail:index:changed:${scope}`,true);this.pump();
  }
  private pump() {
    if (this.closed) return;
    for (let head of this.heads()) {
      if (this.jobs.size >= 4) break;
      if(head.status==='complete'&&!this.jobs.has(head.scope)&&this.store.internalRead(`mail:index:changed:${head.scope}`)) {
        const next=this.create({epoch:head.epoch,accountId:head.accountId,generation:head.generation},head.provider,head,true);
        this.store.internalBatch([{id:headKey(head.scope),value:next}],[`mail:index:changed:${head.scope}`]);head=next;
      }
      if (head.status !== 'indexing' || this.jobs.has(head.scope)) continue;
      try { this.account(head); } catch { continue; }
      const controller = new AbortController();
      const done = this.runMailIndexJob(head, controller.signal).finally(() => {
        if (this.jobs.get(head.scope)?.controller === controller) this.jobs.delete(head.scope);
        this.pump(); this.prune();
      });
      this.jobs.set(head.scope, { runId: head.runId, controller, done });
      void done.catch(() => {});
    }
  }
  private async fetchMailIndexPage(head: Head, signal: AbortSignal): Promise<Page> {
    const readRevision=this.readRevision;
    const selector: MailReadSelector = head.provider === 'gmail' ? { kind: 'gmail.threads', query: 'in:inbox', max: 25 }
      : { kind: 'microsoft.threads', folder: 'inbox', max: 100, unreadOnly: false };
    const result = await this.accounts.mailRead(head.accountId, head.generation, selector, head.nextCursor, signal);
    this.current(head, signal);
    const value = result.value as { threads?: unknown[] };
    if (!Array.isArray(value.threads)) throw new ProviderError('invalid_response', 'The provider returned no valid index page.');
    const threads = head.provider === 'gmail' ? normalizeGmailIndexThreads(value.threads) : mergeIndexedMailThreads([], value.threads);
    let counts: Pick<Page, 'totalMessageCount' | 'totalThreadCount'> = {};
    if (head.pagesIndexed === 0) {
      try {
        const stats = await this.accounts.mailRead(head.accountId, head.generation, head.provider === 'gmail' ? { kind: 'gmail.stats' } : { kind: 'microsoft.stats', folder: 'inbox' }, undefined, signal);
        const count = stats.value as { messagesTotal?: number; threadsTotal?: number; totalItemCount?: number };
        counts = { totalMessageCount: count.messagesTotal ?? count.totalItemCount, totalThreadCount: count.threadsTotal };
      } catch { this.current(head, signal); /* Counts may fail independently of a valid message page. */ }
    }
    return { threads, readRevision, nextCursor: result.next, exhausted: !result.next && !result.message, message: result.message, ...counts };
  }
  private async fetchMailIndexPageWithRetry(head: Head, signal: AbortSignal) {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.current(head, signal);
      try { return await this.fetchMailIndexPage(head, signal); }
      catch (error) {
        last = error; this.current(head, signal);
        if (error instanceof Fault || (error instanceof ProviderError && !['throttled', 'unavailable'].includes(error.code))) throw error;
        if (attempt < 2) {
          const retryAfter = error instanceof ProviderError ? error.retryAfterSeconds : undefined;
          const backoff = (this.options.retryDelayMs ?? (head.provider === 'gmail' && error instanceof ProviderError && error.code === 'throttled' ? 30000 : 800)) * 2 ** attempt;
          await this.wait(Math.max(backoff, Number.isFinite(retryAfter) ? Math.min(86400, Math.max(0, retryAfter!)) * 1000 : 0), signal);
        }
      }
    }
    throw last;
  }
  private async runMailIndexJob(initial: Head, signal: AbortSignal) {
    await yieldTurn();
    let head = initial;
    try {
      while (true) {
        head = this.current(head, signal);
        if (head.count >= (this.options.maxThreads ?? MAX_INDEXED_THREADS) || head.pagesIndexed >= (this.options.maxPages ?? 10000)) {
          this.write({ ...head, status: 'paused', error: 'Indexing paused at the local safety limit. Existing mail remains searchable.' }); return;
        }
        const page = await this.fetchMailIndexPageWithRetry(head, signal);
        head = this.current(head, signal);
        const seen = [...head.seen], digest = page.nextCursor && hash(page.nextCursor), repeated = !!digest && seen.includes(digest);
        if (digest && !repeated) seen.push(digest);
        let count = head.count, limited = false;
        const entries: { id: string; value: unknown }[] = [], pageIds = new Set<string>();
        const threads = page.threads.map(thread=>{
          const change=this.readChanges.get(head.scope)?.get(thread.id);
          return change&&change.revision>page.readRevision?{...thread,labels:change.unread?[...new Set([...thread.labels,'UNREAD'])]:thread.labels.filter(label=>label!=='UNREAD')}:thread;
        }).filter(thread => {
          const id = dataPrefix(head.scope, head.runId) + 't:' + hash(thread.id);
          if (!pageIds.has(thread.id) && !this.store.internalRead<boolean>(id)) {
            if (count >= (this.options.maxThreads ?? MAX_INDEXED_THREADS)) { limited = true; return false; }
            count++; entries.push({ id, value: true }); pageIds.add(thread.id);
          }
          return true;
        });
        const complete = page.exhausted && !limited && !repeated;
        const partial = limited || repeated || !!page.message;
        const error = repeated ? 'The provider repeated an index page. Existing mail remains searchable; rebuild the index to retry.' : limited ? 'Indexing paused at the local safety limit. Existing mail remains searchable.' : page.message;
        const next: Head = { ...head, count, seen, nextCursor: limited ? head.nextCursor : page.nextCursor,
          pagesIndexed: head.pagesIndexed + 1, exhausted: complete, status: complete ? 'complete' : partial ? 'paused' : 'indexing',
          error, totalMessageCount: page.totalMessageCount ?? head.totalMessageCount, totalThreadCount: page.totalThreadCount ?? head.totalThreadCount,
          updatedAt: this.stamp(), lastSuccessfulPageAt: this.stamp(), completedAt: complete ? this.stamp() : head.completedAt,
          revision: head.revision + 1,
          ...(complete ? { base: undefined, retired: [...head.retired, ...(head.base ? [head.base.runId] : [])] } : {}),
        };
        entries.push({ id: pageKey(head.scope, head.runId, head.pagesIndexed), value: threads }, { id: headKey(head.scope), value: next });
        this.store.internalBatch(entries); head = next;
        if (complete || partial) return;
        // Gmail charges 40 units per thread and allows 6,000 per user/minute.
        // Small, spaced batches leave capacity for the foreground reader.
        await this.wait(this.options.pageDelayMs ?? (head.provider === 'gmail' ? 15000 : 350), signal);
      }
    } catch (error) {
      if (this.closed || signal.aborted) return;
      const current = this.head(head.scope);
      if (!current || current.runId !== head.runId || current.status !== 'indexing') return;
      this.write({ ...current, status: 'error', error: error instanceof ProviderError || error instanceof Fault ? error.message : 'Mail indexing was interrupted. Existing mail remains searchable; resume to retry.' });
    }
  }
  private prune() {
    if (this.closed || this.cleaning || this.readers) return;
    this.cleaning = true;
    this.cleanup = (async () => {
      for (const head of this.heads()) for (const runId of head.retired) {
        while (!this.closed && !this.readers) {
          const rows = this.store.internalPage(dataPrefix(head.scope, runId), '', 100);
          if (!rows.length) {
            const current = this.head(head.scope);
            if (current) this.store.internalWrite(headKey(head.scope), { ...current, retired: current.retired.filter(id => id !== runId) });
            break;
          }
          this.store.internalBatch([], rows.map(row => row.id)); await yieldTurn();
        }
      }
    })().finally(() => { this.cleaning = false; });
    void this.cleanup.catch(() => {});
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
    await Promise.allSettled([...this.reads.values(), ...(this.cleanup ? [this.cleanup] : [])]);
  }
}
