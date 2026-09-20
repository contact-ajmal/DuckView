---
title: Data apps (Streamlit)
order: 9
group: Guide
description: Build Streamlit applications directly on a workspace's analytics data — a Python SDK, a code editor with live preview, and a runner that serves the app to the workspace with a read-only, workspace-scoped token.
---

**Apps** turns a workspace into a place where analysts build applications, not only dashboards: a Streamlit app that reads the workspace's tables and files through the `duckview` SDK, edited in DuckView next to a live preview, run by DuckView, and opened by the workspace's members at `/apps/<id>/`.

## Write one

```python
import streamlit as st
from duckview.streamlit import connect, query, table_picker, viewer

st.title("Explorer")
dv = connect()                                   # from the runner's environment
rel = table_picker(dv)                           # tables, views and data files of the workspace
df = query(f"SELECT * FROM {rel} LIMIT 1000")    # DuckDB SQL → pandas, cached for five minutes
st.caption(f"{len(df):,} rows · viewing as {viewer()['email']}")
st.dataframe(df)
```

*New app* in the gallery starts from a **template** (the table explorer: pick a dataset, filter, grid, chart — or blank), **from a dashboard**, or **from saved queries**. A Mosaic dashboard is turned into an app deterministically — its datasets become SQL relations, its menus and sliders sidebar filters, its KPI marks metric cards, its bar / area / line / scatter / heat-map marks aggregating SQL rendered with Altair, its tables `st.dataframe` — so the app answers the same questions the dashboard does and the code is yours to take further. The editor has Python highlighting, ⌘S saves and restarts the running app, the preview on the right is the real app, *Check* runs the static checks (compiles, imports streamlit, no tokens), *Draft* lets Copilot write `app.py` for a goal with the SDK guide as its contract, and the logs are one click away.

## The SDK

`pip install duckview` — no dependencies; add `[streamlit]` for streamlit, pandas and pyarrow.

```python
import duckview
dv = duckview.connect(url, token, workspace)     # or DUCKVIEW_URL / DUCKVIEW_TOKEN / DUCKVIEW_WORKSPACE
dv.query("SELECT zone, avg(fare) FROM trips GROUP BY 1")   # pandas; format="records" | "polars" | "result"
dv.query_arrow("SELECT * FROM trips")             # pyarrow through the Arrow export — the fast path for large results
dv.tables(); dv.files(); dv.catalog()
dv.table("trips").where("fare > 10").order_by("fare DESC").limit(100).to_df()
dv.copilot("Which zones have the highest average fare?")["text"]
dv.tools(); dv.call_tool("profile_dataset", file_path_or_table="trips")   # the agent façade, for LangChain / CrewAI / Strands
```

Everything goes through DuckView's HTTP API with a bearer token — the SDK never opens the `.duckdb` file, so the engine keeps its lock and every read carries the caller's role, the sandbox and the audit trail.

## How it runs

- **First start** creates a Python virtualenv under `<data dir>/.duckview/apps/venv` with streamlit, pandas, pyarrow and the SDK (about a minute, once); an app's `requirements.txt` is installed before it starts.
- **Each app** is a `streamlit run` on its own port with a **minimal environment**: only `DUCKVIEW_URL`, `DUCKVIEW_TOKEN` and `DUCKVIEW_WORKSPACE` — never the server's secrets. The token is minted for the app's creator on every start with the `read` scope, scoped to the app's workspace, expiring after 24 hours and revoked when the app stops: an app can query what a viewer could and nothing else.
- **The proxy** serves the app under `/apps/<id>/` (HTTP and Streamlit's WebSocket). Opening an app from DuckView sets an HttpOnly cookie for `/apps`; every request is checked against the app — workspace members, or everyone signed in when the app's visibility is *org* — and forwarded with the visitor's identity (`X-DuckView-User`, `-Email`, `-Role`, read by `viewer()`). Visiting a stopped app starts it.
- Health is checked before the app is announced running; a crash shows its last log lines; idle apps stop after 30 minutes; at most five run at once (all configurable under `apps.*`).

Apps execute Python next to the server. `apps.enabled` is on in full filesystem mode and **off in sandboxed mode**; an administrator decides. The container image ships `python3` and `venv` ready for the first start.

## For agents and MCP clients

Everything above is a tool. From Claude Code, Claude Desktop, Cursor or any MCP client connected to DuckView:

| Tool | Does |
|---|---|
| `list_apps(workspace_id?)` | Apps with status, URL, visibility, errors. |
| `create_app(name, source, description?, visibility?, run_now?)` | `source: {dashboard_id}` generates from a dashboard; `{saved_query_ids}` / `{queries: [{name, sql}]}` a query browser; `{template}`; `{code, requirements?}` code as written. Validated (compiles, imports streamlit, no tokens) before it is saved, started right away, returns the code and the URL. |
| `update_app(app_id, code?, requirements?, name?, description?, run_now?)` | Re-validated; a running app restarts and the call waits until it is healthy. |
| `run_app` · `stop_app` · `get_app_logs` | Lifecycle and diagnostics (tracebacks, install output). |
| `preview_app(app_id, wait_ms?)` | A headless browser opens the app as a signed-in visitor, waits for Streamlit to render, and returns the visible text **and a screenshot** (an MCP image; needs Chrome/Chromium on the server) — the way an agent checks its own work. |
| `publish_app(app_id, audience, dry_run)` | Human-in-the-loop: `dry_run` (default) says what would change; `dry_run=false` after approval makes the app visible to everyone signed in (`org`) or back to the workspace. Audited. |

The resource `duckdb://guides/data-app` is the SDK contract an agent reads before writing code, and the prompt **`build_data_app(goal, data?)`** is the end-to-end recipe: connect the data and keep it fresh with a sync → profile it → build a Mosaic dashboard → `create_app` from it → `preview_app` → refine with `update_app` → `publish_app` once a person approves. The REST façade (`/api/agent/v1/tools/<name>`) exposes the same tools to LangChain, CrewAI and Strands agents, with screenshots as `images[].data_base64`.
