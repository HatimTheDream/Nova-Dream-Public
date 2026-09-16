import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BackupSnapshot } from '../../packages/domain/workspace-backup.js';
import { Fault, type Store } from './store.js';

const metadata = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(192 * 1024 * 1024) }).strict();
/** Carry older native archives inside each new encrypted export even after a
 * recovered copy starts a new Assistant. Never silently drop an old archive. */
export async function withRetainedNative(store: Store, current: BackupSnapshot['native']): Promise<BackupSnapshot['native']> {
  const state = store.internalRead<{ native: string; nativeHash?: string; nativeBytes?: number }>('recovery:state');
  const previous = z.array(metadata).max(10).parse(store.internalRead('recovery:retained-archives') ?? []);
  const sources = previous.map(item => ({ ...item, name: 'assistant-retained-' + item.sha256 + '.tar.gz' }));
  if (state?.native === 'included') sources.unshift({ ...metadata.parse({ sha256: state.nativeHash, bytes: state.nativeBytes }), name: 'assistant.tar.gz' });
  const kept = new Map<string, NonNullable<BackupSnapshot['native']['retained']>[number]>();
  for (const source of sources) {
    if (source.sha256 === current.sha256 || kept.has(source.sha256)) continue;
    const file = await open(join(store.directory, source.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== source.bytes) throw new Fault(409, 'native_recovery_changed', 'An earlier Assistant archive changed. Keep the original backup and restore it again.');
      const bytes = await file.readFile();
      if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Fault(409, 'native_recovery_changed', 'An earlier Assistant archive failed verification. No complete backup was reported.');
      kept.set(source.sha256, { sha256: source.sha256, bytes: source.bytes, archive: bytes.toString('base64') });
    } finally { await file.close(); }
  }
  if (!kept.size) return current;
  const archives = [...kept.values()];
  if (current.status !== 'included') {
    const primary = archives.shift()!;
    return { ...primary, status: 'included', notes: [...current.notes, 'Preserves the original Assistant archive. It has not been resumed by this copy.'], ...(archives.length ? { retained: archives } : {}) };
  }
  if (archives.length > 10) throw new Fault(413, 'native_recovery_limit', 'This workspace retains too many earlier Assistant archives for one export. Keep the original backups; nothing was discarded.');
  return { ...current, retained: archives };
}
