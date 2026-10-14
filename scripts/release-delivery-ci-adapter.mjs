import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { validateJournalDirectory } from './release-coordinate.mjs';

const need = (v, code) => { if (!v) throw Error(code); };
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const helperHashes = () => Object.fromEntries(['release-delivery-ci.py', 'release-ci-primitives.py'].map(name => [name, sha256(readFileSync(new URL(name, import.meta.url)))]));

export function createCiAdapter(side, { tools, command, storeReceipt, validateTools }) {
  const expectedInput = descriptor => ({ source: descriptor.sources[side], tools, helperHashes: helperHashes() });
  const observe = async ({ intent, journal, descriptor }) => {
    validateTools(tools);
    const outputDirectory = validateJournalDirectory(join(journal.directory, 'ci-' + intent.key), { create: true });
    const request = { format: 1, key: intent.key, version: descriptor.operation.version, source: intent.input.source,
      tools, externalId: intent.externalId, outputDirectory, helperHashes: intent.input.helperHashes };
    const raw = Buffer.from(JSON.stringify(request) + '\n');
    const stored = storeReceipt(journal, intent.key, `ci-request-${sha256(raw)}.json`, raw);
    return JSON.parse(await command(tools.python.path, [fileURLToPath(new URL('release-delivery-ci.py', import.meta.url)), '--request', stored.path, '--request-sha256', stored.sha256],
      { maximum: 4 * 1024 ** 2, timeoutMs: 240000, acceptJsonFailure: true, gitExecPath: tools.gitExecPath }));
  };
  return { input: async ({ descriptor }) => expectedInput(descriptor),
    validate: async ({ descriptor, input }) => { need(canonical(input) === canonical(expectedInput(descriptor)), 'ci-input-changed'); validateTools(tools); },
    execute: observe, observe,
    verify: async (r, { descriptor, intent }) => {
      if (r.externalId) need(/^[1-9]\d*:[1-9]\d*$/.test(r.externalId) && (!intent.externalId || r.externalId === intent.externalId), 'ci-run-attempt-changed');
      if (r.state !== 'completed') return;
      const source = intent.input.source, receipt = JSON.parse(readEvidenceFile(r.receipt)), output = r.output;
      readEvidenceFile(output.log, { maximum: 32 * 1024 ** 2 });
      need(output.sourceCommit === source.commit && output.repository === source.repository && r.externalId === `${output.runId}:${output.runAttempt}`
        && canonical(output.receipt) === canonical(r.receipt), 'ci-output-identity-changed');
      const repository = receipt.repositories?.[0], run = repository?.runs?.[0], job = run?.jobs?.[0];
      const expectedWorkflow = side === 'private' ? 'Nova Dream quality and release history' : 'Application quality';
      need(receipt.format === 1 && receipt.readOnly === true && receipt.sourceVersion === descriptor.operation.version && receipt.repositories.length === 1
        && repository.repository === source.repository.split('/')[1] && repository.sha === source.commit && repository.runs.length === 1
        && run.id === output.runId && run.runAttempt === output.runAttempt && run.name === expectedWorkflow && run.status === 'completed' && run.conclusion === 'success'
        && run.jobs.length === 2 && job.name === 'quality' && job.status === 'completed' && job.conclusion === 'success' && job.logSha256 === output.log.sha256
        && ['Run npm run quality', 'Verify Linux update recovery'].every(name => job.steps.some(step => step.name === name && step.conclusion === 'success')), 'ci-receipt-identity-changed');
      const releaseJob=run.jobs[1],release=repository.release;
      need(releaseJob.name==='release' && Number.isSafeInteger(releaseJob.id) && releaseJob.id>0 && releaseJob.id!==job.id
        && releaseJob.status==='completed' && releaseJob.conclusion==='success' && canonical(output.release)===canonical(release)
        && Number.isSafeInteger(release?.id) && release.id>0 && release.tag===(side==='private'?'nova-v':'v')+descriptor.operation.version
        && release.sourceCommit===source.commit && release.targetCommitish===source.commit && release.repository===source.repository
        && release.draft===false && release.prerelease===false && release.tagObjectType==='commit','ci-release-identity-changed');
    } };
}
