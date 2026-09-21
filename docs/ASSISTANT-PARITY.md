# Assistant Chat: Nova Dream 2.0 Acceptance

Updated 21 September 2026. Source audit baseline: 1.9.4. The 1.9.5 fixes below are a first implementation slice; they do not establish full parity or live delivery.

## Product Priority

Assistant Chat is the primary acceptance target for Nova Dream 2.0. Familiar ChatGPT/Codex conversation workflows take priority over unrelated Home or startup polish. Keep Nova's warm palette, lynx identity, tactile controls, compact composer and shared reading alignment. A feature counts when its complete user journey works, including recovery and saved results; a matching icon or prompt mode is insufficient.

Use the available Windows desktop conversation experience as the main comparison, with the same essential journeys accessible in Nova's narrow browser layout. Platform-specific capabilities and account entitlements must be identified individually. Do not imply that connecting an account gives Nova every feature of the first-party product.

## Reference Experience

Official references checked on 20 September 2026:

- Chat, Work and Codex cover conversation, longer tasks and developer workflows, with availability depending on the surface and account. [Using ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt).
- Projects organize conversations with shared files and instructions; history includes search and organization. [Projects](https://learn.chatgpt.com/docs/projects).
- Keyboard access includes creating conversations, searching and voice controls. [Commands](https://learn.chatgpt.com/docs/reference/commands).
- Supported desktop file workflows include document, spreadsheet, presentation and PDF previews, interactive HTML where available, and focused revisions using annotations. [Working with files](https://learn.chatgpt.com/docs/artifacts-viewer).
- Live voice is distinct from dictation and can discuss or steer task work; screen context and other capabilities vary by platform and rollout. [Voice](https://learn.chatgpt.com/docs/features/voice).

These references describe the target workflows. They are not evidence that Nova implements them or that every reference feature is available on every device.

## Current Inventory And Remaining Gaps

“Implemented” below means a traced source path, not fresh provider acceptance. File paths are relative to the application root.

| Journey | Nova baseline | Remaining acceptance work |
| --- | --- | --- |
| Compose and send | Retained multiline draft, IME-aware Enter, paste/drop/picker, queued follow-ups and exact request receipts. `apps/client/src/Assistant.tsx`, `apps/service/assistant.ts`. | Verify real send, reconnect and retention together; never clear rejected input. |
| Control an active reply | Streaming text, tool activity, plans, stop/reconcile, queue management and steering exist. | 1.9.5 keeps Stop reachable while drafting. Verify stop during text/tool work, unknown outcomes and queue ordering on a connected runtime. |
| Edit, retry and branch | Edits/retries retain original conversations using native forks. | 1.9.5 exposes common actions and repairs nested family navigation. Inline message alternatives remain open work; preserve exact ancestry and all saved branches. |
| History and projects | Saved account-independent transcripts, pagination, reading position, pin/archive/delete, projects with captured instructions/files. | 1.9.5 adds direct New Chat with history closed and semantic selection. Current-chat search, next/previous matches and search-result pagination remain missing. |
| Model, effort and access | Dynamic model inventory, reasoning, speed, account preferences, permissions and pending settings recovery. | 1.9.5 adds current settings to accessible descriptions/tooltips. Compact visible state and verified effective settings need focused acceptance; advertised model names alone do not prove modality/tool support. |
| File input | Verified retained attachments; dispatch currently accepts TXT, MD, JSON, CSV, PDF, PNG, JPEG and WEBP. | 1.9.5 checks format before admission. Office documents and additional code/media formats need verified ingestion, not just successful upload. Check draft and Project files consistently. |
| Replies and artifacts | Markdown, tables, code copying/highlighting, saved artifact identity, image/text previews, output versions, download and Refine. | PDF/Office/media/interactive previews, targeted annotations, larger bounded transfers and format-specific verification remain incomplete. Preserve authenticated, hash-bound reads and isolate executable previews. |
| Research and citations | Research instructions, available web-tool activity and plain linked answers. Captured Project sources are inspectable. | Preserve actual search/fetch evidence tied to run and answer; render claim-linked citations and web source details. Project sources and discovered web evidence must remain distinguishable. |
| Tools, skills and modes | Native skill inventory/setup states, reviewed skill proposals, permission controls and tool execution bridge. Image/Research currently supply instructions. | Show conversation-aware availability and setup from the composer. A mode must neither invent availability nor silently change access. Validate actual image/tool outcomes. |
| Voice and dictation | Dictation plus same-chat WebRTC voice, interruption, captions and Assistant consultation. | Verify microphone, interruption, retained captions and task steering end to end. Live camera/screen sharing requires separate capture/transport support; it is not implemented by the voice client. |
| Developer tasks, memory and longer work | Work/checkouts, changes/review, goals, team workflows, memory and scheduling have their own implementations. | Exercise invocation and return-to-result from Chat. Review files, changes and approvals without losing the conversation; do not equate separate module availability with complete Chat integration. |
| Sharing and portable history | Saved transcripts and copying exist. | Define and verify safe snapshot sharing/export, audience and retained context. A shared link, cross-device continuity or whole-project export has not been accepted in this audit. |

## Implementation Order

1. **Core conversation controls and reliability.** Finish the 1.9.5 fixes, then inline revision navigation and current-chat search. Preserve the compact action row, direct common actions, keyboard focus and original writing.
2. **Files and usable results.** Deliver verified ingestion and in-chat preview for the common formats, then version-aware interactive outputs and focused refinement. Start with the existing retained-file pipeline; keep unsupported formats explicit until their full journey works.
3. **Research and capability readiness.** Add structured evidence and source navigation alongside an honest view of available tools, skills, models and prerequisites. Confirm capabilities using supported runtime APIs or an owned plugin extension.
4. **Voice, developer work and continuity acceptance.** Complete end-to-end checks across typed and spoken work, reconnection, account changes, reloads and narrow layouts. Close the remaining integration gaps from the inventory before claiming parity.

## Required Evidence For 2.0

For each journey record the exact version, platform, connected runtime capabilities, test steps, observed outcome and any limitation. Keep fixture results separate from real connected execution. Unavailable capability reads mean “unverified,” not success. Do not use a single parity percentage.

- A new and an existing conversation both send, stream, stop, queue, steer, edit and retry without losing drafts, files or earlier responses. Stop remains reachable while composing. A lost response never causes an automatic duplicate action.
- Multiple nested revisions can return to the true original and related alternatives. Replaced native histories, missing parents and invalid cycles never merge unrelated conversations.
- Search finds old messages and returns the user to the exact saved position. New Chat, project changes, collapsed history and narrow side panels preserve writing and understandable selection.
- Accepted files can actually reach the runtime; rejected formats retain their draft before admission. Generated results open, download and refine against the exact saved version. Preview errors do not discard outputs.
- Research sources reflect observed evidence. Model, tool and permission availability is accurate before and during work, including pending changes and unavailable services.
- Voice handles dictation separately, interruption and ending predictably, and preserves conversation continuity. Account replacement, reload and reconnect leave saved work retrievable with honest incomplete/unconfirmed states.
- Inspect the real affected UI at a normal desktop width, a desktop conversation narrowed by its side panel, and 390/320 px browser widths. Check selected light/dark states, keyboard focus, 44 px essential targets, overflow, long content and loading/error states. Avoid unrelated visual matrices.

The 2.0 claim remains open until these workflows have the required evidence or a clearly agreed, visible capability boundary. This document is the shared product checklist; private QA records hold machine-specific evidence and deployment details.
