# Assistant Auto effort

Auto is an additional position immediately after Default in the existing response-effort slider. It does not change the control layout, the selected model, the default preference, speed settings or existing manual choices. Reset still restores Default. Models without advertised, recognized effort levels do not gain a selectable Auto position.

Default leaves effort with the provider. Auto uses a local, deterministic task policy: straightforward rewrites or definitions can use low effort; ordinary work uses medium; debugging, substantial sources, compound requirements and Research use high. This is a practical policy, not a guarantee of an optimal reasoning level. It makes no additional model or classifier request. Reading the runtime's model catalog is separate from running a model.

Task demand is captured with the saved submission or queue item, including attachment size/count, project instructions and work mode. A short continuation inherits the prior task's demand. Editing a queued message updates its demand while retaining its captured sources. Before the first send, Nova resolves that demand to a level advertised by the captured model and saves the decision on the original operation. A catalog with a smaller ceiling uses its strongest supported level. An unavailable catalog or missing capability uses provider defaults and retains `capability-unavailable` as the decision reason; it never invents a supported value or changes models.

Unknown send outcomes retain that exact saved decision and request identity. Refreshing, restarting or reconciling the operation does not classify or send it again. Steering adds direction to the existing run without changing its effort. Revised replies and plan amendments are new requests and may receive a new decision.

The literal `auto` is a Nova preference and is never sent as native `thinking` or `thinkingLevel`. Choosing Auto clears a previous manual session override through the existing settings confirmation/recovery process. New and continued conversations keep their local Auto preference while the native session receives its default setting.

Goal and live voice retain their separate provider/session-managed reasoning contracts. Auto currently chooses per-request effort for ordinary text, Plan, Research and Image requests. A Goal operation records `session-managed`, rather than claiming task-specific effort selection.

Verification covers task classification, advertised capability subsets, Default/manual preservation, queue edits, continuation, steering, uncertain-send reconciliation, settings recovery and restart. Synthetic transport tests verify the actual parameters Nova sends. Live provider behavior and the rendered control require release-candidate acceptance separately.
