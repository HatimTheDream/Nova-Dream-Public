import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleName = 'host-capability-BrnTBmSB.js';
const bundleHash = 'b808de4d999c1ac2a2c3f17af55db13f6cf1056e0ccdb4e3d4ce232a51e45aad';
const anchor = '\t\t\t\t\ttoolCallId: request.toolCallId,\n\t\t\t\t\t...request.mcpTool ? { mcpTool: request.mcpTool } : {},';
const binding = '\t\t\t\t\t...attempt.approvalReviewerDeviceId ? { approvalReviewerDeviceIds: [attempt.approvalReviewerDeviceId] } : {},\n';
const workerBundleName = 'principal-CyvMFpus.js';
const workerBundleHash = 'a48dfe9a91b1404f017af38d5b65a972ef9077fa867c80aabee8f69082fb9781';
const workerAnchor = '\t\t\t\tingressOpts: {\n\t\t\t\t\tskillLibraryAuthoring,';
const workerBinding = '\t\t\t\t\tapprovalReviewerDeviceId: !params.isRestartRecoveryResumeRun && params.client?.internal?.agentRunTracking === "plugin_subagent" && params.client.internal.pluginRuntimeOwnerId === "edition3-worker" ? normalizeOptionalString(params.client?.connect?.device?.id) : void 0,\n';

/** OpenClaw2026.9.2 already binds ordinary approvals this way. Native MCP
 * requests omitted the initiating device and could not reach its reviewer.
 * Never take reviewer authority from model-supplied request parameters. */
export function bindNativeApprovalReviewer(source: string): string {
  if (createHash('sha256').update(source).digest('hex') !== bundleHash || source.split(anchor).length !== 2) throw new Error('Unrecognized OpenClaw approval bundle. Update Nova compatibility before starting native tools.');
  return source.replace(anchor, binding + anchor);
}

/** SDK assignment launches retain the authenticated client, but the pinned
 * agent ingress omits its reviewer identity. Bind only our live worker calls;
 * a recovered, synthetic or unrelated launch cannot borrow a review surface. */
export function bindWorkerApprovalReviewer(source: string): string {
  if (createHash('sha256').update(source).digest('hex') !== workerBundleHash || source.split(workerAnchor).length !== 2) throw new Error('Unrecognized OpenClaw worker approval bundle. Update Nova compatibility before starting native tools.');
  return source.replace(workerAnchor, '\t\t\t\tingressOpts: {\n' + workerBinding + '\t\t\t\t\tskillLibraryAuthoring,');
}

/** Owned child only: the global installation and every other process retain
 * their original bytes. Other modules pass through Node's normal loader. */
export function installNativeApprovalCompatibility(entry: string) {
  const directory = join(realpathSync(dirname(entry)), 'dist');
  return registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const path = fileURLToPath(url);
      if (dirname(path) !== directory || !/^(?:host-capability|principal)-.*\.js$/.test(basename(path))) return nextLoad(url, context);
      if (![bundleName, workerBundleName].includes(basename(path))) throw new Error('Unrecognized OpenClaw approval module. Native startup was stopped.');
      const loaded = nextLoad(url, context);
      if (loaded.format !== 'module' || loaded.source === undefined || loaded.source === null) throw new Error('The native approval module could not be verified.');
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as ArrayBuffer).toString('utf8');
      return { ...loaded, source: basename(path) === bundleName ? bindNativeApprovalReviewer(source) : bindWorkerApprovalReviewer(source) };
    },
  });
}
