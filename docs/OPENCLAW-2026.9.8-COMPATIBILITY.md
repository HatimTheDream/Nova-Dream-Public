# OpenClaw 2026.9.8 compatibility

Nova qualifies exact engine versions; an unfamiliar version does not inherit authority from a similar API or database schema. This change adds `2026.9.8` while retaining the reviewed `2026.9.2` and `2026.9.6` paths. It does not enable new external services, browser takeover, shared-turn steering or automatic credential selection.

## Source identity

The reviewed official package is [openclaw@2026.9.8](https://registry.npmjs.org/openclaw/2026.9.8), with archive SHA-256 `317e0a58db32b386e01187fe9c5c4de541f4ce6d815657bf79a102609b81752a` and npm integrity `sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==`. The public SDK declarations and implementation shipped in that package were compared with the [v2026.9.8 source tag](https://github.com/openclaw/openclaw/tree/v2026.9.8). Package acquisition and static review are not installation or live acceptance evidence.

## Reviewed contracts

| Nova boundary | Reviewed 2026.9.8 contract | Preserved restriction |
| --- | --- | --- |
| Account discovery and usage | Public `agent-runtime`, `provider-oauth-runtime` and `provider-usage` SDK exports retain `loadAuthProfileStoreWithoutExternalProfiles`, `resolveApiKeyForProfile`, `resolveOpenAICodexAuthIdentity` and `fetchCodexUsage`. The usage call accepts the exact token, account ID, timeout and injected fetch. | Captured account identity remains explicit; discovery does not authorize a send, change credentials or grant usage access to another account. |
| Worker and source adapters | Plugin runtime retains `subagent.run`, `waitForRun`, latest-consistency session reads, media staging, agent event subscriptions and trusted tool policy registration. See [runtime types](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/plugins/runtime/types.ts) and [plugin types](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/plugins/types.ts). | Exact session/run identity, idempotency, captured/current permissions and uncertain acknowledgements remain enforced. A status read never becomes another dispatch. |
| Lost input acknowledgement | The [chat history handler](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/gateway/server-methods/chat-history-handler.ts) retains `inputRunIds` receipt lookup in the current physical session, including queued pending and consumed input receipts. | A receipt establishes custody of the original input, not successful execution. Completion still requires matching terminal evidence; missing or malformed receipts do not permit a resend. |
| Update suspension | [External application guidance](https://github.com/openclaw/openclaw/blob/v2026.9.8/docs/gateway/external-apps.md) and the [suspend coordinator](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/infra/gateway-suspend-coordinator.ts) retain preserve/drain-false prepare and exact resume results. Ready/busy responses include `writeCustody`, including backup, migration, session mutation and terminal persistence. | Readiness requires zero activity/custody and the exact owned process/lease. Missing, malformed, extra or contradictory fields fail closed. A lost prepare reply is reconciled through the same lease. |
| Held startup databases | Exact agent/shared schema pairs are `19/15` for 9.2, `23/18` for 9.6 and `24/19` for 9.8. The 9.8 changes add session-entry snapshot revisions/projection triggers, worktree GC metadata and profile-identity authorization metadata. | Startup checks remain read-only and keep existing pending-work guards. Existing authorization metadata is preserved; migration must not invent authorization for older rows. Schema numbers alone do not authorize an unreviewed version. |

The package declares Node `>=24.16.0 <25 || >=26.1.0`; deployment must use a qualifying owned runtime. Nova's own service Node requirement is separate.

## Verification boundaries

Focused synthetic checks cover 9.8 account/source/worker/module support, original dispatch retention, queued and consumed input receipt reconciliation, owned process reconnect, suspension custody validation, lost prepare acknowledgement and exact `24/19` held startup. Negative cases reject unfamiliar future versions and prove that retained metadata and uncertain work are not rewritten. These fixtures exercise Nova's adapter behavior and are not a substitute for executing the official installed runtime.

The complete isolated Linux runtime closure, using OpenClaw 2026.9.8 and Node 24.21.0, passed three actual SDK checks: OAuth identity resolution preserves the explicitly captured account; usage lookup uses only that account through injected synthetic responses; and the native suspend coordinator preserves the non-draining custody handshake and exact resume behavior. The qualification recorded zero unexpected network fetches. The independently downloaded runtime archive has SHA-256 `7af79b978af50b9a72997cd7869a0a2a928aff7b3ea5b16f2102f92b78875d3f`. These checks used synthetic data and establish SDK compatibility, not access to a live account.

The official runtime also migrated synthetic native databases in two scenarios, covering four active databases, and six Codex stores covering state schema versions 56/57 and history version 7. The maintained recovery verifier accepted the exact resulting schemas and retained content. This establishes compatibility for those active-database migrations; it does not establish full-workspace recovery or production acceptance.

Final release acceptance must separately record stopped migration/recovery verification, native hold clearance and one real Assistant reply after restart. The official managed companion installer also requires its own peak-storage measurement because its staged dependency tree and npm cache differ from the offline runtime archive. No SDK or database fixture qualifies those delivery steps.

Managed companion capacity is separately reported in staging and stopped admission.
The exact qualified 9.8 runtime uses a conservative 2 GiB estimate: two 512 MiB
new-project components, three 256 MiB cache components and a 256 MiB temporary
input/metadata margin. The official cold-cache success measurement observed
1,164,165,120 additional allocated bytes, a 476,045,312-byte new project and
211,496,960-byte final cache, while preserving the old payload. The runtime,
measurement source and measured lock identities are recorded in the capacity
profile. Repair branches were not executed, 50 ms sampling is not an exact peak,
and registry ranges can resolve another graph; this is not an enforced ceiling.
Cache, temporary and managed-project filesystems must match the recovery volume.
Existing independent restoration allowances and operating reserves remain intact.
