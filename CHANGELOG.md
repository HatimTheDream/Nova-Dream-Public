## [1.13.15] — 2026-09-25

- Preserve strict saved-work verification while recognizing regenerated Codex process/cache records and physical file fingerprints after an independent recovery copy.
- Includes the Assistant cold-start, trusted Codex component, accurate failure reporting, and bounded account-check fixes from 1.13.12–1.13.14.

## [1.13.14] — 2026-09-25

- Keep account checks from spawning overlapping agent processes or running during updates; preserve sign-in and account routing.
- Verify historical configuration promotion records correctly during updates and recovery while retaining strict checks on the current configuration and saved data.
- Includes the Assistant cold-start, accurate failure reporting and trusted Codex component fixes from 1.13.12.

## [1.13.13] — 2026-09-25

- Check full backup and recovery capacity after the agent has stopped and released temporary plugin copies. Keep staging reserves and restart the unchanged app if closed-state capacity is insufficient.
- Includes the Assistant cold-start, accurate failure reporting and trusted Codex component fixes from 1.13.12.

## [1.13.12] — 2026-09-25

- Keep Assistant preparation waiting through a cold agent startup, without retrying message sends or weakening duplicate-send protection.
- Explain preparation failures accurately when the saved input was never sent.
- Install the Codex component through its official, version- and integrity-pinned package so upgraded agents retain the trusted storage needed to answer requests.

## [1.13.11] — 2026-09-25

- Check full recovery space while the managed service is stopped, then verify operating space after restart. Avoid rejecting an otherwise verified combined update because of temporary agent startup files that are removed before restoration.

## [1.13.10] — 2026-09-25

- Verify saved data after the upgraded service has settled and stopped, then restart and confirm readiness before completing the update. Keep temporary SQLite activity from causing a false data-loss failure without weakening retained-data checks.

## [1.13.9] — 2026-09-25

- Verify unchanged maintenance jobs before the agent starts and the reviewed replacement after startup, so combined updates can complete both stages without weakening saved-work checks.

## [1.13.8] — 2026-09-25

- Complete combined updates when verified Nova plugins move to the new installation folder, while preserving checks on saved settings, accounts, permissions and recovery data.
- Recognize reviewed OpenClaw startup migrations for missing session titles and built-in maintenance jobs without allowing changes to user-created schedules or saved content.

## [1.13.7] — 2026-09-24

- Recognize OpenClaw 2026.9.6's update-readiness response so combined updates can finish verification and resume Assistant access. Keep active work and unrecognized responses blocked.
- Pause background mail indexing during update verification and resume from the retained page when maintenance ends.

## [1.13.6] — 2026-09-24

- Complete combined app and agent updates without mistaking verified configuration-size changes for lost saved data.
- Verify restored older versions without requiring model access while the agent is paused, and preserve the original failure reason for diagnosis.

## [1.13.5] — 2026-09-24

- Keep Assistant startup, transcript refresh and automatic planning paused during software updates. Resume reconciliation after the update without replaying messages or rewriting already interrupted outcomes.
- Verify embedded agent records and expected restart metadata without mistaking database checkpoints or appended diagnostic logs for lost saved work.
- Include OpenClaw's matching agent plugin in the combined offline update. Verify its executable and retained settings, and reuse an already verified runtime without reserving its storage twice.

## [1.13.4] — 2026-09-24

- Verify that Nova's service account can run a staged agent update before pausing the app, including runtime folders retained from an interrupted attempt.
- Separate held installation checks from post-restart model checks. Keep work paused and show Checking until the resumed Assistant proves it is ready.
- Preserve committed native database journals during recovery verification without altering the retained recovery copy.

## [1.13.3] — 2026-09-24

- Wait for brief account checks to settle during update verification, including before installation and when confirming that a stopped attempt changed nothing. Keep the existing timeout, saved-account checks and maintenance protection.

## [1.13.2] — 2026-09-24

- Allow software updates after historical interrupted steering and ended meetings when their exact related work has finished. Preserve those records and their original outcomes; active, uncertain or mismatched related work still blocks installation.
- Refresh model availability after reconnecting so update verification can finish without opening Assistant manually.

## [1.13.1] — 2026-09-24

- Check OpenClaw releases separately and show the installed and available versions. Keep a single compact action: Update Nova Dream, Update OpenClaw, or Update all when both change.
- Support signed application-and-engine packages, a separate compatible engine runtime, native data migration and paired restoration. Preserve the exact reviewed update request through reconnects, including engine-only updates.
- Keep historical uncertain requests without letting them permanently block maintenance; active work and unsettled effects still prevent installation. Extend the existing account, source, module and worker adapters to the reviewed OpenClaw 2026.9.6 release.

## [1.13.0] — 2026-09-24

- Add compact Software Update settings with installed Nova and agent versions, concise release notes, a quiet availability indicator, manual checks and shared daily checks of signed compatible releases.
- Retain each update request through reconnects and restarts, verify downloaded packages before execution, and show observed installation stages and measured download progress.
- Wait for active work and account changes, preserve owned agent admission during maintenance, and support a separately provisioned Linux host updater with retained recovery and exact outcome verification.

## [1.12.11] — 2026-09-24

- Show Nova Dream and the connected agent service's reported version in About, replacing the redundant build number. Keep the display accurate through connection changes and avoid background reads when About is closed.

## [1.12.10] — 2026-09-24

- Dictation writes directly into the composer as words arrive, with recording state shown on the microphone button. Keep surrounding writing and edits, avoid duplicate insertion on Stop, and retain interrupted transcripts for recovery.
- Clarify Google and Microsoft sign-in failures, add contextual Google testing and organization guidance, and preserve existing account connections and interrupted sign-in requests.

## [1.12.9] — 2026-09-24

- Simplify Settings into flat, compact rows and optional details. Keep separate font and size controls for the app interface and Assistant messages, with an expandable preview.
- Give connected accounts contextual management controls and accurate partial-connection status. Keep unresolved sign-ins, recovery notices and active actions visible.
- Put backup and recovery first, keep computer access controls accessible, and reduce unnecessary background status checks while preserving pending requests across navigation and workspace changes.

## [1.12.8] — 2026-09-24

- Give App interface and Assistant messages separate font and text-size preferences, preserving existing device choices. Keep message reading independent of navigation, controls and the composer, with readable touch-screen input and monospace code.
- Simplify Settings into compact grouped rows with aligned controls, a category sidebar on wide windows and a single scrolling category row on narrow screens.

## [1.12.7] — 2026-09-24

- Connect Chat Research workload estimates to the original run’s native tool activity, including cached runtime tools. Handle updates arriving before their activity event, preserve exact retry identity, and reject late progress after Stop, disconnection or completion.

## [1.12.6] — 2026-09-24

- Admit Research progress through the runtime’s awaited tool-preparation callback, using its exact native task and call identity before execution. Preserve cancellation and approval checks while allowing workload updates through the connected model’s prepared tool set.

## [1.12.5] — 2026-09-24

- Fix live Chat Research workload reports being rejected when the runtime discovers tools separately from its policy hooks. Keep progress tied to the exact approved research run and native tool call, so the linear estimate can advance with reported completed work.

## [1.12.4] — 2026-09-24

- Make Assistant reading more compact with a system-font default, smaller message text and quieter headings. Add Font and Assistant text size choices with an immediate preview in Settings, saved on this device.
- Give Chat Research short action titles while retaining the full approved instructions in expandable details. Replace the looping activity animation with a linear, explicitly estimated progress bar based on task-specific completed and remaining research work, including subtasks within broad actions.
- Save research workload estimates with the exact approved run, reconcile updates and preserve completed work. Update the specific activity line as the investigation develops, hold retained progress during interruptions and confirm completion only when the actual report finishes.

## [1.12.3] — 2026-09-23

- Fix voice calls incorrectly stopping with “The conversation or Project changed” when selecting the connected account updates the chat timestamp. Keep checks for genuine conversation, Project and permission changes.

## [1.12.2] — 2026-09-23

- Show the current search, source read or reported research subtask beneath a stable approved outline, with activity details available inline.
- Use an activity bar when remaining research work is unknown instead of treating completed checklist rows as an overall percentage. Keep completion tied to the actual finished run.
- Pause live indicators when updates are unavailable or research needs an answer, and preserve clear stopping and interruption states without borrowing activity from another run.

## [1.12.1] — 2026-09-23

- Simplify the active Chat Research card: keep the activity list, show a quiet Researching status above a slim progress bar, and place a circular Stop control beside the bar.
- Remove the visible step counter, duplicate elapsed timer and repeated tool details; retain accessible measured progress and interruption recovery. Keep the card on the same raised surface as the composer.

## [1.12.0] — 2026-09-23

- Give Chat Research a saved research plan, edit/start/cancel controls, a service-owned start countdown, read-only investigation progress, and interruption recovery. Keep Work Research in the normal Codex-style conversation flow.
- Show completed-versus-total observed research steps in a linear bar and distinguish research cards from the conversation background.
- Keep completed Chat research reports inside the conversation, with in-place expansion, actual citation links, observed activity and Markdown export; remove the floating document viewer.
- Preserve exact research decisions across retries, pause automatic starts after disconnect or restart, and prevent stale edits or approvals from starting duplicate work.

## [1.11.0] — 2026-09-23

- Show a rounded, animated dot placeholder for observed image-generation calls; freeze it when stopping or unconfirmed, and remove it when the call ends. Give returned images a quieter, image-first layout with direct viewing, download and refinement. Keep image results visible outside collapsed work details, including after reopening a conversation.
- Read Word, Excel and PowerPoint attachments through bounded text extraction, retaining original files and hashes, spreadsheet formulas/cached values, and slide notes. Reject unsafe or unreadable documents before sending.
- Compact numbered question paging and Goal controls while preserving saved answers, exact approval identities and visible recovery for uncertain outcomes.
- Give completed Research replies an expanded reading view and a compact list of their actual source links, including when reopening saved conversations.

## [1.10.10] — 2026-09-23

- Clear every Assistant feature chip as soon as Send, Queue or Steer is pressed, including failed and unconfirmed attempts, while preserving the submitted feature and exact retry identity.
- Keep subsequent messages in Chat and protect new writing or explicitly reselected features from late responses, conversation changes and plan approval.

## [1.10.9] — 2026-09-23

- Restore dictation setup when multiple agents are configured by explicitly addressing its isolated main-agent session.
- Let a connecting recording be cancelled, keep slow microphone setup alive, explain microphone and no-speech failures, and prevent stale errors from stopping a retry.
- Keep dictated phrases in spoken order, preserve the existing draft, and retain unconfirmed words for review instead of silently losing or submitting them.

## [1.10.8] — 2026-09-23

- Keep each chat focused on its own questions and approvals. Remove the cross-chat request tray and review shortcuts from the composer while preserving requests in their original conversations.

## [1.10.7] — 2026-09-23

- Show each answered question batch as a normal, visible user reply with muted questions above the answers, following the supplied Codex reference. Keep replies visible when work details collapse.
- Place new answer replies between the surrounding assistant messages using the saved first resolution observation; preserve legacy history without inventing its answer time.
- Keep Next and Previous limited to question navigation, including after revisiting completed answers; submit the batch only with Send answers.

## [1.10.6] — 2026-09-23

- Return the composer to writing after questions are answered. Keep confirmed answers in compact conversation bubbles with an Asked questions summary, following the Codex interaction pattern.
- Preserve completed question history when a chat resumes on a new connection; keep pending and unconfirmed requests tied to their original authorization and status checks.

## [1.10.5] — 2026-09-23

- Keep older planning messages readable after native history refresh by recognizing their original saved instruction format. Internal planning instructions stay hidden while the owner's exact message remains visible.

## [1.10.4] — 2026-09-23

- Make Auto the single automatic effort choice; remove Default from the existing effort slider. Reset and model changes select Auto.
- Use task-aware Auto for new work with legacy Default preferences while preserving manual choices and already captured work.

## [1.10.3] — 2026-09-23

- Keep plan proposals inside the conversation with expansion in place, earlier versions and an optional desktop reading panel.
- Replace separate plan approval buttons with an Implement this plan? question, a numbered Yes answer and retained amendment writing. Skip returns to the saved message draft; revised plans require a fresh decision.
- Preserve exact proposal approval, single execution and recovery of unconfirmed decisions across navigation and retries.

## [1.10.2] — 2026-09-23

- Show Assistant question sets one question at a time with Previous/Next navigation, retained answers and complete-set submission from the last question.
- Clear the Plan composer chip after an accepted assignment or queue submission while preserving the submitted planning workflow and unsent writing.

## [1.10.1] — 2026-09-22

- Give Assistant messages and the surrounding composer area one continuous background in both themes, preserving the distinct chat header and input controls.
- Include the saved planning, Auto effort, Read aloud, generated-image actions, Goal polling and steps-pill improvements from 1.10.0.

## [1.10.0] — 2026-09-22

- Add saved Assistant plans with numbered questions, retained proposal versions, amendments and exact approval before one implementation run. Enforce Plan and Research tool restrictions through the managed runtime.
- Add Auto to the existing effort control, choosing a supported reasoning level for each text request and preserving that choice through queues and uncertain retries.
- Improve Read aloud with speech-ready text, sentence-aware chunks, configured speech playback and explicit device-voice fallback; keep preparation, pause and stop tied to actual playback.
- Show generated images in the conversation with direct View, Download and Refine actions; retain the existing composer prompt, mode chips and menu layout.
- Stop recurring Goal reads in ordinary chats without goals and surface unconfirmed goal status with recovery.
- Fix the doubled steps-pill outline and remove it after confirmed completion, retaining interrupted and unconfirmed progress for review.

## [1.9.14] — 2026-09-22

- Add reversible project removal from Assistant and Project settings, with Restore in Deleted. Keep conversations, drafts, source folders and captured work intact; hide removed projects from new-work choices.
- Keep a full-width, two-line Inbox list by default on every screen, with visible Flag, Pin and Trash inside each row. Make the side-by-side reading pane an optional wide-window view, unify provider flags, and fix cramped menus and header spacing.
- Clarify mail action reviews and older-mail synchronization status without adding background polling.
- Use plain Calendar day numbers, highlight the selected date independently of today, and display events as flat rectangular blocks with explicit overflow counts and complete narrow-screen view controls.

## [1.9.13] — 2026-09-22

- Use matching 44 px mascot, module and header buttons on mobile and desktop, with a 60 px docked rail and clear 24 px module icons.
- Keep navigation options aligned beside the compact rail while preserving the persistent header, saved sidebar visibility and working drafts.

## [1.9.12] — 2026-09-22

- Match the persistent header mascot to the square module buttons at every screen size.

## [1.9.11] — 2026-09-22

- Keep the Nova mascot visible in the app header whether navigation is shown or hidden.
- Dock square module buttons beside the workspace on mobile and desktop, resize content when toggled, and remember the chosen sidebar visibility.

## [1.9.10] — 2026-09-22

- Restore the mascot and square module buttons in compact mobile navigation, with a nearby Close control, scrollable modules and Settings kept at the bottom.

## [1.9.9] — 2026-09-22

- Reduce repeated workspace and Assistant reads while idle, on another page or in a hidden tab; refresh promptly on return and retain fast updates for active work.
- Back off failed background reads instead of repeatedly retrying at the normal active rate, without replacing pending requests or interrupting server work.
- Reduce idle Connections and empty request-card polling, stop recurring closed or completed tool-view checks, and preserve discovery of tool images that arrive later.

## [1.9.8] — 2026-09-22

- Make Voice the primary empty-composer action on desktop and narrow screens; switch to Send for text or files, and Stop or Queue during work. Keep dictation separate and prevent empty Enter from starting a call.
- Show waiting messages as compact visible rows directly above the composer, with direct Remove and supported pause/review actions. Clear admitted rows from the live queue and retain earlier items in conversation-menu history.
- Preserve queued writing, independent drafts, paused edits and original uncertain submissions. Record the remaining differences from Codex queue steering and editing honestly.

## [1.9.7] — 2026-09-21

- Center Assistant replies and the composer in a tighter reading column, with quieter spacing around work activity.
- Group a verified reply’s commentary and tool activity behind one elapsed-time disclosure: Working for while active, Worked for after completion, and clear stopped or unconfirmed states. Keep the final answer visible and preserve exact saved-message links.
- Combine each identified tool call and result into one compact action with useful, bounded input details, Copy controls and expandable output. Distinguish blocked execution from errors and unknown outcomes without inventing success.
- Keep elapsed time fixed after completion, refresh changed activity metadata, and preserve voice captions, attached files, search matches and uncertain-operation recovery.

- Collapse adjacent successful actions into quiet summaries; keep blocked, failed, running and unconfirmed actions distinct, and reveal exact saved details for search.
- Simplify queued messages and approval/question cards around clear primary actions with contextual secondary controls. Retain drafts through question expiry and move completed questions into request history.
- Correct Markdown reply paragraphs that rendered smaller than the intended reading size, and preserve stronger tool-result evidence when later history is uncertain or contradictory.
- Put saved input and output together in one Shell/Details surface with a full-value Copy action; remove excess depth from Assistant controls and keep the model discoverable on narrow composers. Voice remains in Add to message when space is tight.
- Preserve tool-only completion timing, refresh identities from overlapping history, reconcile truncated/full action results, and avoid repeated tools around steering messages. Reopen collapsed details when navigating to a new saved search target.
- Repair duplicated retry prompts when a native receipt arrives before its send acknowledgment. Preserve original records, files and message links, and restore the exact reading position when repaired history changes pagination.

## [1.9.6] — 2026-09-21

- Simplify Assistant attachments, output actions and narrow conversation headers while preserving the compact effort slider. Clarify paused messages, plan steps, unconfirmed activity, Deleted conversations and voice-caption recovery.
- Show invalid-input Send/Queue states and pending workspace changes clearly without discarding writing or replacing retained requests. Explain empty saved user entries while preserving their original identity and files.
- Bring Content writing forward with one title/save header, optional brief details and quieter cards; simplify Inbox folder navigation and explain agent readiness beside its action.
- Remove Calendar's duplicate day summary, keep one readable agenda, and place optional event details behind a disclosure with reachable save actions.
- Simplify agent and assignment forms, make setup requirements actionable, and provide ordinary Daily/Weekly routine controls while preserving custom schedules.
- Give phone-width workspaces an on-demand navigation drawer, simplify widget configuration around one preview, and improve search alignment, task/event labels and settings wording.

## [1.9.5] — 2026-09-21

- Keep Stop Reply available while writing or attaching a follow-up, alongside queue and steering controls, without clearing the draft.
- Put Edit, Try Another Response and Read Aloud directly beside messages. Provide New Chat/New Work with history closed, announce selected history rows and describe current response/access settings for assistive technology and tooltips.
- Navigate complete verified conversation branch families, including nested revisions, and move branches into the first level of the conversation menu. Keep unrelated or replaced histories separate and label missing ancestors honestly.
- Check supported Assistant attachment formats before staging or admitting a new message, including saved Project sources. Preserve unsupported files, drafts and pending request reconciliation; keep general workspace file storage unrestricted by this send contract.
- Make Assistant Chat parity the primary Nova Dream 2.0 acceptance checklist, with remaining file previews, research evidence, search, capability discovery and connected workflow verification recorded explicitly.

## [1.9.4] — 2026-09-20

- Keep the current chat or task editor open when device storage cannot retain its newest writing. Check the current draft before navigation, preserve pending save receipts, and allow navigation again once retention or host saving succeeds.
- Explain Team Work prerequisites beside Start, identify unavailable saved projects or team members, and keep uncertain starts tied to their original request.
- Preserve original capitalization in conversation titles, contacts, filenames, models and other saved content while keeping action labels in Title Case.
- Make navigation options keyboard accessible with Escape dismissal, predictable focus return, outside dismissal and clear reorder limits.

## [1.9.3] — 2026-09-20

- Keep account selection in a compact composer button beside the model control. On narrow layouts, find it inside Response Settings; account names, usage and selection feedback stay in the menu without adding a permanent toolbar row.

## [1.9.2] — 2026-09-20

- Keep a known exhausted ChatGPT account out of the next-request selection until its reported reset, even when usage becomes stale. Unknown reset times use the last successful reading's bounded freshness; failed refreshes cannot extend it indefinitely.
- Retain unconfirmed voice captions in their original chat on the current device after closing, reloading or starting another call. Keep their unconfirmed label and preserve the original call if browser storage cannot save them.

## [1.9.1] — 2026-09-20

- Show Account Status Unavailable when account status cannot be read, instead of incorrectly saying no account is connected; preserve known account labels and counts.

## [1.9.0] — 2026-09-20

- Keep conversations, saved replies, voice captions, pins and verified files in Nova independently of a ChatGPT account. Migrate saved history incrementally and show incomplete coverage honestly.
- Connect multiple ChatGPT accounts with separate Add Account and Reconnect actions, independent usage/reset readings, duplicate identity detection, and a preferred/backup order.
- Select an account per chat or use the default order. Choose a ready backup before a new reply while preserving the same chat and context; never replay an uncertain request.
- Resume saved Chat conversations on a replacement Assistant connection without creating a second visible chat. Carry reviewed dialogue and verified files into the next message; keep drafts, Projects and memory. Work checkouts and missing sources retain explicit recovery requirements.
- Preserve reading positions and historical source links across account changes. Save voice captions locally even when the native transcript acknowledgement is delayed.
- Fix Windows sign-in process cleanup so closing or replacing a sign-in stops its owned terminal process.

## [1.8.13] — 2026-09-20

- Keep the latest-message arrow centered without voice and beside the voice controls during a call, without adding a row or lifting the mascot. Reserve horizontal space on narrow layouts so the controls stay in place as the arrow appears.

## [1.8.12] — 2026-09-20

- Shorten warm voice setup by avoiding unrelated conversation review waits and overlapping independent preparation checks; reconnects keep their own provider catalog requests.
- Use semantic speech boundaries to allow natural pauses within a thought.
- Keep live captions in conversation order across history refreshes and pagination. Preserve visible words when a provider final is blank, marked as unconfirmed.
- Protect captions from concurrent admission updates, settle silent interrupted replies, and finish queued caption saves before closing a call. Late callbacks from an ended call cannot stop a new call.

## [1.8.11] — 2026-09-20

- Restore voice startup when the provider omits or normalizes its optional caption-delay setting, while still requiring the correct transcription model and captured conversation context before audio is admitted.
- Automatically show connection errors so a failed call no longer appears as just the mascot and a close button.
- Replace Latest with a compact down-arrow button below the voice controls, keeping its accessible label and scroll behavior.

## [1.8.10] — 2026-09-20

- Keep Latest below the voice controls and above the message box, with enough transcript clearance for the full dock and last message.
- Automatically dismiss a normally ended call once its captions are confirmed saved; keep uncertain or unsaved captions available for recovery.
- Enlarge the voice mascot to 104 pixels while keeping compact call controls and the shared squircle shape.
- Give listening a distinct ear-wave cue and react to measured microphone or playback sound; silence, mute, interruption and ended calls settle the motion, with a static reduced-motion alternative.
- Favor balanced speech-caption accuracy over the earliest partial words, and verify the transcription configuration before admitting microphone audio. Preserve final captions and their original turn identities.

## [1.8.9] — 2026-09-20

- Show the Listening expression whenever a connected microphone is ready, including the silence before speech.
- Fill a logo-sized voice tile with the selected lynx artwork and remove visible status subtitles and the disclosure arrow.
- Float compact voice controls over the conversation, keeping chat visible beside them and the last message reachable.
- Use a pulsing brand-red rounded square during voice setup, with a static reduced-motion alternative; keep accessible status and call recovery controls.

## [1.8.8] — 2026-09-19

- Remove the redundant Chat / Work / Team Work row above Assistant conversations. Keep space switching in the sidebar and Team Work in the side-panel launcher.
- Replace the old Assistant and voice mascot graphics with the selected Red or Cream executive lynx, including Idle, Listening and Speaking expressions.
- Keep voice artwork aligned with the current call state, and remove unused legacy mascot assets.

## [1.8.7] — 2026-09-19

- Match desktop and web-app launcher icons to the app's borderless squircle shape, with transparent corners in both Red and Cream exports.
- Preserve the approved face, colors and suit; keep Apple touch icons opaque for the platform's own masking.

## [1.8.6] — 2026-09-19

- Preserve uncertain Assistant work requests across sign-in, app-update, access and workspace interruptions. Reconciliation reuses the original request after reconnecting instead of allowing duplicate team work or other work actions.
- Keep unsupported browser addresses and repository branches editable before a work request is saved; share the field rules with the server.
- Include the 1.8.5 history, draft/attachment, team-recovery and question refinements together with the approved button styling.

## [1.8.5] — 2026-09-19

- Keep Assistant history steady while background updates arrive: finish requested pages, preserve loaded messages after failed reads, and retain the same archived reading view during refresh.
- Wait for selected files and recovered attachments to finish preparing before sending, queuing, steering, starting voice or switching spaces.
- Reconcile the original Team Work start after a lost response or browser-storage failure; keep pending receipts visible until they clear.
- Recheck question deadlines and conversation access immediately before answering or cancelling, preventing stale requests after expiry, archiving or deletion.

## [1.8.4] — 2026-09-19

- Adopt the approved Nova × Duo button treatment: clean filled faces, a solid lower accent edge, tighter ordinary corners and full-depth press feedback, retaining Nova's colors and Title Case labels.
- Keep neutral controls readable with a subtle border and lighter lower edge; preserve compact controls, keyboard focus and the logo/module squircle geometry.

## [1.8.3] — 2026-09-19

- Give the Home logo a red accent shadow and the same tactile press feedback as the other action buttons, preserving the borderless artwork and 60 × 60 tile.
- Make Assistant actions, compact widget controls and button-shaped links use consistent raised, hover, pressed and focus states. Preserve positioned controls when pressed and keep dismissal overlays translucent.
- Return keyboard focus to the widget Options button after closing its menu or customization dialog.

## [1.8.2] — 2026-09-19

- Introduce borderless Red and Cream executive lynx icons. Choose either in Settings → General → Appearance; the saved choice updates Nova's in-app identity, browser icon and notification artwork independently of the color theme.
- Match the logo and module buttons at 60 × 60 with soft squircle corners. Fill the logo tile edge to edge and preserve the same dimensions on narrow screens.
- Preserve the chosen icon across reopening, connected clients, backups and older layout edits. Add matching browser-install exports and a shared design reference for future UI work.

## [1.8.1] — 2026-09-19

- Match sidebar module rearrangement to Home widgets: a lifted icon follows the pointer, neighboring icons animate into place, and the drop settles into its saved position. Support holding to move, touch scrolling before pickup, keyboard moves, reduced motion and cancellation without accidentally opening a module.

## [1.8.0] — 2026-09-19

- Rebuild the Home widget library around visual previews and clear size choices. Create multiple independent widgets with names, readable color choices, filters, notes and website bookmarks; duplicate, hide, restore or remove them while preserving unfinished editor drafts.
- Add separate Clock, Weather, Next action, Daily routines and Next appointment widgets. Use saved task readiness, recurring occurrences and calendar data; keep stale or incomplete external data clearly labeled.
- Add visible drag-and-drop placement and smooth widget rearrangement, including keyboard moves and a hold-to-move gesture. Replace Home mascot art with size-specific date/time layouts and condition-aware weather graphics; retain the red calendar event accent. Hide Home and sidebar scrollbars while preserving scrolling; use compact icon controls with readable labels.
- Give equal widget sizes consistent dimensions and fit useful content to each size without internal scrolling, make Home actions readable without redundant arrows or decorative badges, and open specific tasks directly from attention items.
- Unify action buttons around the rounded, raised navigation style and keep list-item typography consistent across tasks, routines, links and appointments.
- Center and evenly space Settings tabs, show the release version clearly with internal build details tucked away, clarify optional Tailscale pairing, and fix clipped controls in the collapsed navigation rail.
- Preserve saved boards, custom writing, task history and backup restoration with the schema 55 upgrade. Resetting the Home arrangement keeps custom widget content.

## [1.7.1] — 2026-09-19

- Make Home setup steps and destination actions visibly clickable before hover, with persistent borders, filled backgrounds, stronger labels and comfortable spacing.
- Keep completed-step badges, clear hover and pressed feedback, keyboard focus, dark-theme contrast and wrapping in narrow widgets.

## [1.7.0] — 2026-09-18

- Keep Chat, Work and Team work controls visible above existing conversations, with a direct Team work entry that preserves the current conversation and unsent writing.
- Save structured reviewer findings, priorities, locations and reported checks. Distinguish Needs changes, Ready for your review and missing or unconfirmed reports; a finished response alone is never accepted as a clean review.
- Apply confirmed findings through an explicit builder fix and independent re-review, capped at three owner-started rounds. Preserve captured member settings, checkout changes, every prior stage and review, and the same command after uncertain responses or reloads.
- Scope report submission and reading to the original authorized team execution, keep reviewers read-only apart from their report, and preserve older generated briefings without overwriting owner edits.

## [1.6.0] — 2026-09-18

- Preserve complete immutable team handoffs, with bounded excerpts and paginated reads for the owner and the next authorized agent. Keep results after their original conversation is removed.
- Retry a confirmed failed stage as a new attempt in the same checkout. Retain earlier attempts, outputs and unsent writing; reconcile the same retry request after a lost response or restart.
- Show finished-stage counts, explicit unknown and stop-requested states, and the need for owner review. Keep unsafe retry and resume actions unavailable while the original outcome is unconfirmed.
- Protect settled Assistant outcomes from late status or cancellation responses, and upgrade exact older generated briefings without replacing owner edits.

## [1.5.13] — 2026-09-18

- Choose suitable team members for Research, Implement and Review without consuming specialists as fallbacks. Keep ambiguous roles explicit and preserve saved choices and pending starts.
- Clear recovered team-status read errors without hiding failed actions, and cancel obsolete reads when leaving the view.
- Open the correct Home settings category, include overdue deadlines in Attention, and distinguish future or completed work from an empty workspace.
- Show connection checks as pending until observed, and decode Inbox preview entities and invisible preheader padding while preserving meaningful Unicode and original messages.
- Support Windows Git checkout reviews with the normal symlink setting, and make development test fixtures portable across Windows and POSIX hosts.

## [1.5.12] — 2026-09-16

- Show startup waiting time as a plain duration in seconds and minutes, recalculated with one-second precision as observed loading speed changes.
- Put the percentage on the left and remaining time on the right in one row beneath the red bar. Leave uncertain estimates blank instead of showing a fabricated countdown.

## [1.5.11] — 2026-09-16

- Show estimated time remaining beneath the startup bar, adapting to observed progress and the last five successful startups on the current device and workspace.
- Recalculate when loading stalls, keep errors actionable, and exclude interrupted or backgrounded attempts from timing history.

## [1.5.10] — 2026-09-16

- Prepare navigation before opening Home: warm module code and nested views, bundled character and office art, Inbox, and the initial Calendar, team and Profile data behind one playful startup bar.
- Reuse prepared views for smooth first navigation. Show only a clockwise red loading ring for brief in-app waits; retain clear recovery controls when a connection fails.

## [1.5.9] — 2026-09-16

- Open the workspace without waiting for mail. Prepare Inbox on its first visit with its own continuous progress bar, reusing completed work across navigation.
- Give startup playful subtitles and one measured download bar. Match module loading states to the red-border Nova logo and red progress theme, with friendly copy and navigation still available.

## [1.5.8] — 2026-09-16

- Measure workspace downloads using received bytes and their actual total, with indeterminate progress when the total is unavailable.
- Keep Inbox preparation before opening Home on desktop and phone. Show real mailbox and recent-message counts, with a separately labeled percentage for each phase, instead of fixed startup milestones or an eight-second automatic skip.

## [1.5.7] — 2026-09-16

- Refresh startup with the red-border Nova Dream logo, matching red progress bar and percentage, and clear step-by-step loading text. Progress follows actual startup checkpoints; slow or unavailable mail never prevents your workspace from opening.
- Keep numbered updates in GitHub Releases with repository-specific notes and source tags, published after successful quality checks.

## [1.5.6] — 2026-09-16

- Use Nova Dream throughout app titles, calendars, connection messages and new Assistant context while preserving existing chats and workspace identities. Restore the accepted red-border logo to the desktop shortcut, Dock and browser tab; retain the shortcut's selected workspace when renaming it.

## [1.5.5] — 2026-09-16

- Use the primary text color for Assistant reply paragraphs, matching your messages in light and dark themes across desktop, phone, live voice and saved conversations.

## [1.5.4] — 2026-09-16

- Keep consecutive voice captions in one message bubble while you continue speaking, including when part of the message has already saved. Copy the whole spoken message; keep separate calls, typed messages and Assistant replies distinct. Existing conversations and saved readers use the same grouping, with original message actions available for each preserved part.

## [1.5.3] — 2026-09-16

- Display your original typed or dictated message when the AI runtime trims its surrounding instruction envelope. Repair existing live and saved conversation views, copying, transcript exports and retries without rewriting native history, changing permissions or stripping your own headings.

## [1.5.2] — 2026-09-15

- Clear a team stage’s exact submitted briefing from its composer after saving the original operation. Keep the briefing in history and preserve later owner writing, including after a restart.

## [1.5.1] — 2026-09-15

- Keep Linux browser temporary socket paths short when a workspace lives inside a long recovery directory; preserve its durable profile and existing sandbox protections.

## [1.5.0] — 2026-09-15

- Connect GitHub with its device sign-in, choose a repository and branch, and prepare a separate checkout on Nova’s host.
- Review the exact changed files, commit, push a feature branch and open a draft pull request, with retained publication receipts and recovery after an interrupted response.
- Coordinate research, implementation and review across saved agents, sharing one checkout with durable handoffs, pause and stop controls, and real progress in the hub.
- Add an isolated host browser with page observations and reviewed agent actions. These workflows run from mobile or desktop; VPS hosting remains optional.

## [1.4.1] — 2026-09-15

- Show the provider’s 168-hour quota window as “Weekly allowance” in Settings.

## [1.4.0] — 2026-09-15

- Simplify Settings into six compact categories, with readable rows and expandable setup, account management and device-storage details.
- Add provider-reported AI allowance, reset times and available credits, plus seven-day runtime token activity. Unavailable figures stay explicit; saved identities are not assumed to own provider totals.
- Preserve visited forms, active desktop links and existing account permissions while navigating Settings.

## [1.3.0] — 2026-09-15

- Choose selected apps or full desktop control, independently of a timed session or “Until I turn it off”. Persistent access resumes after reconnecting the same desktop and workspace; Stop and remote revocation clear it.
- Add a menu-bar access indicator and Stop control, and expand computer interaction with typing, scrolling, dragging, menus and whole-desktop observations when explicitly enabled.
- Preserve per-action review, signed device identity, short operation deadlines and no-repeat receipts. VPS hosting remains optional.

## [1.1.2] — 2026-09-15

- Transfer large attachments and encrypted backup uploads in authenticated pieces below Vercel's routing limit; reassemble verified bytes through the original guarded operation.
- Encrypt temporary upload pieces, bind them to their device, workspace and destination, and preserve original request identities when retrying retained files.
- Keep upload-size errors distinct from sign-in failures.

## [1.2.2] — 2026-09-15

- Let desktop linking recover from an expired pairing challenge, and recheck expiry after a delayed native confirmation.

## [1.2.1] — 2026-09-15

- Include Electron and Chromium license notices in the private desktop archive. No runtime or permission behavior changes.

## [1.2.0] — 2026-09-15

- Add Install & devices with platform-specific installation guidance, actual device-storage status and persistent-storage requests.
- Add optional, authenticated desktop links and reviewed computer actions with timed local app grants, revocation and durable interruption receipts. VPS hosting remains optional.
- Add a local Apple Silicon companion build and authenticated, checksum-verified downloads. Public notarized installers and other desktop platforms remain separate releases.
- Keep existing agent access unchanged; introduce an explicit Computer capability and schema 54 to protect compatibility.

## [1.1.1] — 2026-09-15

- Recognize the pinned OpenClaw browser sign-in message on headless Linux hosts, preserving complete-link, OpenAI origin, callback and PKCE validation.
- Keep server sign-in URLs ephemeral across streamed output and cancellation; the supported SSH callback setup remains required.

## [1.1.0] — 2026-09-15

- Prepare a protected Vercel entry for a durable VPS using an independent server credential, exact owner address, isolated gateway and existing guarded web sessions.
- Retain Tailscale access as a separate mode and support the authenticated return from Vercel login without opening cross-site API access.
- Reduce repeated workspace/Assistant downloads using authenticated conditional reads, with bounded memory-only reuse and brief idle Assistant polling backoff.
- Include deployment, cost and migration instructions; live VPS/Vercel setup remains unconfigured pending account provisioning and acceptance.

## [1.0.3] — 2026-09-15

- Use the selected red-outline Nova Dream logo for the top-left Home button, with transparent outer corners for light and dark navigation surfaces.

## [1.0.2] — 2026-09-15

- Restore the original red-outline Nova Dream app-icon variant for Add to Home Screen and browser installation, retaining its frame, shadow and lynx artwork.
- Version the icon URLs so refreshed installation previews request the corrected artwork.

## [1.0.1] — 2026-09-15

- Use the approved Nova Dream lynx logo and name for iPhone Add to Home Screen and browser installation, with opaque PNG icons and a maskable variant that preserves the artwork.
- Serve the web app manifest through the existing authenticated desktop, phone and private-web routes.

## [1.0.0] — 2026-09-15

- Deliver the integrated web workspace: Home, Tasks, Assistant and voice, Google/Microsoft Inbox and Calendar, Contacts, Agents and Hub, Content, and Profile quests with shared saved work.
- Include verified Mac/iPhone continuity, private phone QR pairing, recovery and import review, tabbed Settings, and the enlarged keyboard-focus correction.
- Complete the bounded native Calculator acceptance through verified foreground window input, with per-call review and temporary-access cleanup.
- Keep VPS deployment, public distribution and optional companion installation separate from this local web release; preserve unavailable capabilities and uncertain external effects explicitly.

## [0.75.4] — 2026-09-15

- Keep Settings tabs in the page flow so they cannot cover fields during keyboard navigation at enlarged browser zoom.
- Leave space around automatically scrolled Settings controls so focus remains visible.

## [0.75.3] — 2026-09-15

- Require scoped window-readiness discovery after an app starts, and keep foreground image-based input grounded in the latest verified window observation.
- Preserve earlier queued instructions, native permissions and saved work while applying the guidance to newly started Assistant and agent work.

## [0.75.2] — 2026-09-15

- Restore a stopped Tailscale connection through an explicit Reconnect Tailscale action, preserving its saved network settings and ordinary status-only behavior.
- Show a locally generated QR code for the verified phone address, separate expiring pairing codes, and clearer connection help in Settings → Phone & devices.
- Add an explicit major-version promotion command that synchronizes app, lockfile, README and release metadata while preserving schema, publication and installation boundaries.

## [0.75.1] — 2026-09-15

- Keep interrupted voice replies silent until a new spoken input is committed and its own audio stream begins; ignore late cancelled-response tools and completion events.
- Preserve native computer-tool observations when Code Mode returns text, and guide agents to request bounded window state without discarding warnings or control identities.

## [0.75.0] — 2026-09-15

- Organize Settings into General, Accounts, Assistant & voice, Phone & devices, and Data & recovery tabs, with clearer descriptions and larger reading text.
- Preserve unfinished setup fields when switching tabs, support keyboard navigation and narrow screens, and open the relevant category from connected modules.
- Keep phone and recovered-workspace permissions intact.

## [0.74.3] — 2026-09-15

- Show the saved provider reason when an opened email could not be marked read, including temporary Gmail request limits, while keeping uncertain actions unrepeated.

## [0.74.2] — 2026-09-15

- Bind desktop shortcuts to an explicitly selected saved workspace, including its address and existing data, so reopening Nova keeps the current accounts and phone-connected work.
- Refuse missing storage, redirected paths and mismatched running builds; retain separate browser profiles and the previous shortcut for recovery.

## [0.74.1] — 2026-09-15

- Keep supplied tool action details open, identify missing review arguments, and show live review/assignment countdowns with approval waiting included.
- Keep agent action requests in their assignment review instead of showing unopenable conversation links in Assistant.
- Reject expired approvals before admission and again before dispatch; preserve native final outcomes and exact-request reconciliation without extending access.

## [0.74.0] — 2026-09-15

- Continue from a complete or partial saved transcript in a fresh, read-only chat, with a reviewed text attachment and no automatic message. Preserve the original conversation, Project, permissions and unsent drafts.
- Keep transcript preparation retryable against its captured version after interrupted uploads or responses, and preserve exported files through backup and restore.
- Make archived and linked saved messages readable when their native host is unavailable, retaining exact message and source-hash checks.

## [0.73.0] — 2026-09-15

- Keep captured Assistant messages readable on a new browser when the original connection is unavailable, with explicit complete/partial transcript labels. Live actions still require the original native identity.
- Add reviewed connection setup for an activated recovery copy: accounts require fresh sign-in, routines and queued messages stay paused, and unresolved operations are preserved without replay.
- Carry earlier Assistant archives through subsequent encrypted backups and restores, verify every retained archive, and protect connection setup against concurrent backup or workspace switches.

## [0.72.0] — 2026-09-15

- Add headless server key protection, isolated from release files and browser clients, with verified restart and fail-closed handling of missing or changed credentials.
- Add an optional private owner web entry point for a VPS, restricted to an exact Tailscale identity and HTTPS origin, using independent secure sessions and existing workspace guards.
- Add verified server startup and a private credential initializer. Keep Mac/phone previews and optional desktop work separate from the future VPS deployment.

## [0.71.2] — 2026-09-15

- Restore paired-phone access to boardroom gatherings and discussions, current agent approvals, and automatic read status for displayed email. These actions keep the existing session, revision, provider permission and replay checks; host configuration remains desktop-only.

## [0.71.1] — 2026-09-15

- Repair native Phone Settings links: open the official Tailscale download page and the current private phone address, rechecking the paired service and enabled route before opening. Unrelated destinations and stale routes remain blocked.

## [0.71.0] — 2026-09-15

- Add browser ChatGPT sign-in in Settings, keeping device-code sign-in as an explicit alternative. Show the saved ChatGPT account separately from model and voice readiness.
- Keep authorization links and codes out of saved receipts and logs; pin the login method, cancel only the owned process, and preserve exact request replay through restart or runtime unavailability.
- Read account identity through OpenClaw's supported metadata command, with bounded reads and no duplicate credential store. Existing model choices and mail/Calendar accounts are preserved.

## [0.70.5] — 2026-09-14

- Capture computer-control instructions with new Assistant requests and agent work: observe after each input, stop after refused or unverified actions, respect authorized window access, and leave time for cleanup.
- Preserve original queued instructions, conversation history and exact worker inputs across restart. Native permissions and deadlines remain unchanged; these instructions still require live behavior verification.

## [0.70.4] — 2026-09-14

- Explain settled agent failures caused by AI usage limits, temporary rate limits or expired sign-in. Keep the safe reason through restart without retaining raw provider errors.
- Preserve saved work, explicit cancellation and unresolved-run checks; never start an automatic replacement attempt.

## [0.70.3] — 2026-09-14

- Recover uncertain Gmail sends even when Gmail replaces Message-ID. Check a complete bounded Sent inventory, the unique operation marker and the complete reviewed message before reporting provider acceptance.
- Preserve no-resend behavior across service restart and include recoverably trashed Sent messages; changed, duplicated or incomplete evidence remains uncertain.

## [0.70.2] — 2026-09-14

- Recover uncertain Gmail draft saves when Gmail replaces Message-ID: check Nova's operation marker and the complete reviewed MIME contents before confirming a saved draft. Keep ambiguous, moved, edited and incomplete results uncertain without repeating the write.
- Bound fallback checks to 50 draft headers, reading the full content only for one matching marker; check known draft containers directly when recovering an update.
- Show active mail requests as waiting for the provider and keep retry controls out of the way until the request finishes.

## [0.70.1] — 2026-09-14

- Bind browser requests to the exact loaded app candidate. Reject stale snapshot reads and changes before they can alter workspace data, including same-version rebuilds.
- Offer an explicit reload while keeping the current editor open. Retain save request identities and preserve existing Stop, End and access-revocation controls across updates.
- Require the native desktop shell to match as well; reloading a page cannot silently mix a newer client with an older preload.
- Include binary uploads, generated image previews and voice setup in the same client identity contract.

## [0.70.0] — 2026-09-14

- Keep parent and child tasks as separate editable records with their own notes, plans and completion. Add child creation, parent selection and family navigation to the task editor, plus parent labels in Tasks.
- Restore supported Dream Claw and Nova one-off task families with stable links and previous completion protection. Preserve unsupported, missing or cyclic links together with dependent work.
- Prevent parent cycles and active children losing a parent to Trash; validate task families during backup and recovery. Advance workspace format to 52 so older builds cannot misread parent links.

## [0.69.0] — 2026-09-14

- Freeze the desktop shell, preload, launch policy and icon with the client and service. Desktop startup verifies the exact candidate, including same-version rebuilds, before opening its window.
- Add explicit isolated desktop QA profiles and ports through the shared launcher. Preserve older or unresponsive services, reject unsafe profile paths, and reuse matching services without starting duplicates.
- Keep native folder selection and page permissions restricted to the selected local workspace; retain the default preview profile.

## [0.68.0] — 2026-09-14

- Restore the human profile name and carry verified earlier Nova Dream XP into Profile when the human profile and complete ledger agree. Show its source separately; old completions cannot earn that credit again or advance new daily quests.
- Bind the carried balance to the exact preserved source during backup and restore. Ambiguous or inconsistent progress stays archived without changing the displayed balance.
- Advance workspace format to 51 to protect the new balance when opening older builds.

## [0.67.0] — 2026-09-14

- Repeating tasks and habits can use several dates each month, including the last day, with one occurrence when selected dates overlap. Tasks and Calendar share the same schedule and completion history.
- Restore matching Nova monthly rules as one paused, editable series while preserving source archives and previous completions without new XP.
- Keep date selections in the repeat editor and advance workspace format to 50 so older builds cannot misread the new rules.

## [0.66.2] — 2026-09-14

- Restores authorized workspace tools for agents using explicitly configured native tools, including the same review, stop and revocation checks as ordinary assignments.
- Shows waiting native approvals in Team, Hub and assignment status. Historical attempts share one approval feed, and failed status refreshes leave review controls usable.
- Clarifies that agents should propose workspace changes only when the assignment requests them.

## [0.66.1] — 2026-09-14

- Preserves the authenticated initiating device when an Edition 3 worker requests native tool approval. Keeps approval prompts, scoped tools and recovery restrictions; unknown native runtime bytes stop startup instead of applying an unverified correction.

## [0.66.0] — 2026-09-14

- Let work assignments use explicitly configured native MCP tools through a separate runtime profile, with exact tool lists retained in each execution receipt. Proposal and discussion runs keep their workspace-only tools.
- Show native action approvals in assignment review, using the same device-bound reviewer and explicit decisions as Assistant. Stopped, completed and retired work cannot approve another action.
- Retain existing agent histories, workspace grants and tool-free execution; reject unscoped tool registrations and changed tool sets.

## [0.65.1] — 2026-09-14

- Route native MCP approval requests to the device that initiated the work, using the native host-owned reviewer identity. Keep tool approval decisions and access limits intact.
- Apply the compatibility correction only inside Nova's owned runtime and verify the exact native bundle before loading it; leave the global OpenClaw installation unchanged.

## [0.65.0] — 2026-09-14

- Restore verified Nova Project source files with their original Project links, and distinguish linked sources and schedules in the import review.
- Restore supported recurring Tasks and habits as paused series with their saved occurrences, including rescheduled dates. Preserve unsupported rules and inconsistent series together without creating unrelated one-off tasks.
- Keep earlier completions separate from new XP, including after reopening, completing or restoring imported Tasks. Retain complete original archives and paused external effects.

## [0.64.3] — 2026-09-14

- Keep progress updates and tool activity attached to the running reply until OpenClaw confirms the exact run and session finished. Queued follow-ups and voice cannot start on an intermediate text segment.
- Retain uncertain completion for review if the native receipt cannot be read, without resending the original request.

## [0.64.2] — 2026-09-14

- Bind native approval review to the owner device that started the conversation, while retaining a separate review connection, restricted methods and explicit decisions. OpenClaw's MCP reviewer-binding defect still prevents the Calculator test; it is not bypassed.
- Preserve the prior review identity and credentials for recovery when moving to the owner-bound connection.

## [0.64.1] — 2026-09-14

- Open, edit and recover Outlook drafts that omit their sender, using the authenticated mailbox when no sender is specified and preserving any explicit sender.
- Show the actual failed draft-review error when ownership returns to the same writing, instead of incorrectly reporting a draft opened elsewhere.
- Distinguish an unconfirmed draft save from an unconfirmed send in the kept-message selector.

## [0.64.0] — 2026-09-14

- Add reviewed predecessor imports into separate, encrypted workspace copies, with stable source identities, preserved originals, linked-record checks and paused execution.
- Open Nova schema 15 backups with their matching key locally in the browser; keep the key off the service.
- Verify full recovered record and file values before offering a separate workspace.

## [0.63.7] — 2026-09-14

- Keep voice connected when its first saved caption supplies an automatic conversation title. Apply the title after the call ends while retaining the captured conversation, Project and access checks.

## [0.63.6] — 2026-09-14

- Fix ChatGPT voice sign-in failing when the main Assistant and assignment worker coexist by selecting the explicit main-agent owner.
- Direct Calendar Task edits to their original Tasks record instead of suggesting unrelated provider permissions.
- Clarify that account setup can reuse a compatible Desktop OAuth registration with a fresh sign-in on this host.

## [0.63.5] — 2026-09-14

- Fix valid multi-megabyte backup archives and native artifact downloads failing with a JavaScript stack overflow during byte validation. Share the bounded-stack validator with Outlook draft files while preserving existing file limits and encoding checks.

## [0.63.4] — 2026-09-14

- Pin Goal reporting guidance to new requests, preserving the original display and provenance of earlier Goal messages across reloads.

## [0.63.3] — 2026-09-14

- Connect Goal completion and blocker reporting to the saved native session through existing Nova Dream tools. Require the current Goal request and exact goal ID; keep read-only workspace access intact.
- Distinguish saved goal completion from finished planning steps. Retain unknown outcomes and reconcile goal reports by observation without repeating updates.

## [0.63.2] — 2026-09-14

- Release a rejected chat-creation request so the preserved original draft can start a fresh conversation. Keep uncertain native outcomes bound to their original request to prevent duplicate sends.
- Show the actual setup rejection and a return-to-draft action instead of an unusable history retry.

## [0.63.1] — 2026-09-14

- Fix manually named Assistant chats and completed-reply branches when both the main Assistant and assignment worker are configured. New native keys explicitly select the main Assistant; existing histories and retained drafts are preserved.
- Link Content results directly to their captured-source/readings review and clarify supported PDF/image inputs in assignment setup.

## [0.63.0] — 2026-09-14

- Let agents and Assistant inspect captured PDF pages and actual PNG, JPEG and WebP pixels through the existing workspace tools, with exact saved-file identities.
- Record pages and views read in assignment review; distinguish available files, inspected pages and truncated text. Keep original attachments unchanged.
- Bound source parsing in worker threads, reject unselected files, and recheck active requests and current source permissions before returning results.
- Preserve earlier workspace backups and advance schema to 49 for captured binary sources and reading records.

## [0.62.0] — 2026-09-14

- Add encrypted workspace backups, exact archive verification, and separate recovered copies with provider, routine and mutation holds. Preserve Tasks/XP, quests, Content versions, character recipes, files and operation receipts.
- Include supported managed Assistant archives through OpenClaw backup/restore, with explicit coverage limits; keep passwords out of retained browser work and service journals.
- Add download, upload, review, interrupted-request recovery and local-copy management to Storage settings; remove obsolete phone-pairing copy.
- Add reviewed local activation, a persistent workspace selection and return to the untouched original; retain native archives while connected effects remain paused.

## [0.61.0] — 2026-09-14

- Build Profile around the saved Lynx portrait, retained identity/appearance editor, original level curve and one canonical earned-XP display.
- Add daily and Monday-based weekly quests in the workspace timezone, personal quests with real Task steps, milestones, completion feedback and paginated earned history.
- Create new quest Tasks atomically, link existing work without modifying it, preserve drafts/retry identities, review conflicting edits, and archive or restore quests without removing Tasks.
- Derive progress from the complete correction ledger. Reopening work updates quests/levels; repeat saves and repeated completion cannot duplicate credit or farm another day's quest. Rest days carry no penalty.
- Connect Profile progression and quest operations to the existing Assistant/agent tool catalog, with both Profile and Tasks grants and the existing review controls.
- Preserve saved profiles, agents, grants, Content and the central hub. Advance workspace schema to 47 for persisted personal quests.

## [0.60.0] — 2026-09-13

- Complete Content’s writing workspace with Markdown formatting, rendered and split previews, verified inline images, collections, tags, reusable templates with files, and revisioned shared brand guidance.
- Connect Research, Draft, Improve and Review to the existing agents. Capture exact saved sources, brand versions and unresolved review feedback; compare returned proposals before applying a new draft version.
- Add assigned, version-specific review threads, quoted comments, resolution, changes requested and explicit owner approval. Later edits require a new review.
- Compare and restore saved versions without overwriting history. Export exact writing, portable Markdown, original assets, source identity, review records and file hashes in a ZIP.
- Preserve existing records, drafts, agent grants and the central office hub. Keep external publishing and analytics deferred; text agent runs explicitly identify binary attachments they did not analyze.

## [0.59.1] — 2026-09-13

- Center the boardroom within a balanced, count-aware office grid: four offices use2×2, six3×2 and nine3×3, with the meeting space reserved between the office banks.
- Replace the one-sided hallway with a connected courtyard loop, cross-passages and four boardroom entrances. Use the same path geometry for rendering and collision navigation.
- Reflow saved offices without changing their agent assignments, titles or furnishings; recover character positions when the plan changes. Advance workspace schema to45.
- Center the full campus in the viewport and retain short arrow-key taps between animation frames.

## [0.59.0] — 2026-09-13

- Give every agent a private office and add a large boardroom with a long table and twelve individually placed chairs; preserve existing agent designs, access and saved furnishings.
- Coordinate eight-direction walking, adjacent-heading turns and sit/stand transitions, with independent idle timing, greetings, coffee breaks and social conversations.
- Add saved team discussions: invite participants, gather at the table, run sequential contributions using earlier results, and retain a final summary. Pause/end controls preserve original attempt receipts; discussion runs can read context but cannot write workspace changes.
- Advance the additive workspace schema to44 for the boardroom layout and discussion plans.

## [0.58.0] — 2026-09-13

- Complete the Agents workspace with a staged creator, retained appearance drafts, searchable and recoverable roster, detailed profiles, assignment handoff, routines and skill/capability controls.
- Share one modular pixel character recipe across creator, profile and hub: eight-direction walk, idle, sit/work/stand and wave, expressions, independent fur/face/ears, fitted everyday clothes, navy/charcoal suits, ties and bags. Preserve legacy selections and original art sources.
- Add connected furnished room kits, stable desk placement, eight-direction navigation with collisions, saved furnishing choices and a full-room overview. Use actual worker and review status, with links to canonical applied Tasks and Content.
- Complete the native assignment/module-tool adapter for OpenClaw 2026.9.2. Retain exact captured inputs, reviewed proposals and receipts; enforce current access revocation and prevent repeated effects after stop, retry or restart. Advance the additive workspace schema to 43.

## [0.57.4] — 2026-09-13

- Give workspace launcher actions a visible resting outline and background, so Files, Review and available Live view controls look clickable without hovering.

## [0.57.3] — 2026-09-13

- Replace nested conversation-menu accordions with compact action pages and Back navigation; show draft actions directly.
- Make the bullet-list button toggle a pinned summary; Work can switch between Environment and Outputs, with Sources retained below.
- Add closable workspace tabs for files, reviews and available live tool views, a new-tab button, keyboard navigation and expansion. Keep open views and selection when hiding the panel, with separate saved tabs per conversation.

## [0.57.2] — 2026-09-13

- Use space-specific three-dot menus: Chat gets Pin, Archive, Delete and Project moves; Work gets Rename, Pin, Archive and Copy. Disclose secondary settings below.
- Replace the generic four-tab Assistant drawer with compact Chat Outputs/Sources and Work Environment/Sources summaries, plus a separate workspace toggle.
- Open saved outputs and source files in an on-demand preview; keep download, refinement, Content handoff and current-checkout change review accessible.
- Move Project controls beside the conversation title, captured sources into each reply’s menu, and memory/history/details into the conversation menu. Keep live tool views separate from inline progress and approvals.

## [0.57.1] — 2026-09-13

- Move Chat / Work into the Assistant sidebar toolbar as a connected two-button switch with the active half highlighted.
- Simplify Work Project settings to Project name and Source folder; keep Chat-only instructions and reference-file controls in Chat Projects. Preserve existing saved Project context.
- Keep Search, New chat/New work and Collapse beside the switch in one compact row, using labeled icon buttons. Preserve separate histories, drafts and all existing space behavior.

## [0.57.0] — 2026-09-12

- Add a clear Chat / Work switch with separate conversations, search scopes, selections and retained drafts. Keep existing Assistant controls and actions available in both spaces.
- Keep existing Projects in Chat with shared sources and instructions. Add separate Work Projects with real local folders, a desktop folder chooser, optional native Git worktrees and task-bound checkout change reviews.
- Preserve Project context through future messages, captured sources and voice; retain original work folders through saved tasks. Keep access permissions separate from the space and environment choice.
- Add a collapsible activity panel with real tool output, Stop and authenticated, conversation-bound tool images. Native live cursor viewing remains unavailable because the installed computer service fails its connection handshake; no simulated cursor or screen is shown.
- Explain native worktree disk-space rejection; keep local folder execution available. Preserve existing records with schema 42 and retain earlier captured messages unchanged.

## [0.56.0] — 2026-09-12

- Give the managed chat Assistant tools to read and update the existing Tasks, Calendar, Inbox, Contacts/CRM, Agents, Content, Profile, Home and Project services.
- Apply local changes through canonical record validation and revision checks. Keep read-only and planning conversations read-only; Guarded changes and provider actions receive a concrete review card in chat.
- Retain action history and exact request receipts across retries/restarts. Cancel provider preparations, reconcile uncertain sends without resending, and show partial mail outcomes honestly.
- Refresh shared workspace records after confirmed Assistant changes. Keep credentials, account permissions, pairing and unsent drafts outside these tools.

## [0.55.0] — 2026-09-12

- Add a chronological contact timeline for logged notes, calls, meetings and messages alongside linked emails, Calendar events and follow-up Tasks.
- Add keep-in-touch cadences that use shared Tasks and Calendar reminders, organization pages with linked people and shared notes, relationship links with inverse labels, and an optional four-stage pipeline.
- Add reviewed Google and Microsoft address-book imports and contact-field sync, with exact-email matching, folder selection, pause/resume, conflict review, retained local histories and recovery of interrupted provider updates.
- Keep CRM notes, photos, additional organizations, relationships and reminder settings private to the workspace. Request separate contact read/write permissions through existing account connections.
- Preserve new CRM fields when older contact forms save; schema 41 fences older services. Keep the main directory compact with one People / Organizations / Pipeline selector.

## [0.54.0] — 2026-09-12

- Add private contact profile photos with replace/remove, retained upload recovery and initials fallback.
- Support multiple organizations with an Add organization control, editable primary organization and search across every membership.
- Add compact sorting by name, primary organization or recently updated; duplicate merging retains organizations and provides a photo choice.
- Preserve new contact fields when older forms save; keep photo history and encrypted file references through merges and restores.

## [0.53.0] — 2026-09-12

- Build Contacts into a compact people directory with favorites, readable contact pages, private notes, contact editing and retained drafts.
- Review senders from connected Inbox indexes before adding them. Open related emails, create linked follow-up Tasks, and open upcoming Calendar events from saved email sources on each person’s page.
- Review and combine duplicates without losing email addresses, source links, notes or task origins. Preserve archived originals and version history with an explicit restore-as-separate action. Schema 39 fences merged records from stale edits.

## [0.52.5] — 2026-09-12

- Consolidate Tasks filters and sorting behind one Filter & sort button. Start with three simple rows: High priority only, Order, and More options.
- Keep Automatic, Due date and Title as the primary order choices. Tuck detailed filters, additional sorting, bulk selection and Trash behind further disclosure; retain selected checkmarks and removable active labels.

## [0.52.4] — 2026-09-12

- Keep task creation inside the list. Remove the yellow Tasks-page New task button and the global top-bar Capture button.
- Consolidate full task details and repeating-task creation under the inline add row’s options; remove the separate New repeat and Add daily entry points. Preserve typed drafts and carry their title into new repeating tasks.

- Pack the Tasks title, view tabs and search/filter controls into a shared toolbar that wraps only when needed.
- Add Cancel and Escape dismissal to generated subtask suggestions, retaining the checklist and returning focus to Generate again.

## [0.52.3] — 2026-09-12

- Replace the large Tasks filter form with a compact Project, Status and Priority picker. Mark selected choices and show readable, removable active-filter labels above the list.
- Keep sorting, selection and Trash in a quiet List options menu. Reflect nondefault list choices visibly and reset hidden task selections when filters change.

## [0.52.2] — 2026-09-12

- Expand subtasks directly below each task or calendar-event row with a compact folder-style chevron, including empty checklists and one-offs. Add steps and review Assistant suggestions in place; retain the original task and Calendar detail views.
- Remove the empty To-dos and Daily filler messages, leaving quiet section headings.
- Keep manual subtask writing through collapse/reload, update child checkmarks immediately, and accept generated steps only after a confirmed save. Preserve linked parent completion and existing recovery journals.

## [0.52.1] — 2026-09-12

- Fix Home's Add task buttons passing click-event data into a new task. Fresh tasks now retain their drafts and generated subtasks without the false storage warning found during live Assistant verification.

## [0.52.0] — 2026-09-12

- Generate editable subtasks with the existing Assistant from Task and Calendar event details, including one-offs and individual recurring occurrences. Review suggestions before adding them; keep manual Add subtask alongside generation.
- Save event checklists and their linked parent completion in shared workspace records, with progress visible in Tasks and completion reflected in Calendar. Preserve provider schedules and invitation responses.
- Retain the original generation request across reloads and reconnects, verify its tool-free native reply, and support cancellation without starting duplicate work. Schema 38 protects saved suggestions and event checklists.

## [0.51.0] — 2026-09-12
- Add saved completion checkboxes to shared Calendar one-offs and individual occurrences in Tasks, retaining checked rows and completion history.
- Turn the existing checklist into expandable subtasks: checking the parent completes all steps, finishing every step completes the parent, and reopening a step reopens its parent. Add/edit up to 500 subtasks in task details.
- Keep task and subtask changes atomic, revisioned and recoverable; Calendar completion stays in the workspace without changing meetings or attendance. Schema 37 preserves the new completion records.

## [0.50.0] — 2026-09-12

- Give Tasks three clear destinations: Today, Scheduled, and Completed. Split Today into To-dos and Daily; group schedules by cadence. Keep one-line rows, global search, and optional filters/Trash without extra navigation.
- Show existing Calendar appointments in Tasks and open their original local or connected-calendar editor. Preview future recurring tasks in Calendar using their canonical occurrence identities; keep edits, completion, and Trash from producing duplicates.
- Preserve checked tasks for the day they are completed, consolidate finished work in Completed, and carry unfinished work into Today.

## [0.49.0] — 2026-09-12

- Simplify Tasks to Today, Upcoming and All tasks, with secondary views in one menu, optional search filters and collapsible habits. Keep each task to one line; click its title for full details. Checking a task leaves it visibly checked in its planning list, including after reopening. Remove Focus and timer controls at the owner's request.
- Add quick capture, bulk planning/status/priority changes, retained Undo, recoverable Trash, duplication, and full task revision history. Keep plan dates separate from deadlines and preserve canonical Home/Calendar task identity.
- Retain interrupted saves across reloads, reject stale Undo, protect prerequisite tasks, and cancel reminders on removal. Make task details easier to scan with visible checklists and keyboard saving.

## [0.48.6] — 2026-09-12

- Load connected calendars automatically, select primary calendars on first use, and refresh the visible date range while keeping saved events on screen.
- Restore Outlook appointments with empty recurrence metadata. Add individual calendar visibility controls to the original Sources and filters panel, preserving deliberate hidden-calendar choices.

## [0.48.5] — 2026-09-12

- Prepare oversized newsletter photos as high-resolution, proportionally scaled PNGs instead of blocking the entire email. Preserve ordinary original images and the complete-message reveal.
- Isolate large-image decoding in one bounded worker process with byte, pixel, queue and time limits; retain existing public-host validation and account fences.

## [0.48.4] — 2026-09-12

- Fix complete-email preparation for newsletters containing imported font stylesheets or web fonts. Exclude non-image CSS resources from image discovery and rendering while preserving background images, layout and fallback fonts.
- Keep the complete-message reveal, original image bytes and provider-backed instant read status.

## [0.48.3] — 2026-09-12

- Show Read, the open envelope and normal row weight in the same paint as the fully rendered email. Remove the display delay and save Gmail/Outlook read status in the background.
- Restore the provider’s unread appearance if saving fails. Keep pending indicators tied to the exact account and message revision; queue rapid openings and preserve deliberate Mark unread.

## [0.48.2] — 2026-09-12

- Automatically mark fully rendered, visible conversations as read in Gmail and Outlook. Background preloading, hidden readers and failed image preparation leave unread mail untouched; preserve deliberate Mark unread until the next opening.
- Update the affected conversation’s saved read status immediately, including during older-mail indexing. Keep exact message membership, provider confirmation and durable retry/restart protection.

## [0.48.1] — 2026-09-12

- Make unread mail distinct with blue closed-envelope icons, bold sender/subject text and subtle row shading. Read mail uses a neutral open-envelope icon and regular weight.
- Show explicit Read or Unread status in the reader and offer the matching Mark read or Mark unread toolbar action. Preserve provider-owned status and the existing action review.

## [0.48.0] — 2026-09-12

- Start every fresh app window at Home. Prepare the existing Inbox during startup and warm the latest 25 conversations and their images, with an eight-second startup limit and remaining work continuing in the background.
- Reveal a selected email only after its body, images and layout are ready. Remove image-reveal controls and the safe-viewing image banner; show one retry state if the complete email cannot be prepared.
- Keep startup mail caches bounded and tied to the current account and connection. Preserve unsent Capture writing without reopening its dialog on launch.

## [0.47.5] — 2026-09-12

- Preserve email table and logo size limits and cap photos at their original pixel width so small thumbnails are not stretched into blurry banners. Decode already-loaded images without an additional lazy-loading delay.
- Load up to four images concurrently, reuse the just-opened provider message, and cache original image bytes briefly for quick repeat opens. Keep exact account/message binding, bounded memory, protected-message behavior and partial retry support.

## [0.47.4] — 2026-09-12

- Automatically load images as ordinary email messages enter the reader. Retain protected reading for suspicious messages, skip invisible tracking pixels, and show retry only when images fail.
- Queue automatic image requests and retire queued or late results after navigation, account or safety changes. Preserve successful images while retrying unavailable ones.

## [0.47.3] — 2026-09-12

- Show external email images in place through an explicit per-message control, with bounded image loading, partial-failure feedback and retry. Preserve email head styles and supported background images.
- Load Outlook inline-only attachments and keep embedded images in their original message layout. Scope image results to the exact account, connection and message.
- Keep active flags visible and reveal unused actions on hover or keyboard focus; identify Outlook flags and Gmail stars in tooltips.

## [0.47.2] — 2026-09-12

- Pace Gmail background indexing in smaller batches to stay below the current per-user quota and leave room for opening mail. Resume from saved pages and allow quota cooldown before retrying.

## [0.47.1] — 2026-09-12

- Give Inbox a continuous reading surface, compact desktop tools and paging, clear read/unread hierarchy, and identifiable receiving accounts. Retain touch targets, saved selections, collapse controls and density options.
- Default new views to chronological mail; keep explicitly chosen topics, senders and accounts contiguous with a separate pinned section.
- Consolidate sync feedback into one expandable status and add an explicit retry for a failed selected message.
- Accept Microsoft's equivalent OData paging URLs while preserving mailbox/query validation. Distinguish temporary Gmail request limits from permission failures and use the existing bounded index backoff.

## [0.47.0] — 2026-09-11

- Protect the active workspace key through Mac Keychain or Windows account encryption, using a bounded native helper separate from the app window.
- Verify the encrypted wrapper and reopenability before removing the active plaintext key. Preserve the original on interrupted conversion; reject corrupt, unavailable or cross-OS wrappers without fallback.
- Add Storage settings with retained protection retries and truthful active-key/backup boundaries. Keep key material out of browser and phone responses.
- Include the helper in the paired frozen service and advance the workspace schema; previous candidates require their paired recovery snapshots.

## [0.46.0] — 2026-09-11

- Add private phone access to the shared workspace: expiring one-use pairing codes, secure device cookies, retained pairing retries and individual revocation.
- Reuse the predecessor Tailscale Serve model on a separate loopback listener and dedicated private HTTPS route. Preserve other routes and reject public sharing, desktop bootstrap and host configuration from phone requests.
- Add desktop device settings and a compact phone pairing screen; hide cached workspace content after revoked access while keeping unsent device drafts.
- Preserve phone records across service restart, fence older schemas, and finish sender-choice alignment in the shared Contact dialog.
- Live phone/Tailscale, installed-device and recovery acceptance remain separate from this implementation checkpoint.

## [0.45.0] — 2026-09-11

- Link a verified email sender to an existing or new Contact, retain its exact source message, and continue through linked Tasks and Calendar without duplicating records.
- Resolve selected Outlook messages outside the first conversation page; preserve uncertain Contact saves for reconciliation and reject duplicate creation or stale account/revision choices.
- Plan Content at a time, timezone and duration in the original Calendar, including explicit clock-change choices. Keep publication records distinct from planned time.
- Attach source files to saved Content versions. Assignment runs capture the complete supported UTF-8 text files from selected Content and Project versions; unsupported or oversized files stop before a worker starts.
- Show observed Assistant startup stages and elapsed time. Update host status independently while voice access checks are pending, without spawning duplicate requests.
- Advance the workspace schema to preserve source links, timed planning and complete assignment file captures; older candidates must use their paired recovery snapshot.

## [0.44.0] — 2026-09-11

- Install the original Nova Rounded icon family across the shared shell and original Calendar/Inbox, including clear panel, mute, reply-all, file and action states.
- Compact shared headings, record toolbars and lists; disclose filters and secondary Content actions; use a list by default for first-time narrow Content views.
- Improve Home card density, Profile portrait editing, Assistant header controls and Inbox sender/subject spacing while preserving saved layouts and original module behavior.
- Guide unconnected mail/calendar users into account setup with a return to the originating module. Keep retained mail writing accessible.
- Extend saved-work search to Contacts, Content, Agents, assignment plans and Profile; open exact records and Projects, and identify archived results.

## [0.42.1] — 2026-09-09

## [0.43.0] — 2026-09-10

- Show elapsed goal time in the Pursuing goal bar, retaining the native start and stop timestamps across reloads.
- Restore Nova’s compact steps counter and centered expanded plan above the composer, with live status, readable step markers and hover, touch and keyboard controls.

- Add permanent removal for saved drafts in Deleted, with an anchored confirmation and retry of the same removal after an interrupted response.
- Fix chat removal with attached drafts. Keep separately saved files, outputs and memories intact.
- Prevent old draft requests and late attachment uploads from restoring removed writing. Other windows keep newer unsent edits for explicit review, and clean windows clear the removed draft.
- Keep snapshot and draft revisions increasing through deletion and restart.

- Center the Steps pill directly above the chatbox, matching the original Nova Dream layout.
- Clean up the exact temporary dictation session through ordinary archived-session removal, preserving replacement sessions and recovering interrupted cleanup.

## [0.42.0] — 2026-09-09

- Open Attachments directly in the file picker; add Image generation and native Goal setup to a flat + menu with icons and labels.
- Display live voice text in the conversation, with a circular Nova call control and preserved scrolling.
- Connect dictation to the existing ChatGPT voice transport with replies and tools disabled, while keeping dictated text in its original draft.
- Restore compact work activity and Steps and Goal directly above the chatbox, remove duplicate progress controls, and adopt automatic contextual titles without replacing manual names.

## [0.41.0] — 2026-09-09

- Permanently remove a settled chat from Deleted with an explicit confirmation and exact native session checks; separately saved outputs, files and memories remain available.
- Recover interrupted removal without deleting a replacement session or repeating a confirmed native deletion, and prevent concurrent writing from reappearing in the removed chat.

## [0.40.0] — 2026-09-09

- Save, edit, find and remove source-linked memories for all chats or a selected Project; include exact saved notes in future text and voice context.
- Preserve unconfirmed memory changes for safe retry, keep earlier captured input intact, and inspect current or captured memories in conversation and voice details.
- Hide the empty queue row when no follow-up is waiting; completed queue history remains in Work.

## [0.39.2] — 2026-09-09

- Preserve a saved or queued message's Plan/Research mode when copying into an empty draft, while keeping the chosen mode of existing writing.
- Keep following the latest reply when composer or queue resizing changes the reading viewport; deliberate upward scrolling still takes priority.

## [0.39.1] — 2026-09-09

- Allow live steering when the native runtime identifies the exact visible reply without exposing a complete active-run list.
- Keep automatic follow-ups waiting for delayed steering confirmation, then send once without requiring manual queue recovery.

## [0.39.0] — 2026-09-09

- Supply whole PDF, image and larger text sources to voice through the managed Assistant’s native file tools, with verified transfer receipts and cache reuse.
- Keep native file paths out of the composer and browser voice instructions, and prevent late source transfers from starting ended calls.

## [0.38.0] — 2026-09-09

- Let voice consults read verified Project text sources and the exact saved output being refined; show available and unsupported sources inside voice details.
- Report source and payload failures before sending as unsent requests, while retaining recovery for uncertain native outcomes.

## [0.37.1] — 2026-09-09

- Reconnect the previously selected managed Assistant automatically when Edition 3 restarts, preserving later host or credential choices.

## [0.37.0] — 2026-09-09

- Add retained Project settings and shared source files, with exact context captured for each message and clear source inspection.
- Show the native configured default model and its supported effort options without requiring a model override.

## [0.36.2] — 2026-09-09

- Recover failed model catalogs inline and refresh available models after connection changes, without overlapping reads or retaining another host’s choices.
- Discover supported effort levels when OpenClaw first returns a prepared catalog without capabilities; use ordinary reads after discovery and retry on connection changes.
- Keep effort labels and sliders aligned with the confirmed setting as model details arrive. Save only deliberate changes and restore the confirmed value after rejection.
- Apply existing-chat effort and speed through temporary response controls, preserving ordinary chat permissions and the host’s default model.
- Keep slow native startup pending until readiness, exit or stop; reuse its existing launch and preserve any later explicit connection choice.

## [0.36.1] — 2026-09-09

- Keep Assistant connection and chat updates flowing when responses take longer than the refresh interval, without overlapping periodic requests.
- Separate output loading from chat status; fence replaced-workspace responses and wait for fresh readback after edits.
- Show an initial connection check and recoverable update interruption instead of a premature disconnected notice.

## [0.36.0] — 2026-09-09

- Answer Nova's native questions in the compact composer review tray, with single/multiple choices, custom answers, cancellation and retained normal answer drafts.
- Recover uncertain answers against their original request; keep confirmed outcomes separate from expired, replaced or missing requests. Secure fields go directly to the native secret store and stay out of chat/draft storage.
- Keep ordinary chat permissions unchanged through a separate question-review connection. Schema 26 fences the new retained request records.

## [0.35.0] — 2026-09-09

- Restore compact native action approvals in Assistant, with scoped replay, exact choices, retained decisions, and explicit recovery after an uncertain response.
- Show expandable tool progress and native tool results; keep late results and activity across restart without reopening completed runs.
- Prepare the separate approval destination before text or voice execution while preserving ordinary chat permissions.

## [0.33.2] — 2026-09-09 — Assistant reading continuity

- Keep your message and reading position when switching chats, leaving Assistant, reopening the app or changing the layout.
- Reopen older pages around the saved native message, with Earlier, Newer and Latest controls that preserve continuous history.
- Keep live updates from pulling an older reading window to the latest reply, and retain precise position while earlier pages load.

## [0.34.0] — Retained message tools

- Navigate preserved conversation versions from one compact header menu.
- Pin exact messages, reopen their sources and remove shared pins without changing native history.
- Pause, resume or stop read aloud; navigation and voice release the reader.

## [0.33.1] — 2026-09-09 — Assistant access recovery

- Apply explicit Full access through a separate, short-lived native settings connection. Ordinary chat keeps its existing permissions.
- Release rejected settings changes and add Check status, Retry change and Keep current settings recovery, preserving drafts and exact conversation identity.
- Retain unresolved outcomes without automatically retrying access changes, and reconcile stale browser intents after settings are resolved.

## [0.33.0] — Assistant voice and working modes

- Restore a compact voice bubble above the composer, with call details on demand; keep navigation independent of the call.
- Respect upward reading while new messages arrive and keep the jump-to-latest control out of the reading layout.
- Simplify Plus to Attachments and Chat/Plan/Research modes; keep mode intent with saved drafts and exact submissions.
- Run newly queued messages after the current reply, with pause/edit/reorder and failure guards. Existing paused queues remain paused.
- Refine model/effort presentation and retain contextual actions outside Plus.

## [0.32.2] — 2026-09-09

- Expand Projects inline above Recents and retain their collapsed state across chat changes.
- Add Pin, Archive, Delete and Restore to saved drafts without modifying original writing; allow removal of unfinished chats without native sessions.
- Start voice directly, show compact model/effort/speed and inline enforced Access choices, and expand Plus with folders, saved files and context actions. Add file paste/drop.
- Schema 22 preserves shared draft organization and permission-change reconciliation. Existing chat and draft content stays intact.

## [0.32.1] — 2026-09-09 — Assistant Recents and chat actions

- Replace the separate Saved drafts category and All chats control with one Recents list. Sort conversations and unfinished drafts by recent activity, keep pinned chats first, and preserve Project filtering plus bottom Archive/Deleted destinations.

- Replace row settings dialogs with anchored Pin, Rename, Move to Project, Mark read/unread, Archive/Restore and Delete actions. Open the same menu with three dots, right-click, keyboard context-menu keys or a touch hold; scrolling cancels the hold.

## [0.32.0] — 2026-09-09 — Assistant workspace restoration

- Put Nova's identity in the conversation header, remove repeated ordinary-message headings and the redundant folder/save strip, and keep Archive and Deleted at the bottom of the organization sidebar. Add pinned/unread conversations and reversible deletion.
- Restore an automatically growing composer with Plus and Access on the left, response effort/speed, dictation, Voice and Send/Stop on the right. Keep six 44-pixel controls on 320-pixel screens and position menus outside scrolling messages.
- Start a chat directly from its first message; revise sent messages, request alternate responses and branch while preserving the original conversation. Retain exact submission receipts, source context and independent drafts. Reject revisions whose original files cannot be carried forward.
- Restore live steering, editable/reorderable retained queues, and Outputs/Sources/Work/Details disclosure. Keep queue actions in the composer and show draft files in Sources.
- Add transcription-only dictation with retained text and microphone cleanup. Verify effective effort/speed readback; Access currently displays the verified native permission policy, with permission changes still pending.
- Reuse DC's virtualized transcript and rich replies, preserve loaded older pages, and separate unavailable history from an empty chat. Lazy-load Assistant: 127 KB startup and about 418 KB total gzip JavaScript, with an explicitly reviewed 430 KB total budget.
- Full ChatGPT/Codex parity, native dictation/voice acceptance, expanded Access controls, remaining message/Plus actions and broader 1.0 acceptance remain open.

## [0.31.1] — 2026-09-09 — connected planning and Skills preview

- Add saved agent routines with one-time, interval and custom schedules, local date/time and timezone previews, explicit enabling, and missed-run policies. Retain drafts, revision reviews, occurrence history and links to captured assignments and results.
- Connect the Team Hub to assignment activity, exact inputs/results, routines, Tasks and Content using the original office resources. Compact Lynx sprites remain unfinished.
- Inspect installed Assistant skills, setup requirements, full native proposals and support files. Retain exact reviews and create/update/revise drafts; apply or reject reviewed versions through explicitly enabled management access. Keep writing and original operation receipts through navigation, lost replies and restart.
- Resolve exact installed skill keys to native names before updates. Keep reviewed targets fixed, display distinct keys and resolved names, and copy reviewed writing into an independent draft when choosing another target. General restoration and product-agent skill mapping remain open.
- Add Content Board, Calendar and List planning with retained stage/date moves, seeded drafts, Project context and compact filters. Show planned Content in the main Calendar and return to the same retained draft. Require a manual publication record before marking work Published. Timed planning remains unfinished.
- Update the Mac preview and desktop shortcut to this combined candidate. Preserve the prior candidate, stopped data and native profile; the schema update retains existing records, attachment files and key. Full native-window, scheduled-run, rollback and broader 1.0 acceptance remain open.

## [0.29.0] — 2026-09-09 — saved agent assignments

- Start an agent assignment from exact saved plan, design, Project and selected source versions; retain each attempt independently of later edits.
- Run through the pinned tool-free native worker, request stop explicitly or at the selected time limit, and reconcile uncertain outcomes without duplicate execution.
- Review captured inputs and saved results, download complete output files, and keep linked Task identities. Create a Content draft with the original file, Project and exact assignment provenance while preserving unfinished writing.
- Retain verified native outcomes in an encrypted journal so recorded results survive runtime restarts. Stop the owned Assistant runtime when its app service exits.
- Keep an unconfirmed attempt in history after explicit review so you can continue other assignments without inventing a successful result or automatically retrying work. Late results remain recoverable.

## [0.28.0] — 2026-09-09 — Assistant outputs in Content

- Start Content drafts from exact saved Assistant replies and generated files, preserving their original version, file bytes, and Project connection.
- Edit and export the new draft independently; preview or download its original file, open the source message, and continue through linked Tasks without losing unfinished writing.
- Retain the same creation request across retries and reloads; reject changed sources and protect original-file links. Binary, oversized, and invalid text files remain attached intact.
- Agent execution and the other remaining module foundations are still in progress. No external publication is performed.

## [0.27.0] — 2026-09-09 — connected saved records

- Add Contacts, Content, agent designs and assignment plans, plus personal Profile, using the existing saved-record authority and retained editors.
- Keep version history, exact-source follow-up Tasks, actual Content file exports and earned Task history connected across modules.
- Reuse the accepted original Lynx portraits with explicit crop, background and frame choices; preserve unsupported saved recipes.
- Agent execution, Hub activity and complete modular character customization remain under development. No external publication is performed.

## [0.26.1] — 2026-09-08 — shared visual foundation

- Share warm surfaces, readable text, gold actions and selections, and keyboard focus across the shell and original Calendar/Inbox controls.
- Make desktop Inbox rows compact with clearer sender, subject and provider text; retain larger touch targets and independent selection, star and pin actions.
- Restore the accepted Lynx mark to the native window and Mac Dock, and use the same mark for the refreshed desktop shortcut.

## [0.26.0] — 2026-09-08 — original grouped schedule deletion

- Connect the original all-pattern and custom recurring-day selectors to exact Google/Outlook series reviews, with guest notification acknowledgement and separate results for every selected pattern.
- Retain partial deletion outcomes across lost responses, account reconnect and service restart. Check uncertain results without replaying effects, keep the remainder, or explicitly review only unapplied patterns.
- Preserve independent event writing when a custom selection excludes its original series. Show each choice’s title/time and the current-view coverage of grouped selections.
- Schema 17 fences the group journals. Live provider/device acceptance and remaining provider content/recurrence fidelity stay open.

## [0.25.1] — 2026-09-08 — retained Calendar recovery

- Refresh retained provider events against current account permissions after reconnect, preserving edited fields and explicit reminder choices; keep admitted operations bound to their original requests.
- Recognize Google's minimal cancellation records during deletion recovery and verify Calendar access before interpreting an absent event as deleted. Recovery remains read-only.
- Preserve exact account/Calendar identity and the original schedule selector's bounded set of choices. Grouped schedule dispatch and live provider/device acceptance remain open.

## [0.25.0] — 2026-09-08 — original provider Calendar editor

- Connect the original Calendar form to Google and Outlook event creation, editing and scoped deletion, with complete provider reads and a retained review before applying changes.
- Preserve unedited meeting details, formatting, repeat patterns and provider reminders; keep Edition 3 categories in the shared workspace.
- Keep local and provider writing across switching, reload and cloned windows. Review conflicts alongside current provider fields and reconcile uncertain results without replaying provider effects.
- Schema 16 protects durable Calendar operation records. Core original-editor browser journeys, scoped deletion, lost-result recovery, keyboard/narrow layout and controlled restart are verified with disposable fixtures. Live provider/device acceptance, grouped schedule deletion and remaining provider fidelity cases are not yet complete.

## [0.24.0] — 2026-09-08 — return to original email

- Open a Calendar follow-up's exact Gmail or Outlook conversation in the original Inbox reader, including mail outside the current folder or loaded index.
- Preserve the current folder, independent reading position and compose/reply writing; keep only source navigation metadata through reload and cloned windows.
- Revalidate the original account and connection before displaying content, reject mismatched and late responses, and offer retry or connection recovery without changing the Calendar event.
- Reuse original Gmail message summaries and Outlook flags/categories, attachments and reviewed mail controls. Live provider/device and full 1.0 acceptance remain open.

## [0.23.0] — 2026-09-08

- Connect the original Calendar reminder controls to private host scheduling, with retained event/occurrence identities, bounded recurrence catch-up, snooze/dismiss and exact device notification outcomes.
- Add explicit all-day reminder dates/times and clock-change review to the original editor; keep reminder status separate from device delivery and open the exact occurrence from the shared reminder panel.
- Preserve prior alarms and late notification receipts through edits, cancellations and restart; schema 15 fences older services. External channels and native/phone delivery acceptance remain open.

## [0.22.0] — 2026-09-08 — original Inbox-to-Calendar follow-ups

- Connect the original Inbox follow-up shortcut to the existing local Calendar service, preserving the email context and suggested instant in the workspace timezone.
- Recover the original request after response loss, prevent duplicate scheduling across windows/devices, and preserve later Calendar edits. Explicit additional follow-ups retain prior events.
- Open saved follow-ups in the original Calendar editor while keeping other event drafts, including unconfirmed saves, available to resume.
- Keep follow-up status and reminder delivery separate. No provider Calendar write or mail mutation occurs from this local planning action.
- Schema 14 protects retained follow-up identities. Full provider/device and M0–M7 acceptance remains open.

## [0.21.0] — 2026-09-08 — original outgoing file selections

- Attach and remove files in the original compose and reply screens, using the existing file cards and image viewer.
- Keep selected files encrypted on the private service and retain exact file references through reload, cloned windows, response loss and independent messages.
- Include the reviewed file selection in Gmail and Outlook drafts/replies; record and reconcile Outlook file additions/removals before continuing the same draft.
- Remove explicitly omitted inline images from saved formatting, preserve untouched HTML, and handle supported 10 MB file validation without stack overflow.
- Exclude unsent drafts from the original reply-source selection and reject draft replies at the Gmail service boundary.
- Schema 13 protects retained file selections and staged Outlook file operations from older services. Live provider/device and full 1.0 acceptance remain open.

## [0.20.0] — 2026-09-08 — original draft file access

- Show retained inline images through the original mail renderer, and reuse original attachment cards and the image lightbox for draft files.
- Read exact files from their owned saved operation, verify metadata and bytes, and keep them only in temporary browser memory. Switching or closing rejects late results; individual failed reads offer retry.
- Preserve composer keyboard interaction when the image viewer opens above it. Keep original-file downloads and bounded image previews separate.
- Working source checkpoint; live provider/device acceptance and full 1.0 remain in progress. Public preview and shortcut are unchanged.

## [0.19.0] — 2026-09-08 — reopen original provider drafts

- Open Gmail and Outlook drafts from the original Inbox reader into an independent kept message. Opening reads provider content; save and send retain explicit review.
- Preserve original formatted content, named recipients, reply metadata and supported attachment bytes while updating the same provider draft. Plain text replacement is an explicit composer choice.
- Fence older draft editors across windows, devices, account reconnects and service restart, including unresolved provider operations. Schema 12 protects draft ownership records.
- Working source checkpoint; full 1.0, live-provider and device acceptance remain open. Public preview and desktop shortcut remain unchanged.

## [0.18.0] — 2026-09-08 — independent kept messages

- Improve the original Inbox composer with a kept-message switcher and a separate New message action. Each message retains its own recipients, writing, signature choices and original delivery journal.
- Allow switching or closing while a mail review is pending. Late responses remain attached to the original message; cloned windows retain exact unresolved send requests.
- Keep the current composer open when browser storage cannot save a switch, and preserve unsaved writing for recovery. Refine composer keyboard focus and touch controls.
- Working source checkpoint. Reopening provider-owned drafts from the Drafts folder, attachment fidelity and live-provider acceptance remain in progress. The public preview and desktop shortcut are unchanged.

## [0.17.0] — 2026-09-08

- Connect the original Inbox action controls and MailAssistant review planner to read/unread, stars/flags, archive, trash, and existing labels/categories for Google and Microsoft.
- Keep per-message results, review history, exact confirmation recovery and guarded undo through reload and service restart. Saved drafts are excluded; uncertain effects are checked without automatic replay.
- Refresh mail indexes after changes while retaining cached mail and manual pause. Schema 11 protects the new provider action journal.

## [0.14.1] - Unreleased — original Inbox delivery controls

- Connects the original compose/reply forms to complete account, recipient, signature and source reviews, with draft/save/send status kept across navigation and reload.
- Preserves exact pending requests through lost responses, browser-storage failure and cloned windows. Provider responses never clear newer writing; unresolved sends cannot be retried as new messages.
- Adds restrained inline status/recovery controls with chunky buttons, 44px actions and narrow reflow. Real provider consent, draft updates, uploads, triage and native/device acceptance remain open.
- Working source only; public 0.12.0 and the Desktop shortcut remain unchanged.

## [0.14.0] - Unreleased — original mail delivery and recovery

- Adds the private service boundary for the original compose/reply/draft/send workflows, preserving exact sender/recipients, signatures within the body, quoted source context and verified attachment bytes.
- Keeps encrypted, immutable message reviews and per-step receipts. Binds confirmation to account generation, writing identity, source fingerprint and exact revision/digest. Lost responses and interrupted writes never trigger automatic resend.
- Reconciles matching Gmail operation headers and marked Outlook drafts/Sent messages. Confirmed responses survive a concurrent disconnect or shutdown; uncertain evidence stays uncertain.
- Uses the supported Outlook MIME send/reply route to dispatch the reviewed bytes directly, closing the original mutable-draft gap before send. Keeps the original Outlook draft mappings and reply-draft flow.
- Advances working schema to 8 and adds pinned server-only Nodemailer MIME generation with file/URL access disabled. The original Inbox UI, draft-update/large-upload workflow, provider permission upgrade, mail actions and live/native/device acceptance remain unfinished.
- Working source only; public 0.12.0 and the existing 0.13.0 original-module QA services are unchanged.

## [0.13.0] - Unreleased — original Calendar, Inbox and Assistant integration

- Reuses Dream Claw's actual Calendar page, Month/Week/Day views, event editor, cards, filters and calendar helpers through an isolated Edition 3 host adapter.
- Connects the original editor to existing kept drafts, exact save recovery, explicit conflict review and occurrence/whole-series choices. Retains advanced repeat settings and adjusted-date Keep/Reset controls.
- Improves keyboard access, overlapping appointment placement and all-day strips. Schema 7 retains original category and reminder preferences; delivery and provider-write integration remain unfinished.
- Restores the original Assistant sidebar frame, resizing, focus return and shortcuts, plus top hide/reopen controls for main navigation. Keeps sidebar preferences and unsent writing; Project browsing stays separate from the draft context.
- Reuses Nova Dream’s rich completed/streaming reply rendering, table scrolling, footnotes and code highlighting/collapse/full-source Copy. Missing optional renderers keep exact source text.
- Defers the original Calendar, Inbox, Markdown and completed-code highlighting until needed. Retains the 180 KB startup ceiling, with an explicitly expanded 350 KB total budget for the original Inbox and 80 KB individual deferred-chunk checks.
- Adds the private mail-read bridge required by the original Inbox, reusing original Outlook grouping/message transforms and existing E3 account ownership. Keeps MIME/source identity, opaque bounded paging and attachment byte checks; original Inbox UI/index/write integration remains unfinished.
- Reuses the original Inbox client mail wrappers, folder/session and presentation helpers through the private service. Fences reconnects and queued reads; preserves partial pages, literal full messages and text attachments with bounded hydration. Original Inbox write-flow integration remains in progress; the mounted screen checkpoint follows below.
- Mounts the actual original Inbox screen with its original folders, grouping/filtering, split reader, attachments and composer. Keeps compose/reply/signature writing through route changes, closed dialogs, restart and independent cloned windows; exposes storage failures without losing in-memory writing. Improves collapse focus, narrow layout and original image-preview zoom/download.
- Connects the original Inbox index model and Pause/Resume controls to encrypted, account-scoped background pages. Keeps cached search through refresh/restart, removes obsolete rows only after completed refresh, preserves deliberate pauses and rejects older progress or replaced-account results.
- Working source only. Original mobile Calendar, complete provider/reminder actions, Inbox write/source review, maximum-mailbox/device acceptance and Assistant restoration are still required before promotion.

## [0.12.0] - 2026-09-08 — repeating local events

- Adds daily, weekly, monthly and yearly local events with intervals, end dates or counts, weekday patterns and a concrete date preview.
- Separates one-occurrence edits from whole-series changes, preserving moved-date identity, individual cancellations and explicit Keep/Reset choices for adjusted dates.
- Retains the original scoped save across reload and lost responses; conflict review refreshes both series and occurrence revisions without replacing kept writing.
- Advances Edition 3 to schema 6. Calendar reminders, provider writes and live provider/device acceptance remain in progress.

## [0.11.0] - 2026-09-08 — calendar planning and provider reads

- Adds Month, Week and Day planning, source filters, task plans and an editable local calendar with retained event drafts, exact save recovery and explicit conflict review.
- Reads expanded Google and Microsoft events with bounded pagination, source/account identity and independent cache status. Partial refreshes preserve earlier events; account changes fence late results.
- Keeps all-day dates exclusive, resolves timed events across timezones and clock changes, and preserves provider series/revision identity without rewriting recurrence rules.
- Advances Edition 3 to schema 5. Provider writes, richer recurrence/reminders, live provider acceptance and device acceptance remain in progress.

## [0.10.1] - 2026-09-08 — dependable local shutdown

- Stops accepting new requests before shutdown, drains leftover browser connections after a short grace, and keeps the database open until started request handlers settle.
- Rejects request bodies completed after shutdown begins; previously admitted saves retain their original receipts through restart.
- Cancels an in-progress managed Assistant startup before it can launch or reconnect later, joins owned process exit, and permits a later explicit start.

## [0.10.0] - 2026-09-08 — provider connection foundation

- Adds dedicated Google and Microsoft Desktop OAuth setup with PKCE browser sign-in, verified account identity and separate read permissions.
- Keeps provider credentials in the encrypted host store; cancelled, expired, interrupted and mismatched sign-ins cannot replace another connection. Lost setup replies reconcile without storing client secrets in browser journals.
- Checks bounded calendar and mail folder access independently, with partial permission failures, refresh rotation and explicit reconnect/disconnect recovery.
- Advances the workspace format to schema 4 so older builds cannot reopen the new account authority. Live provider registrations, full Calendar/Inbox synchronization and device acceptance remain in progress.

## [0.9.1] - 2026-09-08 — isolated running build

- Starts the production service and client from one hash-verified build copy, so later development builds cannot change the running preview’s files.
- Reuses verified copies, rejects altered or mixed build bytes, and keeps the original Edition 3 data directory when starting the frozen service.
- Creates the paired file inventory during each build. A healthy existing service stays running until an explicit idle restart.

## [0.9.0] - 2026-09-08 — task scheduling and reminders

- Adds daily/weekly intervals, monthly/yearly date or ordinal-weekday rules, explicit missing-date policy and inclusive end dates while preserving existing occurrence identities.
- Keeps a revisioned daily task order across Tasks and Home with direct title dragging, keyboard/buttons and retained conflict/retry proposals.
- Adds independent task/series reminder times with explicit DST gap/overlap handling. The host schedules durable due/missed alerts; snooze/dismiss and completion preserve the task’s plan and deadline.
- Adds the reminder center and opt-in device notifications while the client is open. One recorded delivery attempt is shared across windows, shown/unknown/unavailable remain distinct, and lost responses never trigger automatic redisplay.
- Protects the expanded Edition 3 format with schema 3; existing keys authenticate before any upgrade write.

## [0.8.0] - 2026-09-08 — exact conversation search and archive reading

- Searches native saved user/Assistant messages with explicit app-session and Project/archive scope, indexing/limit status, and stable message/session result identities.
- Opens search results and archived conversations in a separate read-only reader while preserving the active draft, model, reading position and voice target. Exact missing sources fail clearly instead of substituting a latest message.
- Keeps read-only history separate from the active execution cache, supports retained reset-history anchors, and remembers source IDs across reload rather than stale numeric offsets.
- Makes Project organization filter conversations without rewriting draft context. Reconciles a completed edit journal before admitting a new archive/restore change.

## [0.7.0] - 2026-09-08 — daily tasks and habits

- Adds Capture, Today, Upcoming, Anytime, Waiting, Review and History with Project filters, separate planned/deadline times, priority, estimates, checklists, prerequisites and source links.
- Keeps waiting, blocked, completion and reopen in one task lifecycle. Completion credits use a correction ledger; repeated requests, skipping and timers cannot duplicate earned XP.
- Adds daily and weekly habits/repeating tasks with stable local-date occurrence identities, explicit skip, series pause/resume and retained missed-day review across restart and daylight-saving changes.
- Adds focus sessions with per-window ownership, confirmed elapsed time, interruption leases and explicit resume. Home reflects real blocked and missed work.
- Upgrades only Edition 3's encrypted workspace format to schema 2, validating existing keys before schema writes. Older Edition 3 builds fail closed on the upgraded format.

## [0.6.0] - 2026-09-08 — retained message queue

- Keeps prepared Assistant messages and their exact Project, model, versioned refinement source and file bytes in a visible paused queue, separate from the active draft.
- Adds explicit Run next, recoverable Keep aside/Restore, copy-to-draft and original-run status. Nothing starts automatically after a reply, reconnect or restart.
- Admits queue submission and its operation link atomically. Exact retries reconcile the original run, and changed Project/model/session identity pauses execution for review.
- Gives repeated conversation/refinement names readable numbered suffixes for OpenClaw’s unique-name requirement. Definite setup rejection is shown separately from an unknown outcome.
- Requires written change instructions before sending a refinement whose original image is already attached. Confirms an interrupted Run next response from its exact operation receipt.
- Adds focused queue, restart, lost-response, context-change and native-preflight regression coverage.

## [0.5.0] - 2026-09-08 — native generated outputs

- Previews actual Assistant-generated images and saves/downloads native file bytes through the original conversation’s private OpenClaw artifact grant. Exact artifact, message, session, host and workspace identity are checked before and after transfer.
- Refines saved outputs in a new conversation bound to the original ID, version and content hash. New files keep parent lineage, and the source remains attached for follow-up edits. Other drafts remain intact.
- Updates open history when asynchronous media generation appends its attachment after the initial reply. Saved outputs recover the same file receipt after interrupted saves; changed retry bytes cannot replace an existing version.
- Bounds file downloads and image dimensions, keeps active document/animation formats download-only, and cancels stale previews on reconnection. Adds focused transfer, preview, lineage and recovery checks.

## [0.4.1] - 2026-09-08 — streaming caption repair

- Uses supported streaming input transcription through the existing ChatGPT voice connection so partial captions can appear while speech continues. Requires provider confirmation of both Project context and the streaming model before enabling microphone transmission.
- Keeps a new partial spoken turn after earlier captions until its commit assigns a durable history position; interrupted uncommitted speech does not reserve a missing ordinal.
- Preserves displayed history when selecting the already-open conversation again.
- Adds focused setup, acknowledgement and pre-commit caption ordering regression coverage. Representative hardware/device latency acceptance remains open.

## [0.4.0] - 2026-09-08 — local voice preview

- Connects real browser voice through the host’s ChatGPT account, keeping one-use provider credentials on the service. Supplies the full saved Project purpose before enabling audio and forwards that same captured context to backing Assistant consultations.
- Adds compact voice controls and readable captions that remain present through workspace navigation. Mute fences outgoing microphone audio locally; Interrupt silences playback; End releases media and retains pending caption saves under the original conversation.
- Saves finalized spoken turns in the same native conversation, reconciles duplicate/lost receipts, and closes stale calls across reconnects or changed conversation identities. Drafts stay editable during a call and are sent after it ends.
- Proves synthetic speech, direct and consulted Project answers, real incoming audio, ordered history saves, navigation, mute and End through the signed-in provider. Hardware microphone, native/phone audio and measured multi-turn latency acceptance remain open. The observed transcription route waits until speech ends, so live captions do not yet meet the 1.0 target.

## [0.3.0] - 2026-09-07 — local preview candidate

- Adds guided ChatGPT device-code sign-in through the isolated OpenClaw host. Account credentials remain with OpenClaw; only the temporary verification code reaches the UI.
- Retains exact sign-in attempt receipts, prevents duplicate starts after lost responses/restarts, and distinguishes stopping the local flow from confirmed account setup.
- Shows the host’s advertised voice connection separately from actual call readiness. Handles OpenAI’s nine-character device codes and reports bounded setup progress without exposing terminal output.
- Keeps browser sessions independent when multiple Edition 3 workspaces use different ports on the same host. Preserves existing device identities while adopting the new session cookie.
- Fences late events, credentials and results from a replaced OpenClaw client, including reconnects to the same host.
- Adds focused sign-in lifecycle and actual terminal tests. Live voice controls and provider/device acceptance remain in progress.

## [0.2.2] - 2026-09-07 — local preview candidate

- Keeps Capture and Send icons visible at phone widths while hiding only their text labels. Verified against the populated Assistant and retained draft.

## [0.2.1] - 2026-09-07 — local preview candidate

- Keeps newer conversation settings when an older response arrives after reconciliation, and retains exact native settings in cached history.
- Shows the owner's original message in chat while preserving its verified Project context in the execution record.
- Reconnects an already running Edition 3 runtime without launching another process.

## [0.2.0] - 2026-09-07 — development preview

- Connects an isolated OpenClaw runtime with ChatGPT-backed conversations, exact Project and attachment context, streaming replies, separate retained drafts, archive reading, and per-conversation model settings.
- Preserves uncertain sends without replay and checks native session/run identities during recovery.
- Saves exact Assistant replies as downloadable Markdown documents, with new versions and source identity for refinement while other drafts remain intact. Native generated files/images remain open.
- Restores the IconPark family and introduces a rounded, tactile visual system across the interface. Navigation buttons share a neutral color, use one selected accent, and show names on hover.
- Adds an owner-authorized Mac desktop shortcut that opens the isolated app and starts its private service when needed. The Windows shortcut implementation still needs device verification.
- Adds connection setup and status. Voice, provider accounts, phone access, and the broader 1.0 acceptance work remain in progress.

## [0.1.0] - 2026-09-07

- Adds an isolated Home, task, Project and Assistant-draft workspace with light/dark themes, direct widget/navigation reordering, pinned Settings, and responsive layouts.
- Retains draft text and staged files locally, saves encrypted records and attachment bytes through an independent service, and makes saved drafts available to another browser as an explicit copy.
- Adds revision conflicts, recovery-epoch fencing, exact request receipts and HTTP dropped-response/restart checks. Keeps Assistant execution, actual voice and phone pairing visibly unconfigured.
- Adds an isolated Electron preview profile, synchronized Edition 3 version/build metadata and a dedicated single-pass quality gate. Existing application releases and data are preserved.
## [0.15.0] - Unreleased — editing saved provider drafts

- Reopens an Edition 3 saved Gmail or Outlook draft in the original compose/reply workflow, retaining its provider identity and reviewed operation history through updates and sending.
- Shows detected remote changes separately from proposed writing. Rechecks the provider version before applying an edit; stale reviews return to the kept draft. Outlook uses an actual provider ETag instead of deriving one from a change key.
- Preserves exact pending updates through reload and lost responses, restores the saved parent after cancelled edits and adopts a newer operation from another window without dispatching stale writing. A recovered Outlook update requires explicit confirmation before the remaining send.
- Advances working schema to 9. Live conditional-write behavior, external draft import, permission upgrades, outgoing-file workflows, triage and native/device acceptance remain open. Public 0.12.0 and the Desktop shortcut remain unchanged.
## [0.16.0] - Unreleased — connected account permission upgrades

- Adds Google and Microsoft permission review for saving/sending drafts and organizing mail. Requests the complete supported scope set and displays permissions actually granted, including partial consent.
- Keeps the same account generation and saved writing through explicit upgrades, preserves original requests across lost responses and fences later mail dispatches when credentials change. Reconnecting remains a separate connection change.
- Fixes mail reads, indexing and delivery rejecting the provider-prefixed account IDs created by real OAuth sign-in. Uses one shared account identity contract and tests the actual sign-in-to-mail path for both providers.
- Advances schema to 10. Live consent, original triage mutations and native/device acceptance remain unfinished; public 0.12.0 and the Desktop shortcut stay unchanged.
