// Adapted from OpenClaw #162033. Copyright (c) 2026 OpenClaw Foundation.
// The exact upstream commit and full MIT license are retained in the paired script.
// These isolated source-bound checks do not qualify actual retained-state startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { REVIEWED_ARTIFACTS, REVIEWED_INVENTORY, backportRuntimeSessionPublication } from '../scripts/backport-runtime-session-publication.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = [REVIEWED_ARTIFACTS[0], REVIEWED_ARTIFACTS.find(row => row.path.endsWith('sqlite-store.worker.mjs'))];

test('publication accepts the selected aliased database while refusing other, retired or mismatched owners', () => {
  for (const artifact of variants) {
    const definition = artifact.hunks.find(hunk => hunk.name === 'publication-physical-identity').after;
    const operation = {}, creation = { active: true, agentId: 'main', sessionKey: 'agent:main:fixture',
      source: { kind: 'file', databaseIdentity: '7:42', path: '\\\\?\\C:\\physical\\agent.sqlite', current: true } };
    const records = { operations: new Map([[operation, creation]]) };
    const assertCurrent = value => { if (!value?.active || value.source.current === false) throw Error('retired owner'); };
    const guard = new Function('preparedSharingChanges', 'assertCreationCurrent', 'path',
      definition + '\nreturn assertSessionEntryCreationPublication;')(records, assertCurrent, path.win32);
    const target = { agentId: creation.agentId, sessionKey: creation.sessionKey,
      paths: new Set(['C:\\junction\\agent.sqlite']), databaseIdentity: 'file:7:42' };
    assert.doesNotThrow(() => guard(operation, target));
    assert.throws(() => guard(operation, { ...target, databaseIdentity: 'file:7:43', paths: new Set([path.win32.resolve(creation.source.path)]) }), /no longer current/);
    assert.throws(() => guard(operation, { ...target, agentId: 'other' }), /no longer current/);
    assert.throws(() => guard(operation, { ...target, sessionKey: 'agent:main:other' }), /no longer current/);
    creation.active = false; assert.throws(() => guard(operation, target), /retired owner/); creation.active = true;
    creation.source.current = false; assert.throws(() => guard(operation, target), /retired owner/); creation.source.current = true;
    creation.source = { kind: 'native', database: { path: 'C:\\native.sqlite' } };
    assert.throws(() => guard(operation, target), /no longer current/);
    assert.doesNotThrow(() => guard(operation, { ...target, databaseIdentity: undefined, paths: new Set(['C:\\native.sqlite']) }));
  }
});

test('both bundled preparation forms admit new-row aliases before branching and reject unrelated stores', () => {
  const producers = [REVIEWED_ARTIFACTS[1], variants[1]];
  for (const artifact of producers) {
    const minified = artifact.path.includes('/worker/');
    const definition = artifact.hunks.find(hunk => hunk.name === 'new-and-existing-row-alias-admission').after;
    const preparation = minified ? definition.replace(/if\(xr\)\{$/, '') : definition;
    const p = path.win32;
    const sharing = { source: { path: 'C:\\physical\\agent.sqlite' }, databaseIdentity: 'file:7:42' };
    const candidates = [{ path: 'C:\\junction\\agent.sqlite', physicalPath: sharing.source.path }];
    const run = new Function('path', 'sharing', 'discoveryCandidates', 'matchesAgentDatabaseReadCandidatePath', 'SessionMutationFactsUnavailableError',
      'const selectedPaths=new Set(); let selectedDatabaseIdentity; const wi=sharing,Pr=selectedPaths,Kt=discoveryCandidates,Jn={storePath:"C:\\\\logical\\\\sessions.json"};\n'
      + preparation + '\nreturn { selectedPaths:[...selectedPaths], selectedDatabaseIdentity };');
    const match = (candidate, source) => candidate.path === source;
    const value = run(p, sharing, candidates, match, Error);
    assert.equal(value.selectedDatabaseIdentity, sharing.databaseIdentity);
    assert(value.selectedPaths.includes(candidates[0].path));
    assert(value.selectedPaths.includes(sharing.source.path));
    assert.throws(() => run(p, sharing, [{ ...candidates[0], physicalPath: 'C:\\other.sqlite' }], match, Error));
  }
});

test('the exact artifact set changes only the reviewed payloads and five inventory rows', {
  skip: !process.env.NOVA_SESSION_PUBLICATION_RUNTIME,
}, () => {
  const root = process.env.NOVA_SESSION_PUBLICATION_RUNTIME;
  const pins = [...REVIEWED_ARTIFACTS, REVIEWED_INVENTORY];
  const inputs = new Map(pins.map(pin => [pin.path, fs.readFileSync(path.join(root, pin.path))]));
  const outputs = backportRuntimeSessionPublication(inputs);
  for (const pin of pins) {
    assert.equal(digest(inputs.get(pin.path)), pin.inputSha256);
    assert.equal(digest(outputs.get(pin.path)), pin.outputSha256);
  }
  const oldInventory = JSON.parse(inputs.get(REVIEWED_INVENTORY.path));
  const newInventory = JSON.parse(outputs.get(REVIEWED_INVENTORY.path));
  assert.deepEqual(newInventory.filter((row, index) => JSON.stringify(row) !== JSON.stringify(oldInventory[index])).map(row => row.path).sort(), REVIEWED_ARTIFACTS.map(row => row.path).sort());
  const changed = new Map(inputs); changed.set(REVIEWED_ARTIFACTS[0].path, Buffer.from('changed'));
  assert.throws(() => backportRuntimeSessionPublication(changed), /Unreviewed input/);
  const missing = new Map(inputs); missing.delete(REVIEWED_ARTIFACTS[0].path);
  assert.throws(() => backportRuntimeSessionPublication(missing), /exactly the six/);
  assert.throws(() => backportRuntimeSessionPublication(outputs), /Unreviewed input/);
});
