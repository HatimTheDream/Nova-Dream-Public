# Nova Dream Design System

Living visual and interaction reference · baseline: application 1.8.4; approved navigation: 1.9.13 · updated 22 September 2026.

This document separates **accepted principles**, **observed implementation** and **open proposals**. Accepted principles guide new work; observed values describe the inspected source, not a claim that every screen already conforms. Proposals are not delivered features. Keep this document and the shared styles synchronized in both independent repositories when decisions change. Functional specifications remain useful unless a newer decision explicitly replaces them.

## Vision And Accepted Principles

Nova is a warm, capable executive workspace: immediately readable, personal and comfortable for sustained work with an Assistant. Its character comes from deliberate color, rounded forms and tactile controls, rather than decoration competing with the task.

The primary 2.0 target is [Assistant Chat UI and feature parity](ASSISTANT-PARITY.md): familiar ChatGPT/Codex conversation journeys expressed in Nova's visual language. Validate complete behavior and recovery alongside appearance; keep capability gaps explicit until verified.

- Simplicity, readability and less is more guide every change. Preserve working compact controls; remove duplication before adding interface. Put secondary options in existing menus or disclosures. Add visible explanation only when a particular state or decision needs it. An alternative layout alone is not a defect.
- Keep response settings as a compact current effort, model chooser, slider and speed/reset control. Capability parity does not require a separate form section or permanent label for every setting.
- Assistant 1.10 keeps Auto as one added effort position, the existing composer placeholder and the existing five + actions. A simple question uses compact numbered answers and inline Send. Avoid extra prompts, subtitles or redundant request headings. Active step progress has one visible pill and leaves the composer after confirmed completion; uncertain work keeps its honest status.
- Make actions recognizable before hover. Use one coherent button family, clear selection and visible focus.
- Remove redundant navigation arrows and ornamental icons from cards. An icon should identify an action, state or meaningful category.
- Use Title Case for authored UI headings and short labels. Preserve normal sentence case in explanatory prose and preserve user-entered titles, messages and imported data exactly. Do not add subtitles that merely repeat a heading.
- Prefer useful information density to empty oversized cards. Equivalent saved widget sizes must produce equivalent board dimensions.
- Preserve drafts, attachments, selection and saved work across navigation, retries and updates. Report state honestly; visual polish must not hide uncertainty.
- Keep recurring routines, the next actionable task and the next appointment distinct. They answer different questions.

## Current Palette And Color Roles

**Observed implementation:** [theme.css](../apps/client/src/theme.css) defines the following roles. The warm light canvas, neutral surfaces and gold action color are current behavior. Brand red is already `#D93643`, including startup treatments. Red is the identity color; that does **not** authorize replacing every gold control with red.

| Role / Token | Light | Dark |
| --- | --- | --- |
| Canvas `--canvas` | `#F7F6F2` | `#171720` |
| Surface `--surface` | `#FFFFFF` | `#22222D` |
| Raised Surface `--raised` | `#FFFFFF` | `#2C2B39` |
| Text `--text-rgb` | `#282634` | `#F7F4FF` |
| Muted Text `--muted-rgb` | `#635F70` | `#C5BFD3` |
| Dim Text `--dim-rgb` | `#706B79` | `#B4AEC2` |
| Divider / Edge `--line` | `#E1DFD6` | `#41404E` |
| Essential Control Border `--control` | `#918B7F` | `#928C9F` |
| Brand Red `--brand-red` | `#D93643` | `#D93643` |
| Primary Action / Gold `--gold` | `#F6C453` | `#F6C453` |
| Action Ink `--gold-ink` | `#352300` | `#352300` |
| Action Edge `--action-edge` | `#B78722` | `#B78722` |
| Accent / Hover | `#84570C` / `#6B4507` | `#F6CF70` / `#FFDC8E` |
| Violet | `#5B4BB7` | `#B8ADFF` |
| Sky | `#236889` | `#79C9EC` |
| Success / Green | `#16664F` | `#6DD8B1` |
| Danger | `#B4232F` | `#FF909C` |
| Focus | `#245FAC` | `#8CCFFF` |
| Soft Gold | `#FFF0BB` | `#443B23` |
| Soft Violet | `#EFE8FF` | `#383052` |
| Soft Green | `#E7F5D9` | `#293D2A` |
| Soft Sky | `#E3F2FC` | `#273C4D` |
| Soft Peach | `#FFE8DC` | `#483329` |

`--action` aliases gold; `--action-ink` aliases gold ink. Selection uses soft gold and text ink, with an edge mixed from 40% gold and the divider color. Color mixtures and translucent overlays require checking the rendered composite, not just the starting tokens. Keep unselected navigation neutral and use one shared selected treatment. Do not assign an unrelated background color to every module.

Danger, success and focus remain semantic roles. A red brand element is not automatically an error; communicate errors with understandable content and state as well. Essential control boundaries must remain discernible even where decorative separators are subtle.

## Typography And Content

**Observed implementation:** Nova imports locally bundled Sora Variable with system sans fallbacks. [styles.css](../apps/client/src/styles.css), [ui-refinements.css](../apps/client/src/ui-refinements.css) and component styles determine the effective sizes. These are source-derived current defaults, not a fresh browser measurement of every route.

| Role | Current Baseline | Use |
| --- | --- | --- |
| Page Intro Heading | 26 px, 1.3 line height; 23 px at narrow breakpoint | Main page orientation |
| General H1 Fallback | 32 px, weight 730 | Screens without a page-specific override |
| Section H2 | 19 px, 1.4 line height, weight 680 | Grouping within a page |
| H3 | 16 px, 1.5 line height, weight 660 | Subsections |
| Body Paragraph | 14 px, 1.65 line height | Readable explanatory text |
| Control / Dense Role Tokens | 14 px | Inputs and dense work; individual components can override |
| Metadata Role Token | 12 px | Supporting details |
| Home List Item | 13 px, weight 600 | Tasks, routines, links, attention and appointment titles |
| Home Detail Role | 12 px | Supporting widget information |

Clock, date and weather are deliberate glance displays, not list headings. Their responsive numbers may be much larger; for example, the weather temperature uses a 42–66 px clamp. Appointment titles must retain the shared list scale even when a prominent calendar date is shown. Some component-specific supporting labels are currently smaller than the role tokens; treat those as observed exceptions to review, not a blanket endorsement of tiny text.

Keep labels readable without inflating every line to heading weight. Use tabular numerals for times and changing counts where alignment matters. Truncate bounded previews deliberately and provide a useful route to the full content; never silently alter stored text to fit the layout.

Clickable content keeps the same spelling and case as its source. Shared button styling preserves saved record rows, file and model names, search excerpts and supporting prose. When a new control mixes an authored action with a user-entered or imported value, put `preserve-case` on that value's element; put it on the button when the entire label is content. Title Case applies to the authored action, not its data.

## Controls, Surfaces And Accessibility

**Current shared control contract:** [buttons.css](../apps/client/src/buttons.css), loaded after the main component styles, defines 12 px ordinary corners and weight 650. Filled primary/selected actions have a clean face without a colored perimeter outline and a 4 px solid lower edge. Neutral actions retain a subtle 2 px border and 2 px lower edge. Pressing moves each control by its resting depth and compresses that lower edge completely. Primary and selected navigation actions use gold with the action ink and edge. Other selected controls use soft gold. Navigation controls use the shared app-tile shape described under App Identity And Character.

Compact action controls use a 2 px resting edge even when selected. Press feedback uses an independent translation, preserving transforms that center or position a control. The borderless Home logo participates with a 4 px red accent edge; both Red and Cream artwork keep their full tile dimensions. Button-shaped links share neutral feedback while preserving native link behavior and user-authored labels. Keyboard focus outlines remain distinct from decorative resting borders.

This family governs interactive actions, not every content surface. Content rows, checkboxes, calendar cells/events, drag artwork and translucent dismissal overlays retain specialized geometry; nested action buttons should still belong to the shared family. Card geometry currently uses a 22 px radius and a restrained solid lower edge. Avoid unnecessary nested cards and excessive outlines around ordinary text.

**Accepted reference direction, 19 September 2026:** the owner selected the Nova × Duo comparison, specifically preferring the lower accent edge over the accent outline surrounding the face. The primary Get Started control on [Duolingo's public website](https://www.duolingo.com/) uses a solid 4 px lower edge, 12 px corners and 15 px/700 uppercase text. Its white secondary control uses a bordered face and a smaller separate lower shadow. Nova adopts the clean filled face and lower-edge treatment while retaining Title Case, Sora typography, gold actions and red identity. The comparison reconstructed Duolingo's website; its font and press motion were approximations, not native-app measurements.

Small visible icons may sit inside a generous hit area. Nova's internal primary touch-target goal remains **44 × 44 CSS px**, including compact widget controls. Visible artwork need not fill that target. WCAG 2.2's [Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) is 24 × 24 CSS px with defined exceptions; do not mistake that minimum for Nova's preferred comfortable target or ignore the exceptions when evaluating a screen.

Current focus treatment is a 3 px outline with a 3 px offset. Sidebar focus is inset to avoid clipping. Retain visible keyboard focus, accessible names for icon-only controls and distinguishable disabled/selected states. Tooltips help identify icons but must not be the only accessible name. Menus must close predictably and return focus to the originating control when appropriate.

Check text against its actual background: [Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) requires 4.5:1 for ordinary text and 3:1 for qualifying large text, subject to the criterion's exceptions. This document is not a certified accessibility audit; color tokens alone do not establish compliance.

## Layout, Spacing And Settings

**Accepted direction:** align tab labels to the center of their own equal targets; keep padding balanced so selected tabs do not look shifted. Headers, cards and form rows should share intentional alignment. Keep Settings reachable with comfortable inset space, and separate the product version from optional diagnostic build details.

**Proposed spacing convention:** use a 4 px base with 8, 12, 16, 24 and 32 px steps for new work, choosing the step by context rather than forcing every existing component onto one value. Shared alignment, comfortable edge clearance and readable grouping matter more than filling every pixel.

Home can scroll as a board while individual widgets remain bounded. Its scrollbar chrome may be hidden while wheel, touch and keyboard scrolling remain usable. Retain useful scrolling cues in long Assistant conversations. Sidebar overflow must not clip buttons, focus rings or the pinned Settings control; do not apply a global scrollbar-hiding rule to solve one surface.

## Home And Widget Behavior

**Accepted priorities:** Clock, Weather, Next Action, Next Appointment and Daily Routines are distinct useful widgets. Daily Routines means recurring daily activities, not an appointment list. Focus timers and focus sessions are not part of the requested direction. Notes and useful external links can coexist with these priorities without duplicating the module rail.

Support multiple independently configured instances, including titles and color choices. The library should present appealing, representative previews and an obvious Add Widget action. Keep the same example data while switching sizes or options so users compare the design change, not a different appointment or task. Clearly distinguish gallery examples from real workspace data.

Widgets must fit without internal scrolling. Each size should have an intentional composition and a bounded amount of meaningful content: essential information first, then additional rows or details where room permits. Do not merely enlarge a compact card or leave an oversized blank area. Use counts and an Open action for overflow, with full scrolling lists in their proper modules. Hiding a scrollbar is not a substitute for making widget content fit.

Equal saved sizes share board dimensions. Account for long titles, empty states, errors and narrow windows when deciding row limits. Keep the next action visible, and prevent controls from being clipped by the card edge. Size selection can use clear icons with accessible names. Compact inset Options and Move controls should leave comfortable edge spacing; icon actions for hide, remove and duplicate need understandable names and focus behavior.

Weather uses recognizable condition artwork—sun, cloud, rain and related states—alongside real readings. Unknown or stale readings must remain explicit. Next Appointment retains the accepted calendar-inspired red event stripe, compact time and consistently sized title. Do not add the retired lynx illustrations back into widgets.

## Reordering And Motion

Widgets support both holding the widget surface and using its Move control. The lifted item follows the pointer, a landing placeholder shows the intended position, and neighboring items move aside. Sidebar module rearrangement must use the same visual and behavioral language. Settings stays pinned. Remove redundant Move Earlier / Move Later rows from the widget's ordinary menu; retain an appropriate accessible equivalent elsewhere.

Current shared motion uses a 350 ms hold, 220 ms neighbor movement and 180 ms landing, with `cubic-bezier(.2,.75,.25,1)`. Standard button feedback uses 120 ms transitions. Respect reduced-motion preferences; positional changes must remain understandable when animation is removed. Do not make regular work depend on bounce or whole-screen motion.

Reordering must not trigger navigation or activate content after drop. Preserve touch scrolling before pickup, support cancellation, retain focus and save the final order. Keyboard support is necessary, but [Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) also calls for a single-pointer alternative without dragging unless an exception applies. A drag handle alone is not that alternative; verify the actual accessible route for each surface.

## App Identity And Character

**Accepted identity:** a flat, straight-ahead lynx fills the app tile, with black eyebrows and facial details, gold eyes, a charcoal suit and red tie. The artwork has **no black perimeter frame or decorative outline**; its background reaches every edge of an opaque square. Preserve the selected face scale and proportions rather than shrinking the character into unused background space or adding a rendered 3D tile. The accepted source artwork and platform exports are recorded in [the brand asset guide](../assets/brand/README.md).

**Implemented choices:** Red is the default; Cream is its light companion with red markings and the same executive identity. Settings → General → Appearance → App Icon contains only the two visual preview controls, labelled **Red** and **Cream**, with an obvious selected state and accessible names. Do not add a repetitive subtitle or explanatory paragraph. This saved workspace preference is independent of the light/dark interface theme and follows the existing layout save/conflict handling. It selects the in-app mark, startup logo, favicon, notification artwork, touch export, installation manifest and Assistant illustration palette. Assistant listening and speaking expressions are automatic activity states, not additional Appearance choices. Earlier outfit alternatives remain archived concepts.

Keep source artwork, in-app marks and Apple touch exports opaque. The in-app presentation uses a 24% rounded-corner fallback. Browsers supporting `corner-shape: squircle` use that native CSS shape with a 50% radius. Desktop and ordinary web-app launcher exports bake that same fourth-power superellipse into transparent, antialiased corners, because Windows does not apply the app's CSS mask. Keep original source pixels and face scale intact; add no border or surrounding padding. ImageGen colors are approximate: the icon palette is retained, while the interface's exact brand-red token remains `#D93643`. Do not claim exact color matching or perfect mathematical symmetry from the prompt. Review small-size clarity and real rendered backgrounds.

**Assistant expressions:** `NovaAssistantMark` uses the selected Red or Cream palette in the welcome view and all inline or floating voice panels. Resting artwork reuses the approved 192 px app mark. Listening and speaking use their dedicated 256 px square exports, preserving the same executive identity and CSS corner shape. The voice mascot uses a 104 × 104 CSS px squircle with the shared lower accent edge and no padded outer frame; the header logo and navigation tiles use the approved 44 × 44 scale. Compact 44 px call controls sit below the larger face. Listening has a distinct paired ear-wave cue even during ready silence. Welcome artwork displays at 92 × 92, reduced to 76 × 76 in narrow layouts. Keep voice controls in a compact overlay above the composer so the transcript remains visible on both sides. Shared dock-clearance tokens keep the last message reachable. Latest stays centered without voice; during a call it shares the controls’ row with a 44 px target and a 12 px gap. Showing or hiding Latest must not lift the mascot or move the call controls.

Select listening whenever a connected, unmuted microphone is ready for the next turn, including silence before speech. Select speaking for actual Assistant audio playback in a connected call, including while the microphone is muted. Processing, muted, ending, ended and error states use the resting expression. Permission, preparation and connection use an indeterminate pulsing rounded square in the exact brand red; disable its animation for reduced motion. Omit visible state subtitles and the disclosure chevron. Retain screen-reader status, tooltips, microphone/interrupt/end controls and expandable call details, including sound and caption recovery. A normal hang-up dismisses the panel after the call and captions are confirmed saved; uncertain closure or unsaved words retain recovery controls. Per-turn expression changes never change the saved App Icon choice, favicon, manifest or operating-system icon. Saved personal agent appearances and the portrait/pixel rendering engines are unchanged; these shared Assistant images do not replace them.

Voice artwork motion must follow measured sound: input amplitude while listening, audible playback amplitude while speaking. Silence is still; mute, interruption and ended calls clear the relevant levels. Use a separate artwork subscription so audio samples do not rerender the transcript. Reduced motion keeps the expression and listening cue static. Captions request the provider's balanced transcription delay as a quality hint, not an admission requirement: an omitted or normalized delay must not block a correctly acknowledged transcription model and captured conversation context. Captions remain a separate recognition result from the audio understood by the voice model and must never be reconstructed from its reply. Connection errors open their details automatically. The Latest action is an accessible down-arrow button beside the voice controls during a call.

**Approved compact navigation (1.9.13):** mascot, module and header buttons share **44 × 44 CSS px** targets on mobile and desktop. Module glyphs are 24 × 24 px inside a 60 px docked rail. The mascot remains visible in the header with navigation shown or hidden. The panel occupies ordinary app space, and showing it resizes the workspace beside it. Phone navigation starts hidden when there is no saved preference; desktop navigation starts visible. Save the owner's choice, retain it when switching modules and keep Settings reachable. Navigation options follow the rail edge and fit inside narrow windows. This replaces the earlier 60 px tiles and phone drawer. CSS pixels do not establish identical physical dimensions on every device; launcher exports remain separate from in-app sizing.

**Implemented export distinction:** Opaque 1024 × 1024 px platform masters, 192 px in-app marks and 180 px Apple touch icons derive from the high-resolution unmasked source; 192/512 px ordinary launchers and desktop PNG/ICO exports have transparent squircle corners. The authored source images are 1254 × 1254 px, separate from platform export dimensions. Modern Apple [App Icons guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons) specifies a 1024 × 1024 px square layout for iOS/iPadOS/macOS and system-applied rounded masking. The web touch export remains 180 × 180 and opaque. Both choice manifests retain the same app identity and advertise ordinary icons; different platform crops need their own review. Desktop PNG/ICO packaging defaults to Red. Existing installed shortcuts may retain a cached icon and need a local icon refresh. No physical iPhone installation has been tested for this change.

## Assistant States And Reliability

Keep the composer to its writing area and one compact action row. Account selection belongs in an icon-only button beside the model control, using the shared button face, lower edge and focus treatment. Account names, usage, routing details and selection errors appear inside its disclosure. When the conversation is too narrow for another 44 px target, include account selection in the response menu instead of adding a permanent row or shrinking the controls. Check the rendered composer with both wide and narrow conversation columns before delivery.

Readiness, execution and result presentation must reflect actual state. Distinguish connecting, ready, working, waiting for approval, interrupted, unavailable, failed and complete where those distinctions affect the next action. Show progress only when supported by real progress; use an honest indeterminate state otherwise. Do not present a staged draft as a sent message or a prepared artifact as a published result.

Preserve unsent writing, attachments and context through navigation and recoverable errors. Keep actionable recovery near the affected work, with technical diagnostics available in details. Long Assistant conversations may scroll normally; Home's no-internal-scroll rule must not damage the reading experience. Team and agent activity should help users understand who is working, what needs attention and what can be resumed, without decorative motion implying activity that is not occurring.

## Acceptance And Next Tranches

For each changed surface, inspect representative light/dark and narrow/wide states, keyboard focus, long text, empty/loading/error states and reduced motion. Check consistent buttons, stable sample previews, equal widget sizing, content fit and saved-state persistence. Exercise dragging, cancellation, keyboard and single-pointer alternatives as applicable. Report the actual candidate and checks completed; a narrow browser viewport is not a physical touchscreen test. Use focused verification during development and the required release gate once per coherent candidate.

Proposed next tranches, subject to selection and implementation:

1. Verify the accepted icon exports on actual newly installed devices, including platform masking and icon-cache behavior; do not count browser gallery previews as physical-device acceptance.
2. Resolve remaining typography, control and widget-density exceptions against this reference, with meaningful content in every size.
3. Improve Assistant and team-work state clarity while preserving drafts and execution semantics.
4. Consider further character or agent appearance work separately from the implemented shared Assistant expressions; preserve saved personal avatars and do not present static concepts as delivered behavior.

Update the accepted decisions and observed baseline after delivery. Keep pending proposals visibly pending, and explain what changed, why, how it was verified and what remains unfinished.
