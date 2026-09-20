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

*New app* in the gallery starts from the **Table explorer** template (pick a dataset, filter, grid, chart) or a **Blank** one. The editor has Python highlighting, ⌘S saves and restarts the running app, the preview on the right is the real app, and the logs are one click away. *Ask Copilot* sends the file with the SDK's contract for improvements.

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

## For agents

Apps are registered next to dashboards and syncs; the same REST endpoints (`/api/workspaces/:id/apps`, `/api/apps/:id/start|stop|logs`) serve automation today, and `create_app` / `preview_app` / `publish_app` tools with a `build_data_app` prompt are the next step — connectors bring the data in, syncs keep it fresh, the dashboard and the app get generated without leaving the MCP client.
