---
name: duckview-ui
description: DuckView's UI/UX rules — the design system, component architecture, AI/agent/tool patterns, workspace context and UI QA. Use for any change to packages/web (pages, components, styling, copy) or any server change that shapes what the UI shows (tool labels, task events, approvals).
---

# DuckView UI

DuckView is an **AI-native data workspace**: analysts and data engineers work on DuckDB workspaces through SQL, visual tools (explorer, dashboards, notebooks), natural language and autonomous agents. These are four ways of working on the same objects, not four apps. The UI is a professional desktop tool, closer to an IDE than a website: dense, quiet, fast, and trustworthy.

Stack: React 19, Vite 7, Tailwind v4 (`src/index.css` `@theme`), zustand stores (`src/store`), hash routing (`src/app/routes.ts`), CodeMirror 6 for SQL, Chart.js for grid widgets and ad-hoc charts, Mosaic/vgplot for cross-filtered views, lucide icons. There is no shadcn or Radix. The primitives live in `src/components/ui/index.tsx`. Extend them; never add a second component library.

## Principles

1. **The data is the interface.** Tables, SQL and charts get the space. Chrome, headers and explanations stay small. Never put a hero, marketing copy or a decorative illustration inside the product.
2. **Hierarchy from type and dividers, not boxes.** Use a heading and a hairline before a bordered card. Nest at most one bordered surface.
3. **One accent, and it means "act here."** Duckbill yellow (`accent-500`, text in `--accent-ink`) marks primary actions, the active nav item, the selection and focus. It is never decoration. Status colours carry status only.
4. **Every state is designed:** empty, loading, error, partial, no permission, and the AI states (below). Pair a state colour with a word or an icon, never colour alone.
5. **AI is a layer, not a room.** Any surface can be asked about. Any AI answer becomes a native object (a SQL tab, a chart, a widget, a metric query, a dashboard) that the user can inspect and edit.
6. **Show the work.** Agent and tool activity is inspectable: what was planned, which tools ran, with what, what came back, and what needs approval. Keep it collapsed by default and one click from full detail.
7. **Keyboard first.** ⌘K reaches everything, ⌘↵ runs, Esc closes, and every control has a visible focus ring.

## Design tokens

Themes (`src/theme/themes.ts`: Midnight, Graphite, Fjord dark; Daylight, Professional, Paper light) rewrite `--t-*` variables. Light themes **mirror** the neutral ramp, so the ramp classes below flip correctly. Dark is the first-class default, but check both.

Semantic colours exist in `@theme` (`index.css`); prefer them in new code — `bg-canvas`, `bg-surface`, `bg-selected`, `border-line`, `border-line-strong`, `text-fg-strong`, `text-fg`, `text-fg-body`, `text-fg-secondary`, `text-fg-muted`, `text-fg-faint`. They alias the ramp below, which older code uses directly:

| Role | Class |
|---|---|
| Canvas (page, editor) | `bg-zinc-950` |
| Raised surface (hover row, side panel, table header) | `bg-zinc-900` (or `/60` for subtle) |
| Selected row or item | `bg-zinc-800/80` plus text `zinc-50` |
| Border, default hairline | `border-zinc-800` |
| Border, strong (hovered control, focused panel) | `border-zinc-700` |
| Divider inside a list | `border-zinc-800/70` |
| Text: strongest (titles, values) | `text-zinc-50` / `text-zinc-100` |
| Text: body | `text-zinc-200` / `text-zinc-300` |
| Text: secondary (labels, descriptions) | `text-zinc-400` / `text-zinc-500` |
| Text: faint (placeholders only; never for text people need to read) | `placeholder:text-zinc-600` |
| Accent fill / accent text | `bg-accent-500 text-[color:var(--accent-ink)]` / `text-accent-300` (use `text-accent-400` for icons) |
| Success / warning / error / info | `emerald` / `amber` (orange on the duck themes) / `red` / `sky`: text `-400` (`-300` on dark tints), tint `-500/12` |
| Column types | `typeTone()` / `<TypePill>` only: numbers sky, time emerald, nested and boolean fuchsia |
| Chart series | `var(--series-1…8)` in fixed order; status charts use `--status-good/warning/serious/critical` |

Never use literal hex, `violet`, `purple` or `indigo` classes, or gradients, in feature code. Fuchsia is only for types.

**Type scale** (Inter UI; JetBrains Mono for SQL, cell values, IDs, paths). Only these sizes exist (`@theme` tokens):

| Class | Size | Use |
|---|---|---|
| `text-page` semibold | 18px | page title (`PageTitle` / `PageHeader`) |
| `text-title` semibold | 15px | dialog title, the lead number of a panel |
| `text-body` | 13px | body, controls, admin-list cells (the base; `body` is 13px) |
| `text-xs` | 12px | dense UI, labels, secondary text, grid cells |
| `text-2xs` | 11px | metadata, counts, timestamps, captions |
| `text-display` | 28px | only a KPI value on a dashboard |

Arbitrary sizes (`text-[13px]`) and `text-sm/base/lg/xl` fail `pnpm --filter @duckview/web lint:ui` (part of the build). No ALL-CAPS tracked labels and no eyebrow labels above headings (`Eyebrow` renders nothing on purpose). Use sentence case everywhere. Numbers get `tabular-nums`.

**Spacing:** a 4px grid. Controls gap 6–8 (`gap-1.5`/`gap-2`); inside panels 12–16 (`p-3`/`p-4`); between sections 20–24 (`space-y-5`/`space-y-6`); page gutter `px-6 py-5`, content `max-w-5xl` for settings-like pages and full width for work surfaces.

**Sizes:** control height 30px (`--control-h`), `sm` 26px; top bar 44px (`--topbar-h`); rail 72px; grid row 26px; list row about 32px.

**Radius:** 4px controls, 6px panels, 8px dialogs and the palette. Use nothing larger.

**Elevation:** shadows only on things that float (menus, dialogs, drawers, palette). A resting surface never has a shadow.

**Motion:** 120ms state changes, 200ms for opening. `dv-pop` for popovers, `dv-drawer` for drawers. There are no entrance animations on page content. Respect reduced motion (global rule in `index.css`).

## Components

Use in this order: an existing primitive, then an extension of it, then a new shared component. A one-off component in a feature file is the last resort.

- `components/ui`
  - Button (`primary` for the one main action per view, `secondary`, `ghost`, `danger`), IconButton (a `label` is required), Input, Select, Label, Badge, StatusDot, Kbd, Tabs, Menu/MenuItem, Modal, Drawer, Spinner, CopyButton, Empty, Card, Stat.
  - Do not hand-roll `<button className=…>` look-alikes, raw `<select>`, or a raw `<input>` (checkboxes are the exception until a `Checkbox` exists).
- `components/layout`
  - `PageHeader` (title, one-line description, actions), `Panel` / `SideCard` (heading and content), `KvRows`, `TypePill`, `Tag`.
- `components/panes.tsx`
  - Resizable split panes. Work surfaces (workbench, explorer, notebooks) use panes, not stacked cards.
- `components/shell`
  - Sidebar (rail), TopBar (workspace switcher, breadcrumb, storage, live status, AI), SectionNav (sub-tabs from `SUBPAGES`), CommandPalette (⌘K), InboxBell.
- Data (`components/data`). Three tables, each for one job; a raw `<table>` fails lint.
  - **`DataTable`** is for lists of things: runs, members, apps, tokens, stats. It takes columns as `{ key, header, cell, sortValue?, align?, width?, truncate?, numeric?, responsive?, defaultHidden? }`.
    - It provides sorting (with `aria-sort`), `search` (a filter box), `columnPicker` (remembered), and loading skeletons when `rows === null`.
    - It shows `error` inline with `onRetry`, and `empty` when there are no rows.
    - Rows can be clickable (`onRowClick`, keyboard too), selectable (`selected`/`onSelectedChange`) and expandable (`expanded`).
    - It also takes `rowProps` (data-* attributes), `pageSize` (a "Show more" button), and `density="compact"` for dense stats.
  - **`ResultPreview`** shows a few rows of a query inline: previews, a stream's latest rows, failing rows, AI answers. It is monospace and shows NULL.
  - **`features/workspace/ResultsGrid`** is the full result table in the workbench and explorer: virtualised, with column types and TSV copy.
  - **`LocationBrowser`** is the only way to choose a path: a folder, or files, on the server's disk or in a cloud bucket. Never add a raw path input or a one-off folder picker.
    - Props: `mode="folder"|"files"`, `multiple`, `remote` (show cloud connections), `title`, `confirmLabel`, and `onPick(paths)`. Paths are absolute, or DuckDB URIs for remote files. If `onPick` throws, the dialog stays open and shows the error.
    - Server side: `/api/storage/locate`, `/places`, `/mkdir` and `/native-pick`. The "Use system dialog" option appears only when the server is in full mode and the request comes from localhost (`services/native-picker.ts`).
    - A question dialog opened on top of it (`promptAction`/`confirmAction`) catches Escape first, so Escape closes only that question.
  - **Right-click menus** use `ContextMenu` (`components/ui`) with `MenuItem`s. Every row with a right-click menu also has a visible "More actions" `IconButton` that opens the same menu, so keyboard and touch users can reach it.
- Sources (`features/overview/DataSourceBar`, `AddSourceDialog`)
  - To add a connection anywhere, use `SourceCatalog`, `wizardFor` and `ConnectionWizards` (`features/connections/SourceCatalog`). Never build a second list of providers or a second connection form.
  - Pinned and recent datasets are per-viewer conveniences in `localStorage` (`duckview.sources.<workspaceId>`).
- Workspaces
  - New workspace always opens `CreateWorkspaceWizard` (`features/workspace`). Its steps are Basics, Storage, Engine, Start from and People.
  - A multi-step dialog shows numbered steps with ticks for the finished ones, has Back and Next, and keeps Create available once the required fields are filled.
  - `StorageChooser` has `allowExisting`, which opens an existing .duckdb file through `LocationBrowser`. A folder target also has a "Choose folder…" button.
  - Administration → Workspaces (`WorkspacesAdminPanel`) is a `DataTable` with filters above it. Bulk actions appear in the toolbar once rows are selected.
  - A destructive bulk action asks the person to type the name, or "delete N", to confirm.
  - One workspace is managed at `#/workspaces/<id>/<tab>` (`WorkspaceDetailPage`). It reuses the settings panels that take a `workspaceId` (Git, Embed, Orchestration) and `EngineSettingsForm`.
    - Health checks are listed worst first, each a `StatusDot` with a label and one line of detail.
  - Backups and bundles (`WorkspaceBackups`, on the detail page's Lifecycle tab):
    - A restore always takes a safety backup first. Restoring objects is an opt-in checkbox.
    - Authenticated downloads use `downloadAuthed(url, name)` from `api/client`.
  - The organisation's workspace policy (quotas, the idle policy, creation rules) is Administration → Workspaces → Policies (`WorkspacePolicyPanel`). Quota usage shows as `QuotaBar`s on the Usage tab.
- Counts in copy use real plurals ("1 table", "2 tables"), never "1 tables".
- Charts
  - Every chart, KPI and table widget sits in `ChartFrame` (`components/data`). It provides the title, metadata, hover or focus actions (`actionsVisible` pins them) and the loading, error and empty states.
    - `ChartSkeleton` shows the loading shape: `kpi`, `chart`, `table` or `text`.
    - View-mode widget actions are "Open in SQL" and "Ask AI about this".
  - Chart.js via `lib/chart.ts` (`useChartTheme`, `MAX_SERIES`, `compactNumber`), Mosaic via `lib/mosaic`.
  - Categorical colours in SVG are `var(--series-n)` set through `style`, not presentation attributes. Axis and label text is `zinc-400`/`zinc-500`, gridlines `zinc-800`, series from `--series-*`. Don't draw a legend when there is a single series. Charts never decorate.

- Feedback (`components/ui/feedback.tsx`, exported from `components/ui`):
  - `toast.success(title, detail?)`, `toast.error(err, title?)`, `toast.info(…, action?)`: the outcome of an action. The mount is in `main.tsx`.
  - `await confirmAction('Delete X? Why it matters.')`: the question becomes the title, the rest the body, and the verb names the button. It is destructive when the question starts with Delete, Remove, Revoke or similar; then Cancel has focus.
  - `await promptAction(title, { label, defaultValue })`: one line of text.
  - `InlineError` (error, onRetry, action), `ErrorState` (a whole area), `Skeleton`, and `useAction()` (pending flag plus toasts).
  - **Never** call `alert()`, `confirm()` or `prompt()`; lint fails on them.
- Forms (`components/ui/forms.tsx`): `Field` (label, control, hint, error), `Textarea`, `Checkbox`, `Switch`.
- Focus (`components/ui/focus.ts`): `useFocusTrap`, used by Modal, Drawer and the confirm dialog. Menu and Tabs take arrow keys. Close buttons carry `data-close`, and `data-autofocus` picks the first field.

### Planned primitives (add them here, then reuse them; see roadmap Phase 2+)

- **Data:** `DataTable` (sort, filter, column picker, selection, empty and loading states), `ChartFrame` (title, actions, loading, empty, error around any chart), `SchemaTree` shared by the workbench and the explorer.
- **AI (still planned):** `ArtefactCard`. The following already exist in `components/ai`:
  - `ApprovalCard`: title, requester, reason, statements, and Approve / Deny or custom children.
  - `ToolStep`: a sentence, status, "changes data", duration and a disclosure.
  - `TaskTimeline`: goal, state (Planning / Running / Waiting / Needs approval / Done / Failed / Cancelled) and steps.
  - `describeTool(tool, args, title)` puts tool calls in words. Add a verb to `describe.ts` for every new tool.

## Work surfaces

- **SQL workbench:**
  - A failed query shows an error panel with the code, the message, "Go to line n" (parsed from `LINE n:`; uses `SqlEditorHandle.goToLine`), Copy error, and Fix with AI.
  - A statement that changes data shows `ApprovalCard` (`components/ai`).
  - Shortcuts: ⌘↵ runs, ⌘⇧↵ explains, Esc stops, ⌘S saves. The sheet is in the ⋯ menu.
  - Hooks go above the page's early returns: a hook added below `if (!workspace) return` blanks the page on reload.
- **Data explorer:**
  - The tabs are Overview, Schema, Preview, Profile, Explore and SQL.
  - Clicking a column opens `ColumnDetail`: stats, the distribution or top values, "Query this column", and "Ask about it".
  - Tables link to lineage at `#/governance/lineage?focus=<table>`.
  - Profiling shows a skeleton with the step in words; a failure shows `ErrorState` with Retry.

## States and copy

- **Empty:** use `<Empty title hint action>`. Say what goes here, why it matters, and give the one action that fills it ("No dashboards yet. Build one from a query or install a template."). Not "Nothing here."
- **Loading:** a skeleton in the shape of the content for anything over about 300ms. Show a spinner only inside the control that is working (`Button loading`). Long operations report progress in words: "Profiling 12 columns…"
- **Error:** what happened, the cause if known (the server's message, trimmed to its first line), and what to do (Retry, Fix with AI, Open settings). Show it inline where the action was, never as a modal alert. Errors don't apologise.
- **Permission:** hide what the user can never do. Disable, with a reason in `title` or a hint, what they can't do *here* ("Viewers can't install templates").
- **Copy:** plain verbs and the user's nouns. A button says what happens ("Install into Sales"), and its toast repeats the verb ("Installed"). Name things by what they are for ("notifications", not "webhook config").

## Workspace context

The context chain is: user → workspace (TopBar switcher, `useWorkspace().activeId`) → storage/connection → dataset (`overviewTarget`) → page (route) → selection (grid rows, editor selection, widget) → query tab → task.

- Always show the workspace and where the data lives (the TopBar storage label).
- **The open object** is declared with `usePageObject({ kind, id, label })` (`store/context.ts`). The breadcrumb shows it, and the AI receives it as context.
  - It is wired up for datasets, dashboards (grid and Mosaic), notebooks, query tabs and apps.
  - Every page that shows one object must declare it.
- AI requests carry context automatically: the page object (`page`, from `usePageObject`), the picked `targets`, `activeSql`, the error, the result preview and the notebook id.
  - The server's `describePage` turns the object into prompt text; a dashboard, for example, becomes its widgets and their SQL. A dataset on screen is profiled like a target.
  - The chips in the AI panel show that context, and each can be removed (`pageOff`).
  - The user never retypes the table name.
- **Ways into the AI:**
  - ⌘J toggles the panel.
  - ⌘K offers "Ask AI: …" for anything typed.
  - The workbench has "Ask AI about these results" and, on errors, "Fix with AI".
  - Widgets have "Ask AI about this"; datasets have "Ask AI"; a column has "Ask about it".
- Deep links are hash routes. Every object view must be linkable (`#/dashboards/<id>`, `#/notebooks/<id>`, `#/settings/<category>`), and AI answers link to the objects they made.

## AI, agents and tools

One vocabulary for Copilot turns, DuckView agent runs (`hosted_agent_runs.steps`), MCP/A2A tool calls (live `mcp_tool` events) and orchestrated runs:

**Task** = goal, context, plan, steps (tool calls), approvals, artefacts, outcome.

- **States** (always a word plus a `StatusDot` tone):

  | State | Tone |
  |---|---|
  | Planning | `busy` |
  | Running *tool* | `busy` |
  | Waiting for data | `idle` |
  | Needs approval | `warn` |
  | Done | `ok` |
  | Failed | `error` |
  | Cancelled | `idle` |

- **Tool steps** read as sentences, not function names: "Ran a query on `orders` · 1.2 s · 240 rows", "Profiled `customers`", "Created dashboard *Sales overview*". The raw tool name, arguments and result sit behind a disclosure. Add a human label when you add a server tool (`agent/tools.ts`: `title` and `description`).
- **Permission** is visible on every tool.
  - Live `mcp_tool` events carry `title`, `effect` ('read' | 'write') and `reason`.
  - A held call (`approval_required`) shows as an `ApprovalCard` in Agents → Approvals and in the inbox bell ("Waiting for your approval").
  - Agents get approval in their own client. DuckView offers "Run it myself in SQL", which opens the statement in a tab, where it waits for the workbench's own approval.
- **Artefacts** (SQL, chart, widget, dashboard, metric query, app, notebook) render as compact cards with Open, Insert and Pin actions that land in the native surface. Never leave a result only inside the chat.
- **Streaming:** stream text; keep the timeline order stable; never reflow finished steps. Offer Stop while running, and Retry on a failed step or task.
- **Natural language** is an entry point everywhere: ⌘K "Ask…", "Ask about this" on tables, results, widgets and errors ("Fix with AI"). The answer changes application state (opens the SQL tab, applies the chart config) rather than only describing it.
- There is no special AI colour or gradient, and no sparkle confetti. Mark AI with the `Sparkles` icon and structure.

## Layout and information architecture

- **Shell:** rail (8 sections) | top bar | section sub-tabs | page.
  - The rail sections are Home, Data, SQL, Dashboards, Apps, Agents (`#/agents`, which also accepts `#/mcp`), Connections and Settings.
  - The top bar holds the workspace › section › page › object breadcrumb, ⌘K, the storage label, live status, the AI assistant and the account.
  - Add pages to `SUBPAGES` or `parseRoute`, not to the rail, which stays at eight items or fewer.
  - Agents opens on Activity, then Approvals; the agents, MCP clients and tools come after.
- **Work surfaces** (SQL, explorer, notebooks, dashboards) are full-bleed panes. Settings-like pages use `PageHeader` and a centred `max-w-5xl` column.
- **Settings** has three groups: **Your account** (profile, teams, appearance, layout, credentials, integrations, AI keys), **Workspace *name*** (engine, SQL clients, orchestration, Git, embedding), and **Administration** (usage & cost, users, audit, provisioning, resources, cluster, data apps).
  - Put a new category in the group it belongs to; hash routes stay `#/settings/<id>`.
  - Below 1024px the category list becomes a picker.
- **Responsive:** optimise for 1280–1920 wide.
  - Below 1024: side panes collapse to toggles, grids scroll horizontally, and dialogs become full-width sheets.
  - Below 640 the rail hides; the top bar's menu button opens the sections in a drawer.
  - Below 640: only reading tasks (dashboards, results, runs) need to work.
  - Never shrink the text below the scale to fit.

## Accessibility

- Semantic elements (`button`, `a`, `table`/`th scope`, `nav`, `main`, `dialog`); `aria-current` on the nav; `role="tab"` with `aria-selected`.
- Dialogs and drawers: move focus in on open, trap it, and return it to the trigger on close; Esc closes. Menus: arrow keys, Enter, Esc. Tabs: arrow keys. Add these to the primitives, not to each call site.
- Every IconButton has a `label`. An icon-only `Button` has an `aria-label` and a `title`.
- Every input and select has `aria-label` or is inside `Field`. `Label` is only visual: it does not associate with the control.
- Status is never colour alone.
- Text contrast is at least 4.5:1.
  - `zinc-500` is the lowest text step; each theme's ramp is tuned so it passes on the raised surfaces.
  - Metadata on a selected row uses `zinc-400`.
  - Type colours use the `-300` step, which also works in light themes.
- Tables: header cells, `tabular-nums`, NULL shown as an italic `NULL` (not blank), long values truncated with `title`.

## Avoid

- A bordered, rounded card around every section; cards inside cards; KPI tiles as the default opening of a page.
- Gradients, glass or blur, glows, oversized radii (>8px), coloured drop shadows, decorative illustrations, entrance animations.
- ALL-CAPS tracked labels, eyebrow labels, mono for prose, "A · B · C" metadata chains longer than three items, `→` appended to buttons.
- Placeholder-grey walls of explanation. One line of description at most, then the thing itself.
- A second table, chart, dialog or button style; raw `alert()`/`confirm()`; literal colours; new font sizes.
- AI that only chats: every answer must be actionable in the app.

## UI QA (before calling UI work done)

1. **Types:** `pnpm --filter @duckview/web typecheck`.
2. **Build:** `pnpm --filter @duckview/web build`. The server serves `packages/web/dist`, so restart the local server (port 4200) after building.
3. **Browser check:** open the changed page in a real browser (`scripts/e2e-mosaic.mjs <scenario>` or Chrome), inspect the screenshot, and check:
   - Midnight (dark) and one light theme;
   - 1440px and 1024px wide;
   - empty, loading, error and populated states;
   - keyboard only: Tab, Enter, Esc;
   - no console errors.
4. **Lint:** `pnpm --filter @duckview/web lint:ui`, which also runs in the build. It fails on browser dialogs, off-scale sizes, named colours (violet, purple …), gradients and raw `<select>`. Use `--warnings` to list literal hex colours. Opt a line out only with `ui-lint-ignore: <reason>`.
5. **Accessibility and looks:** run `node scripts/e2e-mosaic.mjs visual-qa`.
   - It covers 12 pages in Midnight at 1440px, Daylight at 1440px and Midnight at 1024px, and saves screenshots to a folder.
   - It fails on an unnamed control, an unlabeled field, text below AA contrast, or horizontal overflow.
   - Look at the screenshots of the pages you changed.
6. **Behaviour:** new flows get an e2e scenario in `scripts/e2e-mosaic.mjs`, with `data-testid` on the elements it drives. Run the full scenario list before committing (see the project memory for the list and the local setup).
