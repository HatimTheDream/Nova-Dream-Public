import type { CalendarRequest } from './provider-calendar-write.js';
import { readProviderMail } from './provider-mail.js';
import type { MailRequest } from './provider-mail-delivery.js';
import type { MailReadSelector } from '../../packages/domain/mail.js';
import { z } from 'zod';
import { readProviderCalendar } from './provider-calendar.js';
import type { AccountCapabilities, AccountPermission, CalendarSource, ClientConfiguration, MailFolder, Provider } from '../../packages/domain/accounts.js';

export const readScopes = {
  google: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'],
  microsoft: ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'],
} satisfies Record<Provider, string[]>;
export function accountScopes(provider:Provider, permissions:AccountPermission[]=[], existingScopes:string[]=[]) {
  const additional:Record<Provider,Record<AccountPermission,string>>={
    google:{mailDraft:'https://www.googleapis.com/auth/gmail.compose',mailSend:'https://www.googleapis.com/auth/gmail.send',mailModify:'https://www.googleapis.com/auth/gmail.modify',calendarWrite:'https://www.googleapis.com/auth/calendar.events',contactsRead:'https://www.googleapis.com/auth/contacts.readonly',contactsWrite:'https://www.googleapis.com/auth/contacts'},
    microsoft:{mailDraft:'Mail.ReadWrite',mailSend:'Mail.Send',mailModify:'Mail.ReadWrite',calendarWrite:'Calendars.ReadWrite',contactsRead:'Contacts.Read',contactsWrite:'Contacts.ReadWrite'},
  };
  // Desktop Google grants require the full request; do not rely on incremental
  // authorization or arbitrary provider-returned scopes as additional requests.
  const granted=accountCapabilities(provider,existingScopes);
  const retained=(Object.keys(additional[provider]) as AccountPermission[]).filter(key=>granted[key]);
  return [...new Set([...readScopes[provider],...[...retained,...permissions].map(key=>additional[provider][key])])];
}
const id = z.string().min(1).max(1000), label = z.string().max(1000);
const tokensSchema = z.object({ access_token: z.string().min(1).max(20000), refresh_token: z.string().min(1).max(20000).optional(), token_type: z.string().refine(s => s.toLowerCase() === 'bearer'), expires_in: z.number().int().min(1).max(31536000), scope: z.string().min(1).max(20000).optional() });
export type ProviderTokens = { accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] };
export class ProviderError extends Error {
  constructor(readonly code: 'reconnect' | 'permission' | 'throttled' | 'unavailable' | 'invalid_response' | 'not_found', message: string, readonly retryAfterSeconds?: number, readonly responseStatus?: number) { super(message); }
}
export function accountCapabilities(provider: Provider, scopes: string[]): AccountCapabilities {
  const values = new Set(scopes.map(s => provider === 'microsoft' ? s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase() : s));
  const has = (...names: string[]) => names.some(s => values.has(s));
  return provider === 'google' ? {
    mailRead: has('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'),
    calendarRead: has('https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'),
    mailDraft: has('https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'),
    mailSend: has('https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'),
    mailModify: has('https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'),
    calendarWrite: has('https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'),
    contactsRead: has('https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts'), contactsWrite: has('https://www.googleapis.com/auth/contacts'),
  } : { mailRead: has('mail.read', 'mail.readwrite'), calendarRead: has('calendars.read', 'calendars.readwrite'), mailDraft: has('mail.readwrite'), mailSend: has('mail.send'), mailModify: has('mail.readwrite'), calendarWrite: has('calendars.readwrite'), contactsRead: has('contacts.read', 'contacts.readwrite'), contactsWrite: has('contacts.readwrite') };
}
export function authorizationUrl(configuration: ClientConfiguration, redirectUri: string, state: string, challenge: string, scopes=readScopes[configuration.provider], loginHint?:string) {
  const google = configuration.provider === 'google';
  const url = new URL(google ? 'https://accounts.google.com/o/oauth2/v2/auth' : `https://login.microsoftonline.com/${configuration.tenant}/oauth2/v2.0/authorize`);
  const parameters: Record<string, string> = { client_id: configuration.clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', prompt: google ? 'consent select_account' : 'select_account' };
  if(loginHint)parameters.login_hint=loginHint;
  if (google) parameters.access_type = 'offline'; else parameters.response_mode = 'query';
  url.search = new URLSearchParams(parameters).toString(); return url.href;
}

/** Provider bytes stay on the service; redirects and raw provider errors never reach the client. */
export class Providers {
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}
  private async json(url: string, init: RequestInit = {}, signal?: AbortSignal, maximumBytes = 2 * 1024 * 1024, emptyStatuses: number[] = []): Promise<unknown> {
    const abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    let response: Response;
    try { response = await this.fetcher(url, { ...init, signal: abort, redirect: 'error' }); }
    catch { throw new ProviderError('unavailable', 'The provider response is not confirmed. Check the connection before continuing.'); }
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      if (reader) while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximumBytes) { await reader.cancel(); throw new Error('bounded response'); } chunks.push(value); }
    } catch { throw new ProviderError('unavailable', 'The provider response was incomplete.', undefined, response.ok ? undefined : response.status); }
    if (response.ok && size === 0 && emptyStatuses.includes(response.status)) return null;
    let data: any; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { if (response.ok) throw new ProviderError('invalid_response', 'The provider returned an unreadable response.'); }
    if (!response.ok) {
      if (response.status === 401 || data?.error === 'invalid_grant' || data?.error === 'interaction_required') throw new ProviderError('reconnect', 'Sign in to this account again. Saved work is kept.');
      const gmailReasons = new URL(url).hostname === 'gmail.googleapis.com' && Array.isArray(data?.error?.errors) ? data.error.errors.map((error: {reason?: string}) => error?.reason) : [];
      if (response.status === 403 && gmailReasons.some((reason: string) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason))) {
        const retry = Number(response.headers.get('retry-after'));
        throw new ProviderError('throttled', 'Gmail is temporarily limiting requests. Your mail is kept; try again shortly.', Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 5);
      }
      if (response.status === 403 && gmailReasons.includes('dailyLimitExceeded')) throw new ProviderError('permission', 'Gmail’s daily app quota has been reached. Saved mail is available; review the Google app quota before resuming.');
      if (response.status === 403 || ['access_denied', 'consent_required', 'invalid_scope'].includes(data?.error)) throw new ProviderError('permission', 'The provider denied this request. Review account permissions and restrictions.');
      if (response.status === 404) throw new ProviderError('not_found', 'This provider item is no longer available. Refresh its folder or source.');
      if (response.status === 429) { const retry = Number(response.headers.get('retry-after')); throw new ProviderError('throttled', 'The provider asked this account to wait before trying again.', Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : undefined); }
      throw new ProviderError('unavailable', response.status >= 400 && response.status < 500 ? 'The provider rejected this request. Your writing is kept.' : 'The provider could not complete this request.', undefined, response.status);
    }
    return data;
  }
  mailRequest(provider: Provider, accessToken: string, signal: AbortSignal): MailRequest {
    const base = provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me' : 'https://graph.microsoft.com/v1.0/me';
    return (path, init = {}, emptyStatuses = []) => {
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new ProviderError('invalid_response', 'Invalid mail resource.');
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (provider === 'microsoft') headers.set('Prefer', 'IdType="ImmutableId"');
      const rawDraft=provider==='google'&&(init.method??'GET')==='GET'&&/^\/drafts\/[^/?]+\?/.test(path)&&new URLSearchParams(path.split('?')[1]).get('format')==='raw';
      return this.json(base + path, { ...init, headers }, signal, (rawDraft?54:4) * 1024 * 1024, emptyStatuses);
    };
  }
  calendarRequest(provider: Provider, accessToken: string, signal: AbortSignal): CalendarRequest {
    const base = provider === 'google' ? 'https://www.googleapis.com/calendar/v3' : 'https://graph.microsoft.com/v1.0/me';
    return (path, init = {}, emptyStatuses = []) => {
      if (!/^\/(?:calendars|users\/me\/calendarList)\//.test(path) || path.includes('\\')) throw new ProviderError('invalid_response', 'Invalid Calendar resource.');
      const url = new URL(base + path);
      if (!url.href.startsWith(base + '/') || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(path.split('?')[0]))) throw new ProviderError('invalid_response', 'Invalid Calendar resource.');
      const headers = new Headers(init.headers); headers.set('Authorization', 'Bearer ' + accessToken); headers.set('Content-Type', 'application/json');
      if (provider === 'microsoft') headers.set('Prefer', 'IdType="ImmutableId", outlook.timezone="UTC"');
      return this.json(url.href, { ...init, headers }, signal, 4 * 1024 * 1024, emptyStatuses);
    };
  }
  contactRequest(provider: Provider, accessToken: string, signal: AbortSignal): MailRequest {
    const base = provider === 'google' ? 'https://people.googleapis.com/v1' : 'https://graph.microsoft.com/v1.0/me';
    return (path, init = {}, emptyStatuses = []) => {
      const valid = provider === 'google' ? /^\/people(?:\/|:)/.test(path) : /^\/(?:contacts|contactFolders)(?:[/?]|$)/.test(path);
      const url = new URL(base + path);
      if (!valid || path.includes('\\') || !url.href.startsWith(base + '/') || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(path.split('?')[0]))) throw new ProviderError('invalid_response', 'Invalid address-book resource.');
      const headers = new Headers(init.headers); headers.set('Authorization', 'Bearer ' + accessToken); headers.set('Content-Type', 'application/json');
      if (provider === 'microsoft') headers.set('Prefer', 'IdType="ImmutableId"');
      return this.json(url.href, { ...init, headers }, signal, 4 * 1024 * 1024, emptyStatuses);
    };
  }
  private tokenUrl(configuration: ClientConfiguration) { return configuration.provider === 'google' ? 'https://oauth2.googleapis.com/token' : `https://login.microsoftonline.com/${configuration.tenant}/oauth2/v2.0/token`; }
  private async token(configuration: ClientConfiguration, form: Record<string, string>, fallbackScopes: string[], signal?: AbortSignal): Promise<ProviderTokens> {
    const params = { ...form, client_id: configuration.clientId, ...(configuration.clientSecret ? { client_secret: configuration.clientSecret } : {}) };
    const raw = await this.json(this.tokenUrl(configuration), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }, signal);
    const result = tokensSchema.safeParse(raw); if (!result.success) throw new ProviderError('invalid_response', 'The provider did not return a usable account token.');
    const t = result.data;
    // OAuth permits omitted scope only when unchanged from the requested grant.
    return { accessToken: t.access_token, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}), expiresAt: this.now() + t.expires_in * 1000, scopes: t.scope === undefined ? fallbackScopes : [...new Set(t.scope.split(/\s+/).filter(Boolean))] };
  }
  exchange(configuration: ClientConfiguration, code: string, verifier: string, redirectUri: string, signal?: AbortSignal, scopes=readScopes[configuration.provider]) { return this.token(configuration, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, ...(configuration.provider==='microsoft'?{scope:scopes.join(' ')}:{}) }, scopes, signal); }
  refresh(configuration: ClientConfiguration, refreshToken: string, scopes: string[], signal?: AbortSignal) { return this.token(configuration, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(configuration.provider === 'microsoft' ? { scope: scopes.join(' ') } : {}) }, scopes, signal); }
  private get(url: string, accessToken: string, microsoft: boolean, signal?: AbortSignal) { return this.json(url, { headers: { Authorization: `Bearer ${accessToken}`, ...(microsoft ? { Prefer: 'IdType="ImmutableId"' } : {}) } }, signal); }
  mailRead(provider: Provider, accessToken: string, subject: string, selector: MailReadSelector, cursor: string | undefined, signal: AbortSignal) {
    return readProviderMail((url, abort, maximumBytes) => this.json(url, { headers: { Authorization: `Bearer ${accessToken}`, ...(provider === 'microsoft' ? { Prefer: 'IdType="ImmutableId"' } : {}) } }, abort, maximumBytes), provider, subject, selector, cursor, signal);
  }
  calendarEvents(provider: Provider, accessToken: string, accountSubject: string, calendarId: string, start: string, end: string, signal?: AbortSignal) {
    return readProviderCalendar((url, abort) => this.json(url, { headers: { Authorization: `Bearer ${accessToken}`, ...(provider === 'microsoft' ? { Prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' } : {}) } }, abort), provider, accountSubject, calendarId, start, end, signal);
  }
  async profile(provider: Provider, accessToken: string, signal?: AbortSignal) {
    const raw = await this.get(provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', accessToken, provider === 'microsoft', signal);
    if (provider === 'google') {
      const parsed = z.object({ sub: id, email: label.optional(), name: label.optional() }).safeParse(raw);
      if (parsed.success) return { subject: parsed.data.sub, email: parsed.data.email ?? '', label: parsed.data.name || parsed.data.email || 'Google account' };
    } else {
      const parsed = z.object({ id, mail: label.nullable().optional(), userPrincipalName: label.optional(), displayName: label.nullable().optional() }).safeParse(raw);
      if (parsed.success) return { subject: parsed.data.id, email: parsed.data.mail || parsed.data.userPrincipalName || '', label: parsed.data.displayName || parsed.data.mail || parsed.data.userPrincipalName || 'Microsoft account' };
    }
    throw new ProviderError('invalid_response', 'The provider account identity could not be verified.');
  }
  async calendars(provider: Provider, accessToken: string, signal?: AbortSignal): Promise<{ items: CalendarSource[]; limited: boolean }> {
    const raw = await this.get(provider === 'google' ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100' : 'https://graph.microsoft.com/v1.0/me/calendars?$top=100&$select=id,name,isDefaultCalendar,canEdit,color', accessToken, provider === 'microsoft', signal);
    if (provider === 'google') {
      const parsed = z.object({ kind: z.literal('calendar#calendarList'), items: z.array(z.object({ id, summary: label.optional(), primary: z.boolean().optional(), timeZone: label.optional(), backgroundColor: label.optional(), accessRole: label.optional() })).max(100).default([]), nextPageToken: id.optional() }).safeParse(raw);
      if (parsed.success) return { items: parsed.data.items.map(c => ({ id: c.id, name: c.summary || c.id, primary: c.primary === true, ...(c.timeZone ? { timezone: c.timeZone } : {}), ...(/^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? '') ? { color: c.backgroundColor } : {}), providerCanWrite: ['owner', 'writer'].includes(c.accessRole ?? '') })), limited: !!parsed.data.nextPageToken };
    } else {
      const parsed = z.object({ value: z.array(z.object({ id, name: label, isDefaultCalendar: z.boolean().optional(), canEdit: z.boolean().optional() })).max(100), '@odata.nextLink': z.string().max(20000).optional() }).safeParse(raw);
      if (parsed.success) return { items: parsed.data.value.map(c => ({ id: c.id, name: c.name, primary: c.isDefaultCalendar === true, providerCanWrite: c.canEdit === true })), limited: !!parsed.data['@odata.nextLink'] };
    }
    throw new ProviderError('invalid_response', 'The calendar list could not be verified.');
  }
  async mailFolders(provider: Provider, accessToken: string, signal?: AbortSignal): Promise<{ folders: MailFolder[]; limited: boolean }> {
    const raw = await this.get(provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/labels' : 'https://graph.microsoft.com/v1.0/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount', accessToken, provider === 'microsoft', signal);
    if (provider === 'google') {
      const parsed = z.object({ labels: z.array(z.object({ id, name: label })).max(10000) }).safeParse(raw);
      if (parsed.success) return { folders: parsed.data.labels.slice(0, 100).map(l => ({ id: l.id, name: l.name })), limited: parsed.data.labels.length > 100 };
    } else {
      const parsed = z.object({ value: z.array(z.object({ id, displayName: label, totalItemCount: z.number().int().nonnegative().optional(), unreadItemCount: z.number().int().nonnegative().optional() })).max(100), '@odata.nextLink': z.string().max(20000).optional() }).safeParse(raw);
      if (parsed.success) return { folders: parsed.data.value.map(f => ({ id: f.id, name: f.displayName, ...(f.totalItemCount === undefined ? {} : { total: f.totalItemCount }), ...(f.unreadItemCount === undefined ? {} : { unread: f.unreadItemCount }) })), limited: !!parsed.data['@odata.nextLink'] };
    }
    throw new ProviderError('invalid_response', 'The mail folder list could not be verified.');
  }
}
