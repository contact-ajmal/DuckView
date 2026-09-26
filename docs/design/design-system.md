# Design system

The source of truth is `packages/web/src/index.css` (`@theme`) and `src/theme/themes.ts`. The rules for using it
are in the `duckview-ui` skill. This page explains the system and its roles.

## Character

A professional data tool: quiet, dense where the data is, spacious where a decision is made. It uses one accent,
duckbill yellow, which means "act here". Hierarchy comes from type, tone and hairlines, not from boxes. Dark and light
are both first-class: light themes mirror the neutral ramp, so every role below holds in both.

## Colour roles

| Role | Token / class | Use |
|---|---|---|
| Canvas | `bg-canvas` (zinc-950) | The page, editors, the result grid |
| Raised | `bg-raised` (zinc-900) | Side panels, table headers, the rail, composer fields |
| Overlay | `bg-overlay` (zinc-950 + `shadow-xl` + `border-line`) | Menus, popovers, dialogs, the palette |
| Hover | `bg-hover` (zinc-900) | A row or ghost control under the pointer |
| Pressed / selected | `bg-selected` (zinc-800) | The selected row, the active segment, the current nav item |
| Line | `border-line` (zinc-800) | The default hairline |
| Line, subtle | `border-line-subtle` (zinc-800 at 60%) | Dividers inside a list |
| Line, strong | `border-line-strong` (zinc-700) | A focused composer, a hovered field |
| Text | `fg-strong`, `fg`, `fg-body`, `fg-secondary`, `fg-muted`, `fg-faint` | Titles → body → labels → metadata → placeholders |
| Accent | `bg-accent-500` + `text-[color:var(--accent-ink)]` | The one primary action, the active nav marker, a selected checkbox |
| Accent, subtle | `bg-accent-subtle` (accent at 12%) | The one highlighted choice where a fill is needed |
| Focus | `--focus-ring` (accent-500) | Every focus ring |
| Status | `emerald` ok, `amber` warning, `red` error, `sky` info | Always paired with a word or an icon |
| Series | `--series-1…8` | Charts, in order |

Rules:

- There are no gradients, no violet and no literal hex in features.
- Status never decorates.
- Fuchsia is only for column types.

## Surfaces and elevation

Elevation is a stack of three levels. A resting surface never has a shadow.

```
canvas (0) ── raised (1): rail, side panel, composer ── overlay (2): menus, dialogs, palette (shadow-xl)
```

Nest at most one bordered surface. On the canvas, prefer a heading plus a hairline over a card.

## Typography

Inter for the UI, and JetBrains Mono for SQL, values, identifiers and paths.

| Token | px | Use |
|---|---|---|
| `text-2xs` | 11 | Metadata, counts, timestamps |
| `text-xs` | 12 | Dense UI, labels, grid cells |
| `text-body` | 13 | Body, controls |
| `text-title` | 15 | Dialog titles, a mission's request, a panel's lead |
| `text-page` | 18 | Page titles |
| `text-display` | 28 | Only a KPI value |

Use sentence case everywhere, with no ALL-CAPS or eyebrow labels. Numbers use `tabular-nums`. Weights:

- 400 for body;
- 500 for controls and names;
- 600 for titles.

## Spacing and layout

- A 4 px grid.
  - Between controls: 6–8.
  - Inside panels: 12–16.
  - Between sections: 20–24.
  - Page gutter: 24 (16 on a phone).
- Sizes:
  - control 30 px (`sm` 26);
  - top bar 44;
  - rail 72;
  - list row 32;
  - grid row 26.
- Reading width:
  - `max-w-2xl` for the Agent Home and a mission's request;
  - `max-w-5xl` for settings-like pages;
  - full width for work surfaces.

## Radius

| Token | px | Use |
|---|---|---|
| `rounded-md` | 4 | Controls, chips |
| `rounded-lg` | 6 | Panels, the composer, artifact frames |
| `rounded-xl` | 8 | Dialogs, the palette, the sign-in panel |

Nothing is larger. Status dots and avatars are `rounded-full`.

## Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120 ms | Hover, press, colour |
| `--dur-med` | 200 ms | Open: menus, drawers, disclosure |
| `--dur-slow` | 320 ms | A layout change the person caused, such as Home → working |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Everything that enters |

- Classes: `dv-pop` (popovers), `dv-drawer` (drawers), `dv-rise` (content that the person's own action brought in,
  such as the working state), and `dv-reveal` (a disclosure's body).
- There are no entrance animations on page load. Reduced motion collapses everything to 1 ms.

## Component states

Every interactive component has these states, and none relies on colour alone:

| State | Treatment |
|---|---|
| Rest | Its role colours |
| Hover | `bg-hover` or `border-line-strong`, 120 ms |
| Pressed / selected | `bg-selected` + `fg-strong`; `aria-pressed`, `aria-selected` or `aria-current` |
| Focus | A 2 px accent ring, offset 1 (keyboard only, `:focus-visible`) |
| Disabled | 50% opacity, `cursor-not-allowed`, with the reason in `title` |
| Loading | A spinner inside the control (`Button loading`) or a skeleton in the content's shape |
| Error | `text-red-300` plus an icon; inline where the action was |

## Primitives added in this pass

- `Segmented`: a small radio group with arrow keys. Used for intents and a result's view.
- `Disclosure`: a button with `aria-expanded` and a body that reveals in 200 ms. Used for activity and "Show the
  work".
- `ContextChip`: a removable token for a chosen dataset or carried object.
- `ProgressBar`: moved to `components/ui`.
- `Logo` variants:
  - `mark` (default);
  - `mono` (currentColor);
  - `full` (mark + wordmark);
  - `nav` (the mark sized for the rail).
