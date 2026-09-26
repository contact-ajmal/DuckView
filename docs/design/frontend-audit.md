# Frontend audit

An audit of the DuckView web package (`packages/web`) after the Agent Home landed (4c1d58e), before the design-system
pass. Screens were reviewed on Midnight (dark) and Daylight (light) at 1440, 1024 and 390 px, and the shell, the Agent
Home, the mission workspace, the command palette, the sign-in page and the Analyst WebUI were read in source.

## Strengths

- **A real token layer.** Tailwind v4 `@theme` tokens, rewritten per theme through `--t-*` variables. Light themes
  mirror the neutral ramp, so one class set works in both. There is a semantic layer (`canvas`, `surface`, `line`,
  `fg-*`), and there are chart series and status colours.
- **An enforced type scale.** Five sizes plus `display`. `lint:ui` rejects arbitrary sizes, gradients, raw tables and
  `alert()`.
- **Shared primitives.** `components/ui` (Button, IconButton, Menu, Tabs, Modal, Drawer, feedback), `components/data`
  (DataTable, ChartFrame, ResultPreview) and `components/ai` (ToolStep, ApprovalCard, TaskTimeline). Feature code
  mostly uses them.
- **Designed states.** Skeletons, `ErrorState`, `InlineError`, `Empty` and toasts, used consistently.
- **Keyboard.** ⌘K palette, ⌘I agent, ⌘J AI panel, visible focus rings everywhere, focus traps in dialogs.
- **The agent's work is honest.** Plans, tool steps in words, approvals and "Open in Console" that checks access
  again.

## Inconsistencies

- **Three AI entries with overlapping names:** the rail's "Agent" (the Agent Home), the rail's "Agents" (activity,
  approvals, MCP) and the top bar's "AI" button (the contextual panel, ⌘J). People can't tell which one to use.
- **Radii.** The sign-in card is `rounded-2xl` with a `shadow-xl` and a backdrop blur; the palette is `rounded-xl`.
  The skill says 8 px for dialogs and nothing larger.
- **Chips.** Agent Home intents use bordered chips (`border-zinc-800`), while elsewhere segmented choices are Tabs or
  ghost buttons.
- **Surfaces.** `bg-zinc-900/60`, `bg-zinc-900/70` and `bg-zinc-900` all appear for "raised". There is no named
  elevated or interactive level.
- **Brand.** The sign-in page still reads "DuckView Enterprise — Hardened DuckDB workspaces · MCP for agents", while
  the product now opens on the agent.

## Visual problems

- **The logo is a literal duck head** (an eye and a bill on a "D"). At 16 px the eye and the bill turn into noise,
  and it reads as a mascot rather than a tool.
- **The mission workspace boxes everything.** Findings, each result and each object are all bordered cards inside a
  bordered layout, which makes three nested outlines at 1024 px.
- **The top bar has nine things at 1440 px:** switcher, breadcrumb, search, storage, Live, bell, AI and avatar, plus
  the menu on mobile. The eye has no resting place.

## Clutter

- **The Agent Home says too much.**
  - A headline plus a sentence of explanation.
  - A labelled context bar ("Workspace …", "Dataset …").
  - Six intent chips.
  - Two equal columns: Active and Recent.
  - A footer of three links.
- **Status appears three times.** "Live", the storage label and the StatusDot text all compete in the top bar,
  though "Live" is only useful when it is *not* live.
- **The Data section has nine tabs,** mixing exploration (Explorer, Compare), modelling (Prepare, Models, Metrics) and
  governance (Catalog, Lineage, Quality, Access policies).

## Navigation

- **Sections.** There are eight rail sections of equal weight: Agent, Data, SQL, Dashboards, Apps, Agents, Connections
  and Settings. SQL, Dashboards and Apps are all ways of *building* on data and belong together.
- **The workspace overview** (`#/home`) is reachable only from a footer link on the Agent Home.
- **Profile and help.** Profile lives in the top bar; there is no help entry at all. Keyboard shortcuts are buried in
  the workbench's ⋯ menu.
- **Permissions.** The rail isn't permission-aware: a viewer sees Connections and Models, then hits a refusal.

## Typography

- The scale is right. The misuse is local: the Agent Home headline uses `display`, which is reserved for KPI values.
  A prompt-first home shouldn't need a headline at all.
- Some labels use `font-semibold` at `text-xs` next to `text-body` titles, which blurs the hierarchy in the mission
  side panel.

## Spacing

- The 4 px grid holds. The Agent Home top padding (`11vh`) pushes the composer below the fold at 1024×700 once a
  carried context line appears.
- In the mission side panel, the section gaps (`space-y-5`) are larger than the gaps between results (`space-y-4`),
  which inverts the hierarchy.

## Components

- Missing primitives:
  - a **segmented control**: intents and the result view's Chart, Table and SQL switcher;
  - a **disclosure**: activity, "Show the work";
  - a **context chip**: a chosen dataset shown as a removable token.
- `ProgressBar` lives in a feature file (MissionList) but is used by two surfaces.
- `Logo` has one variant: no wordmark, no monochrome version, no favicon source.

## Agent UI

- **The move from ready to working is a page change,** not a continuation. The prompt the person typed disappears and
  reappears as a title.
- **Activity is always expanded** in the working state and competes with the plan.
- **Active missions don't look different from recent ones:** same row, same weight, one list beside the other.
- **Recent rows have no actions.** Opening a mission is the only way to duplicate or share it.
- **No dataset chosen reads as "Any data".** That is neutral, but it doesn't invite choosing one.

## Accessibility

- Focus rings, `aria-current`, radiogroups, progressbars with values and roles on the palette are all present. Keep
  them.
- The rail labels are `text-2xs` `zinc-500` on `zinc-900`, about 4.1:1, which is below AA for 11 px text. Raise
  inactive labels to `zinc-400`.
- The intent chips are `role="radio"` but don't respond to arrow keys.
- The Live status reads as colour plus a word only at xl widths; below that it is colour alone with a title.

## Responsive

- Below 640 px the rail hides behind a drawer. The drawer lists the same eight sections, each with a two-line hint,
  so it is tall.
- The Agent Home is fine at 390 px (the e2e checks for overflow). The mission's workspace collapses its side panel
  under the results at under 1024 px, which pushes the Context panel far down.
- The top bar's breadcrumb truncates the workspace name to 9 rem below xl, which is acceptable.

## Recommended direction

Keep the stack, the token layer and the primitives, and make the product quieter rather than different:

1. **Tokens.**
   - Name surface levels (`canvas → raised → overlay`) and interaction layers (`hover`, `pressed`, `selected`).
   - Add accent roles (`accent`, `accent-ink`, `accent-subtle`, `focus`), status roles and motion tokens for
     enter and exit.
   - Stop inventing opacity variants in features.
2. **Brand.** A geometric mark: a D-shaped viewport holding a 2×2 data grid. It comes with full, compact, monochrome,
   favicon and nav-mark variants, and the sign-in page reads "Your intelligent data workspace."
3. **Navigation.**
   - Five primary destinations: **Agent, Workspaces, Data, Build, Connect**.
   - Secondary: **Help, Settings, Profile**, at the foot of the rail.
   - Permission-aware, so what the person can never use is hidden.
   - One AI entry per job: the Agent (missions) in the rail, and "Ask about this screen" (⌘J) as a quiet top-bar
     icon. Agents & MCP moves under Connect.
4. **Top bar.** The workspace and breadcrumb, the command bar, and three icons: the inbox, ask-about-this, and
   connection status shown only when degraded.
5. **Agent Home.**
   - The prompt is the centre, with no headline paragraph.
   - A compact context line (workspace · datasets) with "+ Context".
   - Five quiet intents.
   - Active missions as a stronger band with progress, and Recent as a compact list with hover actions.
6. **Mission.**
   - The request stays in place as the page's heading from the moment it is sent.
   - Activity sits behind a disclosure.
   - Results appear on the canvas with hairlines rather than boxes.
   - One primary action per screen.
