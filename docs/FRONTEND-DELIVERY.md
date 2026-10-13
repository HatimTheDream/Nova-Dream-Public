# Compatible interface delivery

This route separates the interface loaded by a browser from the running workspace
service. It requires a full bootstrap service update before its first use. The
implementation must pass its isolated, canonical CI, recovery and live acceptance
checks before operators treat it as a qualified delivery route. A 30-second final
switch is a measurement target, not a guaranteed duration.

## Eligible changes

The format-2 `client-behavior` compatibility capsule permits browser JavaScript,
TypeScript and React source under `apps/client/src`, the client entry document,
presentation CSS and static raster image/font changes. The client transport and
identity core (`api.ts`, `client-identity.ts`, `upload-body.ts`, and
`conditional-reads.ts`) stays bound to the service. It also binds shared contracts,
service and desktop source and their complete compiled output, dependencies,
configuration, build tools, deployment workers and canonical workflows. Official
version/build metadata is normalized narrowly. Generated documentation, tests and
the existing signed stable-feed output are not application build inputs. Unknown
inputs and changed compiled service/desktop bytes require full delivery. Format-1
presentation-only capsules cannot be repurposed for this expanded route; the
bootstrap service must carry format 2 before it accepts these packages.

An interface has its own immutable ID, version and build. The backend candidate,
API, schema, workspace identity and request fence retain their actual service
values. About and Software Update distinguish interface and service versions when
they differ. Open windows keep their asset namespace; a new document loads the
selected interface. A compatible interface update shows a nonblocking refresh
notice. Delivery never reloads windows automatically or replays work. A changed
backend candidate continues to use the separate stale-client protection.

## Prepare and sign

Use the exact successful canonical Linux CI run and its retained application
archive. Authenticate the download, verify the source/run/archive identities and
record the approved raw `ci-source.json` hash. An arbitrary local receipt is not
independent evidence of CI provenance.

```text
node scripts/frontend-package.mjs package-retained EXTRACTED_SOURCE BASE_SERVICE ORIGINAL_APP_TGZ CI_RECEIPT APPROVED_RECEIPT_SHA256 NEW_OUTPUT HTTPS_ARTIFACT_URL SEQUENCE EXPIRES_AT
node scripts/frontend-package.mjs sign MANIFEST EXTERNAL_PRIVATE_KEY TRUSTED_PUBLIC_KEY NEW_SIGNATURE PREVIOUS_MANIFEST_OR_initial [PREVIOUS_SIGNATURE]
```

The producer writes a complete frontend archive and manifest into a new external
directory. The separate `frontend-stable` channel starts at sequence 1 and advances
from the previous verified raw manifest and detached signature. It uses the
existing external Ed25519 release identity; it creates no key and publishes
nothing. Signing is not deployment qualification.

## Protected worker

The provisioned Linux root worker reads a protected configuration with exact
`frontendDirectory`, `stateDirectory`, `controlSocket`, existing Node binary/hash,
trusted public key/hash and artifact origins. The fixed public assets root is
`/opt/nova/frontend`, operation state is `/var/lib/nova-update/frontend`, and the
root-only socket is `/run/nova-update/frontend.sock`. Assets and the public key
must be readable by the service but writable only by root. Private operation
records remain root-private, outside workspace data.

Launch only the frontend worker process with an explicit `0022` umask so its
public directories and files retain the requested `0755` and `0644` modes.
Private state and journal paths explicitly remain `0700` and `0600`. Keep the
application and updater umasks unchanged, and verify asset and public-key reads
as the actual service UID; a root-only check does not prove service access.

A promotion operation is `{format:1,operationId,manifestPath,signaturePath,archivePath}`.
A deliberate rollback is a **new** operation `{format:1,operationId,rollbackOf}`
bound to the exact completed journal in the configured state directory. Capture
the read-only plan and a separate intent binding its raw hash and the operation's
raw hash before execution.

```text
python3 -B deploy/update-runner/frontend.py --plan OPERATION --config CONFIG
python3 -B deploy/update-runner/frontend.py --execute OPERATION --config CONFIG --plan-receipt PLAN --intent INTENT
python3 -B deploy/update-runner/frontend.py --resume OPERATION --config CONFIG
```

Preparation verifies the signature, compatibility, admission period, monotonic
sequence, every archived path and every asset byte before acquiring exclusion.
The durable controller lease prevents service installation and operator
maintenance while keeping workspace writes and native work running. Selection is
one fsynced atomic file replacement. Preserve all old assets for open windows.

Lost acknowledgements and interrupted switches reconcile the same journal and
lease. Fence a before-begin interruption with the controller's durable cancellation
record; never replay an uncertain begin. An observed admitted lease may finish
through the same idempotent end after exact selector and service checks. Do not
replace operation identities or delete uncertain evidence. Explicit rollback restores only the recorded prior selector, retains the
channel high-water mark and uses a new lease. It does not restore a database,
restart a service or remove recovery roles.

## Acceptance and timing

Before qualification, exercise real signatures and protected Linux files, lease
exclusion, crashes, controller restart, expired installed assets, old lazy chunks,
encoded document-path refusal and exact rollback. Bootstrap retains the full
settled saved-state verification, rehearsal, installation and browser/Assistant
acceptance route. Eligible asset delivery then checks unchanged backend process,
candidate and workspace identity, old-window assets, new-document identity,
retained writing/request envelopes and actual browser acceptance.

Report development, preparation and the final selection/acceptance interval
separately. Refresh mutable health, operation and capacity facts immediately before
the switch. Record the measured duration and unresolved limitations honestly.
