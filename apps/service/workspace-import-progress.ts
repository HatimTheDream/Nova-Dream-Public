import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { importedProgressSchema, type ImportedProgress } from '../../packages/domain/profile-progression.js';
import { importSourceSchema, type ImportSource } from '../../packages/domain/workspace-import.js';
import type { BackupSnapshot } from '../../packages/domain/workspace-backup.js';

const identifier = z.string().min(1).max(1000);
const profileSchema = z.object({ id: identifier, kind: z.enum(['human', 'agent']), displayName: z.string().min(1).max(120), xp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const eventSchema = importedProgressSchema.shape.events.element;

/** A carried balance is evidence from one source, never a new completion award. */
export function verifiedImportedProgress(source: ImportSource): ImportedProgress | undefined {
  if (source.format !== 'nova-dream-backup-15') return;
  try {
    const rows = (name: string) => {
      const table = source.snapshot.tables[name];
      if (!table || new Set(table.columns).size !== table.columns.length) throw Error('Missing source table.');
      return table.rows.map(values => {
        if (values.length !== table.columns.length) throw Error('Invalid source columns.');
        const row = Object.fromEntries(table.columns.map((key, i) => [key, values[i]]));
        const raw = row.encrypted_payload ?? row.payload ?? row;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object' || ('id' in row && row.id !== value.id)) throw Error('Invalid source identity.');
        return value;
      });
    };
    const profiles = rows('profiles').map(value => profileSchema.parse(value));
    if (new Set(profiles.map(p => p.id)).size !== profiles.length) return;
    const humans = profiles.filter(p => p.kind === 'human'); if (humans.length !== 1) return;
    const owner = humans[0], profileIds = new Set(profiles.map(p => p.id)), events = rows('xp_events').map(value => eventSchema.parse(value));
    if (new Set(events.map(e => e.id)).size !== events.length || events.some(e => e.createdAt > source.snapshot.createdAt || !profileIds.has(e.profileId))) return;
    const own = events.filter(e => e.profileId === owner.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (own.reduce((n, e) => n + BigInt(e.amount), 0n) !== BigInt(owner.xp)) return;
    return importedProgressSchema.parse({ source: 'Nova Dream', sourceHash: createHash('sha256').update(canonical(source)).digest('hex'), profileId: owner.id, name: owner.displayName, xp: owner.xp, asOf: source.snapshot.createdAt, events: own });
  } catch { return; }
}

export function verifyImportedProgress(services: BackupSnapshot['services']): void {
  const carried = services.filter(s => s.id.startsWith('profile:imported-progress'));
  if (!carried.length) return;
  if (carried.length !== 1 || carried[0].id !== 'profile:imported-progress') throw Error('The backup has more than one earlier XP balance.');
  const balance = importedProgressSchema.parse(carried[0].value);
  const matches = services.filter(s => s.id.startsWith('migration:source:')).flatMap(s => {
    const parsed = importSourceSchema.safeParse(s.value);
    const result = parsed.success ? verifiedImportedProgress(parsed.data) : undefined;
    return result && result.sourceHash === balance.sourceHash ? [result] : [];
  });
  if (matches.length !== 1 || canonical(matches[0]) !== canonical(balance)) throw Error('The earlier XP balance does not match its preserved source.');
}
