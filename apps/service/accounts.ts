import type { CalendarRequest } from './provider-calendar-write.js';
import type { MailRequest } from './provider-mail-delivery.js';
import type { AccountCapabilities } from '../../packages/domain/accounts.js';
import type { MailReadSelector } from '../../packages/domain/mail.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { accountActionSchema, cancelAccountSignInSchema, configureAccountSchema, connectAccountSchema, type AccountReadProbe, type AccountsState, type AccountSignIn, type ClientConfiguration, type ConnectedAccount, type Provider } from '../../packages/domain/accounts.js';
import { Fault, Store } from './store.js';
import { accountCapabilities, accountScopes, authorizationUrl, ProviderError, Providers, readScopes, type ProviderTokens } from './providers.js';

type Configuration = { revision: number; value: ClientConfiguration };
type Attempt = AccountSignIn & { clientRevision: number; baseAccounts: Record<string, number>; expectedAccountId?: string; completionId: string; scopes?: string[]; preserveGeneration?:string; loginHint?:string };
type Credential = { generation: string; configuration: ClientConfiguration; tokens: ProviderTokens; version?:string };
type Live = { controller: AbortController; server?: Server; url?: string; ready?: Promise<void>; removeCallback?: () => void };
const active = (a: AccountSignIn) => ['preparing', 'waiting', 'exchanging'].includes(a.state);
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const stamp = (time: number) => new Date(time).toISOString();

/** Dedicated E3 OAuth authority. No predecessor config, token stores or browser passwords. */
export class Accounts {
  private live = new Map<string, Live>();
  private jobs = new Set<Promise<unknown>>();
  private refreshing = new Map<string, Promise<Credential>>();
  private probing = new Map<string, Promise<AccountReadProbe>>();
  private controllers = new Set<AbortController>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private webCallbacks = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>();
  constructor(private store: Store, private providers = new Providers(), private now: () => number = Date.now, private callbackOrigin?: string) {
    for (const attempt of this.attempts()) if (active(attempt)) this.writeAttempt({ ...attempt, state: attempt.state === 'exchanging' ? 'unknown' : 'expired', message: 'The service restarted. Start a new sign-in; the old attempt will not be replayed.' });
    for (const account of this.accounts()) if (account.state === 'refreshing') this.writeAccount({ ...account, state: 'reconnect', revision: account.revision + 1, message: 'An account refresh was interrupted. Sign in again; saved work is kept.' });
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
  }
  private config(provider: Provider) { return this.store.internalRead<Configuration>(`accounts:client:${provider}`); }
  private ensureOpen() { if (this.closed) throw new Fault(503, 'account_service_closed', 'The account service is closing.'); }
  private attempts() { return this.store.internalList<Attempt>('accounts:attempt:'); }
  private permissions(a:ConnectedAccount) { return {...a,capabilities:{...a.capabilities,mailModify:accountCapabilities(a.provider,a.scopes).mailModify}}; }
  private accounts() { return this.store.internalList<ConnectedAccount>('accounts:item:').map(a=>this.permissions(a)); }
  private attempt(id: string) { return this.store.internalRead<Attempt>(`accounts:attempt:${id}`); }
  private account(id: string) { const a=this.store.internalRead<ConnectedAccount>(`accounts:item:${id}`);return a&&this.permissions(a); }
  private writeAttempt(a: Attempt) { return this.store.internalWrite(`accounts:attempt:${a.id}`, a); }
  private writeAccount(a: ConnectedAccount) { return this.store.internalWrite(`accounts:item:${a.id}`, { ...a, updatedAt: stamp(this.now()) }); }
  private track<T>(job: Promise<T>) { this.jobs.add(job); void job.finally(() => this.jobs.delete(job)).catch(() => {}); return job; }
  private stopLive(id: string) { const live = this.live.get(id); this.live.delete(id); live?.removeCallback?.(); live?.controller.abort(); live?.server?.close(); live?.server?.closeAllConnections(); }
  webCallback(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', this.callbackOrigin);
    const states = url.searchParams.getAll('state'), callback = states.length === 1 ? this.webCallbacks.get(states[0]) : undefined;
    if (!callback) throw new Fault(400, 'account_callback_invalid', 'This sign-in response is no longer available. Start a new account connection.');
    callback(request, response);
  }
  private sweep() {
    if (this.closed) return;
    for (const a of this.attempts()) if (active(a) && this.now() >= a.expiresAt) { this.writeAttempt({ ...a, state: a.state === 'exchanging' ? 'unknown' : 'expired', message: 'This sign-in expired. Start a new sign-in when ready.' }); this.stopLive(a.id); }
  }
  private view(a: Attempt, device: string): AccountSignIn & { authorizationUrl?: string } {
    const { clientRevision, baseAccounts, expectedAccountId, completionId, scopes, preserveGeneration, loginHint, ...publicPart } = a;
    const url = a.deviceId === device && a.state === 'waiting' ? this.live.get(a.id)?.url : undefined;
    return { ...publicPart, ...(url ? { authorizationUrl: url } : {}) };
  }
  state(device: string): AccountsState {
    this.ensureOpen();
    this.sweep();
    return { ...(this.callbackOrigin ? { callbackUri: this.callbackOrigin + '/oauth/callback' } : {}), clients: (['google', 'microsoft'] as const).map(provider => {
      const c = this.config(provider); return { provider, revision: c?.revision ?? 0, configured: !!c, ...(c ? { clientId: c.value.clientId, ...(c.value.provider === 'google' ? { hasClientSecret: !!c.value.clientSecret } : { tenant: c.value.tenant, callbackPort: c.value.callbackPort, ...(c.value.clientSecret ? { hasClientSecret: true } : {}) }) } : {}) };
    }), accounts: this.accounts(), attempts: this.attempts().filter(a => a.deviceId === device).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(a => this.view(a, device)), probes: this.store.internalList<AccountReadProbe>('accounts:probe:').filter(p => this.account(p.accountId)?.generation === p.generation) };
  }
  configure(device: string, raw: unknown) {
    this.ensureOpen();
    const cmd = configureAccountSchema.parse(raw);
    return this.store.admit(device, cmd, { type: 'account-configure', ...cmd }, () => {
      const previous = this.config(cmd.configuration.provider);
      if ((previous?.revision ?? 0) !== cmd.expectedRevision) throw new Fault(409, 'account_configuration_changed', 'Another window changed this provider setup. Review the current setup.');
      if (this.attempts().some(a => a.provider === cmd.configuration.provider && active(a))) throw new Fault(409, 'account_signin_active', 'Finish or cancel the current sign-in before changing its setup.');
      const value = cmd.configuration.clientSecret === undefined && previous?.value.provider === cmd.configuration.provider && previous.value.clientId === cmd.configuration.clientId && previous.value.clientSecret
        ? { ...cmd.configuration, clientSecret: previous.value.clientSecret } : cmd.configuration;
      this.store.internalWrite(`accounts:client:${cmd.configuration.provider}`, { revision: cmd.expectedRevision + 1, value });
      const result = { provider: cmd.configuration.provider, revision: cmd.expectedRevision + 1, configured: true };
      this.store.internalWrite(`accounts:configuration-receipt:${cmd.requestId}`, { deviceId: device, epoch: cmd.epoch, result });
      return result;
    }).value;
  }
  configurationReceipt(device: string, id: string) {
    this.ensureOpen();
    const receipt = this.store.internalRead<{ deviceId: string; epoch: string; result: { provider: Provider; revision: number; configured: boolean } }>(`accounts:configuration-receipt:${id}`);
    if (!receipt || receipt.deviceId !== device) throw new Fault(404, 'account_configuration_unconfirmed', 'This setup request is not confirmed. Review the current setup before saving again.');
    if (receipt.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Review account setup after workspace recovery.');
    return receipt.result;
  }
  async start(device: string, raw: unknown) {
    this.ensureOpen();
    const cmd = connectAccountSchema.parse(raw); this.sweep();
    const receipt = this.store.admit(device, cmd, { type: 'account-signin', ...cmd }, () => {
      const configuration = this.config(cmd.provider);
      if (!configuration) throw new Fault(409, 'account_client_missing', 'Set up this provider’s Nova Dream OAuth client first.');
      if (this.attempts().some(a => a.provider === cmd.provider && active(a))) throw new Fault(409, 'account_signin_active', 'This provider already has a sign-in in progress.');
      const existing = cmd.accountId ? this.account(cmd.accountId) : undefined;
      if (cmd.accountId && (!existing || existing.provider !== cmd.provider || existing.revision !== cmd.expectedRevision)) throw new Fault(409, 'account_changed', 'Review the current account before reconnecting.');
      const upgrading=!!existing&&!!cmd.permissions?.length;
      const credential=existing&&this.store.internalRead<Credential>(`accounts:credential:${existing.id}`);
      if(upgrading&&(existing.state!=='connected'||!credential?.tokens||JSON.stringify(credential.configuration)!==JSON.stringify(configuration.value)))throw new Fault(409,'account_changed','Reconnect this account with the current setup before adding permissions.');
      const a: Attempt = { id: randomUUID(), provider: cmd.provider, deviceId: device, epoch: this.store.epoch, createdAt: this.now(), expiresAt: this.now() + 600000, state: 'preparing', message: 'Preparing private browser sign-in…', clientRevision: configuration.revision, baseAccounts: Object.fromEntries(this.accounts().filter(a => a.provider === cmd.provider).map(a => [a.id, a.revision])), ...(cmd.accountId ? { expectedAccountId: cmd.accountId } : {}), completionId: randomUUID(), requestedPermissions:[...new Set(cmd.permissions??[])],scopes:accountScopes(cmd.provider,cmd.permissions,existing?.scopes),...(upgrading?{preserveGeneration:existing.generation}:{}),...(existing?.email?{loginHint:existing.email}:{}) };
      this.writeAttempt(a); return a.id;
    });
    if (receipt.fresh) {
      const live: Live = { controller: new AbortController() }; this.live.set(receipt.value, live);
      live.ready = this.track(this.prepare(receipt.value, live));
    }
    await this.live.get(receipt.value)?.ready;
    const a = this.attempt(receipt.value); if (!a || a.deviceId !== device) throw new Fault(409, 'account_signin_missing', 'This sign-in is no longer available.');
    return this.view(a, device);
  }
  private async prepare(id: string, live: Live) {
    const a = this.attempt(id)!, configuration = this.config(a.provider)!;
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    let redirectUri = '';
    let server: Server | undefined;
    const removeCallback = () => { server?.close(); live.removeCallback?.(); };
    const callback = (req: IncomingMessage, res: ServerResponse) => {
      const answer = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff' }); res.end(`<!doctype html><title>Nova Dream account connection</title><h1>Nova Dream</h1><p>${message}</p><p>Return to Nova Dream to check your account connection.</p>`); };
      if (req.method !== 'GET' || !redirectUri || `${this.callbackOrigin ? 'https' : 'http'}://${req.headers.host}` !== new URL(redirectUri).origin || (req.url?.length ?? 0) > 7000) return answer(400, 'This callback was not accepted.');
      let url: URL; try { url = new URL(req.url ?? '/', redirectUri); } catch { return answer(400, 'This callback was not accepted.'); }
      if (url.origin !== new URL(redirectUri).origin || url.pathname !== '/oauth/callback' || url.searchParams.getAll('state').length !== 1 || !equal(url.searchParams.get('state') ?? '', state)) return answer(400, 'This callback does not match the sign-in.');
      const current = this.attempt(id);
      if (this.closed || this.live.get(id) !== live || !current || current.state !== 'waiting' || this.now() >= current.expiresAt) return answer(409, 'This sign-in is no longer waiting for a response.');
      if (url.searchParams.has('error')) {
        if (url.searchParams.has('code') || url.searchParams.getAll('error').length !== 1) return answer(400, 'The provider response was not accepted.');
        this.writeAttempt({ ...current, state: 'failed', message: 'The provider did not approve this sign-in. You can try again when ready.' }); answer(200, 'The account was not connected.'); removeCallback(); this.live.delete(id); return;
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) return answer(400, 'The provider response was incomplete.');
      this.writeAttempt({ ...current, state: 'exchanging', message: 'Verifying the provider account…' }); answer(200, 'Sign-in received. Nova Dream is verifying the account.');
      removeCallback(); void this.track(this.complete(id, live, configuration, code, verifier, redirectUri));
    };
    try {
      if (this.callbackOrigin) {
        redirectUri = this.callbackOrigin + '/oauth/callback';
        this.webCallbacks.set(state, callback); live.removeCallback = () => this.webCallbacks.delete(state);
      } else {
        const local = createServer({ maxHeaderSize: 8192 }, callback); server = local;
        local.headersTimeout = 10000; local.requestTimeout = 10000; local.keepAliveTimeout = 1000; live.server = local;
        await new Promise<void>((accept, reject) => { local.once('error', reject); local.listen(configuration.value.provider === 'microsoft' ? configuration.value.callbackPort : 0, '127.0.0.1', () => { local.removeListener('error', reject); accept(); }); });
        const address = local.address(); if (!address || typeof address === 'string') throw new Error('No callback address');
        redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
      }
      if (this.closed || this.live.get(id) !== live || this.attempt(id)?.state !== 'preparing') { removeCallback(); return; }
      live.url = authorizationUrl(configuration.value, redirectUri, state, challenge,a.scopes??readScopes[a.provider],a.loginHint);
      this.writeAttempt({ ...a, state: 'waiting', message: 'Continue in your system browser to choose the account and permissions.' });
    } catch {
      if (!this.closed && this.attempt(id)?.state === 'preparing') this.writeAttempt({ ...a, state: 'failed', message: 'The local sign-in address is unavailable. Check setup and try again; no other service was stopped.' });
      this.stopLive(id);
    }
  }
  private async complete(id: string, live: Live, configuration: Configuration, code: string, verifier: string, redirectUri: string) {
    try {
      const intent=this.attempt(id)!;
      const tokens = await this.providers.exchange(configuration.value, code, verifier, redirectUri, live.controller.signal,intent.scopes??readScopes[intent.provider]);
      if (this.closed || this.live.get(id) !== live || this.attempt(id)?.state !== 'exchanging' || live.controller.signal.aborted) return;
      const profile = await this.providers.profile(configuration.value.provider, tokens.accessToken, live.controller.signal);
      if (this.closed) return;
      const a = this.attempt(id)!;
      if (this.live.get(id) !== live || a.state !== 'exchanging' || this.now() >= a.expiresAt) return;
      const accountId = `${a.provider}:${createHash('sha256').update(profile.subject).digest('hex').slice(0, 40)}`;
      this.store.admit(a.deviceId, { requestId: a.completionId, epoch: a.epoch }, { type: 'account-signin-complete', attemptId: a.id }, () => {
        const previous = this.account(accountId);
        if (a.expectedAccountId && a.expectedAccountId !== accountId) throw new Fault(409, 'account_identity_changed', 'A different account was selected. The original connection was kept.');
        if ((previous?.revision ?? 0) !== (a.baseAccounts[accountId] ?? 0) || this.config(a.provider)?.revision !== a.clientRevision) throw new Fault(409, 'account_changed', 'The account or provider setup changed during sign-in. Review before trying again.');
        if(a.preserveGeneration&&previous?.generation!==a.preserveGeneration)throw new Fault(409,'account_changed','This account connection changed while adding permissions. Your saved work is kept.');
        const generation = a.preserveGeneration??randomUUID(), time = stamp(this.now());
        const account: ConnectedAccount = { id: accountId, provider: a.provider, ...profile, revision: (previous?.revision ?? 0) + 1, generation, state: 'connected', scopes: tokens.scopes, capabilities: accountCapabilities(a.provider, tokens.scopes), connectedAt: a.preserveGeneration?previous!.connectedAt:time, updatedAt: time };
        this.store.internalWrite(`accounts:credential:${accountId}`, { generation, configuration: configuration.value, tokens,version:randomUUID() } satisfies Credential);
        const missingPermissions=(a.requestedPermissions??[]).filter(permission=>!account.capabilities[permission]);
        this.writeAccount(account); this.writeAttempt({ ...a, state: 'completed', accountId,missingPermissions,message:missingPermissions.length?'Account verified. Some requested permissions were not granted. Review this account’s current access.':a.preserveGeneration?'Account permissions updated. Your saved work stays with this account.':'Account identity verified. Check mail and calendar access next.' }); return accountId;
      });
    } catch (error) {
      if (!this.closed) { const a = this.attempt(id); if (a?.state === 'exchanging') this.writeAttempt({ ...a, state: error instanceof Fault || (error instanceof ProviderError && ['permission', 'reconnect'].includes(error.code)) ? 'failed' : 'unknown', message: error instanceof Fault || error instanceof ProviderError ? error.message : 'The account response is unconfirmed. Start a new sign-in; this attempt will not be replayed.' }); }
    } finally { this.stopLive(id); }
  }
  cancel(device: string, raw: unknown) {
    this.ensureOpen();
    const cmd = cancelAccountSignInSchema.parse(raw);
    const result = this.store.admit(device, cmd, { type: 'account-signin-cancel', ...cmd }, () => {
      const a = this.attempt(cmd.attemptId);
      if (!a || a.deviceId !== device) throw new Fault(404, 'account_signin_missing', 'This sign-in is not owned by this device.');
      if (!active(a)) return this.view(a, device);
      return this.view(this.writeAttempt({ ...a, state: 'cancelled', message: 'Sign-in stopped. Existing account connections were kept.' }), device);
    }).value;
    this.stopLive(cmd.attemptId); return result;
  }
  disconnect(device: string, raw: unknown) {
    this.ensureOpen();
    const cmd = accountActionSchema.parse(raw);
    return this.store.admit(device, cmd, { type: 'account-disconnect', ...cmd }, () => {
      const a = this.account(cmd.accountId);
      if (!a || a.revision !== cmd.expectedRevision) throw new Fault(409, 'account_changed', 'This account changed. Review the current connection.');
      const next = this.writeAccount({ ...a, revision: a.revision + 1, generation: randomUUID(), state: 'disconnected', scopes: [], capabilities: accountCapabilities(a.provider, []), message: 'Disconnected from Nova Dream. Provider-side consent can be managed in your account settings.' });
      this.store.internalWrite(`accounts:credential:${a.id}`, { disconnected: true }); return next;
    }).value;
  }
  private currentAccount(id: string, generation: string) {
    if (this.closed) throw new Fault(503, 'account_service_closed', 'The account service is closing.');
    const a = this.account(id);
    if (!a || a.generation !== generation || !['connected', 'refreshing'].includes(a.state)) throw new Fault(409, 'account_changed', 'The account connection changed. Refresh its status before continuing.');
    return a;
  }
  private async credential(account: ConnectedAccount): Promise<Credential> {
    if (this.store.recoveryEffectsPaused) throw new Fault(409, 'recovery_held', 'Connected accounts are paused while this recovered workspace is reviewed.');
    const key = `${account.id}:${account.generation}`, running = this.refreshing.get(key);
    if (running) return running;
    this.currentAccount(account.id, account.generation);
    const credential = this.store.internalRead<Credential>(`accounts:credential:${account.id}`);
    if (!credential?.tokens || credential.generation !== account.generation) throw new Fault(409, 'account_changed', 'Sign in to this account again.');
    if (credential.tokens.expiresAt > this.now() + 60000) return credential;
    if (!credential.tokens.refreshToken) {
      this.writeAccount({ ...account, revision: account.revision + 1, state: 'reconnect', message: 'This account session expired. Sign in again; saved work is kept.' });
      throw new Fault(409, 'account_reconnect', 'Sign in to this account again.');
    }
    const refreshing = this.writeAccount({ ...account, revision: account.revision + 1, state: 'refreshing', message: 'Refreshing the account connection…' });
    const controller = new AbortController(); this.controllers.add(controller);
    const job = this.track((async () => {
      try {
        const tokens = await this.providers.refresh(credential.configuration, credential.tokens.refreshToken!, credential.tokens.scopes, controller.signal);
        this.currentAccount(account.id, account.generation);
        const profile = await this.providers.profile(account.provider, tokens.accessToken, controller.signal);
        const current = this.currentAccount(account.id, account.generation);
        if (current.revision !== refreshing.revision || profile.subject !== account.subject) throw new Fault(409, 'account_identity_changed', 'The refreshed account identity did not match. Sign in again.');
        const next: Credential = { ...credential,version:randomUUID(), tokens: { ...tokens, ...(tokens.refreshToken ? {} : { refreshToken: credential.tokens.refreshToken }) } };
        this.store.admit('accounts-service', { requestId: randomUUID(), epoch: this.store.epoch }, { type: 'account-refreshed', accountId: account.id, generation: account.generation, revision: current.revision }, () => {
          this.store.internalWrite(`accounts:credential:${account.id}`, next);
          this.writeAccount({ ...current, revision: current.revision + 1, state: 'connected', message: 'Account connection refreshed.', scopes: tokens.scopes, capabilities: accountCapabilities(account.provider, tokens.scopes) }); return true;
        });
        return next;
      } catch (error) {
        if (!this.closed) { const current = this.account(account.id); if (current?.generation === account.generation && current.state === 'refreshing') this.writeAccount({ ...current, revision: current.revision + 1, state: 'reconnect', message: 'The refresh outcome is unconfirmed. Sign in again; saved work is kept.' }); }
        throw error;
      } finally { this.refreshing.delete(key); this.controllers.delete(controller); }
    })());
    this.refreshing.set(key, job); return job;
  }
  private async providerRead<T>(accountId: string, generation: string, capability: 'calendarRead' | 'mailRead', read: (account: ConnectedAccount, accessToken: string, signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    this.ensureOpen(); const account = this.currentAccount(accountId, generation), controller = new AbortController(); this.controllers.add(controller);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    return this.track((async () => {
      try {
        signal.throwIfAborted();
        const credential = await this.credential(account), current = this.currentAccount(accountId, generation);
        signal.throwIfAborted();
        if (!current.capabilities[capability]) throw new ProviderError('permission', capability === 'mailRead' ? 'This account has not granted mail read permission.' : 'This account has not granted calendar read permission.');
        const result = await read(current, credential.tokens.accessToken, signal); signal.throwIfAborted(); this.currentAccount(accountId, generation); return result;
      } catch (error) {
        if (!this.closed && error instanceof ProviderError && error.code === 'reconnect') {
          const current = this.account(accountId); if (current?.generation === generation && current.state === 'connected') this.writeAccount({ ...current, state: 'reconnect', revision: current.revision + 1, message: 'This provider needs a new sign-in. Saved work is kept.' });
        }
        throw error;
      } finally { this.controllers.delete(controller); }
    })());
  }
  /** A confirmed provider write result must survive a later disconnect. The
   * delivery journal owns its result; authority is checked before each dispatch. */
  mailOperation<T>(accountId: string, generation: string, capabilities: (keyof AccountCapabilities)[], signal: AbortSignal,
    run: (account: ConnectedAccount, request: MailRequest, beforeDispatch: () => void) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const account = this.currentAccount(accountId, generation), controller = new AbortController();
    this.controllers.add(controller);
    const abort = AbortSignal.any([signal, controller.signal]);
    let credentialVersion:string|undefined;
    const check = () => {
      this.ensureOpen(); abort.throwIfAborted();
      const current = this.currentAccount(accountId, generation);
      if (capabilities.some(capability => !current.capabilities[capability])) throw new ProviderError('permission', 'This mail action needs additional account permission. Your writing is kept.');
      const saved=this.store.internalRead<Credential>(`accounts:credential:${accountId}`);
      if(credentialVersion!==undefined&&(saved?.version??saved?.tokens?.accessToken)!==credentialVersion)throw new Fault(409,'account_changed','Account credentials changed before this mail action. Your writing is kept; check the saved operation.');
    };
    return this.track((async () => {
      try {
        check(); const credential = await this.credential(account);credentialVersion=credential.version??credential.tokens.accessToken; check();
        return await run(this.currentAccount(accountId, generation), this.providers.mailRequest(account.provider, credential.tokens.accessToken, abort), check);
      } finally { this.controllers.delete(controller); }
    })());
  }
  calendarOperation<T>(accountId: string, generation: string, capabilities: (keyof AccountCapabilities)[], signal: AbortSignal,
    run: (account: ConnectedAccount, request: CalendarRequest, beforeDispatch: () => void) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const account = this.currentAccount(accountId, generation), controller = new AbortController();
    this.controllers.add(controller);
    const abort = AbortSignal.any([signal, controller.signal]);
    let credentialVersion:string|undefined;
    const check = () => {
      this.ensureOpen(); abort.throwIfAborted();
      const current = this.currentAccount(accountId, generation);
      if (capabilities.some(capability => !current.capabilities[capability])) throw new ProviderError('permission', 'This Calendar action needs additional account permission. Your writing is kept.');
      const saved=this.store.internalRead<Credential>(`accounts:credential:${accountId}`);
      if(credentialVersion!==undefined&&(saved?.version??saved?.tokens?.accessToken)!==credentialVersion)throw new Fault(409,'account_changed','Account credentials changed before this Calendar action. Your writing is kept; check the saved operation.');
    };
    return this.track((async () => {
      try {
        check(); const credential = await this.credential(account);credentialVersion=credential.version??credential.tokens.accessToken; check();
        return await run(this.currentAccount(accountId, generation), this.providers.calendarRequest(account.provider, credential.tokens.accessToken, abort), check);
      } finally { this.controllers.delete(controller); }
    })());
  }
  contactOperation<T>(accountId: string, generation: string, capabilities: (keyof AccountCapabilities)[], signal: AbortSignal,
    run: (account: ConnectedAccount, request: MailRequest, beforeDispatch: () => void) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const account = this.currentAccount(accountId, generation), controller = new AbortController();
    this.controllers.add(controller);
    const abort = AbortSignal.any([signal, controller.signal]);
    let credentialVersion:string|undefined;
    const check = () => {
      this.ensureOpen(); abort.throwIfAborted();
      const current = this.currentAccount(accountId, generation);
      if (capabilities.some(capability => !current.capabilities[capability])) throw new ProviderError('permission', 'This contact action needs additional account permission. Your writing is kept.');
      const saved=this.store.internalRead<Credential>(`accounts:credential:${accountId}`);
      if(credentialVersion!==undefined&&(saved?.version??saved?.tokens?.accessToken)!==credentialVersion)throw new Fault(409,'account_changed','Account credentials changed before this contact action. Your writing is kept; check the saved operation.');
    };
    return this.track((async () => {
      try {
        check(); const credential = await this.credential(account);credentialVersion=credential.version??credential.tokens.accessToken; check();
        return await run(this.currentAccount(accountId, generation), this.providers.contactRequest(account.provider, credential.tokens.accessToken, abort), check);
      } finally { this.controllers.delete(controller); }
    })());
  }
  calendarSources(accountId: string, generation: string) { return this.providerRead(accountId, generation, 'calendarRead', (a, token, signal) => this.providers.calendars(a.provider, token, signal)); }
  calendarEvents(accountId: string, generation: string, calendarId: string, start: string, end: string) { return this.providerRead(accountId, generation, 'calendarRead', (a, token, signal) => this.providers.calendarEvents(a.provider, token, a.subject, calendarId, start, end, signal)); }
  mailRead(accountId: string, generation: string, selector: MailReadSelector, cursor?: string, signal?: AbortSignal) {
    return this.providerRead(accountId, generation, 'mailRead', (a, token, signal) => this.providers.mailRead(a.provider, token, a.subject, selector, cursor, signal), signal);
  }
  async probe(device: string, raw: unknown): Promise<AccountReadProbe> {
    this.ensureOpen();
    const cmd = accountActionSchema.parse(raw);
    if (cmd.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'Review the account after workspace recovery.');
    const account = this.account(cmd.accountId);
    if (!account || account.revision !== cmd.expectedRevision) throw new Fault(409, 'account_changed', 'The account changed. Refresh before checking access.');
    this.currentAccount(account.id, account.generation);
    const key = `${account.id}:${account.generation}`, existing = this.probing.get(key); if (existing) return existing;
    const controller = new AbortController(); this.controllers.add(controller);
    const job = this.track((async () => {
      try {
        const credential = await this.credential(account), current = this.currentAccount(account.id, account.generation);
        const denied = () => Promise.reject(new ProviderError('permission', 'This account has not granted read permission.'));
        const [calendars, mail] = await Promise.allSettled([
          current.capabilities.calendarRead ? this.providers.calendars(account.provider, credential.tokens.accessToken, controller.signal) : denied(),
          current.capabilities.mailRead ? this.providers.mailFolders(account.provider, credential.tokens.accessToken, controller.signal) : denied(),
        ]);
        const latest = this.currentAccount(account.id, account.generation);
        const message = (reason: unknown) => reason instanceof ProviderError ? reason.message : 'This provider read is unavailable.';
        const result: AccountReadProbe = { accountId: account.id, generation: account.generation, checkedAt: stamp(this.now()),
          calendars: calendars.status === 'fulfilled' ? { state: 'available', ...calendars.value } : { state: 'unavailable', items: [], limited: false, message: message(calendars.reason) },
          mail: mail.status === 'fulfilled' ? { state: 'available', ...mail.value } : { state: 'unavailable', folders: [], limited: false, message: message(mail.reason) },
        };
        if ([calendars, mail].some(r => r.status === 'rejected' && r.reason instanceof ProviderError && r.reason.code === 'reconnect')) this.writeAccount({ ...latest, revision: latest.revision + 1, state: 'reconnect', message: 'The provider needs a new sign-in. Saved work is kept.' });
        return this.store.internalWrite(`accounts:probe:${account.id}`, result);
      } finally { this.probing.delete(key); this.controllers.delete(controller); }
    })());
    this.probing.set(key, job); return job;
  }
  async close() {
    clearInterval(this.timer);
    for (const a of this.attempts()) if (active(a)) this.writeAttempt({ ...a, state: a.state === 'exchanging' ? 'unknown' : 'expired', message: 'The service closed. Start a new sign-in; the original attempt will not be replayed.' });
    this.closed = true;
    for (const id of this.live.keys()) this.stopLive(id);
    for (const c of this.controllers) c.abort();
    await Promise.allSettled([...this.jobs]);
  }
}
