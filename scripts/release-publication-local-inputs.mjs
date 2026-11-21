import { lstatSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readEvidenceFile } from './release-plan.mjs';

const roles = ['archive', 'execution', 'metadata'];
const maxBytes = 128 * 1024 ** 2;
const readJSON = ref => JSON.parse(readEvidenceFile(ref));
function requireInput(ok, reason) {
  if (!ok) throw new Error('publication-local-input-' + reason);
}

export function verifyPublicationLocalPath(logicalPath, localPath) {
  requireInput(/^\/mnt\/nova-data\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(logicalPath)
    && !logicalPath.split('/').some(piece => piece === '.' || piece === '..')
    && /^[A-Za-z]:\\/.test(localPath) && localPath === win32.join(win32.parse(localPath).root, ...logicalPath.slice(1).split('/')), 'canonical-path');
}

/** Translate only the qualified dependency files that a Windows child will
 * open. All journal references and the signed feed bytes keep their identities. */
export function projectPublicationRequest(request, binding) {
  const proof = readJSON(binding);
  requireInput(proof.kind === 'same-original-qualified-dependency-inputs' && proof.status === 'verified'
    && proof.descriptorModified === false && proof.rebuild === false && proof.sourceOrRemoteEffects === false, 'proof');
  const original = readJSON(proof.originalTarget).full.dependencyTransport.qualifiedDependencies;
  const downloads = readJSON(proof.previousAuthenticatedDownloads);
  const dependencies = request.signed.dependencies;
  requireInput(downloads.format === 1 && downloads.downloadVerified === true && downloads.productionEffects === false
    && [original, proof.rows, downloads.sourceRefs, downloads.localRefs].every(rows => same(Object.keys(rows).sort(), roles))
    && dependencies.newNativeDependenciesQualified === true && same(dependencies.qualification, dependencies.execution), 'qualified-roles');
  const local = {};
  for (const role of roles) {
    const row = proof.rows[role], logical = dependencies[role], ref = row.actualWindowsInput;
    requireInput(same(row.originalDescriptorRef, logical) && same(original[role], logical)
      && same(downloads.sourceRefs[role], { ...logical, bytes: row.bytes }) && same(downloads.localRefs[role], row.source)
      && row.independentSingleLink === true && row.source.sha256 === logical.sha256 && ref.sha256 === logical.sha256, 'lineage');
    verifyPublicationLocalPath(logical.path, ref.path);
    requireInput(process.platform === 'win32' && resolve(logical.path) === ref.path, 'canonical-path');
    requireInput(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= maxBytes
      && lstatSync(ref.path).nlink === 1 && readEvidenceFile(ref, { maximum: row.bytes }).length === row.bytes, 'qualified-bytes');
    local[role] = ref;
  }
  requireInput(dependencies.description.archiveBytes === proof.rows.archive.bytes
    && dependencies.description.archiveSha256 === local.archive.sha256, 'archive-identity');
  const projected = { ...request, signed: { ...request.signed, dependencies: { ...dependencies, ...local, qualification: local.execution } } };
  if (request.spec?.role === 'dependencies') {
    requireInput(request.spec.path === dependencies.archive.path && request.spec.sha256 === local.archive.sha256
      && request.spec.bytes === proof.rows.archive.bytes, 'role-spec');
    projected.spec = { ...request.spec, path: local.archive.path };
  }
  return projected;
}
