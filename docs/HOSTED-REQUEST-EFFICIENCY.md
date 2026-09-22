# Hosted request efficiency

## Why this is part of reliability

A hosted workspace left open can exhaust a request allowance even without new user actions. Compression and unchanged responses reduce transfer, but do not remove the incoming request. Vercel counts successful and failed function requests toward invocations: https://vercel.com/docs/functions/usage-and-pricing#invocations. Edge and function counters can reflect the same request; they are not separate counts of unique visits.

The 1.9.8 source baseline had global snapshot reads every 2.5 seconds, Assistant state/output reads every 1.5 seconds (with short unchanged-response backoff), and model refresh every 30 seconds. The loops remained mounted on other pages and had no hidden-document interval. Nominal best-case global polling was approximately 46 requests/minute or 66,240/day for a continuously awake tab. Browser throttling and latency affect that estimate. Assistant module-action checks and a closed/completed tool-view panel added more calls. Connections requested five resources every 1.8 seconds. These are code-derived estimates, not production traffic attribution.

## Candidate 1.9.9

A shared visibility-aware scheduler prevents overlapping background cycles, reduces idle and hidden activity, refreshes when the document becomes visible, and exponentially delays repeated failures. Explicit user actions and reconciliation keep their own request identities. The server continues working regardless of which client panel is visible. Active voice and microphone execution remain separate from these background status checks.

Core workspace polling remains periodic while hidden to retain reminder and workspace health observation. Assistant state/history remains fast for an active visible reply; idle and inactive routes use slower checks. Model lists need fewer refreshes than live replies. Idle Connections catalogs, empty module-action trays, and settled/closed tool views avoid active-rate polling.

| Surface | Visible behavior | Hidden behavior |
| --- | --- | --- |
| Workspace snapshot | Every 10 seconds; explicit actions refresh immediately | Every 30 seconds |
| Assistant state and outputs | Every 1.5 seconds during active work; every 15 seconds on an idle Assistant page; every 60 seconds on another idle page | Every 60 seconds |
| Models | Every 60 seconds | Every 120 seconds |
| Connections | Runtime/status and sign-in every 30 seconds when settled, every 2 seconds while starting or waiting; account every 60 seconds; voice catalog on opening, return or relevant change | Automatic panel reads suspend |
| Module-action tray | Every 3 seconds during work or pending/uncertain requests; every 30 seconds when empty or settled | Automatic panel reads suspend |
| Tool image view | Every second while open and active; brief discovery after new tool evidence; one read when a new image hint arrives | Automatic panel reads suspend |

Intervals start after the preceding read settles. Existing conditional-response holds can skip unchanged reads. Repeated failures increase the retry delay up to two minutes, without shortening a slower normal interval. Returning to a visible document prompts a fresh check. The tradeoff is slower observation of idle changes made on another device: a visible workspace can take about ten seconds, and an idle hidden Assistant can take about a minute before its next automatic check. This does not delay the server's execution or replace explicit action receipts.

Late tool images remain discoverable even after work completes. The existing authenticated Assistant state response includes a transient image identity, which changes its ETag when a valid new image arrives. The image panel then fetches that image once; it does not require continuous closed-panel polling. This hint is not persisted into the saved operation and does not alter the answer, tool history or completion time.

Do not cache private authenticated API responses publicly, remove authentication middleware, disable saved-work reconciliation, or reduce active audio/streaming correctness to meet a request target. Static asset caching and cross-tab subscription sharing require their own review.

## Measured local result

The actual built app and service were measured in matched idle states for one minute each, with a visible 1280-by-720 browser document, no active runs and no user actions during each window. These are counted HTTP requests, including unchanged responses, rather than estimates from timer settings.

| Idle page | Before: 1.9.8 client | After: 1.9.9 client | Reduction |
| --- | ---: | ---: | ---: |
| Completed Assistant conversation | 80 requests | 18 requests | 77.5% |
| Assistant connection settings | 201 requests | 16 requests | 92.0% |

All counted requests finished with successful or unchanged responses. The completed conversation's recurring image reads fell from 12 to zero in the measured minute; its module-action checks fell from 20 to two. The Connections voice-catalog reads fell from 33 to zero after initial loading. Timer phase and latency can change a one-minute count slightly; these percentages are scoped observations, not guaranteed monthly totals.

The external Assistant runtime was a controlled synthetic fixture. The before client remained the unchanged 1.9.8 build; the source service already reported 1.9.9 metadata in both measurements. After verification used the final 1.9.9 client and source service. No measured request traversed Vercel.

## Verification and limits

Each repository ran one full quality gate: 1,558 tests passed, none failed, and eight platform-specific tests were skipped. Type checking, dependency security audits and release validation passed. The final build initially exceeded the unchanged size limit by 81 bytes. Small shared-reader and scheduler simplifications were followed by 25 focused regressions, TypeScript and successful direct builds in each repository; the full gate was not repeated. Final client JavaScript measures 147,908 startup and 626,963 total gzip bytes, within the existing limits.

Regressions cover nonoverlap, hidden-document behavior, failure backoff, cleanup, explicit receipt refreshes, model recovery after identity changes, active panel transitions and late images after completion. Authenticated image hints change the status ETag without changing saved runs. An actual new UI reply showed active work and Stop, then a completed answer with fixed elapsed time; the separately typed draft remained intact.

This is a local, unpushed candidate, not a live deployment. Production project/path totals and post-deployment quota recovery are not established by local testing. The hosted app must receive the candidate and existing clients must load its new code before these reductions can apply there. Existing usage is not reset. No upgrade purchase or Vercel configuration change is part of this source correction. Real-provider, installed-app, hardware-voice and physical-phone acceptance remain outside this local pass.
