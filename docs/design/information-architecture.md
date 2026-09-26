# Information architecture

The Console's navigation, as defined in `packages/web/src/app/routes.ts`. Every hash DuckView has ever used still
resolves: only the section a page belongs to, and its tabs, changed.

## Primary (the rail)

| Section | Opens | Tabs | For |
|---|---|---|---|
| **Agent** | `#/` | — (a mission is `#/agent/missions/<id>`) | Ask, start and follow missions |
| **Workspaces** | `#/home` | Overview · Templates | The active workspace at a glance, starting points, managing one workspace (`#/workspaces/<id>`) |
| **Data** | `#/data` | Explorer · Catalog · Quality · Lineage · Compare · Access policies | Find, understand and govern the data |
| **Build** | `#/query` | SQL · Notebooks · Dashboards · Apps · Alerts ┆ Prepare · Models · Metrics | Make things from data; the second group models it |
| **Connect** | `#/connections` | Connections · Agents & MCP | Reach data sources, and let agents reach DuckView |

## Secondary (the foot of the rail)

- **Help:** keyboard shortcuts, the command palette and the reference docs.
- **Settings:** workspace and account settings, and administration for admins.
- **Profile:** the person, theme and sign out.

On a phone, the rail becomes a drawer with the same five sections followed by the same three secondary entries.

## One AI entry per job

- **Agent** (rail, ⌘I): missions. It carries what is on screen as context.
- **Ask about this screen** (a top-bar icon, ⌘J): the contextual panel for a quick question about the open object.
- **Agents & MCP** (Connect): other agents, tools and approvals. This is operations, not a place to talk to the agent.

## Permission-aware

The rail and the tabs are filtered by what the person can do in the active workspace. This mirrors
`/api/agent/capabilities`, and the server enforces it again.

| Hidden for | Items |
|---|---|
| Viewers and read-only accounts | Build › Prepare, Build › Models, Workspaces › Templates, Connect › Connections |
| Everyone who isn't an admin | Settings › Administration pages (as before) |

When every tab of a section is hidden, the section is hidden too.

## Old hashes → new sections

| Hash | Section › tab |
|---|---|
| `#/query`, `#/notebooks` | Build › SQL, Notebooks |
| `#/dashboards`, `#/dashboards/<id>` | Build › Dashboards |
| `#/alerts/{alerts,snapshots,channels}` | Build › Alerts (the page has its own Alerts, Snapshots and Channels tabs) |
| `#/apps` | Build › Apps |
| `#/transform/{prepare,dbt,metrics}` | Build › Prepare, Models, Metrics |
| `#/transform/quality` | Data › Quality |
| `#/governance/{catalog,lineage,policies}` | Data |
| `#/governance/{audit,provisioning}` | Settings |
| `#/agents`, `#/mcp` | Connect › Agents & MCP |
| `#/templates` | Workspaces › Templates |
| `#/home` | Workspaces › Overview |
| `#/workspaces/<id>` | Workspaces |

## Command palette (⌘K)

Commands:

- Ask Agent
- Switch Workspace
- Select Dataset
- Open SQL
- Open Dashboard
- Open Catalog
- Start Mission
- Search Data
- Search Tools
- Open MCP
- Settings

Every section and tab is also listed under "Go to". Typing searches datasets, columns, queries, dashboards, notebooks,
metrics and apps, and offers "Ask the agent: …".
