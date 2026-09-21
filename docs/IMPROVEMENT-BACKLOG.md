# Proposed improvement backlog

Current 2.0 priority (20 September 2026): [Assistant Chat parity and acceptance](ASSISTANT-PARITY.md). Its complete conversation journeys take precedence over unrelated Home/startup polish. Historical items below keep their original evidence and status.

Status: correctness slice implemented in 1.5.13; complete handoffs, explicit failed-stage retry and focused team recovery clarity implemented in 1.6.0; structured reviews, explicit fix/re-review rounds and persistent Assistant navigation implemented in 1.7.0. Remaining slices are proposals. Audit baseline: Nova Dream 1.5.12 / build 1.0.169 / schema 54. Priority: stronger Assistant and agent workflows. This document contains generic product/source findings only; installation-specific operations belong in private records.

P1 = next product/reliability tranche; P2 = following work. S/M/L are relative effort, not delivery promises. Source paths below are relative to the application root. Preserve existing retained writing, exact run identity, receipt deduplication, permission intersections and unknown-outcome reconciliation.

## Correctness and delegation

### ND-01 — Select suitable default team members (P1, S)

Implemented in 1.5.13: reserve title-matched specialists, recognize Maker, leave ambiguous slots unselected and preserve saved choices. A durable explicit-role schema remains a possible follow-up.

Evidence: `apps/client/src/TeamWorkPanel.tsx:11` matches title substrings greedily; Maker is not a recognized implementation title and fallback can consume the best Reviewer.

Action: reserve all strong matches before filling gaps; use explicit supported roles as the durable model. Ambiguous slots should require a choice. Do not expand agent permission to fit a guessed role.

Done when: Maker/Reviewer/Researcher rosters select the intended roles independent of roster order; missing/ambiguous roles are clear; overrides remain selected; existing authority checks still apply. Use actual rendered form coverage as well as selector tests.

### ND-02 — Preserve complete, retrievable handoffs (P1, M)

Implemented in 1.6.0: immutable complete output records, bounded excerpts with full-read instructions, scoped agent pagination, and authenticated owner/phone reads. Original results survive conversation removal and restart; legacy incomplete excerpts remain labeled.

Evidence: `apps/service/team-work.ts:96,118` shortens the stage result to 20,000 characters, then supplies only 9,000 divided across prior stages. Original conversation output is separate and retained.

Action: immutable complete result references plus bounded summaries with explicit omission notices and a supported full-content read path. Include changes, checks, constraints, unresolved issues and artifact references.

Done when: a constraint beyond the old cutoffs is retrievable by the next stage; restart preserves the exact original; summary size remains bounded; both UI and agent know when they see a summary; no duplicate submission is introduced.

### ND-03 — Retry failed stages and close the review loop (P1, L; two slices)

Evidence: `apps/service/team-work.ts:63–69,96–99`; `packages/domain/team-work.ts:6`. Failed stages cannot resume; operation completion advances the chain without a structured review verdict.

Slice 1 implemented in 1.6.0: explicit retry creates a new attempt for a confirmed failed stage, preserving the failure and showing current checkout/context. Unknown original outcomes must reconcile first.

Slice 2 implemented in 1.7.0: immutable structured findings and reviewer-reported checks, Ready for your review / Needs changes / unavailable outcomes, and explicit Apply findings appending a builder/reviewer pair. Three owner-started fix rounds per workflow; all prior stages, attempts, captured settings and file changes remain. Missing, failed or unverifiable review evidence is not acceptance. Publication stays with the owner. Applying findings requires the exact retained completed review execution; reports remain readable after conversation removal.

Done when: retry is idempotent, old attempts remain visible, unconfirmed executions cannot duplicate, a review reporting defects yields Needs changes, and finite iteration limits return control to the owner. Depends on ND-02 and stable result identities.

### ND-04 — Separate active limits from workflow history (P1, M)

Evidence: `apps/service/team-work.ts:45` caps all current-epoch workflows at 100; `apps/service/assignments.ts:121` has an attempt-history ceiling.

Action: paginated archived history and explicit retention/export/removal rules. Preserve output/conversation/receipt references. Never silently purge active or unknown work.

Done when: 100 completed/archived workflows do not block a new one; limits still bound simultaneous work; archived outcomes and restored backups remain consistent; removal cannot permit a replay.

### ND-05 — Show actual progress and recovery choices (P1, M)

Team recovery slice implemented in 1.6.0: stage counts, prior attempts, exact retry reconciliation, unavailable unsafe actions, explicit unknown/stop-requested/owner-review states, and stable unchanged failure observations. Assignment timelines and distinct observed/progress timestamps remain future work.

Evidence: `packages/domain/assignments.ts:12`, `packages/domain/worker.ts:21`, `apps/service/assignments.ts:53,256,270`. Repeated observation updates are not proof of progress.

Action: separate lastObservedAt/lastProgressAt; bounded step/tool timeline; safe failure categories; clear waiting-for-owner, running, disconnected, stop-requested and outcome-unconfirmed states. Persist only meaningful durable changes.

Done when: unchanged polls do not advance progress time or rewrite complete attempts; fixtures for approval wait/disconnect/reconcile/save failure have truthful distinct next actions; reconnect resolves the original run rather than resending. No raw secrets or private prompts in diagnostic summaries.

## Product continuity

### ND-06 — Bring actionable work into one attention view (P1, M)

Evidence: `apps/client/src/Home.tsx:27,33`, `App.tsx:124–125,141`, `ApprovalTray.tsx:30–35`, `AssignmentRuns.tsx:95–96` expose separate subsets.

Action: Needs you / Running / Ready to review groups on Home and an app-level indicator. Reuse original precise approval controls and source links.

Done when: a chat approval, assignment approval, failed team stage and returned result are discoverable from Home in one action; stale/resolved items reconcile; no blanket approval is added. Depends on reliable source state from ND-05.

### ND-07 — Deliver a consolidated result (P1, M)

Evidence: `apps/client/src/TeamWorkPanel.tsx:22` links stage conversations/handoffs; existing review and output actions live in `Assistant.tsx:379,455,477` and `AssignmentRuns.tsx:97`.

Action: result card containing changed files/artifacts, checks actually run, review findings, skipped stages and unresolved items. Reuse Review changes, download/reuse and follow-up controls.

Done when: a user can inspect a three-stage result without reconstructing three conversations; every check is evidenced or explicitly unverified; no publication or task completion happens implicitly. Depends on ND-02; consumes review outcomes from ND-03 when available.

### ND-08 — Delegate from saved work with context intact (P2, M–L)

Evidence: `apps/client/src/TaskEditor.tsx:35–45`, `RecordFields.tsx:50–54`, `RecordConnections.tsx:24–38`, `TeamWorkPanel.tsx:10–12,21`.

Action: Work on this with Assistant / Assign to agent from a saved task and later other relevant records. Capture source revisions, project, files, expected output and effective scope. Guided prerequisite actions return to the preserved brief; template choices should precede a general workflow builder.

Done when: task → run → reviewed result → originating task is navigable; changed source records cannot silently replace the captured brief; unsaved edits are handled explicitly; no eligible project/agent produces a useful setup action; current checkout/access are visible before starting. Reuse the existing execution engines.

### ND-09 — Recover from startup preparation failures (P1, M)

Evidence: `apps/client/src/App.tsx:64–87`, `OriginalInbox.tsx:66–91`, `preload-lazy.ts:12–18`.

Action: preserve the chosen single full initial-preparation experience. Track failures by subsystem, retain successful phases, retry failed work only, and offer an explicit degraded entry when only nonessential preparation failed. Measure usable prepared-Assistant time and total preparation transfer, not just static entry-bundle size.

Done when: slow/failed mail, calendar and cosmetic-asset fixtures produce accurate status and targeted recovery; successful normal startup retains prepared views; saved writing is untouched. A shell-first alternative requires an explicit product decision.

### ND-10 — Make Inbox recommendations relevant (P2, M)

Evidence: `apps/client/src/dreamclaw/pages/Inbox/index.tsx:352–380,2781–2786` relies on broad urgency/reply heuristics and candidate order.

Action: distinguish actionable requests, transactional receipts, authentication codes, newsletters and waiting-on-someone items; show reason/confidence and enable corrections. Security classification and task relevance should remain separate concepts.

Done when: representative synthetic fixtures do not promote expired one-time codes and routine receipts into reply/follow-up recommendations; real requests remain discoverable; owner corrections persist; message → task → agent → reply draft retains source links and separately reviewed sending. Establish a precision baseline before promising gains.

### ND-11 — Make the visual hierarchy serve current work (P2, M)

Evidence: `apps/client/src/Home.tsx:8,29–38`; icon-only visible navigation at `App.tsx:139`. Design recommendation, not an assertion of missing accessible names.

Action: preserve the existing brand/mascot and rounded visual language. Prioritize needs-attention, active work and results; offer a compact clock; retire completed onboarding; add optional labelled navigation and distinguish panel controls. Standardize spacing, typography, status semantics and primary/secondary actions in shared components.

Done when: the same capture/delegate/review journey is clear at desktop and 390px widths, keyboard-only and 200% zoom; focus and reduced-motion behavior survive; long names do not obscure essential controls; light/dark contrast is measured before claiming compliance. Avoid a broad visual rewrite without user benefit.

### ND-12 — Make saved work addressable (P2, M)

Evidence: `apps/client/src/App.tsx:96,113` stores module route in local state.

Action: authenticated module/record/run URLs, safe unavailable-item fallbacks, Back/Forward and refresh support. Put identifiers, not sensitive titles/prompts, in URLs.

Done when: refresh and browser history restore the selected saved item, copied links open the intended authenticated view, removed items have useful fallback, and unsaved drafts survive navigation. Can begin with the run/result links required by ND-06/07.

## Reliability, code organization and verification

### ND-13 — Bound service reads as history grows (P2, M)

Evidence: `apps/service/store.ts:750–753` scans a substring prefix; `:784–789` provides an existing indexed range pattern. `assistant.ts:77–101,145–147,220,524` repeatedly lists history.

Action: correct indexable prefix ranges, bounded pages and active-run projections, retaining encrypted canonical records. Avoid decrypting unrelated history on every event.

Done when: supported-prefix results/order are equivalent, query plans show indexed search, 10k/100k synthetic datasets have recorded before/after query/event-loop measurements, and recovery/deduplication remain correct. Do not invent production speedup figures.

### ND-14 — Expose component health and safe diagnostics (P2, M)

Evidence: `apps/service/http.ts:240,687,709–710`, `agent-routines.ts:58`.

Action: distinguish liveness from protected readiness; track last successful scheduler ticks, consecutive failures, runtime availability and disk pressure. Add rate-limited structured errors and support IDs without record contents or credentials.

Done when: injected persistent scheduler failure becomes component-degraded within two intervals and clears on recovery; durable cursors do not advance on failure; an unexpected HTTP error is locally traceable without exposing private data.

### ND-15 — Make backup resource use predictable (P2, L)

Evidence: `apps/service/store.ts:164–178`, `backup-crypto.ts:14–22`, `workspace-backups.ts:142`, `packages/domain/workspace-backup.ts:5`.

Action: first measure memory/event-loop impact and add size-aware admission/progress. Then isolate or stream consistent snapshot encryption/verification, preserving recovery isolation and old archive compatibility.

Done when: representative near-limit export/restore meets an explicitly selected memory/responsiveness budget; ordinary saves remain responsive; interrupted operations preserve the source; full record/blob hashes round-trip; earlier supported archives still restore. An actual OOM is not established by this audit.

### ND-16 — Clean abandoned upload pieces safely (P2, S–M)

Evidence: `apps/service/upload-transfers.ts:23,26,82`. Expiration knows only current-process transfers; root cleanup occurs at graceful close.

Action: identify orphaned owned roots at startup, verify containment and inactive ownership, account for their disk usage and remove only abandoned pieces.

Done when: a killed fixture's abandoned upload is cleaned on restart; active transfers/user files/outside symlink targets survive; cleanup failures appear in safe diagnostics.

### ND-17 — Test real workflows and gate private PRs (P1 supporting work, M)

Evidence: `package.json` quality scripts; `tests/team-work.test.ts` mocked worker; private `.github/workflows/nova-release.yml` versus public quality PR trigger.

Action: a small fixture-backed rendered-browser suite for role selection, preserved brief, lost response, pause/stop/unknown run and review/fix lifecycle. Add private Edition 3 PR checks; keep publishing restricted to qualifying main pushes.

Done when: the identified behavior fails the test when broken; synthetic workspaces and deterministic adapters avoid real accounts/cost; PR status runs without making a release. One coherent full quality gate per candidate; no exhaustive unrelated screenshot matrix.

### ND-18 — Refactor where it improves workflow changes (P2, incremental M)

Evidence: dense team UI/service logic; large Inbox, Assistant, HTTP and store modules; two independently maintained source histories.

Action: readable formatting for touched modules; separate typed run transitions, worker/protocol parsing, presentation and provider adapters. Define UI status/error contracts. Add a concise architecture map and read-only parity tool with an explicit allowlist for sanitization and private-only material. Move obsolete experiments only after checking reachability and history.

Done when: behavior and exact authority/receipt invariants remain tested, a reviewer can trace a run transition without hunting through giant components, and shared changes produce a reviewed two-repository parity report. Do not mechanically split files or introduce a new framework just to reduce line counts.

### ND-19 — Repair misleading small states (P1, S–M)

Implemented in 1.5.13: all six corrections below have focused regressions. Original audit observations are retained for traceability.

- Home timezone: `Home.tsx:29,37` → `App.tsx:146` currently opens Accounts; land in General while Review connections still opens Accounts.
- Home attention: `Home.tsx:27` misses a past due date without a past planned date; include explicit overdue reasons and exclude done/skipped/trashed records.
- Poll recovery: `TeamWorkPanel.tsx:15,24` retains read errors after successful polls; clear recovered read errors separately from unresolved mutation errors.
- Connection loading: `Connections.tsx:12–16,59–60` initially labels unknown data disconnected; show Checking until a definitive result.
- Inbox preview: `dreamclaw/pages/Inbox/index.tsx:294–301,570–586` leaves encoded entities/preheader padding; decode plain text safely, normalize padding and preserve meaningful Unicode without rendering HTML.
- Empty/copy states: `Home.tsx:30–33` can show first-task guidance when only future tasks exist, and singular attention uses plural copy; distinguish true emptiness, no ready tasks and filters.

Done when: each exact triggering condition has a focused regression, restored/unsaved state is retained, and working controls remain in their proper category.

## Additional finding during implementation

### ND-20 — Verify native Windows sign-in process shutdown (P1, M)

A bounded real-PTY sign-in regression on Windows does not exit cleanly after the synthetic code flow. The isolated fixture avoids test-loader inheritance and retains the actual assertions; it remains a failure rather than being skipped. This does not establish that the production user flow fails, and it is not native Windows acceptance.

Action: isolate ConPTY shutdown and runtime/test-harness differences, verify the packaged native Windows sign-in lifecycle and cleanup, and keep all existing authentication and cancellation guards. Hosted Linux verification is separate. Do not widen access or dismiss the failing native check to obtain a passing gate.

## Proposed delivery sequence

1. **Correctness patch:** ND-01 + small ND-19 fixes and focused regressions.
2. **Dependable delegation:** ND-02/04, safe retry from ND-03, ND-05 and supporting ND-17 tests.
3. **Visible outcomes:** ND-06/07, structured review/fix cycle and necessary ND-12 links.
4. **Connected daily work:** ND-08/10/11 and remaining ND-12 navigation.
5. **Reliability in parallel:** ND-09/13/14/16, then measured ND-15 work. ND-18 accompanies the areas being changed.

Every implementation release needs the appropriate version bump/changelog, focused checks, one full quality gate for a coherent candidate, separate sanitized private/public commits, and an explicit deployed-versus-source status. A checked-off plan is not evidence of shipped behavior.
