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

## [1.1.3] — 2026-09-15

- Publish a standalone, self-hosting source distribution with setup, privacy and recovery instructions and fresh repository history.
- Remove unused experimental 3D assets and replace the remaining owner-specific test name with a neutral fixture.
- Include private systemd runtime credential copies with restrictive permissions for Linux hosting.
- Retain the integrated workspace, pixel character system, provider adapters, encrypted recovery and bounded upload transport from the verified hosted edition.

## [1.2.2] — 2026-09-15

- Let desktop linking recover from an expired pairing challenge, and recheck expiry after a delayed native confirmation.

## [1.2.1] — 2026-09-15

- Include Electron and Chromium license notices in the private desktop archive. No runtime or permission behavior changes.

## [1.2.0] — 2026-09-15

- Add Install & devices with platform-specific installation guidance, actual device-storage status and persistent-storage requests.
- Add optional, authenticated desktop links and reviewed computer actions with timed local app grants, revocation and durable interruption receipts. VPS hosting remains optional.
- Add a local Apple Silicon companion build and authenticated, checksum-verified downloads. Public notarized installers and other desktop platforms remain separate releases.
- Keep existing agent access unchanged; introduce an explicit Computer capability and schema 54 to protect compatibility.

## [1.1.2] — 2026-09-15

- Transfer large attachments and encrypted backup uploads in authenticated encrypted pieces below the gateway request limit.

## [1.1.0] — 2026-09-15

- Add protected VPS/Vercel hosting and authenticated conditional reads.

## [1.0.0] — 2026-09-15

- Complete the integrated personal web workspace with Assistant, voice, tasks, connected mail/calendar, agents, content and profile progression.
