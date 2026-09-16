import { z } from 'zod';
import type { Provider } from '../../packages/domain/accounts.js';
import { sharedContactSchema, type SharedContact, type SharedField } from '../../packages/domain/address-books.js';
import type { MailRequest } from './provider-mail-delivery.js';
import { ProviderError } from './providers.js';
const googleFields = 'names,emailAddresses,phoneNumbers,organizations,metadata';
const msFields = 'id,displayName,emailAddresses,mobilePhone,businessPhones,homePhones,companyName,jobTitle,changeKey';
const object = z.record(z.string(), z.unknown());
const list = (v: unknown): Record<string, any>[] => z.array(object).max(1000).parse(v ?? []);
const string = (v: unknown) => typeof v === 'string' ? v : '';
export type RemoteContact = { id: string; etag: string; value: SharedContact; raw: Record<string, any> };
const primary = (items: Record<string, any>[]) => items.find(i => i.metadata?.primary) ?? items[0];
export function parseProviderContact(provider: Provider, input: unknown): RemoteContact {
  const raw = object.parse(input) as Record<string, any>; let value: SharedContact, id: string, etag: string;
  if (provider === 'google') {
    id = string(raw.resourceName); if (!/^people\/[a-zA-Z0-9_-]+$/.test(id)) throw new ProviderError('invalid_response', 'This Google contact has no usable identity.');
    const source = list(raw.metadata?.sources).find(s => s.type === 'CONTACT'); etag = string(source?.etag);
    if (!source || raw.metadata?.deleted) throw new ProviderError('not_found', 'This account contact is no longer available.');
    const name = primary(list(raw.names)), phones = primary(list(raw.phoneNumbers)), org = primary(list(raw.organizations));
    const emails = list(raw.emailAddresses); const first = primary(emails); if (first) emails.splice(emails.indexOf(first), 1), emails.unshift(first);
    value = { name: string(name?.displayName || name?.unstructuredName || name?.givenName || emails[0]?.value || phones?.value) || 'Unnamed contact', emails: [...new Set(emails.map(e => string(e.value)).filter(Boolean))], phone: string(phones?.value), organization: string(org?.name), position: string(org?.title) };
  } else {
    id = string(raw.id); if (!id || id.length > 1000) throw new ProviderError('invalid_response', 'This Microsoft contact has no usable identity.');
    etag = string(raw['@odata.etag']);
    value = { name: string(raw.displayName || raw.emailAddresses?.[0]?.address || raw.mobilePhone) || 'Unnamed contact', emails: [...new Set(list(raw.emailAddresses).map(e => string(e.address)).filter(Boolean))], phone: string(raw.mobilePhone || raw.businessPhones?.[0] || raw.homePhones?.[0]), organization: string(raw.companyName), position: string(raw.jobTitle) };
  }
  const parsed = sharedContactSchema.safeParse(value); if (!parsed.success) throw new ProviderError('invalid_response', 'This account contact has unsupported or oversized details. Its original remains in the account.');
  return { id, etag, value: parsed.data, raw };
}
const pathFor = (provider: Provider, id: string) => provider === 'google' ? '/' + id : '/contacts/' + encodeURIComponent(id);
export async function getProviderContact(provider: Provider, request: MailRequest, id: string): Promise<RemoteContact> {
  return parseProviderContact(provider, await request(pathFor(provider, id) + '?' + (provider === 'google' ? new URLSearchParams({ personFields: googleFields, sources: 'READ_SOURCE_TYPE_CONTACT' }) : new URLSearchParams({ $select: msFields }))));
}
export async function providerContactsPage(provider: Provider, request: MailRequest, cursor?: string, folder?: string) {
  let path: string;
  if (provider === 'google') { if (folder) throw new ProviderError('invalid_response', 'Google contacts use one address book.'); path = '/people/me/connections?' + new URLSearchParams({ personFields: googleFields, pageSize: '100', sources: 'READ_SOURCE_TYPE_CONTACT', ...(cursor ? { pageToken: cursor } : {}) }); }
  else {
    const root = folder ? '/contactFolders/' + encodeURIComponent(folder) + '/contacts' : '/contacts';
    path = root + '?' + new URLSearchParams({ $top: '100', $select: msFields });
    if (cursor) { const url = new URL(cursor); if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== '/v1.0/me' + root || url.username || url.password || url.hash) throw new ProviderError('invalid_response', 'Invalid address-book page.'); path = root + url.search; }
  }
  const raw = object.parse(await request(path)) as Record<string, any>;
  const entries: RemoteContact[] = []; let skipped = 0;
  for (const item of list(provider === 'google' ? raw.connections : raw.value)) { try { entries.push(parseProviderContact(provider, item)); } catch { skipped++; } }
  const next = provider === 'google' ? string(raw.nextPageToken) : string(raw['@odata.nextLink']);
  return { entries, skipped, next: next || undefined };
}
export async function providerContactFolders(provider: Provider, request: MailRequest) {
  if (provider === 'google') return [];
  const result: { id: string; name: string }[] = [], paths = ['/contactFolders?$top=100&$select=id,displayName']; const seen = new Set<string>();
  while (paths.length && result.length < 100) {
    const path = paths.shift()!, raw = object.parse(await request(path)) as Record<string, any>;
    for (const item of list(raw.value)) { const id = string(item.id); if (!id || seen.has(id)) continue; seen.add(id); result.push({ id, name: string(item.displayName) || 'Contact folder' }); paths.push('/contactFolders/' + encodeURIComponent(id) + '/childFolders?$top=100&$select=id,displayName'); }
    if (raw['@odata.nextLink']) { const url = new URL(raw['@odata.nextLink']); if (url.origin !== 'https://graph.microsoft.com' || !/^\/v1\.0\/me\/contactFolders(?:\/[^/]+\/childFolders)?$/.test(url.pathname)) throw new ProviderError('invalid_response', 'Invalid contact folder page.'); paths.push(url.pathname.slice('/v1.0/me'.length) + url.search); }
  }
  return result;
}
/** Only changed shared fields are sent; addresses, birthdays, private notes and extra phones stay untouched. */
export async function updateProviderContact(provider: Provider, request: MailRequest, current: RemoteContact, value: SharedContact, changed: SharedField[]) {
  if (!current.etag) throw new ProviderError('invalid_response', 'This provider contact has no change token. Sync is paused to preserve concurrent edits.');
  const body: Record<string, unknown> = {}; let path = pathFor(provider, current.id);
  if (provider === 'google') {
    body.metadata = { sources: list(current.raw.metadata?.sources).filter(s => s.type === 'CONTACT') }; const fields: string[] = [];
    if (changed.includes('name')) { body.names = [{ unstructuredName: value.name }]; fields.push('names'); }
    if (changed.includes('emails')) { body.emailAddresses = value.emails.map(email => ({ ...(list(current.raw.emailAddresses).find(e => e.value === email) ?? {}), value: email })); fields.push('emailAddresses'); }
    if (changed.includes('phone')) { const phones = list(current.raw.phoneNumbers), old = primary(phones); body.phoneNumbers = [...(value.phone ? [{ ...old, value: value.phone }] : []), ...phones.filter(p => p !== old)]; fields.push('phoneNumbers'); }
    if (changed.includes('organization') || changed.includes('position')) { const orgs = list(current.raw.organizations), old = primary(orgs); body.organizations = [{ ...old, name: value.organization, title: value.position }, ...orgs.filter(o => o !== old)]; fields.push('organizations'); }
    path += ':updateContact?' + new URLSearchParams({ updatePersonFields: fields.join(','), personFields: googleFields });
  } else {
    body.displayName = value.name;
    if (changed.includes('emails')) body.emailAddresses = value.emails.map(address => ({ ...(list(current.raw.emailAddresses).find(e => e.address === address) ?? {}), address }));
    if (changed.includes('phone')) { if (current.raw.mobilePhone || !current.raw.businessPhones?.length && !current.raw.homePhones?.length) body.mobilePhone = value.phone; else { const key = current.raw.businessPhones?.length ? 'businessPhones' : 'homePhones'; body[key] = [...(value.phone ? [value.phone] : []), ...current.raw[key].slice(1)]; } }
    if (changed.includes('organization')) body.companyName = value.organization;
    if (changed.includes('position')) body.jobTitle = value.position;
  }
  return parseProviderContact(provider, await request(path, { method: 'PATCH', headers: provider === 'microsoft' ? { 'If-Match': current.etag } : {}, body: JSON.stringify(body) }));
}
