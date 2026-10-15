# Resumable release delivery

Run `release:deliver` from the application root with an exact committed private/public source pair and a provisioned private deployment target. The target configuration binds the trusted signing key, authenticated artifact access, protected staging parents, selected service identity and required qualification evidence. Keep this configuration, the journal, signing keys and operational evidence outside both source repositories. Provision the protected staging parent once; it is reusable across operation-specific children.

```sh
npm run release:deliver -- start /absolute/private/input.json
```

The command publishes the exact sources, observes canonical CI in parallel, retrieves authenticated artifacts, chooses the verified route, packages and signs, performs capacity and recovery checks, publishes, installs and checks acceptance. It retains successful phase results and original effect identities in the private journal. Read-only prerequisite checks identify missing protected staging directories before packaging.

[The data-only input and profile](RELEASE-DELIVERY-INPUT.md) supply the exact commit pair, an immutable configured target, a stable caller operation ID and the actual initial timeline. Version, build, signed sequence and selected prior bindings are derived from committed sources and retained accepted evidence. The original three-argument form, `start JOURNAL DESCRIPTOR`, remains available for already prepared operations.

After installation and the saved Assistant reply pass, the result returns an immutable `successor.profile` reference for the next release input. A frontend release preserves the accepted backend base. A full release exports the actual new candidate manifests, original installer result and published signed feed. Browser acceptance remains a separate result. Missing legacy evidence produces an explicit successor export gap; it is never reconstructed as a successful receipt.

Once the target is provisioned and its initial accepted profile is available, ordinary supported releases use new commit inputs and the returned profile; they do not require a new preparation script for each version. Retrying an interrupted initialization requires the same input and operation ID. Source implementation and focused tests are distinct from a completed release: use the original journal's installation and acceptance results to establish what is live.

After an interruption, keep the original journal and operation ID:

```sh
npm run release:deliver -- status /absolute/private/journal ORIGINAL_OPERATION_ID
npm run release:deliver -- resume /absolute/private/journal ORIGINAL_OPERATION_ID
```

Resume observes an uncertain original publication, installation or Assistant request before considering another action. A failed check stops its dependent actions. Investigate its recorded cause; creating a new operation or changing a receipt is not failure recovery. The original observation budget and timing history survive a new invocation.

An uncertain publication is not treated as a completed publication. Completed artifact, ledger and source checks still apply when completion is observed. Bounded diagnostic codes stay in private output to identify a failed prerequisite without exposing credentials or changing the original uncertain effect.

## Supported routes

| Change | Route |
| --- | --- |
| Eligible client JavaScript, TypeScript, React or entry document | Signed frontend bundle with atomic promotion, old-window asset retention and explicit rollback. Existing windows offer Refresh or Later. |
| Ordinary backend change with the qualified runtime, native dependencies, startup/helpers and schema/API contracts | Full release with its required fresh rehearsal, installation and acceptance. |
| Exact runtime 2026.9.6 to 2026.9.8 transition | Not qualified in this release. The guarded route requires a complete verified retained-state proof covering target startup, restart, native-data migration and restoration of the original runtime. The selected prior installation and accepted target anchor have distinct roles; complete service, helper and native bindings must match the proof. |
| Other runtime transitions, application schema/API changes or changed native dependencies/startup/recovery contracts | An explicit qualification gap until a matching producer and verifier have been implemented and qualified. The existing evidence cannot admit different inputs. |

The runtime path requires actual completed isolated qualification. Synthetic tests, a downloaded runtime archive or an existing-state check alone do not establish that proof. Ordinary application updates that preserve the qualified runtime use their separate full route and still require its fresh rehearsal and acceptance checks.

## Acceptance and timing

A completed saved Assistant reply and browser/reload verification are separate results. A missing browser capability is reported as an acceptance gap. `start` and `resume` exit with code 2 when the delivery is incomplete, including that gap; inspect the phase summary to distinguish successful installation from incomplete acceptance.

Progress reports include phase states, elapsed time, original deadlines and actual operation keys. A checkpoint can append a reviewed forecast without replacing the original estimate:

```sh
npm run release:deliver -- checkpoint /absolute/private/journal ORIGINAL_OPERATION_ID /absolute/private/timeline.json
```

After repeated misses, progress requires a review for every missed deadline and a new evidence-backed change of approach recorded after the latest miss. That review preserves the earlier estimates and failures; it does not satisfy a failed technical gate, extend an uncertain request or authorize replay.

Preparation, CI, rehearsal, installation and acceptance are measured separately. A prepared frontend switch is only one part of delivery. Full releases retain their capacity and recovery checks. The verifier reuses repeated content reads only within a bounded read-only inspection; writes, new effects, changed inputs and resumed invocations require fresh verification.

Small host clock differences use a bounded wait for the local wall clock to catch up. Raw observations and their timestamps are retained, and their original maximum ages still apply. Exact host filesystem timestamps remain the staging authority across the JavaScript/Python boundary.
