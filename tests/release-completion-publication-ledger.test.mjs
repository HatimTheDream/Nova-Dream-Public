import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import test from 'node:test';
import { initializeFixture } from '../support/delivery-initialize-fixture.mjs';
import { publicationOptionsForCompletion } from '../scripts/release-completion-publication-ledger.mjs';
import { ReleaseJournal, validateJournalDirectory } from '../scripts/release-coordinate.mjs';
import { deriveDeliveryConfiguration } from '../scripts/release-delivery-initialize.mjs';
import { sha256 } from '../scripts/release-plan.mjs';

test('completion reuses the prior shared ledger only with its original per-asset intents', async t => {
  const f = initializeFixture(t);
  const source = await deriveDeliveryConfiguration(f.input, f.profile, f.options);
  const prior = f.input.operationId;
  const directory = validateJournalDirectory(join(f.root, 'shared-ledger'), { create: true });
  const journalDirectory = join(f.root, 'journal-' + prior);
  const journal = new ReleaseJournal(journalDirectory, { create: true });
  const currentId = randomUUID();
  const candidateId = sha256('previously-published-candidate');
  const releaseIds = { private: 123, public: 456 };
  const assets = ['app', 'bundle', 'dependencies', 'manifest'].map(role => ({
    role, asset: { name: role + '.json', sha256: sha256(role), bytes: role.length, authenticatedDownloadVerified: true },
  }));
  let previous;
  try {
    journal.initializeDelivery({
      format: 1, operation: source.operation, sources: source.sources, target: f.profile.target,
      targetIdentity: source.targetIdentity, adapterIdentity: source.adapterIdentity, timeline: f.input.timeline,
    }, f.now);
    const { intent } = journal.reserveDeliveryPhase(prior, 'publication', {
      signed: { candidateId, signedFeed: f.signedFeed }, releaseIds, ledgerDirectory: directory,
    }, f.now);
    const published = {
      kind: 'nova-delivery-full-publication', operationId: prior, key: intent.key,
      inputSha256: intent.inputSha256, evidence: { feed: f.signedFeed }, releaseIds, assets,
    };
    const receipt = f.put(join(relative(f.root, journalDirectory), 'delivery-evidence', intent.key + '-full-publication.json'), published);
    journal.recordDeliveryObservation(prior, 'publication', {
      state: 'completed', key: intent.key, externalId: prior, reason: 'published', output: published, receipt,
    }, f.now);
    previous = { operationId: prior, descriptorSha256: sha256(journal.loadDelivery(prior).descriptor_json + '\n'), publicationReceipt: receipt };
  } finally {
    journal.close();
  }

  const profile = f.put('next-profile.json', { previousDelivery: previous });
  const releaseInput = f.put('next-start.json', { operationId: currentId, profile });
  const context = { ownerRequest: f.put('owner.json', { operationId: currentId, releaseInput }), publicationLedger: previous.publicationReceipt };
  const descriptor = { operation: { id: currentId, priorCandidateId: candidateId } };
  const options = () => publicationOptionsForCompletion(descriptor, f.target, context);
  const writeIntent = (item, changes = {}) => {
    const { role, asset: { name, bytes, sha256: digest } } = item;
    const spec = { role, name, bytes, sha256: digest, ...changes.spec };
    f.put(join(relative(f.root, directory), releaseIds.private + '-' + name + '.intent.json'), {
      operationId: prior, automaticRetry: false, ...changes, spec,
    });
  };
  for (const item of assets) writeIntent(item);
  assert.deepEqual(options(), { ...f.target.full, publicationLedgerDirectory: directory });

  const dependency = assets.find(item => item.role === 'dependencies');
  for (const changes of [{ operationId: currentId }, { automaticRetry: true }, { spec: { bytes: 1 } }]) {
    writeIntent(dependency, changes);
    assert.throws(options, /completion-publication-ledger-intent-changed/);
  }
});
