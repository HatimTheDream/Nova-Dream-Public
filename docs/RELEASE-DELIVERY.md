# Resumable release delivery

`release:deliver` extends the existing release planner and coordinator. It keeps
source publication, CI, packaging, signing, recovery, installation and acceptance
in one private operation record. The configured controller and maintained recovery
tools remain responsible for host admission and installation.

Run from the application root with the qualified Node toolchain and application
dependencies. The command accepts exact committed private and public sources and
a hash-bound private deployment configuration. It does not commit working files,
infer a replacement host or purchase resources.

## Commands

```sh
npm run release:deliver -- start JOURNAL_DIRECTORY DESCRIPTOR_JSON
npm run release:deliver -- status JOURNAL_DIRECTORY OPERATION_UUID
npm run release:deliver -- resume JOURNAL_DIRECTORY OPERATION_UUID
npm run release:deliver -- checkpoint JOURNAL_DIRECTORY OPERATION_UUID TIMELINE_JSON
npm run release:deliver -- reconcile-failure JOURNAL_DIRECTORY OPERATION_UUID
```

Use absolute private paths for the journal and descriptor. Keep the journal
outside source repositories and synchronized folders, with its SQLite and WAL
files together. The existing coordinator enforces private POSIX permissions or
protected Windows ACLs. Use direct `node scripts/release-deliver.mjs` invocation
when stdout must be JSON without npm's command banner.

`start` initializes the exact descriptor and advances its operation. After an
interruption, use `resume` with the same journal and operation UUID. A changed
adapter graph, target, source identity or reserved input is refused. Do not edit
the journal, create a replacement operation or repeat an uncertain installation
to work around that refusal. An existing request is observed under its original
key and deadline; absence of a response does not prove absence of its effect.

`status` reads retained results without dispatching work. `checkpoint` appends a
timeline update while preserving the original estimate and deadline. Neither
command makes old admission evidence fresh. `reconcile-failure` supports only
explicitly qualified failure policies; it derives and records evidence itself.
It does not accept a caller's claim that an unknown effect never happened, and it
never resumes a closed failed operation.

For `start` and `resume`, exit `0` means the operation completed, `2` means it
remains incomplete, and `1` means input or producer validation failed. Inspect
the returned phase states and capability or acceptance gaps. Exit `0` from
`status` only means the retained status was read successfully.

## Configuration and scope

The exported `deliveryDescriptorSchema` in
`scripts/release-delivery-journal.mjs` defines committed sources, operation
identity, original timeline, target reference, adapter identity and observation
budget. `deliveryTargetSchema` in `scripts/release-delivery-adapters.mjs` defines
the private tools, selected baseline, host transport, signing and release options.
File references contain an absolute path and the SHA256 of the actual bytes.
Signing keys, SSH configuration, installed-host records and operational evidence
must remain private; none belongs in the public source tree.

Both repositories retain independent histories. Source phases verify their exact
commits. Canonical Linux CI is observed in parallel, and retained artifacts are
downloaded through authenticated APIs and checked against the exact run, source,
candidate and toolchain. The verified candidate comparison selects frontend or
full delivery; an operator label cannot force the frontend route.

Compatible frontend delivery preserves the running backend and existing windows'
asset namespaces. Backend, shared-contract, dependency, runtime, schema and
deployment changes select the full route. Selecting that route does not establish
that every changed component has a qualified producer. Unsupported runtime,
dependency, migration or helper transitions produce an explicit capability gap
and stop dependent effects. Current qualification boundaries are enforced by the
configured adapters, rather than inferred from the version number.

## Progress and acceptance

Progress comes from recorded phase results, original keys and actual timestamps.
Coding and preparation, canonical CI, service maintenance, installation and live
acceptance are distinct durations. A short prepared frontend switch is not a
development-to-live timing promise. Parallel CI time must not be counted twice.

Installation, a saved Assistant reply and browser/reload evidence are separate
results. A successful backend reply does not prove a window refreshed or retained
its draft. When a browser producer is unavailable or unintegrated, the command
reports that gap and remains incomplete; a separate browser check must not be
presented as a completed command journal phase. Preserve the original Assistant
request after a timeout instead of submitting another for acceptance.

Completed immutable artifacts and qualified exact-input evidence are reused.
Mutable host capacity and admission are checked before maintenance. A completed
rehearsal is not rerun just to renew a historical observation: where supported,
the adapter observes that same proof again. Required fresh rehearsal and live
saved-work checks still apply to a new full release.

An authorized delivery proceeds through passing technical gates without routine
owner confirmations. A failed gate stops dependent actions and preserves the
original failure. Diagnose its cause before another attempt; uncertain external
effects require reconciliation, not replay.
