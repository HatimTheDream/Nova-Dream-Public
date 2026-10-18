# Two-runner CI measurement

This measurement workflow runs the full check set across two Linux runners. It does not publish a release, install an update, or replace canonical release admission.

- The sorted inventory includes every file matched by the existing `test:quality` command. Alternating files go to shards 1 and 2. Each shard uses two test workers.
- Shard 1 also runs the existing type check, release validation, build, security audit, complete Linux recovery sequence, and hosted archive retention.
- Shard 2 runs the other half of the tests. Both runners install locked dependencies. A failure on either runner fails the workflow.
- The ordinary `npm run quality` command and the canonical release workflow remain unchanged.

The workflow runs on pushes to `perf/frontend-verification-pass`. Its manual dispatch becomes available when GitHub registers the workflow on the default branch. Do not merge or deploy solely to enable that dispatch.

## Evidence

Each shard retains its exact source commit, repository, GitHub run and attempt, complete test inventory, selected files, unfiltered test command, TAP counts, duration, and log digest. Runner capacity and phase outcomes are retained alongside it. The build artifact has explicit measurement-only metadata and SHA-256 bindings.

A valid comparison requires both successful jobs from the same exact source/run/attempt, both distinct shards, matching complete inventories and exact partitions, all required phase outcomes, and verified log and artifact bytes. Existing platform-dependent test skips remain visible in TAP counts; the workflow adds no test filters or skips.

The helper's `validateShardReceipts` validates receipt structure, identity, partition and test/non-test results. Collection must additionally authenticate the GitHub job/artifact records, verify the actual log digests, and check recovery and packaging outcomes. These measurement receipts are deliberately not canonical delivery receipts.

## Timing boundary

Compare the critical path of both jobs, including queue, checkout, installation, checks, recovery, and retained artifacts. Count parallel time once. Report test time separately from workflow time; source publication and release publication are separate costs.

A faster CI result alone does not prove a 5–10-minute development-to-live update. Initialization, artifact preparation, publication, installation, Assistant/browser acceptance, and coordination still need to fit that total budget. Keep the baseline release deferred until measurements support that budget; integrating sharded evidence into release admission is a separate change.
