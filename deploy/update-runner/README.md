# Reviewed application and agent installer

`install.py` and `recovery.py` implement the Linux delivery procedure used by the external updater. They support application updates with OpenClaw **2026.9.2** or **2026.9.6**, and the reviewed **2026.9.2 → 2026.9.6** upgrade. Nova's dependency lockfile and workspace schemas **53/55** stay unchanged. Other engine or schema transitions require a separate review and rehearsal. The installer never runs package installation, removes prior releases, or prunes backups.

Engine updates carry a separately signed, bounded `runtimeBundle` and a `runtime` record in `reviewed-pair.json`. The complete offline archive includes `node/bin/node`, production `node_modules`, `package.json`, and `package-lock.json`. The record pins archive bytes, SHA-256, expanded bytes, file count, Node version and Node binary hash. Root-owned `agentDirectory` and `agentNodePath` selectors choose the immutable package and engine-only Node runtime; Nova and the controller retain their existing Node runtime. The app's `E3_OPENCLAW_ENTRY` and `E3_OPENCLAW_NODE` must use those stable selectors.

One request installs the complete signed pair. An engine-only update may retain the application candidate, so requests and durable receipts also capture `releaseId` (the application bundle hash). Availability, idempotency, staging and verification distinguish successive engine releases with the same Nova version. Runtime archives are streamed independently; only GitHub's exact public release CDN redirect is allowed, and every downloaded byte still requires the signed length and hash.

For 9.6, the closed native stores migrate from agent/shared schemas **19/15** to **23/18** under native maintenance leases. Capacity includes the replacement runtime and native migration temporary space in addition to independent restoration and operating reserves. Original transcript and embedding contents must survive their format conversion; migrations that would discard ambiguous workshop records are rejected. Failure restores the saved workspace and both runtime selectors before restarting the previous pair. Synthetic fixtures are insufficient: rehearse the exact official runtime and retained-data checks before publishing its signed package.

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

The recovery root and its ancestors must be owned by root and not writable by the app account. Keep them outside an app-owned home directory; do not change that home directory's ownership to satisfy updater checks. When retaining an earlier closed snapshot in a new protected recovery root, preserve its full manifest, acceptance, content and metadata and verify that no regular file shares an inode with the live workspace. Preserve the original snapshot.

The baseline must be a root-private closed snapshot with `workspace/`, `acceptance.json` identifying the installed candidate, and `snapshot-verified.json` authenticating `snapshot-manifest.json` (or the older `linked-snapshot-source.json`). It must remain separate from live workspace files. The driver compares every snapshot byte and relevant metadata before reusing unchanged files. After an accepted update, a protected `latest-update.json` selects the next verified baseline; no recovery folder is deleted or replaced.

App releases, recovery and workspace must reside on the reviewed filesystem. Capacity must cover the expanded candidate, changed snapshot files, a full independent restoration, **1.5 GiB** operating reserve and two **128 MiB** allowances. The same capacity is rechecked with the service closed. No activation is used as a capacity probe.

## Frozen package

Create an explicit flat directory with these four files:

- `install.py` and `recovery.py`, copied from these reviewed sources.
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

Optional `startupBarrier` in `reviewed-pair.json` supports recovery when the newly started app is alive but unresponsive. It is an explicit publisher attestation of the reviewed startup contract:

```text
startupBarrier = { format: 1, prior: { artifactPath: sha256, ... }, target: { artifactPath: sha256, ... } }
```

Each mapping must include the candidate manifest hashes of `dist/service/apps/service/http.js`, `store.js`, `software-updates.js`, `runtime.js`, `gateway.js`, `update-maintenance.js`, `update-native-startup.js`, and `update-native-idle.js`. All paths are complete manifest paths. Review both actual source contracts before making this attestation: the app establishes the root journal hold before constructors/dispatch; an unavailable controller remains held; a held native startup rejects unknown recovery work and autonomous sources before spawning; and gateway effects cannot bypass maintenance admission.

For an unresponsive app, this attestation is checked against the full candidate’s verified bytes, the exact controller job hold, the service’s actual new process start identity, Node executable, selected working directory, and its initial fixed update-socket environment. Environment contents are never logged. A generic version number is insufficient. Without this proof, an unresponsive active process is preserved under a failed hold instead of being assumed idle.

## Acceptance and recovery

The local owner-session-only `GET /api/software-update/acceptance` must return the exact `candidateId`, `epoch`, `heldFor`, `maintenanceHeld`, `nativeSuspended`, and `blockers`. Before stopping, both app and controller must hold the same job, native suspension must be current, and blockers must be empty. The fixed loopback API must also show the expected app/schema, actual ready OpenClaw version, model access, and retained account identities/scopes/states.

The driver snapshots only after the owning service and its process group are closed. It verifies every saved database’s full entity, history, blob, reference, request-receipt and metadata rows; domain/account service records remain exact except updater lease and narrow transport token refresh records. Native SQLite shared schema 15 and agent schema 19 use explicit table coverage: saved work, history, projects, skills, memories, configuration, credentials and permissions retain full original rows. Only named derived caches, process leases, boot observations and narrow reconnect timestamps may change. Unknown tables fail preflight before stopping; unchanged table definitions are checked again after startup. Old transcript bytes and search settings are retained. Before the final receipt, the app and native service remain suspended; new external effects are not admitted.

On verified recovery, an independent copy is compared with the closed snapshot and must share no regular-file inode with either backup or failed workspace. The failed workspace is moved intact into that attempt’s recovery folder. The independent prior state returns to its original absolute path, the prior app is selected, and actual readiness plus saved-state/account checks run again. If those checks cannot be proved, the original job remains held for review.

Private outputs belong beside the provided request, at `<candidate>/attempts/<jobId>/`, not beside the immutable `install.py`. A result is atomically published only after complete acceptance. A preflight failure may publish `unchanged` only if no service stop, pointer switch or workspace mutation was attempted, and fresh exact prior health and both maintenance holds can still be verified. It contains no false rollback or saved-state-verification claims. A failure after stopping but before any actual restoration remains a held failure, even if the prior service restarts.

An `unchanged` receipt includes a safe `reasonCode`: `insufficient_storage` for the explicit capacity rejection, or `preflight_failed` for other preparation failures. The controller maps those codes to user-facing text; exception messages, credentials and host paths never become a public reason.

Active native databases are selected through the same durable workspace-selection and recovery-proof contract as the app, then bound to the epoch from authenticated acceptance. Only that workspace’s canonical shared and agent stores receive the reviewed schema rules. Dormant workspace databases, nested archives, plugin fixtures and nonactive caches retain exact file bytes and sidecars; they are neither opened as active stores nor ignored. A selection change, rewritten inactive database or unknown active table fails verification.

## Verification

Run `python3 -B tests/update-runner.test.py -v`. Portable fixtures cover bounds, archive rejection, exact saved SQLite content, account/domain retention, original receipt identity, safe failure handling and native history preservation. On Linux with `rsync`, an additional real file/SQLite test verifies closed snapshots, sparse files, internal hardlinks, extended attributes and independent restored inodes, while using no real service.

Passing synthetic tests does not establish production readiness. Before signing an installable pair, perform the real reviewed host rehearsal, including service environment/protected-path qualification, held startup, readiness failure, paired restoration, retained account/history identity and no duplicate effects. The implementation has no authority to publish or install itself.
