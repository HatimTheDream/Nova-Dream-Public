import type { ImportSource } from '../../packages/domain/workspace-import';

export function prepareDreamClawExport(
  storage: Pick<Storage, 'getItem'>,
  options: { version: string; storeId: string; timezone: string; createdAt?: string },
): Extract<ImportSource, { format: 'dream-claw-storage-1' }>;
