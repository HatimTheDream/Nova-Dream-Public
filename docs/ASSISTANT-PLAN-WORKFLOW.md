# Saved Assistant plans

Plan keeps its existing composer control. The planning turn can ask structured questions, which use compact numbered choices and a written answer. The runtime saves a proposal through `nova_plan`; ordinary prose and progress steps do not create an approval.

The proposal contains its summary, ordered steps, explicit assumptions and verification criteria. After the planning run is confirmed complete, the owner can choose **Approve and start** or **Request changes**. Each amendment retains the prior version. Approval records the exact version and proposal digest and admits one implementation operation in the same workspace transaction. Repeated requests return the original operation rather than dispatching again. Unknown outcomes must reconcile before another action.

Conversation binding, settings, access and selected Project revisions are checked before approval. A stale review can use Request changes to capture current sources and settings and produce a new version. Approval never grants additional native or module permissions. Operation completion is not a claim that its verification criteria passed.

## Execution boundary

The owned OpenClaw 2026.9.2 workspace plugin declares the `nova-plan-read-only` trusted tool policy. Plan and Research dispatch first verify `e3.workspace.policy` for the exact session. This contract is additive; hosts without the current plugin refuse these modes before sending, retaining the request. A newly installed plugin needs the managed runtime restarted.

The service accepts only named read, search, question and planning tools during protected turns. Commands, edits, browser actions, generic Code Mode, delegation, unrecognized tools and Nova writes are blocked. Research uses the same module write fence. The policy does not change existing access for unrelated main-agent sessions or ordinary Goal continuations. A plain “yes” message while a proposal is pending retains the planning boundary; only the saved proposal's approval transition admits implementation.

Native question records are linked by exact run when supplied, otherwise by the same conversation/session and bounded planning time. Unresolved or expired records cannot be treated as answers. Earlier versions retain their linked question identities. The existing question service owns answer receipts and expiry reconciliation.

## Verification and limits

Focused regressions cover proposal completion versus approval, immutable earlier versions, stale approval, replay after restart, changed access recovery, missing run identifiers on questions, unsupported-host rejection, queued Plan identity, plain-text approval attempts, module write restrictions, native-policy bridge rejection and unrelated-session scope. They use isolated synthetic workspaces and a controlled Gateway transport.

The policy API contract was inspected in the exact upstream OpenClaw `v2026.9.2` sources (`src/plugins/plugin-api.types.ts`, `host-hooks.ts`, `hook-types.ts`, `hook-before-tool-call-result.ts`). Test doubles prove Nova's admission and plugin behavior; they are not a live provider execution test. Model quality, real clarification delivery and actual hosted native-tool enforcement still need a live acceptance run on the updated managed runtime before being described as verified end to end.

### Independent pinned-runtime review

The production [Codex harness](https://github.com/openclaw/openclaw/blob/v2026.9.2/extensions/codex/harness.ts#L271) explicitly enables its native hook relay for normal and continued turns. Its [event selection](https://github.com/openclaw/openclaw/blob/v2026.9.2/extensions/codex/src/app-server/native-hook-relay.ts#L380) retains `pre_tool_use` in both approval modes; permission-request routing is separate. The disable/event override options belong to internal attempt options, not the Codex plugin configuration. Nova therefore does not add an unsupported configuration key to force this behavior.

The [native relay](https://github.com/openclaw/openclaw/blob/v2026.9.2/extensions/codex/src/app-server/native-hook-relay.ts#L244) uses the host's pre-tool pipeline. [Dynamic tools](https://github.com/openclaw/openclaw/blob/v2026.9.2/extensions/codex/src/app-server/dynamic-tools.ts#L1042) are wrapped by the same boundary, whose [policy stage](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/agents/agent-tools.before-tool-call.policy.ts#L234) evaluates registered trusted policies. The special `pluginHarnessToolPolicyRestricted` path omits native relay setup but also [disables the native shell/file tool surface](https://github.com/openclaw/openclaw/blob/v2026.9.2/extensions/codex/src/app-server/dynamic-tool-build.ts#L664); dynamic tool policy remains separate. These are source-contract findings for this exact upstream version, not evidence of an installed host test or a guarantee about custom harnesses.

Nova's plugin limits its bridge policy to registered exact session-key/session-ID pairs. Retained Nova bindings are supplied at managed runtime startup, and the pre-dispatch handshake registers new and forked bindings. An unrelated main-agent session bypasses this policy even when Nova's bridge is offline. A registered protected session remains blocked when its policy cannot be checked. The service separately exempts ordinary and Goal work when no unapproved plan is pending. Regression tests cover both unrelated-session bypass and protected-session bridge failure.
