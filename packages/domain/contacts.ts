import { z } from 'zod';
import type { Entity } from './contracts.js';
import { contactSchema, type Contact } from './workspace-records.js';
import { contactEmailKey, mailContactSourceKey } from './mail-contact.js';

export const contactEmails = (value: Contact) => [...new Set([value.email, ...(value.otherEmails ?? []), ...(value.mailSources ?? []).map(source => source.sender)].filter(Boolean).map(contactEmailKey))];
export const contactInitials = (name: string) => name.trim().split(/\s+/u).slice(0, 2).map(word => [...word][0] ?? '').join('').toLocaleUpperCase();
export const organizationKey = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase();
export const contactOrganizations = (value: Contact) => {
  const seen = new Set<string>();
  return [value.organization, ...(value.otherOrganizations ?? [])].map(s => s.trim()).filter(s => { const key = organizationKey(s); if (!key || seen.has(key)) return false; seen.add(key); return true; });
};
export type ContactSort = 'name' | 'organization' | 'recent';
export function sortContacts(contacts: Entity<Contact>[], sort: ContactSort, archived = false) {
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  return [...contacts].sort((a, b) => {
    const first = a.value.organization.trim(), second = b.value.organization.trim();
    const order = sort === 'organization' ? Number(!first) - Number(!second) || compare(first, second) : sort === 'recent' ? b.updatedAt.localeCompare(a.updatedAt) : archived ? 0 : Number(!!b.value.favorite) - Number(!!a.value.favorite);
    return order || compare(a.value.name, b.value.name) || a.id.localeCompare(b.id);
  });
}
export function contactMatches(value: Contact, query: string) {
  const text = [value.name, value.position, ...contactOrganizations(value), ...contactEmails(value), value.phone, value.handle, value.notes, ...value.tags].join(' ').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  return query.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}
export function contactDestination(id: string, contacts: Entity<Contact>[]): string {
  const seen = new Set<string>(); let next = id;
  while (!seen.has(next)) { seen.add(next); const target = contacts.find(contact => contact.id === next)?.value.mergedInto; if (!target) return next; next = target; }
  return id;
}
export function contactDuplicateReason(a: Contact, b: Contact): string | null {
  if (contactEmails(a).some(email => contactEmails(b).includes(email))) return 'Same email address';
  const phone = (value: string) => value.replace(/[^0-9]/g, '');
  if (phone(a.phone).length >= 7 && phone(a.phone) === phone(b.phone)) return 'Same phone number';
  const name = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (name(a.name) && name(a.name) === name(b.name)) return 'Same name';
  return null;
}
export const contactMergeFields = ['name', 'position', 'organization', 'email', 'phone', 'handle', 'timezone', 'category', 'projectId', 'photo', 'pipelineStage', 'keepInTouch'] as const;
export type ContactMergeField = typeof contactMergeFields[number];
const ref = z.object({ id: z.string().regex(/^contact:[a-zA-Z0-9:_-]+$/).max(100), revision: z.number().int().positive() }).strict();
export const contactMergeSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), keep: ref, other: ref, fields: z.partialRecord(z.enum(contactMergeFields), z.enum(['keep', 'other'])), notes: z.enum(['both', 'keep', 'other']) }).strict().refine(v => v.keep.id !== v.other.id, 'Choose two different contacts.');
export type ContactMergeCommand = z.infer<typeof contactMergeSchema>;
export const contactRestoreSchema = z.object({ requestId: z.uuid(), epoch: z.uuid(), contact: ref }).strict();
export type ContactRestoreCommand = z.infer<typeof contactRestoreSchema>;
export function mergedContactValue(keep: Contact, other: Contact, command: Pick<ContactMergeCommand, 'fields' | 'notes'>): Contact {
  const value = { ...keep };
  for (const field of contactMergeFields) {
    const chosen = command.fields[field] === 'other' ? other[field] : keep[field] || other[field];
    if (chosen !== undefined) Object.assign(value, { [field]: chosen });
    else delete value[field];
  }
  value.notes = command.notes === 'keep' ? keep.notes : command.notes === 'other' ? other.notes : [...new Set([keep.notes, other.notes].filter(Boolean))].join('\n\n');
  value.tags = [...new Set([...keep.tags, ...other.tags])];
  value.favorite = !!keep.favorite || !!other.favorite;
  const relations = [...(keep.relationships ?? []), ...(other.relationships ?? [])];
  if (relations.length) value.relationships = [...new Map(relations.map(r => [r.kind + ':' + r.contactId, r])).values()];
  value.otherOrganizations = contactOrganizations({ ...value, otherOrganizations: [...contactOrganizations(keep), ...contactOrganizations(other)] }).filter(s => organizationKey(s) !== organizationKey(value.organization));
  value.otherEmails = [...new Set([...contactEmails(keep), ...contactEmails(other)])].filter(email => email !== contactEmailKey(value.email));
  const sources = [...(keep.mailSources ?? []), ...(other.mailSources ?? [])];
  if (sources.length) value.mailSources = [...new Map(sources.map(source => [mailContactSourceKey(source), source])).values()];
  return contactSchema.parse(value);
}
