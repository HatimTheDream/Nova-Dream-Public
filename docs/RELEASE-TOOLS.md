# Release planning and coordination tools

Stage 3 adds receipt-backed local preparation, described below. Stage 1 implements read-only evidence planning and a Linux host observer. Stage 2
adds a durable local coordinator around one normal controller installation
request. Only that installation dispatch and observation are integrated. CI,
packaging, signing, feed publication, full rehearsal and retention continue to
use their existing helpers and exact receipts; this is not a second installer.
The maintained controller still owns admission, recovery and installation.
These tools do not replace required quality, signature, capacity or recovery
checks, and they do not add a new owner-confirmation step to an authorized release.

Run commands from the application root, with its supported Node and dependencies:

```sh
npm run release:plan -- PLAN_JSON
npm run release:observe-host -- CONTROLLER_CONFIG
```

The observer requires Linux root and the provisioned controller configuration.
When `sudo` does not inherit Node's path, use the installation's configured
absolute app Node executable with `scripts/release-observe-host.mjs`; do not
guess a runtime executable or service name. Both commands print JSON to stdout.
Use direct `node scripts/...` invocation when capturing stdout as a JSON file,
because npm also prints command banners. The caller retains evidence outside
source control. The planner and observer do not persist their own journals; the
coordinator below does.

Planner exit codes: `0` means evidence is complete or the exact operation is
complete with fresh installation and reply acceptance; `2` means an incomplete
operation with missing, stale or unknown evidence; `1` means invalid input/resume
history. Inspect `evidenceComplete` and `operationComplete` separately. Exit `0`
does not authorize another installation or bypass live validation. The observer
reports `status: "observed"` or `"unknown"` in its receipt; a successful CLI exit
does not imply complete observation or deployment readiness.

## Host observation

The observer reads bounded, protected configuration and journal files, resolves
the configured `agentDirectory` as the OpenClaw package itself, and performs only
fixed loopback GETs for health and access context. It emits whitelisted metadata,
never arbitrary configuration, job messages, credentials or response bodies.

Its format-1 receipt includes timestamps, source hashes, health/candidate,
`workspaceEpoch`, `runtime.agentVersion`, available disk bytes, the journal's
explicit `currentId`/`currentJob`, bounded recent jobs and operator lease state.
`latestRecordedJob` is descriptive and never substitutes for `currentJob`.
Sources are rechecked; health/candidate and workspace identity are observed
before and after. Detected changes or unreadable sources yield unknown status.

This is explicitly non-atomic. It does not establish a fresh native heartbeat,
cleared maintenance, saved-work acceptance, or capacity fit. The controller field
is `not-observed`; its null hold field is not a clearance receipt. Disk bytes
alone leave capacity unknown. A live snapshot can change after collection.

## Plan input and evidence

The strict exported schemas in `scripts/release-plan.mjs` are the contract:
`releasePlanInputSchema`, `releaseOperationSchema` and `releaseTimelineSchema`.
The input contains `format: 1`, `operation`, `evidence`, `timeline`, and optional
`previousReport` and `remainingEstimates`. File references have this shape:

```json
{"path":"evidence/synthetic-receipt.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

That is an illustrative reference, not real evidence. Paths resolve relative to
the plan input. Reads are bounded, reject redirected paths, and verify exact
bytes. No referenced field is interpreted as a command. Keep real host receipts,
logs, backups and private records out of both source repositories.

| Phase | Reference keys | Main binding |
| --- | --- | --- |
| `private-ci`, `public-ci` | `receipt`, `log` | Exact repository/source, successful quality and Linux recovery jobs, log hash |
| `package` | `review`, `bundle` | Both source commits, candidates, app archive and maintained helper hashes |
| `capacity` | `observation` | Workspace/prior candidate/runtime and measured lifecycle components |
| `recovery` | `observation`, `review`, `proof` | Exact full rehearsal, prior identity, helper set, original return and settled release |
| `publication` | `receipt`, `feed`, `publicKey` | Ed25519 signature, freshness/sequence, exact bundle and paired publication/readback |
| `installation` | `observation`, `result` | Exact completed job, prior/candidate/workspace, saved-work checks and observed controller release |
| `acceptance` | `receipt`, `observation` | A genuine saved Assistant reply bound to the exact installation |

Each phase reports `passed`, `missing`, `stale` or `unknown`. Local bytes and
receipt consistency do not independently authenticate the origin of every
receipt. Existing live verification remains mandatory. After exact installation
and fresh acceptance pass, earlier capacity/recovery observations can be shown
as historical while retaining their original state and reason. This does not
prove that the installer consumed those exact old observation hashes. Distinguish
`operationComplete` from `evidenceComplete`: historical display never grants new
admission or makes an old observation fresh.

## Canonical CI application archive

After the Linux quality and recovery checks pass, the quality workflow packages
that existing build with `scripts/update-app-archive.py` and retains the archive,
archive metadata and `ci-source.json` for seven days. It does not run another
build or quality gate. `scripts/retain-ci-candidate.py` requires the exact CI
commit, unchanged tracked source and qualified Linux Node toolchain. The receipt
binds the candidate, package lock, archive, source, run attempt and packaging
helpers. Only candidate-listed application files and reviewed host entrypoints
enter the archive; local workspaces, keys, operational records and dependencies
are excluded by the maintained archive contract.

Download the artifact from the exact authenticated repository/workflow/run and
verify that run's source and successful checks independently. Recheck the receipt,
archive hash, member contract and candidate after download. A receipt stored next
to an archive is not independent proof of its origin, and a CI archive is not
recovery qualification, a signed offer or permission to bypass installation
gates. Each repository retains its own separately built evidence.

## Draft, freeze and resume

A draft uses `stage: "draft"` and null target candidates, source commits, bundle
or helper hashes until those identities exist. Known prior candidate/workspace
and runtime intent remain explicit. Never fill missing identities with fixture
hashes to get a pass. A draft cannot become ready for delivery.

For standalone planner resume, supply `previousReport` with its exact path/hash. Only previously
unknown draft fields may become known; known identities cannot change. Freezing
requires the candidate/source/artifact/helper fields. A frozen operation cannot
silently become a different release. Evidence is rechecked, not trusted merely
because an earlier report said passed.

## Durable coordinator

Choose an absolute, private journal directory outside all Git repositories and
OneDrive roots. A new directory is created with private permissions; an existing
directory must already meet the checks. POSIX requires owner-only access. Windows
uses a protected ACL restricted to the current owner, SYSTEM and Administrators;
redirected paths or unexpected access are rejected. Keep this directory and its
SQLite/WAL state together. Do not delete it to retry an uncertain request.
Local reservation serialization applies only to operations using the same
`release.sqlite` journal. It does not globally coordinate separate journal
directories, operator rehearsals or retention work. The host controller remains
the shared authority that rejects conflicting host operations.

Actual command forms are:

```sh
npm run release:coordinate -- init JOURNAL_DIRECTORY DESCRIPTOR_JSON
npm run release:coordinate -- status JOURNAL_DIRECTORY OPERATION_UUID
npm run release:coordinate -- plan JOURNAL_DIRECTORY OPERATION_UUID
npm run release:coordinate -- checkpoint JOURNAL_DIRECTORY OPERATION_UUID PLAN_JSON
npm run release:coordinate -- resume JOURNAL_DIRECTORY OPERATION_UUID
```

`init` stores a frozen descriptor and first checkpoint. Reinitializing the same
identity is permitted only with the same descriptor. `status` reads retained
state; its stored plan is historical. `plan` rechecks the current checkpoint's
evidence without changing the journal. `checkpoint` appends a new plan input and
report with unchanged operation identity and preserved timeline. The coordinator
owns the previous report chain, so its inputs must omit `previousReport`.

`resume` is the effectful command. It first requires all preparation phases and
overrun reviews to pass, then transactionally reserves one local installation
intent and idempotency key. Its fixed adapter stages the reviewed request helper
and root-private operation record, then requests the maintained controller once.
Every later resume only observes that original request, including if a crash
occurred between reservation and dispatch. An absent job or lost response stays
uncertain; it never permits an automatic resubmission or a replacement key.

The request helper independently checks the exact available offer, live prior
identity, real fresh app heartbeat and released full rehearsal. It reserves a
synced, exclusive host intent before its single install POST. Observe mode makes
no install or feed-check request. A helper invocation is bounded to 60 seconds;
the transport timeout bounds the client connection, not the controller worker.
Neither timeout cancels an installation or recovery already running.

A terminal controller job is not full release acceptance. Add genuine
installation and saved-reply receipts with `checkpoint`, then inspect `plan`.
The target build/schema/API still need acceptance against the actual running
app. Coordinator exit success means the command returned a report, not that the
release passed; inspect the intent, plan and uncertainty fields. Rejected input,
storage or evidence produces a bounded error and exit `1`.

### Descriptor and adapter records

`releaseCoordinatorDescriptorSchema` in `scripts/release-coordinate.mjs` is
strict: `{format: 1, input: PLAN_INPUT, adapter: {transport: REF, installSpec: REF}}`.
`input.operation.stage` must be `frozen`. Both adapter references are ordinary
path/SHA-256 references; relative descriptor reference paths resolve beside the
descriptor. Required rehearsal review/proof references must already exist.

The transport JSON follows `releaseTransportSchema` in
`scripts/release-adapters.mjs`: `format: 1`, a restricted `hostAlias`, and
`sshConfig: {path: ABSOLUTE_PATH, sha256: HASH}`. The field name is `path`, and its
value must be absolute. The exact SSH configuration bytes are hashed, not merely
the alias string. No record accepts a shell command, executable, alternate
controller socket or arbitrary network URL. Actual connection records remain
private and are never committed as examples.

The strict `releaseInstallSpecSchema` contains:

```text
format, operationId, candidateId, priorCandidateId, workspaceEpoch,
version, buildVersion, priorVersion, priorBuildVersion, schemaVersion, apiVersion,
agentVersion, priorAgentVersion, bundleSha256, rehearsalLeaseId, rehearsalProofSha256
```

These fields must agree with the frozen operation and exact rehearsal receipts.
The coordinator generates and persists `idempotencyKey`; the adapter adds it to
the root-private host operation. Do not put a guessed key in the install spec.
The adapter binds its helper bytes, transport and spec hashes before dispatch or
observation. Changed adapter identities are rejected rather than silently used
for a pending operation.

## Capacity and time

Capacity requires measured `freeBytes`, `candidateBytes`, `snapshotCopyBytes`,
`independentRestoreBytes`, `startupGrowthAllowanceBytes`, `nativeMigrationBytes`, `managedCompanionBytes`, `metadataOverheadBytes`,
`reserveBytes`, `allowanceBytes`, and an `online` or `closed` lifecycle. Snapshot
delta and metadata overhead must be explicitly measured. The minimum reserve is
1536 MiB. `allowanceBytes` is the **aggregate of both 128 MiB allowances**, at least
256 MiB; do not halve it or count it twice. `nativeMigrationBytes` must explicitly
include native migration storage, or be zero for a same-engine release. Missing
or negative components block the plan. Expected cleanup reclaim is excluded.
Even a passing calculation does not replace stopped and post-start checks.

The recovery helper collects allocation inputs during its fresh, stopped
workspace inventory. It counts each regular-file inode once and budgets both
copied directory/link layouts, the exact serialized snapshot manifest, protected
configuration copies and verification records. `allocationEstimateKind` is
`fresh-input-upper-bound`: directory packing and link allocation are conservative
estimates from current filesystem measurements, not a claim to know the exact
future disk allocation. Copy allowances and the operating reserve remain.

Normal installation and operator rehearsal add their migration or startup costs
to that same admission plan before creating the recovery directory. The previous
generation must be on the same measured filesystem for link-based savings to
apply. A shortage rechecks the stopped original before allowing an unchanged
restart. Successful copies still require full content, metadata, sparse-file and
independent-inode verification; no earlier release's inventory is reused.

`snapshot-verified.json` records component durations under
`timingsMilliseconds`. These timings explain the measured snapshot operation;
they do not include all preparation, maintenance, startup or functional
acceptance. Removing duplicate scans does not by itself establish a total
release-time guarantee or qualify skipping a full runtime rehearsal.

Preserve the original ETA, start time, forecasts, missed deadlines and reviews.
Append revisions and pass the previous report to detect history resets. Refresh
at phase changes, material new information and within five minutes during long
work. Unknown remaining estimates remain unknown. Parallel preparation uses the
longest parallel branch; subsequent serial phases add together.

An overrun produces a review requirement; two misses on an unfinished step flag
new attempts for suspension. The coordinator rejects a new installation
reservation while those review/suspension conditions remain. There is no
automatic watchdog or scheduler. It does not cancel an active restore, replay an
uncertain operation, or pause another process. Observe/reconcile the original
operation and follow the maintained recovery procedure.

Focused checks: `node --test tests/release-plan.test.mjs tests/release-observe-host.test.mjs tests/release-coordinate.test.mjs tests/release-adapters.test.mjs tests/release-command.test.mjs`.
The requester's standalone check is `python3 -B tests/release-install-request.test.py`.
The fixtures are synthetic and do not exercise a live deployment.
`managedCompanionBytes` is a required separate component, zero only when no managed installation is expected. For the reviewed 9.8 runtime use the documented conservative estimate; never merge it into native SQLite migration space or treat it as an enforced ceiling.

## Operating protocol for implementation and delivery

Record the requested outcome, smallest scope, risk class, meaningful checks and
delivery route in the existing task record. Use current authorization and keep
technical verification separate from an owner-confirmation flow. Documentation
and protocol changes receive diff/link/sanitization checks without an application
version bump, package or live installation. Inspect CI/publication side effects;
a supported documentation-only CI skip is eligible only when repository policy
permits it and the exact commit contains no executable, dependency, manifest or
workflow changes. It never waives a required check. See
[GitHub's skip behavior and required-check limitations](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

Before expensive preparation, make one lightweight preflight of the configured
route, authorized access, authenticated artifact downloads, capacity across
runtime/recovery/companion/cache/temp filesystems, compatible rollback and the
required browser-control surface. Discover paths from maintained configuration;
reconcile an uncertain job or already completed purchase before another effect.
Refresh mutable prerequisites before maintenance. An early feasibility check
does not replace fresh closed/admission checks or new-candidate acceptance.

Inspect retained SQLite databases only in a private, verified scratch copy of
the complete database/WAL/SHM family. An in-place `mode=ro` connection can change
SHM bookkeeping; a database-only `immutable=1` read can omit WAL content. Preserve
the original hashes, diagnose any mutation and keep failed evidence intact.
Never silently repin a manifest or weaken a recovery check to repair a diagnostic.

For runtime, dependency, startup, schema, updater or recovery changes, qualify the complete
retained-state verifier after actual settled startup on supported isolated copies
before source freeze. Include relevant first start, restart and existing-state
behavior, generated paths/process leases, machine-policy/database changes and
account/permission preservation. Synthetic database migrations and pre-start
copies alone cannot certify settled startup. Allow derived changes only through
narrow official contracts with refusal tests. Keep private fixture data outside
source and published CI artifacts. The fresh post-freeze rehearsal, independent
recovery verification and live acceptance remain separate gates.

Before a temporary recovery adapter runs, record and independently review its
call contracts against the maintained sequence: method/source reference, phase,
arguments and downstream attributes, input receipt, output and mutation boundary.
Preserve full pre-start native/configuration equality and full settled post-start
derivation. Generated session bindings can be stale before restart; derivation
against the store is required after startup regenerates them, with the protected
key, verified Node/app identities and closed startup window. Keep both checks.

Pass the complete exact-host read-only plan through execution's preflight before
any rename, start, switch or hold release. Metadata probes and synthetic tests
alone do not certify it. Preserve the plan's code, review and log; bind a separate
execution intent to their hashes and recheck mutable roles, configuration and
selected dependency closure before dispatch. Changed relevant inputs invalidate
the plan. Diagnose retained SQLite only through maintained complete-family scratch
copies with source identities checked before and after.

Use an explicit finite timeout, `Restart=no` and one exclusive intent/unit for
long recovery workers. The current one-shot route uses `TimeoutStartSec=3600`;
verify the effective timeout, which systemd may display as `1h`. Observe uncertain
dispatches rather than replaying them. Qualify and package exact frozen Git-blob
bytes; record newline normalization separately and never substitute changed bytes
under a historical hash. A held app's verified restoration takes priority over
new delivery work. These are operator requirements; automatic enforcement is
separate work until implemented and tested.

The reviewed first neutral-policy publication for the 2026.9.6-to-2026.9.8
transition does not qualify refresh of an already-existing policy timestamp.
The pending 2.2.3 candidate implements focused-tested existing-policy timestamp
and physically attested catalog-copy checks. Complete actual copy/restart
qualification, canonical CI, fresh automatic rehearsal and live acceptance before
claiming delivery; partial/manual evidence and documentation alone do not do so.

Keep one operation record linking immutable source/helper/artifact and receipt
hashes, candidate lineage, actual external job/key, phases and original ETA
history. Handoffs refresh drift-prone state without recreating the operation.
Derived receipts identify their original source and field mappings. Keep genuine
saved backend reply proof separate from actual browser visibility/reload proof.
A browser timeout resumes observation of the existing conversation, not another
installation or model submission. A blocked helper or security alert needs
bounded diagnosis; exact command/event attribution stays unknown until evidenced.
Use the supported route and preserve the working app, protected journal and
recovery evidence instead of repeating an unchanged blocked action or bypassing it.

Estimate and report total request time, development/preparation, rehearsal hold,
installation observation, acceptance and closeout separately. Count concurrent
branches once. File mtimes and sampled health are not exact downtime; an absent
send/hold timestamp stays unknown. Record each missed deadline review with its
actual time/location; local records cannot be described as journal writes.
Once checks pass, reuse exact evidence for one focused final audit and close
task-owned QA resources. Expired historical admission receipts do not require a
new live rehearsal solely to close an already verified completed job; they also
do not authorize a next installation.

The delivered coordinator integrates normal installation dispatch/observation
and persists issued timeline checkpoints. Broader preparation/publication
adapters, generated closeout, automatic checkpoint scheduling and a faster whole
release path remain future engineering. Prefer eliminating failed candidates
and repeated manual coordination before optimizing minor scan costs. Keep the
existing quality, signature, capacity, compatibility and recovery gates until a
tested implementation qualifies a replacement.

## Receipt-backed preparation

Run `npm run release:prepare -- PREPARATION_JSON`, or use
`node scripts/release-prepare.mjs PREPARATION_JSON` for clean JSON stdout.
This local read-only command removes manual log-filename reconstruction and
reference hashing from the preparation handoff. It uses the existing bounded
reader and planner rather than another installer or recovery engine.

The strict `releasePreparationInputSchema` in `scripts/release-prepare.mjs`
defines a format-1 input with a frozen `operation`, original `timeline`, optional
`remainingEstimates`, and these producer references:

| Field | Input and binding |
| --- | --- |
| `ci.private`, `ci.public` | Raw hash-bound CI receipts; each matching quality job records its exact adjacent `logFile` and `logSha256` |
| `package.review`, `package.bundlePath` | Raw package review and the operator bundle; its digest comes from the review |
| `dependencies.metadata`, `dependencies.archivePath` | Raw dependency metadata and archive; the complete metadata must match the reviewed pair inside the bundle |
| `assets.receipt`, `assets.directory` | Optional authenticated download receipt and explicit local directory; only its recorded safe filenames are read, with exact hashes and sizes |
| `staging` | Optional raw protected-staging receipt, bound to the exact bundle/dependencies, download proof and recorded destination |

Receipt references use the existing `{ "path": "...", "sha256": "..." }`
contract. Relative paths resolve from the input file. CI logs resolve adjacent
to their producing receipt. The first slice accepts the established `/var/lib/nova-update/staging/<bundle-hash>`
destination; a custom staging root remains unsupported and blocks preparation.
This command does not scan directories or open remote paths found in receipts. The inherited archive reader caps each file at 128 MiB, so a larger otherwise
valid dependency archive blocks this slice rather than bypassing the reader.
Missing, ambiguous, changed, oversized or redirected inputs produce preparation blockers. Retain raw host bytes and their
hashes: formatted display JSON cannot substitute for the producer's receipt.

Output contains a planner-compatible `plannerInput`, its evaluated `plan`,
verified immutable references, producer identities and concrete `blockers`.
A `prepared` result means local CI/package/dependency/download/staging evidence
matches. Omitting downloads or staging permits an intermediate report, but
keeps preparation blocked. Exit codes are `0` for prepared, `2` for blocked,
and `1` for invalid input. Rerunning reads the same evidence without initializing
or changing a journal, staging files, signing, publishing or dispatching.

`installationAuthorized`, `effectsDispatched` and `automaticReplayPermitted`
remain false. The generated planner input contains only immutable CI/package
phases; the original timeline remains intact. This does not manufacture fresh
capacity, a rehearsal, a publication receipt, installation or UI acceptance.
Origin authenticity and current protected host state still require the
maintained delivery checks. Keep real input packets and output outside source
control; they may contain private operational paths.

Preparation automation is one implemented slice. A complete release command and
a qualified frontend delivery path with a roughly 30-second final interruption
remain future work. Measure preparation, interruption and acceptance separately;
a target duration does not permit removing recovery or startup checks.
