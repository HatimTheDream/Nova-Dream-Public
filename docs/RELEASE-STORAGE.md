# Default storage admission for delivery

The normal operator command is unchanged:

```sh
npm run release:deliver -- start /absolute/private/input.json
```

It enters the configured private storage runner automatically. Put the measured
allocation budget beside the input as `input.json.storage-budget.json`, or pass
`--storage-budget /absolute/private/budget.json`. Missing configuration or budget
stops delivery with guidance; it never silently uses a zero allocation estimate
or falls back to the raw release engine.

The runner initializes the original exact-source request before lengthy storage
work, checks the actual host and protected recovery roles, performs eligible
cleanup under the configured retention policy when necessary, and delegates to
the original release journal. After accepted successor creation it performs
storage closeout. If space already fits, it performs no archive or deletion.
All maintained capacity, signature, compatibility and recovery gates still run
at their existing lifecycle points.

## Configuration

Provision `~/.codex/nova-release/storage-default.json` once on the operator
machine. `NOVA_RELEASE_STORAGE_CONFIG` can select another absolute private
configuration path. Keep it, the reviewed Python runner, review manifests,
measured budgets and resulting operation records outside both repositories.
The configuration pins the Python executable, fixed runner and independent
source review by SHA256, and specifies the private operations directory and
allowed application roots. A runner source change requires a new independent
review. Public source contains the portable command boundary and tests, not a
particular host, owner's paths, signing key or retention evidence.

The private runner owns storage policy, measured per-filesystem allocation
checks and narrowly qualified cleanup. Provision it with the deployment target;
this source repository does not invent a storage policy for an unknown host.

## Interrupted operations and legacy commands

```sh
npm run release:deliver -- status /absolute/private/journal ORIGINAL_OPERATION_ID
npm run release:deliver -- resume /absolute/private/journal ORIGINAL_OPERATION_ID
```

Resume locates the original storage request and release operation. It preserves
deadlines, completed evidence and uncertain publication, installation or Assistant
requests. It does not create a replacement operation or repeat an uncertain
effect. A missing original storage request is a reconciliation gap, not authority
to bypass admission.

Raw `release:deliver start JOURNAL DESCRIPTOR` is an internal effectful
interface. It requires the runner's exact, hash-bound storage session before
opening a writable journal. Direct coordinator `resume` is retired as an
operator command and points to `release:deliver resume`; the coordinator remains
available internally to the guarded delivery engine. A session for another
operation, command, source graph or descriptor is rejected. Direct Node calls
enforce the same checks as npm, so an old npm invocation cannot accidentally
skip storage. Status, planning, checkpoints and narrowly qualified failure
reconciliation remain available.

This boundary covers current supported operator entrypoints. Native host workers
and qualified recovery primitives keep their own existing guards. They are not
alternative ordinary deployment commands, and this boundary does not intercept
arbitrary SSH commands or an executable restored from historical Git sources.

## Verification and timing

Focused tests exercise actual CLI routing and refusal, wrong or stale admission,
original-operation resume and read-only access. Fixture tests do not establish a
new live deployment or claim a destructive cleanup occurred. Report storage
preflight, actual archive work, delivery and acceptance separately. Automatic
execution removes manual coordination; large backups still require transfer and
independent content verification time.
