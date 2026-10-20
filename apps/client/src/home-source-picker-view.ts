import type { HomeReference } from '../../../packages/domain/home-library';

export type SourcePickerView = { collection: string; type: 'all' | HomeReference['kind']; query: string; searchOpen: boolean; limit: number };
export const emptySourcePickerView: SourcePickerView = { collection: '', type: 'all', query: '', searchOpen: false, limit: 40 };
export function isSourcePickerView(value: unknown): value is SourcePickerView {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const row = value as Record<string, unknown>;
 return typeof row.collection === 'string' && row.collection.length <= 200 && ['all', 'note', 'link', 'content', 'project', 'task', 'output', 'assignment', 'widget'].includes(String(row.type)) && typeof row.query === 'string' && row.query.length <= 300 && typeof row.searchOpen === 'boolean' && Number.isSafeInteger(row.limit) && Number(row.limit) >= 40 && Number(row.limit) <= 100000;
}
