# Nova Dream Design System

Living visual and interaction reference · baseline: application 1.8.1 · updated 19 September 2026.

This document separates **accepted principles**, **observed implementation** and **open proposals**. Accepted principles guide new work; observed values describe the inspected source, not a claim that every screen already conforms. Proposals are not delivered features. Keep this document and the shared styles synchronized in both independent repositories when decisions change. Functional specifications remain useful unless a newer decision explicitly replaces them.

## Vision And Accepted Principles

Nova is a warm, capable executive workspace: immediately readable, personal and comfortable for sustained work with an Assistant. Its character comes from deliberate color, rounded forms and tactile controls, rather than decoration competing with the task.

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

## Controls, Surfaces And Accessibility

**Current shared control contract:** [buttons.css](../apps/client/src/buttons.css), loaded after the main component styles, defines a 2 px border, 16 px corner radius, 4 px solid lower edge and weight 650. Pressing moves the control down 2 px and leaves a 2 px edge. Primary and selected navigation actions use gold with the action ink and edge. Other selected controls use soft gold. Navigation controls use the shared app-tile shape described under App Identity And Character.

This family governs interactive actions, not every content surface. Content rows, checkboxes, calendar cells/events and drag handles retain specialized geometry; nested action buttons should still belong to the shared family. Card geometry currently uses a 22 px radius and a restrained solid lower edge. Avoid unnecessary nested cards and excessive outlines around ordinary text.

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

Weather uses recognizable condition artwork—sun, cloud, rain and related states—alongside real readings. Unknown or stale readings must remain explicit. Next Appointment retains the accepted calendar-inspired red event stripe, compact time and consistently sized title. Do not add the old lynx illustrations back into widgets while the character overhaul remains deferred.

## Reordering And Motion

Widgets support both holding the widget surface and using its Move control. The lifted item follows the pointer, a landing placeholder shows the intended position, and neighboring items move aside. Sidebar module rearrangement must use the same visual and behavioral language. Settings stays pinned. Remove redundant Move Earlier / Move Later rows from the widget's ordinary menu; retain an appropriate accessible equivalent elsewhere.

Current shared motion uses a 350 ms hold, 220 ms neighbor movement and 180 ms landing, with `cubic-bezier(.2,.75,.25,1)`. Standard button feedback uses 120 ms transitions. Respect reduced-motion preferences; positional changes must remain understandable when animation is removed. Do not make regular work depend on bounce or whole-screen motion.

Reordering must not trigger navigation or activate content after drop. Preserve touch scrolling before pickup, support cancellation, retain focus and save the final order. Keyboard support is necessary, but [Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) also calls for a single-pointer alternative without dragging unless an exception applies. A drag handle alone is not that alternative; verify the actual accessible route for each surface.

## App Identity And Character

**Accepted identity:** a flat, straight-ahead lynx fills the app tile, with black eyebrows and facial details, gold eyes, a charcoal suit and red tie. The artwork has **no black perimeter frame or decorative outline**; its background reaches every edge of an opaque square. Preserve the selected face scale and proportions rather than shrinking the character into unused background space or adding a rendered 3D tile. The accepted source artwork and platform exports are recorded in [the brand asset guide](../assets/brand/README.md).

**Implemented choices:** Red is the default; Cream is its light companion with red markings and the same executive identity. Settings → General → Appearance → App Icon contains only the two visual preview controls, labelled **Red** and **Cream**, with an obvious selected state and accessible names. Do not add a repetitive subtitle or explanatory paragraph. This saved workspace preference is independent of the light/dark interface theme and follows the existing layout save/conflict handling. It selects the in-app mark, startup logo, favicon, notification artwork, touch export and installation manifest. Earlier outfit and expression alternatives remain archived concepts, not additional settings.

Keep every source and exported PNG opaque, including its square corners. The in-app presentation uses a 24% rounded-corner fallback. Browsers supporting `corner-shape: squircle` use that native CSS shape with a 50% radius. These are interface treatments; do not bake either mask, a border, or transparent corner padding into the source. ImageGen colors are approximate: the icon palette is retained, while the interface's exact brand-red token remains `#D93643`. Do not claim exact color matching or perfect mathematical symmetry from the prompt. Review small-size clarity and real rendered backgrounds. A separate full character/state overhaul remains future work.

**Rail sizing:** the brand and module buttons use a consistent **60 × 60 CSS px** size at every viewport, including narrow windows. This adopts the visual scale of the standard iPhone Home Screen icon rather than shrinking the source file to 60 pixels. Apple's archived [QA1686](https://developer.apple.com/library/archive/qa/qa1686/_index.html) lists 120 × 120 px at 2× and 180 × 180 px at 3× for that 60-point icon. CSS pixels are the web layout choice; they do not establish identical physical dimensions on every device. Keep the rail padded and its Settings control reachable.

**Implemented export distinction:** Opaque 1024 × 1024 px platform masters, 192 px in-app marks and 180/192/512 px launcher images derive from the high-resolution unmasked source. The authored source images are 1254 × 1254 px, separate from platform export dimensions. Modern Apple [App Icons guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons) specifies a 1024 × 1024 px square layout for iOS/iPadOS/macOS and system-applied rounded masking. The web touch export remains 180 × 180; Nova's CSS rounding is an in-app approximation, not a replacement for the operating-system mask. Both choice manifests retain the same app identity and advertise ordinary icons; different platform crops need their own review. Desktop PNG/ICO packaging defaults to Red. Existing installed shortcuts may retain a cached icon. No physical iPhone installation has been tested for this change.

## Assistant States And Reliability

Readiness, execution and result presentation must reflect actual state. Distinguish connecting, ready, working, waiting for approval, interrupted, unavailable, failed and complete where those distinctions affect the next action. Show progress only when supported by real progress; use an honest indeterminate state otherwise. Do not present a staged draft as a sent message or a prepared artifact as a published result.

Preserve unsent writing, attachments and context through navigation and recoverable errors. Keep actionable recovery near the affected work, with technical diagnostics available in details. Long Assistant conversations may scroll normally; Home's no-internal-scroll rule must not damage the reading experience. Team and agent activity should help users understand who is working, what needs attention and what can be resumed, without decorative motion implying activity that is not occurring.

## Acceptance And Next Tranches

For each changed surface, inspect representative light/dark and narrow/wide states, keyboard focus, long text, empty/loading/error states and reduced motion. Check consistent buttons, stable sample previews, equal widget sizing, content fit and saved-state persistence. Exercise dragging, cancellation, keyboard and single-pointer alternatives as applicable. Report the actual candidate and checks completed; a narrow browser viewport is not a physical touchscreen test. Use focused verification during development and the required release gate once per coherent candidate.

Proposed next tranches, subject to selection and implementation:

1. Verify the accepted icon exports on actual newly installed devices, including platform masking and icon-cache behavior; do not count browser gallery previews as physical-device acceptance.
2. Resolve remaining typography, control and widget-density exceptions against this reference, with meaningful content in every size.
3. Improve Assistant and team-work state clarity while preserving drafts and execution semantics.
4. Design a separate coherent character/state system after the icon decision; do not imply it has shipped through static concept art.

Update the accepted decisions and observed baseline after delivery. Keep pending proposals visibly pending, and explain what changed, why, how it was verified and what remains unfinished.
