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
