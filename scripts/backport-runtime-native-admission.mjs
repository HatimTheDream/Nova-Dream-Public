/**
 * Prepare a new exact-source module; never mutate or start the input runtime.
 * Upstream: https://github.com/openclaw/openclaw/commit/97e6d8e2592bff84fc9b651b794969f8b1a37da5
 * Eight production source hunks map to these seven bundled sections: two imports
 * disappear in bundling, and the refresh/validation hunk becomes two sections.
 * Preserve that exact upstream stage, then apply the separately identified Nova
 * Windows recovery-host-junction correction. Never replace the full 9.8 module.
 *
 * MIT License — adapted upstream production code and regression
 * Copyright (c) 2026 OpenClaw Foundation
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_COMMIT = '97e6d8e2592bff84fc9b651b794969f8b1a37da5';
export const REVIEWED_RUNTIME_VERSION = '2026.9.8';
export const REVIEWED_MODULE_NAME = 'plugin-generation-artifact-Bm1J86Hz.mjs';
export const REVIEWED_INPUT_SHA256 = 'cf407e9631824208f504fd5271253647b5423d53020694228a732938bf149686';
export const UPSTREAM_OUTPUT_SHA256 = 'ff21035c3ec1160206245ea28c598e5bcb6c435f370438dd1793ea89e421d2cf';
export const REVIEWED_OUTPUT_SHA256 = '0963f1c94a08132199dec653a036d76cefbdeb7f8bf2e3f9dfdcd89b4bcd7eaf';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

export const REVIEWED_SECTIONS = Object.freeze([
  Object.freeze({
    name: "capture-validator", upstream: "plugin-native-reference.ts",
    before: [
      "function assertPluginNativeReferenceNamespace(target, fact, namespace, boundary, expectedHost) {",
      "\tconst relative = pluginNativeNamespaceMemberRelativePath(namespace, fact.capturedPath);",
      "\tconst directory = path.dirname(relative);",
      "\ttry {",
      "\t\tfor (const [name, member] of Object.entries(namespace.members)) {",
      "\t\t\tif (!isPathInside(directory, name || \".\")) continue;",
      "\t\t\tconst filename = fs.realpathSync(path.join(path.dirname(target), path.relative(directory, name || \".\")));",
      "\t\t\tif (!isPathInside(boundary, filename) && !isPathInside(pluginNativeNamespaceBoundary(namespace), filename)) throw new Error(`Companion ${name} leaves the captured generation`);",
      "\t\t\tconst current = fs.statSync(filename, { bigint: true });",
      "\t\t\tif (member.sizeBytes === void 0) {",
      "\t\t\t\tif (!current.isDirectory()) throw new Error(`Companion ${name} is not a directory`);",
      "\t\t\t\tcontinue;",
      "\t\t\t}",
      "\t\t\tconst captured = fs.statSync(pluginNativeNamespaceMemberPath(namespace, name), { bigint: true });",
      "\t\t\tif (current.dev === captured.dev && current.ino === captured.ino) continue;",
      "\t\t\tconst content = hashPluginSourceFile(filename, path.dirname(filename));",
      "\t\t\tif (content.contentHash !== member.contentHash || content.sizeBytes !== member.sizeBytes) throw new Error(`Companion ${name} differs from its captured bytes`);",
      "\t\t}",
      "\t\tif (expectedHost && resolveNativeHost(target) !== expectedHost) throw new Error(\"The native companion directory resolves a different OpenClaw host\");",
      "\t} catch (cause) {",
      "\t\tthrow new Error(\"Native plugin companions cannot be preserved without file symlinks. Enable file symlink support for this filesystem, then reload the plugin.\", { cause });",
      "\t}",
      "}"
    ].join('\n'),
    after: [
      "/** Upstream #162254: verdicts belong to this capture and exact companion placement. */",
      "function createPluginNativeReferenceValidator(boundary) {",
      "\tconst admitted = new WeakMap();",
      "\treturn (target, fact, namespace, expectedHost) => {",
      "\t\tconst directory = path.dirname(pluginNativeNamespaceMemberRelativePath(namespace, fact.capturedPath));",
      "\t\tconst placement = `${directory}\\0${path.dirname(target)}`;",
      "\t\tlet placements = admitted.get(namespace);",
      "\t\ttry {",
      "\t\t\tif (!placements?.has(placement)) {",
      "\t\t\t\tassertPluginNativeReferenceDirectory(target, namespace, boundary, directory);",
      "\t\t\t\tif (!placements) {",
      "\t\t\t\t\tplacements = new Set();",
      "\t\t\t\t\tadmitted.set(namespace, placements);",
      "\t\t\t\t}",
      "\t\t\t\tplacements.add(placement);",
      "\t\t\t}",
      "\t\t\tif (expectedHost && resolveNativeHost(target) !== expectedHost) throw new Error(\"The native companion directory resolves a different OpenClaw host\");",
      "\t\t} catch (cause) {",
      "\t\t\tthrow new Error(\"Native plugin companions cannot be preserved without file symlinks. Enable file symlink support for this filesystem, then reload the plugin.\", { cause });",
      "\t\t}",
      "\t};",
      "}",
      "function assertPluginNativeReferenceDirectory(target, namespace, boundary, directory) {",
      "\tfor (const [name, member] of Object.entries(namespace.members)) {",
      "\t\tif (!isPathInside(directory, name || \".\")) continue;",
      "\t\tconst filename = fs.realpathSync(path.join(path.dirname(target), path.relative(directory, name || \".\")));",
      "\t\tif (!isPathInside(boundary, filename) && !isPathInside(pluginNativeNamespaceBoundary(namespace), filename)) throw new Error(`Companion ${name} leaves the captured generation`);",
      "\t\tconst current = fs.statSync(filename, { bigint: true });",
      "\t\tif (member.sizeBytes === void 0) {",
      "\t\t\tif (!current.isDirectory()) throw new Error(`Companion ${name} is not a directory`);",
      "\t\t\tcontinue;",
      "\t\t}",
      "\t\tconst captured = fs.statSync(pluginNativeNamespaceMemberPath(namespace, name), { bigint: true });",
      "\t\tif (current.dev === captured.dev && current.ino === captured.ino) continue;",
      "\t\tconst content = hashPluginSourceFile(filename, path.dirname(filename));",
      "\t\tif (content.contentHash !== member.contentHash || content.sizeBytes !== member.sizeBytes) throw new Error(`Companion ${name} differs from its captured bytes`);",
      "\t}",
      "}"
    ].join('\n'),
  }),
  Object.freeze({
    name: "recovery-validator", upstream: "plugin-generation-source-lookup.ts",
    before: [
      "\t\tfor (const [target, fact] of hardlinkedTargets) assertPluginNativeReferenceNamespace(target, fact, native.namespaces.get(fact.namespace), recovery.directory);"
    ].join('\n'),
    after: [
      "\t\tconst assertReference = createPluginNativeReferenceValidator(recovery.directory);",
      "\t\tfor (const [target, fact] of hardlinkedTargets) assertReference(target, fact, native.namespaces.get(fact.namespace));"
    ].join('\n'),
  }),
  Object.freeze({
    name: "capture-owned-state", upstream: "plugin-native-admission.ts",
    before: [
      "\tconst hardlinkedTargets = /* @__PURE__ */ new Set();",
      "\tconst recoveredFiles"
    ].join('\n'),
    after: [
      "\tconst hardlinkedTargets = /* @__PURE__ */ new Set();",
      "\tconst pendingTargets = new Set();",
      "\tlet assertReference = createPluginNativeReferenceValidator(directory);",
      "\tconst recoveredFiles"
    ].join('\n'),
  }),
  Object.freeze({
    name: "new-materialization", upstream: "plugin-native-admission.ts",
    before: [
      "\t\tfact.capturedIdentity = linked.capturedIdentity;",
      "\t\treturn linked.sourceIdentity;"
    ].join('\n'),
    after: [
      "\t\tfact.capturedIdentity = linked.capturedIdentity;",
      "\t\tpendingTargets.add(target);",
      "\t\treturn linked.sourceIdentity;"
    ].join('\n'),
  }),
  Object.freeze({
    name: "pending-validation", upstream: "plugin-native-admission.ts",
    before: [
      "\tconst assertReferenceNamespaces = () => {",
      "\t\tfor (const target of hardlinkedTargets) {",
      "\t\t\tconst fact = files.get(targets.get(target));",
      "\t\t\tassertPluginNativeReferenceNamespace(target, fact, state.namespaces.get(fact.namespace), directory, hostRoot);",
      "\t\t}",
      "\t};"
    ].join('\n'),
    after: [
      "\tconst assertReferenceNamespaces = (references = pendingTargets) => {",
      "\t\tfor (const target of references) {",
      "\t\t\tif (!hardlinkedTargets.has(target)) continue;",
      "\t\t\tconst fact = files.get(targets.get(target));",
      "\t\t\tassertReference(target, fact, state.namespaces.get(fact.namespace), hostRoot);",
      "\t\t}",
      "\t};"
    ].join('\n'),
  }),
  Object.freeze({
    name: "unchanged-preparation", upstream: "plugin-native-admission.ts",
    before: [
      "\t\tfinish(receipt) {",
      "\t\t\tif (!files.size) return;",
      "\t\t\tfor (const namespace of namespaces()) finishPluginNativeNamespace(namespace);",
      "\t\t\tfinalReceipt = receipt;",
      "\t\t\tif (hostRoot) linkHost(hostRoot);",
      "\t\t\tassertReferenceNamespaces();",
      "\t\t\tpublish();",
      "\t\t},"
    ].join('\n'),
    after: [
      "\t\tfinish(receipt) {",
      "\t\t\tif (!pendingTargets.size) return;",
      "\t\t\tfor (const namespace of namespaces()) finishPluginNativeNamespace(namespace);",
      "\t\t\tfinalReceipt = receipt;",
      "\t\t\tif (hostRoot) linkHost(hostRoot);",
      "\t\t\tassertReferenceNamespaces();",
      "\t\t\tpublish();",
      "\t\t\tpendingTargets.clear();",
      "\t\t},"
    ].join('\n'),
  }),
  Object.freeze({
    name: "explicit-host-boundary", upstream: "plugin-native-admission.ts",
    before: [
      "\t\tlinkHost(selectedHost) {",
      "\t\t\tlinkHost(selectedHost);",
      "\t\t\tassertReferenceNamespaces();",
      "\t\t\tpublish();",
      "\t\t\treturn new Map([...files].map(([source, fact]) => [source, fact.sourceIdentity]));",
      "\t\t}"
    ].join('\n'),
    after: [
      "\t\tlinkHost(selectedHost) {",
      "\t\t\tassertReference = createPluginNativeReferenceValidator(directory);",
      "\t\t\tlinkHost(selectedHost);",
      "\t\t\tassertReferenceNamespaces(hardlinkedTargets);",
      "\t\t\tpublish();",
      "\t\t\tpendingTargets.clear();",
      "\t\t\treturn new Map([...files].map(([source, fact]) => [source, fact.sourceIdentity]));",
      "\t\t}"
    ].join('\n'),
  })
]);

export const WINDOWS_COMPATIBILITY_ID = 'nova-windows-recovery-host-junction-v1';
export const WINDOWS_COMPATIBILITY_SECTIONS = Object.freeze([
  Object.freeze({
    name: "nova-windows-recovery-host-junction",
    before: [
      "function captureRecoverySource({ rootDir, sourceRoot, capturedRoot, boundaryRoot, capturedPaths, captureNativeRecovery }) {"
    ].join('\n'),
    after: [
      "/** Nova Windows compatibility: copy only the capture-owned host junction.",
      " * This is separate from upstream #162254 and grants no broader symlink copy.",
      " */",
      "function copyWindowsRecoveryHostJunction(from, to, boundaryRoot, recoveryDirectory) {",
      "\tif (process.platform !== \"win32\" || from !== path.join(boundaryRoot, \"node_modules\", \"openclaw\") || to !== path.join(recoveryDirectory, \"node_modules\", \"openclaw\")) return false;",
      "\tconst fail = () => { throw new Error(\"The original recovery host junction could not be preserved.\"); };",
      "\tconst same = (left, right) => left === right || fail();",
      "\tconst identity = (stat) => [",
      "\t\tstat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.rdev,",
      "\t\tstat.size, stat.blksize, stat.blocks, stat.atimeNs, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs",
      "\t].map((value) => {",
      "\t\tif (typeof value !== \"bigint\") fail();",
      "\t\treturn String(value);",
      "\t}).join(\":\");",
      "\tconst directory = (filename) => {",
      "\t\tconst stat = fs.lstatSync(filename, { bigint: true });",
      "\t\tif (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) fail();",
      "\t\treturn `${stat.dev}:${stat.ino}:${stat.mode}`;",
      "\t};",
      "\tconst sourceRootIdentity = directory(boundaryRoot);",
      "\tconst sourceParent = path.dirname(from), targetParent = path.dirname(to);",
      "\tconst sourceParentIdentity = directory(sourceParent);",
      "\tconst recoveryIdentity = directory(recoveryDirectory);",
      "\tconst targetParentIdentity = directory(targetParent);",
      "\tconst link = fs.lstatSync(from, { bigint: true });",
      "\tif (!link.isSymbolicLink()) fail();",
      "\tconst linkIdentity = identity(link), rawTarget = fs.readlinkSync(from);",
      "\tconst target = fs.realpathSync(from);",
      "\tconst targetStat = fs.lstatSync(target, { bigint: true });",
      "\tif (!targetStat.isDirectory() || targetStat.isSymbolicLink()) fail();",
      "\tconst targetIdentity = identity(targetStat);",
      "\tconst checkOriginal = () => {",
      "\t\tsame(directory(boundaryRoot), sourceRootIdentity);",
      "\t\tsame(directory(sourceParent), sourceParentIdentity);",
      "\t\tconst current = fs.lstatSync(from, { bigint: true });",
      "\t\tif (!current.isSymbolicLink()) fail();",
      "\t\tsame(identity(current), linkIdentity);",
      "\t\tsame(fs.readlinkSync(from), rawTarget);",
      "\t\tsame(fs.realpathSync(from), target);",
      "\t\tconst currentTarget = fs.lstatSync(target, { bigint: true });",
      "\t\tif (!currentTarget.isDirectory() || currentTarget.isSymbolicLink()) fail();",
      "\t\tsame(identity(currentTarget), targetIdentity);",
      "\t};",
      "\tconst checkDestinationParent = () => {",
      "\t\tsame(directory(recoveryDirectory), recoveryIdentity);",
      "\t\tsame(directory(targetParent), targetParentIdentity);",
      "\t};",
      "\tcheckOriginal();",
      "\tcheckDestinationParent();",
      "\tif (fs.lstatSync(to, { bigint: true, throwIfNoEntry: false })) fail();",
      "\tfs.symlinkSync(target, to, \"junction\");",
      "\tconst created = fs.lstatSync(to, { bigint: true });",
      "\tif (!created.isSymbolicLink() || fs.realpathSync(to) !== target) fail();",
      "\tcheckOriginal();",
      "\tcheckDestinationParent();",
      "\treturn true;",
      "}",
      "function captureRecoverySource({ rootDir, sourceRoot, capturedRoot, boundaryRoot, capturedPaths, captureNativeRecovery }) {"
    ].join('\n'),
  }),
  Object.freeze({
    name: "exact-host-link-filter",
    before: [
      "\t\t\t\tconst fact = native?.references.get(from);",
      "\t\t\t\tif (!fact) return true;"
    ].join('\n'),
    after: [
      "\t\t\t\tconst fact = native?.references.get(from);",
      "\t\t\t\tif (!fact) return !copyWindowsRecoveryHostJunction(from, to, boundaryRoot, recovery.directory);"
    ].join('\n'),
  })
]);

export function backportRuntimeNativeAdmission(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  requireCondition(digest(bytes) === REVIEWED_INPUT_SHA256, 'Unreviewed runtime module bytes.');
  let result = bytes.toString('utf8');
  for (const { before, after } of REVIEWED_SECTIONS) {
    requireCondition(result.split(before).length === 2, 'Reviewed runtime section is not unique.');
    result = result.replace(before, () => after);
  }
  requireCondition(digest(Buffer.from(result, 'utf8')) === UPSTREAM_OUTPUT_SHA256,
    'Upstream-only backport differs from its preserved identity.');
  for (const { before, after } of WINDOWS_COMPATIBILITY_SECTIONS) {
    requireCondition(result.split(before).length === 2, 'Windows compatibility section is not unique.');
    result = result.replace(before, () => after);
  }
  const output = Buffer.from(result, 'utf8');
  requireCondition(digest(output) === REVIEWED_OUTPUT_SHA256, 'Backported runtime bytes differ from the reviewed output.');
  return output;
}

function ordinaryPath(filename, leafExists = true) {
  requireCondition(typeof filename === 'string' && path.isAbsolute(filename), 'Use absolute module and receipt paths.');
  const absolute = path.resolve(filename);
  const root = path.parse(absolute).root;
  const components = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    if (!leafExists && index === components.length - 1) {
      requireCondition(!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false }), 'Output already exists.');
      continue;
    }
    const stat = fs.lstatSync(current, { bigint: true });
    requireCondition(!stat.isSymbolicLink(), 'Symlink or junction paths are not accepted.');
    if (index < components.length - 1 || !leafExists) requireCondition(stat.isDirectory(), 'Output ancestry is not an ordinary directory.');
  }
  return absolute;
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

/** Writes one new module and receipt; leaves the input and existing files untouched. */
export function writeBackportedRuntimeModule({ source, output, receipt }) {
  source = ordinaryPath(source);
  output = ordinaryPath(output, false);
  receipt = ordinaryPath(receipt, false);
  requireCondition(path.basename(source) === REVIEWED_MODULE_NAME && path.basename(output) === REVIEWED_MODULE_NAME,
    'Use the exact reviewed module filename for both input and output.');
  const comparable = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  requireCondition(new Set([source, output, receipt].map(comparable)).size === 3, 'Input, output and receipt paths must be distinct.');
  requireCondition(path.dirname(output) === path.dirname(receipt), 'Keep the new module and its receipt in one prepared directory.');
  const before = fs.lstatSync(source, { bigint: true });
  requireCondition(before.isFile() && before.nlink === 1n && before.size <= 262144n,
    'Input must be one ordinary, singly linked bounded module.');
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let normalized;
  try {
    requireCondition(identity(fs.fstatSync(sourceFd, { bigint: true })) === identity(before), 'Input changed before reading.');
    normalized = backportRuntimeNativeAdmission(fs.readFileSync(sourceFd));
    requireCondition(identity(fs.fstatSync(sourceFd, { bigint: true })) === identity(before), 'Input changed while reading.');
  } finally {
    fs.closeSync(sourceFd);
  }
  ordinaryPath(source);
  requireCondition(identity(fs.lstatSync(source, { bigint: true })) === identity(before), 'Input namespace changed.');
  ordinaryPath(output, false);
  ordinaryPath(receipt, false);
  const outputFd = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  let outputIdentity;
  try {
    fs.writeFileSync(outputFd, normalized);
    fs.fsyncSync(outputFd);
    const stat = fs.fstatSync(outputFd, { bigint: true });
    requireCondition(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(normalized.length), 'Prepared output identity differs.');
    const readback = Buffer.alloc(normalized.length);
    let offset = 0;
    while (offset < readback.length) {
      const count = fs.readSync(outputFd, readback, offset, readback.length - offset, offset);
      requireCondition(count > 0, 'Prepared output readback ended early.');
      offset += count;
    }
    requireCondition(digest(readback) === REVIEWED_OUTPUT_SHA256, 'Prepared output readback differs.');
    outputIdentity = identity(fs.fstatSync(outputFd, { bigint: true }));
  } finally {
    fs.closeSync(outputFd);
  }
  ordinaryPath(output);
  const finalOutput = fs.lstatSync(output, { bigint: true });
  requireCondition(finalOutput.nlink === 1n && identity(finalOutput) === outputIdentity, 'Prepared output namespace changed after readback.');
  requireCondition(identity(fs.lstatSync(source, { bigint: true })) === identity(before), 'Input changed during output preparation.');
  const result = {
    format: 1, status: 'prepared-not-installed', runtimeVersion: REVIEWED_RUNTIME_VERSION,
    moduleName: REVIEWED_MODULE_NAME,
    source: { path: source, sha256: REVIEWED_INPUT_SHA256, bytes: Number(before.size) },
    output: { path: output, sha256: REVIEWED_OUTPUT_SHA256, bytes: normalized.length },
    backport: { upstreamCommit: UPSTREAM_COMMIT, upstreamOutputSha256: UPSTREAM_OUTPUT_SHA256,
      sha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))) },
    windowsCompatibility: { id: WINDOWS_COMPATIBILITY_ID, scope: 'exact-capture-recovery-host-junction-only' },
    scope: 'upstream-native-admission-with-narrow-windows-recovery-junction', hostChecks: 'each-admitted-target-and-explicit-host-boundary',
    inputModified: false, runtimeStarted: false,
  };
  fs.writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireCondition(args.length === 6 && args[0] === '--source' && args[2] === '--output' && args[4] === '--receipt',
      'Usage: node backport-runtime-native-admission.mjs --source ABSOLUTE_MODULE --output NEW_ABSOLUTE_MODULE --receipt NEW_ABSOLUTE_RECEIPT');
    const result = writeBackportedRuntimeModule({ source: args[1], output: args[3], receipt: args[5] });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}

