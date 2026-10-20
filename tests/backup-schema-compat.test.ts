// Proves schema-47 backups (oldest supported) still restore.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { backupSnapshotSchema, summarizeBackup } from '../packages/domain/workspace-backup.js';

function minimalBackup(schema: number) {
  const now = new Date().toISOString();
  return {
    format: 'nova-dream-workspace-1',
    schema,
    version: '1.13.15',
    id: randomUUID(),
    createdAt: now,
    epoch: randomUUID(),
    cursor: 1,
    entities: [],
    history: [],
    receipts: [],
    services: [],
    files: [],
    references: [],
    native: { status: 'not-configured', notes: [] },
  };
}

describe('backup schema compatibility', () => {
  it('accepts schema 47 (oldest supported)', () => {
    const parsed = backupSnapshotSchema.parse(minimalBackup(47));
    assert.equal(parsed.schema, 47);
    const summary = summarizeBackup(parsed);
    assert.equal(summary.schema, 47);
  });
  it('accepts schemas 55, 56 and current schema 57', () => {
    assert.equal(backupSnapshotSchema.parse(minimalBackup(55)).schema, 55);
    assert.equal(backupSnapshotSchema.parse(minimalBackup(56)).schema, 56);
    assert.equal(backupSnapshotSchema.parse(minimalBackup(57)).schema, 57);
  });
  it('rejects schema 46 (too old)', () => {
    assert.throws(() => backupSnapshotSchema.parse(minimalBackup(46)));
  });
  it('rejects schema 58 (too new)', () => {
    assert.throws(() => backupSnapshotSchema.parse(minimalBackup(58)));
  });
});
