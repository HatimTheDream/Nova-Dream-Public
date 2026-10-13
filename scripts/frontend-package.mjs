import { createPrivateKey, createPublicKey, sign, verify, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { verifyCandidate } from './candidate.mjs';
import { assertFrontendSourceClean, computeFrontendCompatibility, frontendIdentity, frontendLimits, frontendRegular, sha256, validateFrontendManifest, walkFrontendFiles } from './frontend-contract.mjs';

const need = (condition, reason) => { if (!condition) throw Error(reason); };
const writeExclusive = (path, bytes) => {
  for (let cursor = dirname(resolve(path)); ; cursor = dirname(cursor)) { need(lstatSync(cursor).isDirectory() && !lstatSync(cursor).isSymbolicLink(), 'Frontend output parents cannot be symlinks.'); if (cursor === dirname(cursor)) break; }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
};
const capsule = candidate => {
  const value = candidate.manifest.frontendCompatibility;
  need(value && Object.keys(value).sort().join(',') === 'compiledFiles,eligibility,format,serviceInputsSha256,sourceFiles,sourceRevision' && value.format === 2 && value.eligibility === 'client-behavior' && /^[a-f0-9]{64}$/.test(value.serviceInputsSha256 ?? '') && /^[a-f0-9]{40}$/.test(value.sourceRevision ?? '') && Number.isSafeInteger(value.sourceFiles) && value.sourceFiles > 0 && Number.isSafeInteger(value.compiledFiles) && value.compiledFiles > 0, 'The candidate has no complete frontend compatibility capsule.');
  return value;
};
const completeCompiledClosure = candidate => {
  const actual = [];
  for (const tree of ['dist/service', 'dist/desktop']) for (const path of walkFrontendFiles(join(candidate.root, tree))) actual.push(tree + '/' + path);
  actual.sort();
  const expected = [...candidate.bytes.keys()].filter(path => path.startsWith('dist/service/') || path.startsWith('dist/desktop/')).sort();
  need(JSON.stringify(actual) === JSON.stringify(expected) && actual.length === capsule(candidate).compiledFiles, 'The canonical compiled closure contains unverified or missing files.');
};

/** Deterministic USTAR regular files only; no shell, paths from a caller, links or special entries. */
export function frontendArchive(entries) {
  frontendIdentity(entries.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })));
  const blocks = [];
  for (const [path, bytes] of entries) {
    const header = Buffer.alloc(512), octal = (offset, width, value) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    need(Buffer.byteLength(path) <= 100 && bytes.length <= frontendLimits.fileBytes, 'The frontend archive entry exceeds its limit.');
    header.write(path, 0, 100, 'ascii'); octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, bytes.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** Package a complete verified frontend, admitted only against an exact compatible service candidate. */
export function packageFrontend({ workspace, baseWorkspace, outputDirectory, artifactUrl, sequence, createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 7 * 86400000).toISOString(), gitBinary }) {
  const clean = assertFrontendSourceClean(workspace, { gitBinary });
  const candidate = verifyCandidate(workspace), base = verifyCandidate(baseWorkspace), actual = computeFrontendCompatibility(workspace, { gitBinary });
  const targetCapsule = capsule(candidate);
  need(actual.sourceRevision === clean.sourceRevision && actual.sourceRevision === targetCapsule.sourceRevision && actual.serviceInputsSha256 === targetCapsule.serviceInputsSha256, 'Build the frontend from the exact current source inputs.');
  const beforeWrite = () => need(assertFrontendSourceClean(workspace, { gitBinary }).sourceRevision === clean.sourceRevision, 'Frontend source changed while packaging.');
  return packageVerifiedFrontend(candidate, base, { outputDirectory, artifactUrl, sequence, createdAt, expiresAt }, { mode: 'source-verified', deliveryQualification: false }, beforeWrite);
}

const exactKeys = (value, names, reason) => need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...names].sort().join(','), reason);

/** Package once from authenticated canonical CI bytes, with the operator's exact raw receipt binding. */
export function packageRetained({ workspace, baseWorkspace, applicationArchive, ciSourceReceipt, approvedReceiptSha256, outputDirectory, artifactUrl, sequence, createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 7 * 86400000).toISOString() }) {
  const raw = frontendRegular(ciSourceReceipt, 64 * 1024);
  need(typeof approvedReceiptSha256 === 'string' && /^[a-f0-9]{64}$/.test(approvedReceiptSha256) && sha256(raw) === approvedReceiptSha256, 'Bind the exact operator-reviewed canonical CI receipt bytes.');
  const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  exactKeys(receipt, ['format', 'kind', 'sourceCommit', 'repository', 'runId', 'runAttempt', 'toolchain', 'nodeSha256', 'packagerSha256', 'candidateVerifierSha256', 'application', 'rebuilt', 'deliveryQualification'], 'Unexpected canonical CI receipt fields.');
  exactKeys(receipt.toolchain, ['nodeVersion', 'platform', 'arch'], 'Unexpected canonical CI toolchain fields.');
  need(receipt.format === 1 && receipt.kind === 'canonical-ci-built-candidate' && receipt.rebuilt === false && receipt.deliveryQualification === false &&
    ['HatimTheDream/Nova-Dream', 'HatimTheDream/Nova-Dream-Public'].includes(receipt.repository) && /^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? '') &&
    [receipt.runId, receipt.runAttempt].every(value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) &&
    receipt.toolchain.nodeVersion === '22.23.2' && receipt.toolchain.platform === 'linux' && receipt.toolchain.arch === 'x64' &&
    [receipt.nodeSha256, receipt.packagerSha256, receipt.candidateVerifierSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'Use the actual supported canonical CI source/toolchain receipt; it is not delivery qualification.');
  const candidate = verifyCandidate(workspace), base = verifyCandidate(baseWorkspace), targetCapsule = capsule(candidate), metadata = receipt.application;
  exactKeys(metadata, ['format', 'candidateId', 'archiveBytes', 'archiveSha256', 'expandedBytes', 'fileCount', 'packageLockSha256', 'version', 'buildVersion', 'schemaVersion', 'apiVersion'], 'Unexpected canonical application receipt fields.');
  need(metadata.format === 1 && metadata.candidateId === candidate.id && receipt.sourceCommit === targetCapsule.sourceRevision &&
    ['version', 'buildVersion', 'schemaVersion', 'apiVersion'].every(key => metadata[key] === candidate.manifest[key]) &&
    Number.isSafeInteger(metadata.expandedBytes) && metadata.expandedBytes > 0 && metadata.expandedBytes <= frontendLimits.totalBytes && Number.isSafeInteger(metadata.fileCount) && metadata.fileCount > 0,
    'The canonical CI receipt differs from the extracted candidate/source identity.');
  const archive = frontendRegular(applicationArchive, frontendLimits.archiveBytes);
  need(archive.length === metadata.archiveBytes && sha256(archive) === metadata.archiveSha256 && sha256(frontendRegular(join(candidate.root, 'package-lock.json'))) === metadata.packageLockSha256 &&
    sha256(frontendRegular(join(candidate.root, 'scripts/candidate.mjs'))) === receipt.candidateVerifierSha256, 'The original canonical application archive or verifier/dependency bytes differ.');
  return packageVerifiedFrontend(candidate, base, { outputDirectory, artifactUrl, sequence, createdAt, expiresAt }, { mode: 'retained-canonical-ci', receiptSha256: approvedReceiptSha256, repository: receipt.repository, sourceCommit: receipt.sourceCommit, runId: receipt.runId, runAttempt: receipt.runAttempt, deliveryQualification: false });
}

function packageVerifiedFrontend(candidate, base, { outputDirectory, artifactUrl, sequence, createdAt, expiresAt }, verification, beforeWrite = () => {}) {
  const targetCapsule = capsule(candidate), baseCapsule = capsule(base);
  completeCompiledClosure(candidate); completeCompiledClosure(base);
  need(targetCapsule.serviceInputsSha256 === baseCapsule.serviceInputsSha256 && ['apiVersion', 'schemaVersion', 'appId'].every(key => candidate.manifest[key] === base.manifest[key]), 'Shared contract, service, desktop, dependency, startup or deployment inputs changed; use the full delivery route.');
  const paths = walkFrontendFiles(join(candidate.root, 'dist/client'));
  const listed = [...candidate.bytes.keys()].filter(path => path.startsWith('dist/client/')).map(path => path.slice('dist/client/'.length)).sort();
  need(JSON.stringify(paths) === JSON.stringify(listed), 'The built frontend contains unverified or missing files.');
  const entries = paths.map(path => [path, candidate.bytes.get('dist/client/' + path)]), files = entries.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
  const frontendId = frontendIdentity(files), archive = frontendArchive(entries);
  need(archive.length <= frontendLimits.archiveBytes, 'Frontend archive exceeds its limit.');
  const manifest = validateFrontendManifest({ format: 1, kind: 'frontend', channel: 'frontend-stable', sequence, createdAt, expiresAt, frontendId,
    frontendVersion: candidate.manifest.version, frontendBuildVersion: candidate.manifest.buildVersion, sourceRevision: targetCapsule.sourceRevision,
    base: { candidateId: base.id, serviceInputsSha256: baseCapsule.serviceInputsSha256, apiVersion: base.manifest.apiVersion, schemaVersion: base.manifest.schemaVersion },
    artifact: { url: artifactUrl, bytes: archive.length, sha256: sha256(archive) }, files });
  const directory = resolve(outputDirectory), root = candidate.root, baseRoot = base.root;
  need(directory !== root && !directory.startsWith(root + sep) && directory !== baseRoot && !directory.startsWith(baseRoot + sep), 'Keep frontend release outputs outside candidate/source inputs.');
  need(!existsSync(directory), 'Use a new frontend output directory; existing operations are not replayed.');
  // Validate existing ancestors before creating anything; these outputs contain no signing material.
  for (let cursor = dirname(directory); ; cursor = dirname(cursor)) { if (existsSync(cursor)) need(!lstatSync(cursor).isSymbolicLink(), 'Frontend output parents cannot be symlinks.'); if (cursor === dirname(cursor)) break; }
  beforeWrite();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  writeExclusive(join(directory, 'frontend.tgz'), archive); writeExclusive(join(directory, 'frontend.json'), manifestBytes);
  return { frontendId, version: manifest.frontendVersion, baseCandidateId: base.id, serviceInputsSha256: baseCapsule.serviceInputsSha256, verification, archive: { file: 'frontend.tgz', bytes: archive.length, sha256: sha256(archive) }, manifest: { file: 'frontend.json', bytes: manifestBytes.length, sha256: sha256(manifestBytes) } };
}

/** Detached Ed25519 signature with the existing external release key; never creates a key or publishes. */
export function signFrontend({ input, privateKeyFile, publicKeyFile, output, previousManifest, previousSignature, workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..') }) {
  const raw = frontendRegular(input, frontendLimits.manifestBytes), manifest = validateFrontendManifest(JSON.parse(raw.toString('utf8')));
  need(raw.equals(Buffer.from(JSON.stringify(manifest) + '\n')), 'Frontend signing requires exact canonical manifest bytes.');
  const keyPath = resolve(privateKeyFile), root = resolve(workspace);
  need(keyPath !== root && !keyPath.startsWith(root + sep), 'Keep existing signing material outside application source.');
  if (process.platform !== 'win32') need(!(lstatSync(keyPath).mode & 0o077), 'The existing signing key must be readable only by its owner.');
  const privateKey = createPrivateKey(frontendRegular(keyPath, 16 * 1024)), publicKey = createPublicKey(frontendRegular(publicKeyFile, 16 * 1024));
  need(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519', 'Use the existing trusted Ed25519 key pair.');
  const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }), trusted = publicKey.export({ format: 'der', type: 'spki' });
  need(derived.length === trusted.length && timingSafeEqual(derived, trusted), 'The existing release key does not match the trusted key.');
  if (previousManifest === 'initial') { need(!previousSignature && manifest.sequence === 1, 'The initial frontend channel begins at sequence1.'); }
  else {
    need(typeof previousManifest === 'string' && typeof previousSignature === 'string', 'Bind the previous raw frontend manifest and detached signature.');
    const oldRaw = frontendRegular(previousManifest, frontendLimits.manifestBytes), signature = frontendRegular(previousSignature, 64), prior = validateFrontendManifest(JSON.parse(oldRaw.toString('utf8')), { admission: false });
    need(signature.length === 64 && verify(null, oldRaw, publicKey, signature) && prior.channel === manifest.channel && manifest.sequence > prior.sequence, 'Advance the verified frontend channel sequence.');
  }
  const signature = sign(null, raw, privateKey);
  need(signature.length === 64 && verify(null, raw, publicKey, signature), 'Frontend signature verification failed.');
  writeExclusive(resolve(output), signature);
  return { channel: manifest.channel, sequence: manifest.sequence, frontendId: manifest.frontendId, manifestSha256: sha256(raw), signatureBytes: signature.length, signatureSha256: sha256(signature) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'package' && args.length === 6) console.log(JSON.stringify(packageFrontend({ workspace: args[0], baseWorkspace: args[1], outputDirectory: args[2], artifactUrl: args[3], sequence: Number(args[4]), expiresAt: args[5] })));
  else if (mode === 'package-retained' && args.length === 9) console.log(JSON.stringify(packageRetained({ workspace: args[0], baseWorkspace: args[1], applicationArchive: args[2], ciSourceReceipt: args[3], approvedReceiptSha256: args[4], outputDirectory: args[5], artifactUrl: args[6], sequence: Number(args[7]), expiresAt: args[8] })));
  else if (mode === 'sign' && (args.length === 5 || args.length === 6)) console.log(JSON.stringify(signFrontend({ input: args[0], privateKeyFile: args[1], publicKeyFile: args[2], output: args[3], previousManifest: args[4], previousSignature: args[5] })));
  else throw Error('Usage: frontend-package.mjs package SOURCE BASE NEW_OUTPUT HTTPS_ARTIFACT_URL SEQUENCE EXPIRES_AT | package-retained EXTRACTED_SOURCE BASE ORIGINAL_APP_TGZ CI_RECEIPT REVIEWED_RECEIPT_SHA256 NEW_OUTPUT HTTPS_ARTIFACT_URL SEQUENCE EXPIRES_AT | sign MANIFEST EXTERNAL_PRIVATE_KEY TRUSTED_PUBLIC_KEY SIGNATURE PREVIOUS_MANIFEST_OR_initial [PREVIOUS_SIGNATURE]');
}
