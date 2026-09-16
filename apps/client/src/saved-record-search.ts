import type { Snapshot } from '../../../packages/domain/contracts';
import { recordKinds, recordTitle, type RecordKind } from '../../../packages/domain/workspace-records';

const labels: Record<RecordKind, string> = { contact: 'Contact', content: 'Content', agent: 'Agent', assignment: 'Assignment plan', profile: 'Profile' };
const fields = ['name', 'title', 'position', 'organization', 'email', 'phone', 'handle', 'notes', 'brief', 'body', 'purpose', 'tags'];
export function savedRecordMatches(snapshot: Pick<Snapshot, 'records'>, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return recordKinds.flatMap(kind => (snapshot.records?.[kind] ?? []).flatMap(record => {
    const values = record.value as unknown as Record<string, unknown>;
    const haystack = fields.flatMap(field => typeof values[field] === 'string' ? [values[field]] : Array.isArray(values[field]) ? values[field] : []).join(' ').toLocaleLowerCase();
    if (!haystack.includes(needle)) return [];
    return [{ kind, id: record.id, title: recordTitle(record.value), label: labels[kind], archived: 'archived' in record.value && record.value.archived, updatedAt: record.updatedAt }];
  }));
}
