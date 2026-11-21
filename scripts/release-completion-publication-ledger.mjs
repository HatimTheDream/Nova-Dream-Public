import { lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ReleaseJournal } from './release-coordinate.mjs';
import { readEvidenceFile, readReleaseInputFile, sha256 } from './release-plan.mjs';
import { fullPublicationLedgerDirectory } from './release-delivery-full-publication.mjs';

const document = ref => JSON.parse(readEvidenceFile(ref, { maximum: 2 * 1024 ** 2 }));
function requireFact(condition, reason) {
  if (!condition) throw Error('completion-publication-' + reason);
}

// The pinned storage request names the last accepted delivery. Its reserved
// publication input identifies the shared ledger used for arbitration.
export function publicationOptionsForCompletion(descriptor, target, context) {
  const owner = document(context.ownerRequest);
  const start = document(owner.releaseInput);
  const previous = document(start.profile).previousDelivery;
  requireFact(owner.operationId === descriptor.operation.id && start.operationId === owner.operationId,
    'owner-operation-changed');
  requireFact(isDeepStrictEqual(previous.publicationReceipt, context.publicationLedger), 'predecessor-receipt-changed');
  const published = document(previous.publicationReceipt);
  const evidenceDirectory = dirname(previous.publicationReceipt.path);
  const journalDirectory = dirname(evidenceDirectory);
  requireFact(published.kind === 'nova-delivery-full-publication' && published.operationId === previous.operationId &&
    previous.publicationReceipt.path === join(journalDirectory, 'delivery-evidence', published.key + '-full-publication.json') &&
    basename(journalDirectory) === 'journal-' + previous.operationId, 'predecessor-location-changed');
  const journal = new ReleaseJournal(journalDirectory, { readOnly: true });
  try {
    const delivery = journal.loadDelivery(previous.operationId);
    const phase = journal.deliveryPhase(previous.operationId, 'publication');
    requireFact(sha256(delivery.descriptor_json + '\n') === previous.descriptorSha256 && phase?.state === 'completed' &&
      phase.key === published.key && phase.inputSha256 === published.inputSha256 &&
      isDeepStrictEqual(phase.current.receipt, previous.publicationReceipt), 'predecessor-phase-changed');
    requireFact(phase.input.signed.candidateId === descriptor.operation.priorCandidateId &&
      published.evidence.feed.sha256 === target.full.signing.previousFeed.sha256 &&
      phase.input.signed.signedFeed.sha256 === published.evidence.feed.sha256, 'predecessor-identity-changed');
    const directory = fullPublicationLedgerDirectory(phase.input.ledgerDirectory);
    const requested = resolve(target.full.publicationLedgerDirectory);
    requireFact(requested === directory || !lstatSync(requested, { throwIfNoEntry: false }),
      'conflicting-ledger-exists');

    const roles = ['app', 'bundle', 'dependencies', 'manifest'];
    if (phase.input.signed.runtime) roles.push('runtime');
    requireFact(isDeepStrictEqual(published.assets.map(row => row.role).sort(), roles.sort()) &&
      Number.isSafeInteger(published.releaseIds.private) && published.releaseIds.private > 0 &&
      isDeepStrictEqual(phase.input.releaseIds, published.releaseIds), 'predecessor-assets-changed');
    for (const { role, asset } of published.assets) {
      requireFact(asset.name === basename(asset.name) && asset.authenticatedDownloadVerified === true,
        'predecessor-asset-identity-changed');
      const file = join(directory, published.releaseIds.private + '-' + asset.name + '.intent.json');
      const intent = JSON.parse(readReleaseInputFile(file));
      requireFact(intent.automaticRetry === false && intent.operationId === published.operationId &&
        intent.spec.role === role && intent.spec.name === asset.name && intent.spec.sha256 === asset.sha256 &&
        intent.spec.bytes === asset.bytes, 'ledger-intent-changed');
    }
    return { ...target.full, publicationLedgerDirectory: directory };
  } finally {
    journal.close();
  }
}
