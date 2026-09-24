# Managed Software Update host

Settings → General → Software Update checks a curated, signed release feed. The install action identifies the exact reviewed Nova/OpenClaw pair. A GitHub source release alone is not an installable update. There is no automatic installation or unattended publication.

The current host support is a separately provisioned Linux root service. Its Unix socket is local only; it has no TCP listener or public HTTP endpoint. Windows/local companion delivery and arbitrary externally managed Gateways are outside this route. An unconfigured or incompatible host reports that updates are unavailable; it does not report “Up to date.”

## Provisioning boundaries

Install the frozen updater code and its production dependencies separately at `/opt/nova-updater`. Keep it outside the application’s selected release, workspace, and all rollback copies. Build `dist/service` first. Every updater executable, script, dependency, and containing directory must be owned by root and not writable by group or others. Dependency links must stay inside that installation. The launcher verifies these permissions before importing updater modules.

Use the example `deploy/nova-update.service` after adapting the local Node binary location. It uses `flock` to hold `/run/nova-update/host.lock`, runs as root with group `nova`, and creates the protected runtime directory. The sole socket is `/run/nova-update/control.sock`, owned by root with group `nova` and mode `0660`. Add only the Nova workspace service account to that group. Group membership can request an exact signed update and report workspace barriers, so it must not be given to unrelated services or login users.

The root configuration and public verification key live outside releases and workspace backups. The controller does not read the server credential, provider tokens, account files, or workspace databases. Provision these directories and a root-owned `/etc/nova-update/config.json`:

```json
{
  "format": 1,
  "socketGroup": "nova",
  "stateDirectory": "/var/lib/nova-update",
  "workspaceDirectory": "/var/lib/nova/workspace",
  "releaseDirectory": "/opt/nova/releases",
  "runtimeDirectory": "/opt/nova/runtime",
  "appCurrent": "/opt/nova/current",
  "agentDirectory": "/opt/nova/runtime/openclaw/node_modules/openclaw",
  "feed": {
    "url": "https://updates.example.org/nova/stable.json",
    "publicKeyFile": "/etc/nova-update/release-public.pem",
    "channel": "stable",
    "artifactOrigins": ["https://updates.example.org"]
  }
}
```

These addresses and paths are illustrative. Provision a real fixed HTTPS feed and its independently trusted Ed25519 public key. The controller does not automatically trust a key included with application source. Only the public key belongs on the workspace host. Keep its private signing key offline or in a separately protected release environment.

`appCurrent` must be a root-owned direct symlink to a protected immutable candidate beneath `releaseDirectory`. Its selected package, complete candidate manifest, and every candidate artifact are verified using `scripts/candidate.mjs`. `agentDirectory` is the protected physical OpenClaw package beneath `runtimeDirectory`; the controller reads its actual package version and checks the entry file. It does not substitute an upstream advertised engine version. The reviewed runner must independently verify live service readiness against these selected paths.

Set `E3_UPDATE_SOCKET=/run/nova-update/control.sock` in the Nova workspace service environment and restart that service after provisioning. Do not expose the Unix socket through a public reverse proxy. An unavailable controller or uncertain installation result must retain the workspace maintenance hold and original job identity until reconciliation.

The journal under `stateDirectory/jobs`, signed feed cache, staged bundle, request, private runner log, and result are deliberately outside workspace recovery. Do not delete these to retry an uncertain job. Restarted controllers reconcile an already started runner; they do not launch it again. A corrupt journal or verification cache requires operator review. The service unit leaves a running reviewed installer intact if the controller alone restarts; the durable original request continues to identify that attempt.

## Reviewed bundle

An update bundle is bounded JSON with at most 64 flat regular files and a total encoded limit of 128 MiB. It contains a fixed `install.py` entry and its reviewed frozen helpers. Names cannot include directories; `bundle.json`, `request.json`, `result.json`, and `runner.log` are reserved. Each file has canonical base64 bytes and a SHA-256 hash. The signed release also authenticates the whole bundle byte count/hash and `install.py` hash. URLs must use a configured HTTPS artifact origin; redirects are rejected.

Prepare that directory explicitly. Packaging never invents a release runner:

```text
node scripts/update-bundle.mjs /secure/reviewed-pair /secure/output/pair.bundle.json
```

The command creates the bundle and `pair.bundle.json.metadata.json`, refuses to overwrite either finalized artifact, and prints only byte counts and hashes. Copy the returned `bytes`, `sha256`, and `runnerSha256` into the reviewed release manifest. Review the entire helper set, not only the entry file.

The fixed invocation is `/usr/bin/python3 install.py --request request.json`, with no shell. The root-written request identifies the original job, the complete verified release, and the protected host configuration. The runner owns the concrete host-specific procedure: immutable staging; storage reserves; fresh work/effect gates; closed snapshots; retaining the previous app/runtime and paired saved state; a single switch; protected account/credential preservation; bounded readiness; and independently verified paired restore if acceptance fails. It must preserve all private evidence and must not send account material through progress output.

The only accepted progress lines on stdout are JSON objects with `stage` equal to `preparing`, `installing`, `restarting`, or `checking`. They describe observed stages, not a fabricated overall percentage. The runner must tolerate a closed stdout pipe when its controller restarts; progress delivery failure cannot abandon recovery. A runner writes an atomic protected `result.json` only after acceptance or verified restoration:

```json
{
  "format": 1,
  "jobId": "00000000-0000-4000-8000-000000000001",
  "candidateId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "priorCandidateId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "outcome": "completed",
  "savedWorkVerified": true,
  "accountsVerified": true,
  "recoveryVerified": true,
  "healthVerified": true
}
```

`outcome` may instead be `restored` after verified paired recovery. These flags must reflect actual checks, including expected live candidate/version, schema, Gateway/plugins, retained records and history, account state, and prevention of duplicate external effects. Do not fabricate the file to release a maintenance barrier. Missing, mismatched, or unverified acceptance remains a held failure requiring review.

## Signed release feed

The manifest uses `format: 1`, an explicit `channel`, increasing integer `sequence`, UTC `createdAt`/`expiresAt`, and up to 32 unique releases. Validity lasts at most 31 days. The exact UTF-8 JSON payload bytes are signed with Ed25519 and wrapped as `{ "payload": "base64", "signature": "base64" }`. The final envelope must fit 128 KiB. See `updateManifestSchema` in `apps/service/update-feed.ts` for the complete strict contract.

Each release binds its 64-character candidate identity, exact source candidate, Nova and agent versions, Linux architecture/Node major, source Nova/agent versions and schema, target schema, Gateway protocol 4, matching Nova plugin version, explicit reviewed pairing, paired-snapshot and independent-restore requirements, bounded readiness timeout, short release notes, and the bundle details above. An available successor must match the host’s exact current pair and schema. A current-state claim requires the signed feed to identify the actual installed pair. Empty, incompatible, stale, failed, or unverified metadata cannot authorize installation.

An initial managed installation may instead have an entry in the optional `currentCandidates` list (at most 32): `{ candidateId, novaVersion, agentVersion, platform, arch, nodeMajor, schemaVersion, protocolVersion }`. Each value must match the actual installed host, with Linux and protocol 4 required. This signed record establishes current status without a download or an installation action. Candidate identities are unique across both lists; an installable release already describes its target pair. A compatible successor in `releases` takes precedence over current status. Initial provisioning must use the verified installed candidate identity, never a placeholder or a fabricated self-update bundle.

After building the service, sign only a reviewed manifest with an existing external private key and the provisioned public key:

```text
node scripts/update-manifest.mjs /secure/reviewed-manifest.json /secure/signing/release-private.pem /secure/signing/release-public.pem /secure/output/stable.json /secure/previous-stable.json
```

For the first channel release only, replace the previous feed argument with `initial`; sequence must be 1. Later signing verifies the previous feed with the same public key and requires a greater sequence. Changing dates or notes also requires a new sequence. The script refuses an existing output and never generates keys, prints key material, uploads files, or publishes releases. Independently review the public bytes and publish through the authorized release process.

One shared controller check serves all browsers. Successful automatic checks are spaced at least a day apart with jitter; manual checks have a minimum interval and failures back off. The cache retains signed last-good bytes, error state, highest sequence, and notification identity. Metadata is reverified after restart and before an install is admitted. Conditional HTTP responses cannot extend signed expiry.

## Verification limits

Automated fixtures exercise signature tampering, stale/offline information, compatibility, bounds, persisted checks, request receipts, maintenance holds, and simulated installer outcomes. They do not prove real cross-version OpenClaw migration, closed snapshots, credential/history retention, or paired rollback on a production host. No unreviewed engine upgrade becomes qualified by this generic controller. A real reviewed runner and exact host rehearsal are required before publishing an installable pair; the initial integration may retain OpenClaw 2026.9.2.
