import { ApiError, readLocal } from './api';

/** This endpoint-only conflict follows receipt lookup, so no creation or move was admitted. */
export function releaseRejectedProjectRequest(key: string, requestId: string, failure: unknown): boolean {
  if (!(failure instanceof ApiError) || failure.status !== 409 || failure.code !== 'project_deleted') return false;
  if (readLocal<{ requestId: string }>(key)?.requestId !== requestId) return false;
  try { localStorage.removeItem(key); return true; } catch { return false; }
}
