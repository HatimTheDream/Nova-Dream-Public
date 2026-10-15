# Data-only delivery input

Use `npm run release:deliver -- start /absolute/private/input.json` from the committed application checkout. Keep the input, profile, configuration and resulting journal outside both repositories and synced directories. Provisioning the first deployment profile is a configuration task: it requires the actual accepted installation, authenticated retained candidates, existing tools and signing configuration. A missing accepted record is a qualification gap, not an invitation to create a passing receipt.

The input has these fields:

| Field | Value |
| --- | --- |
| `format` | `1` |
| `operationId` | A stable caller-assigned UUID, retained for every retry of this operation. |
| `profile` | `{ "path": "/absolute/private/profile.json", "sha256": "..." }`, using the actual SHA256. |
| `sourceCommits` | Exact full `private` and `public` commit hashes from the independent canonical repositories. |
| `outputRoot` | An absolute protected private directory outside either source checkout. |
| `timeline` | The existing release timeline schema, with the actual start time, original estimate and next checkpoint. A new operation begins without revisions or retrospective reviews. |
| `observationBudgetMs` | An integer from 60000 to 86400000. Reopening the request does not renew it. |

The observation budget covers the entire operation, not one poll. Use an appropriate whole-operation allowance (normally 14400000 ms for a prepared ordinary release); checkpoint forecasts and worker timeouts are separate, and resuming never resets the original allowance. Before freezing sources, verify both configured main branches include their latest published feed commits and account for the recovery snapshot retained after rehearsal in the capacity estimate.

The version and build come from the committed package files; both repositories must agree. The executing delivery source must match the exact committed adapter graph. Signed publication sequence and validity timestamps derive from the authenticated predecessor and original input time. Route selection still compares authenticated candidate contents. Declaring a desired route cannot bypass compatibility checks.

The profile contains `format: 1`, `target` (a hash-bound target configuration), `targetIdentity`, independent `sources.private` and `sources.public` (`root`, canonical `repository`, `branch: "main"`), and `accepted` references to the actual installed `identity`, original installer `result`, reviewed `pair` and signed `bundle`. The target holds the existing tool references, selected private/public candidate directories and manifests, protected host roles, native qualification anchor, public signing-key reference and private-key location. Private-key contents are not read during initialization. Optional `qualificationEvidence` preserves separately verified immutable provenance; it does not make a qualification pass.

Initialization creates immutable `request-OPERATION_ID/initialization.json`, `target.json` and `descriptor.json`, then starts the existing engine in `journal-OPERATION_ID`. Repeating the same input resumes those exact bytes. Changed input, partial conflicting output or an unrelated pre-existing journal is refused. The initializer does not contact the host, publish, sign or install; the existing engine owns those phases and their current gates.

After accepted installation and a saved Assistant reply, `successor.profile` identifies the next immutable profile. It retains the original publication and Assistant receipts and both actual candidate manifests. Full releases advance the accepted backend and signed feed; frontend releases preserve the backend and advance only the signed frontend predecessor. For another release, use this reference, a new stable operation ID, the next committed source pair and an actual new timeline. No version-specific preparation script is needed. If the original identity lacks retained installer-result bytes, automatic export reports `original-installer-result-bytes-unavailable`; preserve that gap and supply the real original record during bootstrap configuration.

An exported profile does not claim browser acceptance and does not move a global selection pointer. Unsupported runtime, dependency, startup or schema transitions retain the existing explicit qualification gaps. `status` is read-only; `resume` can reconcile a completed immutable export after a lost response, even when the original effect observation budget has expired, without restarting any effect.

The accepted profile may also retain `accepted.feedDependencies`, containing exact archive and metadata references. Full successor export derives these from the completed dependency and pair phases, verifies the accepted bundle member, and prepares only the pinned Zod package needed by the selected feed contract. The package uses ordinary Node resolution; no npm install, native module execution or module loader is involved. Initialization repeats content verification and reconciles the same local files before parsing the signed predecessor. Existing candidate code, manifests and immutable profile bytes are preserved.

For an older full successor profile without those references, the initializer can recover them from the retained original journal, completed sign and pair receipts, and accepted bundle. A legacy frontend profile pointing to a different previous operation without retained dependency references remains an explicit provenance gap. Do not substitute a guessed archive path or a new receipt.

After a completed installation and saved Assistant reply, an export-only correction can be reconciled through the existing `npm run release:deliver -- resume /absolute/private/journal ORIGINAL_OPERATION_UUID` command once that original operation's observation budget has expired. The unchanged expiration guard prevents delivery effects while the exporter verifies the old phase results and completes local successor readiness. Preserve the original budget and failures; do not start a duplicate operation or reset its deadline. Existing immutable successor output is checked and returned unchanged. Normal future exports perform this prerequisite automatically.
