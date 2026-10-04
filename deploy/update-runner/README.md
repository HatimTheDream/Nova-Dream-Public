# Reviewed application and agent installer

The reviewed Python driver and recovery helpers implement the Linux delivery procedure used by the external updater. They support application updates with OpenClaw **2026.9.2**, **2026.9.6** or **2026.9.8**, and the exact **2026.9.2 to 2026.9.6** and **2026.9.6 to 2026.9.8** upgrades. The current application schema remains **55**. Changed application dependencies require a separately signed offline closure. Other engine or schema transitions require a separate review and rehearsal. The installer never runs package installation, removes prior releases, or prunes backups.

Engine updates carry a separately signed, bounded `runtimeBundle` and a `runtime` record in `reviewed-pair.json`. The complete offline archive includes `node/bin/node`, production `node_modules`, `package.json`, and `package-lock.json`. The record pins archive bytes, SHA-256, expanded bytes, file count, Node version and Node binary hash. Root-owned `agentDirectory` and `agentNodePath` selectors choose the immutable package and engine-only Node runtime; Nova and the controller retain their existing Node runtime. The app's `E3_OPENCLAW_ENTRY` and `E3_OPENCLAW_NODE` must use those stable selectors.

One request installs the complete signed pair. An engine-only update may retain the application candidate, so requests and durable receipts also capture `releaseId` (the application bundle hash). Availability, idempotency, staging and verification distinguish successive engine releases with the same Nova version. Runtime archives are streamed independently; only GitHub's exact public release CDN redirect is allowed, and every downloaded byte still requires the signed length and hash.

For 9.6, the closed native stores migrate from agent/shared schemas **19/15** to **23/18** under native maintenance leases. Capacity includes the replacement runtime and native migration temporary space in addition to independent restoration and operating reserves. Original transcript and embedding contents must survive their format conversion; migrations that would discard ambiguous workshop records are rejected. Failure restores the saved workspace and both runtime selectors before restarting the previous pair. Synthetic fixtures are insufficient: rehearse the exact official runtime and retained-data checks before publishing its signed package.

For 9.8, native agent/shared schemas change from **23/18** to **24/19**. The agent migration moves three cold JSON fields into canonical session snapshots; verification reconstructs the exact JavaScript serialization and requires every saved value, session identity and snapshot revision. Shared identity authorization columns and worktree garbage-collection metadata must have the official nullable legacy defaults. Previously absent profile identities may become an empty canonical table; invented identities or authorization are refused. Codex **0.155.1 to 0.158.0** adds creator identity and history timestamps, with exact SQLx checksums and the official guardian presentation projection; ordinary saved writing and all unrelated fields stay exact. Pending session validity flags may settle only from zero to the official parsed valid/invalid value during the upgrade or an unchanged 9.8 restart; JSON and every other saved field remain exact. Unknown tables, columns, migration receipts or target engines fail closed. The paired pre-migration snapshot keeps the prior 9.6 schema and runtime for rollback; live version markers are never lowered to make new data appear compatible.

The source contracts are pinned to the tagged [OpenClaw 9.8 schema history](https://github.com/openclaw/openclaw/blob/v2026.9.8/docs/reference/database-schemas/state-schema-history.md), [agent schema](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/state/openclaw-agent-schema.sql), [shared schema](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/state/openclaw-state-schema.sql), and [Codex 0.158 state migrations](https://github.com/openai/codex/tree/rust-v0.158.0/codex-rs/state). Exact official producer fixtures must independently pass the maintained schema and saved-content transforms. These active-database checks do not replace full workspace, startup and paired recovery acceptance; a prepared runtime archive or synthetic expected-transform test alone is insufficient.

The host controller must already be installed, and both the prior and target app must support its maintenance and native-suspension protocol. Installing that initial update-aware app is a separate bootstrap delivery; the previous app has no one-click admission endpoint.

## Provisioning

Next to the protected controller configuration, provision `runner.json` owned by root, mode `0600`. For example:

```json
{
  "format": 1,
  "serviceName": "nova-dream.service",
  "serviceUser": "nova",
  "nodePath": "/opt/nova/runtime/node/bin/node",
  "healthPort": 4383,
  "dependencyDirectory": "/opt/nova/dependencies/node_modules",
  "recoveryDirectory": "/var/lib/nova-update-recovery",
  "baselineDirectory": "/var/lib/nova-update-recovery/before-reviewed-bootstrap",
  "workspaceKeyCredential": "/etc/nova/server.key",
  "protectedFiles": [
    "/etc/nova/server.key",
    "/etc/nova/host.env",
    "/etc/nova/vercel-proxy.key",
    "/etc/systemd/system/nova-dream.service",
    "/etc/caddy/Caddyfile"
  ]
}
```

Use the actual independently reviewed paths. The driver hashes and preserves protected files without displaying their bytes. App dependencies must be the same retained root-owned directory selected by the prior app. The real service process must inherit `E3_UPDATE_SOCKET=/run/nova-update/control.sock`. No caller can supply another command, service, server URL, or recovery path.

All code and dependency authority paths must be root-owned and must not be group/other-writable. Do not apply the historical `775`/`664` deployment modes. A private wrapping credential must also be in `protectedFiles`; retain every loaded service drop-in and external runtime target. Never normalize shared legacy dependency inodes in place.

The recovery root and its ancestors must be owned by root and not writable by the app account. Keep them outside an app-owned home directory; do not change that home directory's ownership to satisfy updater checks. When retaining an earlier closed snapshot in a new protected recovery root, preserve its full manifest, acceptance, content and metadata and verify that no regular file shares an inode with the live workspace. Preserve the original snapshot.

The baseline must be a root-private closed snapshot with `workspace/`, `acceptance.json` identifying the installed candidate, and `snapshot-verified.json` authenticating `snapshot-manifest.json` (or the older `linked-snapshot-source.json`). It must remain separate from live workspace files. The driver compares every snapshot byte and relevant metadata before reusing unchanged files. After an accepted update, a protected `latest-update.json` selects the next verified baseline; no recovery folder is deleted or replaced.

App releases, recovery and workspace must reside on the reviewed filesystem. Capacity must cover the expanded candidate, changed snapshot files, a full independent restoration, **1.5 GiB** operating reserve and two **128 MiB** allowances. The same capacity is rechecked with the service closed. No activation is used as a capacity probe.

Private SQLite verification copies use an exclusive directory on the validated recovery filesystem, rather than the system temporary filesystem. The existing capacity reserves still apply. Each reader verifies the retained database and its sidecars before and after reading a disposable copy. Scratch cleanup removes only the expected empty directory; unexpected residue is retained for review.

## Frozen package

Create an explicit flat directory with these reviewed files:

- `install.py`, `recovery.py`, `codex_log_retention.py`, `app_dependencies.py`, `workspace_key.py`, and `verify-session-bindings.mjs`, copied from these reviewed sources.
- `app.tgz`, the exact paired candidate archive containing only ordinary `dist/`, package metadata, `scripts/host.mjs`, and `scripts/candidate.mjs` files.
- `reviewed-pair.json`, binding this archive to the exact source and target candidates.

```json
{
  "format": 1,
  "candidateId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "priorCandidateId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "archiveBytes": 123456,
  "archiveSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

The values above are examples, not an installable release. Use the exact already-verified candidate and archive bytes, then run the standard `scripts/update-bundle.mjs` packaging command. Its signed manifest binds every helper and the archive. The expanded archive and whole encoded bundle each have a 128 MiB bound. Do not include private operational records or signing material.

Generate `app.tgz` with `python3 -B scripts/update-app-archive.py APP_DIRECTORY OUTPUT_TGZ --node NODE`. It admits only the built candidate, `package.json`, `package-lock.json`, and the two host entry scripts. The manual full-`scripts/` tarball is not the maintained update format.

For changed dependencies, build a fresh Linux production dependency tree outside the deployment host, then run `python3 -B deploy/update-runner/app_dependencies.py pack SOURCE OUTPUT --node NODE`. The descriptor becomes `applicationDependencies` in the reviewed pair; its archive gets a separate signed feed `applicationDependenciesBundle` entry. The complete lock hash, non-root package graph, archive length/hash, expansion/file count and exact Linux architecture, Node version and ABI are checked. The candidate must contain that exact lock. Extraction preserves executable bits, rejects unsafe links, and runs fixed native-import probes as the service account. Each release selects its own immutable closure; prior dependencies remain available for restoration. Budget both downloaded and expanded closures. The manual dependency workflow produces an Actions artifact, not a published or signed update.

When `workspaceKeyCredential` is configured, add a `helpers` mapping in the pair with exact SHA-256 values for `recovery.py`, `codex_log_retention.py`, `app_dependencies.py`, `workspace_key.py`, and `verify-session-bindings.mjs`. The raw workspace key is unwrapped only from the existing selected closed workspace through the verified prior key implementation. It travels to the single pinned binding verifier through stdin, stays out of arguments/logs/files, and is wiped from the driver's mutable buffer. The wrapping credential is not itself the raw workspace key. After startup, bindings must equal those derived from the actual selected snapshot store, with exact provenance. Other configuration stays checked. A prestart snapshot may retain stale generated bindings; they are compared exactly until startup has legitimately regenerated them.

## Read-only admission and explicit prior adoption

The controller calls `--preflight` before requesting maintenance and again immediately before starting an unstarted attempt. This mode validates protected code, retained recovery, signed archives and current candidate/workspace epoch using read-only health/access endpoints. It creates no session, hold, driver lock, attempt receipt or result. Its response must arrive within 120 seconds and match the exact expected identity. Admission is rechecked after controller restart. A started or uncertain attempt still requires authenticated result reconciliation; a preflight pass is never a license to clear it.

Legacy layouts require a separately reviewed `adoptPrior` object in the exact signed pair: `{format:1,baselineManifestSha256,dependencies,sourceDependencies,rollbackDirectoryName}`. Dependency receipts come from the maintained helper. Prepare a separate, immutable copy of the exact prior candidate and an independent dependency copy with preserved bytes/executable modes; never invent a missing prior lockfile. The rollback copy must have the same candidate and startup-script hashes and select the protected retained dependency tree. The original prior tree and its paths stay intact. Running-source capture is preparation only; both the original source and prepared copy must verify again after writers stop. Normal prior dependency/baseline requirements remain strict without this explicit review.

For adoption, an older verified snapshot is only a manifest-pinned deduplication source. Its old acceptance cannot attest current data. Before any new version switch, the driver must create and verify a complete closed snapshot of the selected current workspace, protected files and retained native state, with full independent-restoration capacity. A rollback chooses the independently adopted prior candidate only after restoring the exact current snapshot; its new verified acceptance points to that new recovery generation, never the older deduplication source. Host-specific adoption records belong in private operator delivery, not public source or QA artifacts. This contract is not proof that any particular host adoption has passed its rehearsal.

Optional `startupBarrier` in `reviewed-pair.json` supports recovery when the newly started app is alive but unresponsive. It is an explicit publisher attestation of the reviewed startup contract:

```text
startupBarrier = { format: 1, prior: { artifactPath: sha256, ... }, target: { artifactPath: sha256, ... } }
```

Each mapping must include the candidate manifest hashes of `dist/service/apps/service/http.js`, `store.js`, `software-updates.js`, `runtime.js`, `gateway.js`, `update-maintenance.js`, `update-native-startup.js`, and `update-native-idle.js`. All paths are complete manifest paths. Review both actual source contracts before making this attestation: the app establishes the root journal hold before constructors/dispatch; an unavailable controller remains held; a held native startup rejects unknown recovery work and autonomous sources before spawning; and gateway effects cannot bypass maintenance admission.

For an unresponsive app, this attestation is checked against the full candidateâ€™s verified bytes, the exact controller job hold, the serviceâ€™s actual new process start identity, Node executable, selected working directory, and its initial fixed update-socket environment. Environment contents are never logged. A generic version number is insufficient. Without this proof, an unresponsive active process is preserved under a failed hold instead of being assumed idle.

## Acceptance and recovery

The local owner-session-only `GET /api/software-update/acceptance` must return the exact `candidateId`, `epoch`, `heldFor`, `maintenanceHeld`, `nativeSuspended`, and `blockers`. Before stopping, both app and controller must hold the same job, native suspension must be current, and blockers must be empty. The fixed loopback API must also show the expected app/schema, actual ready OpenClaw version, model access, and retained account identities/scopes/states.

The driver snapshots only after the owning service and its process group are closed. It verifies every saved databaseâ€™s full entity, history, blob, reference, request-receipt and metadata rows; domain/account service records remain exact except updater lease and narrow transport token refresh records. Native SQLite shared schema 15 and agent schema 19 use explicit table coverage: saved work, history, projects, skills, memories, configuration, credentials and permissions retain full original rows. Only named derived caches, process leases, boot observations and narrow reconnect timestamps may change. Unknown tables fail preflight before stopping; unchanged table definitions are checked again after startup. Old transcript bytes and search settings are retained. Before the final receipt, the app and native service remain suspended; new external effects are not admitted.

Stopped-state comparisons read private copies of both the snapshot and current SQLite families, including workspace selection and native stores. They never open retained SQLite files through a direct connection that could change SHM files or directory timestamps. Live preflight keeps its transactional reader; the copied-reader rule applies after closure. Transcript decompression during a closed migration also reads the private copy while retaining the original path for authority and inode checks.

For application updates that keep OpenClaw **2026.9.6** or **2026.9.8**, and the exact **9.6 to 9.8** migration, a narrow exception recognizes the respective Codex **0.155.1** or **0.158.0** startup removal of logs older than **10 days**. It applies only to `logs_2.sqlite.logs`, after attesting the active selected workspace's managed npm installation, package versions and exact reviewed Codex executable hash. Migration attests the target 0.158.0 binary. First application readiness is retained as its own immutable receipt; it does not establish completion of native initialization. Before retained-state comparison, the driver verifies the same service process and maintenance authority, stops it, proves that the owning service has no remaining processes, and records a separate actual closure receipt bound to the job, candidate, engine, workspace epoch, process identity and ready-receipt hash. The start-to-closed interval must remain within the existing one-hour maximum. Normal installation, prior restoration and operator rehearsal use this same operation. Each restart receives its own attempt; intervals are never joined or extended using an arbitrary delay.

Removed rows must form the complete timestamp prefix for a cutoff within that authenticated closed interval, and every retained row must remain exact. First readiness alone cannot authorize removed rows. Missing or altered closure proof, another engine or the **9.2 â†’ 9.6** migration cannot gain a retention exception. Other tables, recent logs and per-partition log limits receive no additional exception. The verifier does not prune any records itself. Emergency stopping remains independent of whether a valid retention interval can still be recorded; a failed or expired proof must never prevent safe shutdown, nor become a successful acceptance.

Keep allocation evidence specific to the operation and phase. A complete rehearsal retains its independent trial tree while startup allocates additional data, so both costs overlap. Normal rollback stops the candidate before creating its independent restore. Neither running free space nor an older small snapshot delta proves capacity for a later candidate. Preserve the fixed operating reserve, measure the closed snapshot delta and restoration cost, and recheck after startup. A backup uploaded elsewhere does not free local storage; any authorized removal must identify the exact redundant copy after independent retrieval and verification. Live workspace files must never be hardlinked to recovery generations.

On verified recovery, an independent copy is compared with the closed snapshot and must share no regular-file inode with either backup or failed workspace. The failed workspace is moved intact into that attemptâ€™s recovery folder. The independent prior state returns to its original absolute path, the prior app is selected, and actual readiness plus saved-state/account checks run again. If those checks cannot be proved, the original job remains held for review.

Private outputs belong beside the provided request, at `<candidate>/attempts/<jobId>/`, not beside the immutable `install.py`. A result is atomically published only after complete acceptance. A preflight failure may publish `unchanged` only if no service stop, pointer switch or workspace mutation was attempted, and fresh exact prior health and both maintenance holds can still be verified. It contains no false rollback or saved-state-verification claims. A failure after stopping but before any actual restoration remains a held failure, even if the prior service restarts.

An `unchanged` receipt includes a safe `reasonCode`: `insufficient_storage` for the explicit capacity rejection, or `preflight_failed` for other preparation failures. The controller maps those codes to user-facing text; exception messages, credentials and host paths never become a public reason.

Active native databases are selected through the same durable workspace-selection and recovery-proof contract as the app, then bound to the epoch from authenticated acceptance. Only that workspaceâ€™s canonical shared and agent stores receive the reviewed schema rules. Dormant workspace databases, nested archives, plugin fixtures and nonactive caches retain exact file bytes and sidecars; they are neither opened as active stores nor ignored. A selection change, rewritten inactive database or unknown active table fails verification.

## Operator recovery rehearsal

`operator_rehearsal.py` provides a separately reviewed, root-only rehearsal without creating an installation job, changing the selected release/runtime, publishing an installer result, or rewriting `latest-update.json`. It requires the provisioned operator-maintenance controller socket and an exact private review; it is not a bypass for signed application delivery. The controller stores the independent lease durably and retains post-stop holds across restarts. Release requires hash-bound local acceptance evidence and the application's subsequent native-resume acknowledgement.

The private review pins `leaseId`, current `candidateId`/`workspaceEpoch`/versions, `hostConfiguration`, the exact old `baselineDirectory` and `baselineManifestSha256`, an independently provisioned `labParent`, the existing `startupGuardFile`/hash, reviewed prior `startupBarrier` artifacts, all `helperHashes`, `nodeSha256`, actual `sourceDependencies`, and both `sourceHostHashes`. Its `format` is 1 and `kind` is `operator-rehearsal-review`. Use actual reviewed identities, never example values. The prior engine must remain exactly 2026.9.6 or 2026.9.8 throughout its rehearsal. The complete selected workspace is captured; an older verified generation is only a pinned deduplication source.

The permanent service guard must contain `[Unit] ConditionPathIsDirectory=` for the exact configured workspace and be included in the retained protected files. The CLI verifies the effective condition through typed systemd D-Bus data. This prevents a missing workspace during a crash between renames from becoming a new empty store. The lab parent must be root-private, share the workspace filesystem, and remain outside the workspace, protected recovery, updater state, release, runtime and configuration trees. Mutable copied data must never enter the controller's recursively root-owned state directory.

```sh
python3 -B deploy/update-runner/operator_rehearsal.py --plan /protected/operator-review.json
python3 -B deploy/update-runner/operator_rehearsal.py --execute /protected/operator-review.json
python3 -B deploy/update-runner/operator_rehearsal.py --status /protected/operator-review.json
```

`--plan` performs read-only admission; it creates no session or lease and never stops a service. Review its exact inputs and full operation plan before using `--execute`. Execution acquires the real app/native hold, closes all owning processes, budgets the complete snapshot delta and independent restoration, and adds an explicit startup-growth estimate to the existing operating reserve and copy allowances. The initial fit estimate is observed held-running allocation minus closed allocation, plus 128 MiB. Each actual startup then records a separate immutable stopped allocation and free-space budget. The permitted lifecycle must prove that the full snapshot and independent trial are already allocated, or that an unchanged restart has abandoned those copies. Growth can use only actual remaining free space above the 1.5 GiB reserve and both 128 MiB allowances. Later starts use fresh baselines and remaining free space, so retained growth is not counted twice or budgeted again. Sampled growth and the free-space floor are both enforced; a refusal preserves its exact pre-stop measurement. These observations do not prove every possible future startup peak.

Before its single lease-entry request, execution rechecks the admitted source process and waits up to 45 seconds for the root controller's freshness status to change from false to true. Both qualifying replies must take at most one second and the observed transition must span at most two seconds. An initially true status alone has an unknown age; it is not enough. This observes the real app heartbeat without creating a session, checking feeds, or submitting a synthetic heartbeat. The controller still independently requires the exact candidate, workspace, idle state and heartbeat age below ten seconds when it receives entry. Slow replies cannot qualify; no observed transition before the deadline, concurrent maintenance or a refusal stops admission safely. Continuously fresh status can also time out without a sufficiently observed transition. Each socket call retains its existing five-second timeout. No expensive verification runs between the qualifying observation and the one entry request. Execution expects a fresh lease identity, not a manually pre-held lease.

The private lab retains the first `operator-request-failure.json` separately from phase evidence, with the action, HTTP status and a fixed safe reason category. Unknown bodies and transport/server failures remain uncertain; raw response text and credentials are never saved. Later status/cancel reconciliation cannot replace this original diagnostic. A lost entry response never triggers another entry request or a service stop. Only an authentic status identifying this exact candidate/workspace/lease before any stop permits the existing guarded cancellation; otherwise authority remains for review. A generic fresh-idle refusal does not by itself prove which freshness, identity or idle condition failed.

The complete current snapshot, protected configuration and existing raw-key verification path use the maintained recovery helpers. An independent restore is first checked while closed, then reopened at the original absolute workspace path under the hold. The original remains intact in the private lab. After trial comparison, the original returns, undergoes its own held-start/closed comparison, and starts once more for final readiness. Every rename has durable intent with exact root inode identities and both parent directories are synced. Successful full rehearsal produces a current baseline acceptance with explicit operator provenance, without changing the latest selector. Capacity refusal before workspace mutation can produce only narrow unchanged/health/accounts evidence; it claims neither saved-work equivalence nor a verified recovery.

Interrupted execution is never automatically replayed. `--status` reports bounded phase and physical-root evidence for manual review. Preserve the lease, original, snapshots and trial tree when any identity, startup or publication is uncertain. A release response timeout is distinct from a held failure; a cleanup failure after release must not claim the app remains held. Only the newly created trial tree may be removed after original verification and settled native release, with its exact inode and private-lab containment checked. Existing recovery generations, originals and prior releases are never deleted by this CLI.

## Verification

Run the focused suites, also required by the Linux release workflow:

```sh
python3 -B tests/update-runner.test.py -v
python3 -B tests/update-closed-readers.test.py -v
python3 -B tests/update-log-retention.test.py -v
python3 -B tests/update-startup-window.test.py -v
python3 -B tests/update-startup-lifecycle.test.py -v
python3 -B tests/update-log-retention-integration.test.py -v
python3 -B tests/recovery-native98.test.py -v
python3 -B tests/operator-rehearsal.test.py -v
```

Fixtures cover bounds, archive rejection, exact saved SQLite content, account/domain retention, original receipt identity, safe failure handling and native history preservation. Focused checks cover copied readers and recovery-filesystem scratch, exact startup log retention, attested runtime integration, and real private startup receipts with mocked service calls and clocks. On Linux with `rsync`, real file/SQLite coverage also verifies closed snapshots, sparse files, internal hardlinks, extended attributes and independent restored inodes, while using no real service. Platform-specific cases skip where their actual filesystem guarantees cannot be exercised.

Passing synthetic tests does not establish production readiness. Before signing an installable pair, perform the real reviewed host rehearsal, including service environment/protected-path qualification, held startup, readiness failure, paired restoration, retained account/history identity and no duplicate effects. The implementation has no authority to publish or install itself.
