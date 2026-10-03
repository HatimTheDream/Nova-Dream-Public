# Quiet List UI contract

This is the selected shared direction for Nova's interface: clear reading order, useful density, content-driven height, and familiar raised controls. It supplements [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) and replaces its older fixed-size Home widget arrangement where they conflict. It describes the current source contract, not exhaustive visual acceptance or proof of a live release.

## Identity and hierarchy

- Keep Nova's warm canvas, gold primary actions, semantic status colors, rounded surfaces, and square mascot artwork. Scale the mascot proportionally; do not crop it into a circle or use it as repeated decoration.
- Organize a page around the decisions and information it serves. Use headings, aligned rows, spacing, and subtle dividers before introducing another bordered card.
- Give the immediate next action a clear emphasis. Secondary actions use quiet controls or an accessible disclosure. Every actionable item retains a visible route to its source, full content, or result.
- Use color to communicate selection, status, or a saved personal choice. Avoid arbitrary category backgrounds, ornamental icons, heavy stacked shadows, and nested boxes without a grouping purpose.
- Preserve authored labels and all user-entered or imported text. Visual cleanup must not rewrite saved content, weaken approval boundaries, or hide unknown outcomes.

## Shared spacing, text, and controls

Use the semantic roles in `theme.css` and the preference handling in `typography.css`. Reuse these tokens rather than creating a second component scale.

| Role | Default before text preferences |
| --- | --- |
| Body | 16px / 24px line height |
| Secondary text and controls | 14px / 20px line height |
| Metadata | 12px; essential instructions use secondary or body text |
| Small / medium / large heading | 16px / 18px / 20px, with matching semantic leading |
| Spacing | 4, 8, 12, 16, 24, 32px |
| Standard / spacious card inset | 16px / 24px |
| Dialog inset | 24px, reducing to 16px on narrow screens |
| Action / icon-button minimum target | 44px high / 44px square |
| Control / card radius | 12px / 16px |

Action buttons retain Nova's 2px outline and solid 2–4px lower edge, with a 12px corner radius. Primary actions and the active global destination use gold; secondary action buttons keep a warm white face. Full content rows, calendar cells and text disclosures keep their own flat geometry. Navigation uses icons only, with accessible names and hover/focus labels; do not add persistent captions beside or beneath navigation icons.

The container owns its content inset. A card's status block, header, body, and actions must have an explicit shared inset; paragraph margins only separate paragraphs. Do not rely on a paragraph's horizontal margin to keep text away from a card edge. Do not add competing blanket descendant resets.

Rows and action groups must yield to long content. Use `min-width: 0`, wrapping labels, flexible columns, and content-driven height. At narrow content widths, actions move below the text rather than shrinking text or forcing horizontal scrolling. A deliberately bounded preview must offer a route to the full content.

Keep interface and message preferences independent. Semantic text tokens resolve the interface scale; the existing build transform handles supported literal sizes and control-token consumers. Do not multiply an already scaled semantic token again. Assistant prose and saved answer text keep the user's message font and size. Growing text must grow its container, including focusable controls.

The 44px target is Nova's product default. Spatial cells and inline content require deliberate treatment rather than an indiscriminate minimum height on every element. Maintain visible keyboard focus, accessible names, native semantics, and keyboard alternatives to drag. Selection, disabled, destructive, pending, failure, and unknown states must remain distinguishable without relying on color alone.

## Current surfaces and adapters

| Surface | Application of the contract |
| --- | --- |
| Shared shell, cards, dialogs, notices, and action groups | `theme.css`, `buttons.css`, and `quiet-ui.css` provide common roles, raised controls, wrapping headers, and consistent dialog slots. These shared styles affect existing screens; they do not constitute a separate redesign of every screen. |
| Responsive navigation | At 800px and below, a bottom row uses the saved navigation order and offers remaining sections through More. At 400px and below it shows three destinations plus More; from 401px to 800px it shows four plus More. A real layout row and safe-area padding keep it clear of content and composers. Wider windows retain the side rail. Resizing never changes navigation preferences. |
| Home: Today | A single reading order presents the greeting, upcoming schedule, grouped briefing rows, and Assistant activity. Details and secondary actions expand within the relevant row. |
| Home: My space | Saved widgets become consistently wide, content-driven sections. There is no mixed-size tile packing or Tetris layout. Existing widget IDs, order, settings, colors, notes, links, hidden items, and saved size metadata are retained; the renderer no longer uses the old sizes to determine geometry. |
| Assistant plans and approvals | Padded status containers, readable semantic labels, restrained dividers, and wrapping controls. Exact proposal versions, decision handlers, retained writing, and recovery actions retain their existing authority. |
| Saved question receipts | Questions and answers retain their pairing and full saved text, with consistent separation and keyboard-accessible disclosure. Secret answers remain hidden. |
| Records and existing module views | Shared controls and surface adapters reduce visual inconsistency while preserving the module's editing and navigation model. Further screen-specific redesigns need their own scope and evidence. |

The Home integration also separates an explicit saved-draft preview from ordinary Assistant/activity navigation, uses a ticking clock for the upcoming schedule, and restores the complete inherited palette for an uncolored clock section. These prevent stale destinations, frozen time labels, and mixed light/dark control colors; they are implementation safeguards, not a claim of exhaustive rendered verification.

## Intentional exceptions

- **Calendar:** preserve spatial day/week/month relationships, time axes, event placement, and calendar-specific keyboard behavior. Apply shared text, focus, and action roles without flattening the calendar into a generic list.
- **Inbox:** preserve a denser message list, folder navigation, thread reading, and composer layout. Density must still allow readable text, identifiable selection, and usable targets.
- **Content Board and Calendar views:** preserve grouping, columns, and date placement where they carry meaning. This exception does not justify unrelated mixed-size dashboard tiles.
- **Hub:** preserve its spatial scene, actors, inspection, and movement model. Shared controls and detail panels follow the contract without converting the scene into cards or rows.

An exception is justified by the task and interaction, not by a desire to make a screen look different. Its surrounding controls, writing, status, and recovery should remain recognizable as Nova.

## Checklist for the next feature

1. Choose the content order and primary action before choosing containers; identify any meaningful spatial exception.
2. Reuse semantic tokens and container-owned padding. Check long titles, empty content, error/status text, and action wrapping.
3. Preserve exact source navigation, saved writing, identities, approval semantics, and uncertain outcomes.
4. Check the affected journey at wide, actual narrow desktop, and phone widths, with enlarged text, keyboard use, and both themes. Keep before/after evidence tied to the same state and dimensions.
5. Report what was source-reviewed, exercised, rendered, and delivered separately. Shared styling coverage is not proof that every feature or button has been accepted.
