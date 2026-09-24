# duckview — Python SDK

Query DuckView workspaces from Python and build Streamlit data apps on the analytics data DuckView already holds — connectors, syncs, persistent workspaces and all.

```python
import duckview
dv = duckview.connect()                          # DUCKVIEW_URL / DUCKVIEW_TOKEN / DUCKVIEW_WORKSPACE
df = dv.query("SELECT zone, avg(fare) AS fare FROM trips GROUP BY 1")   # pandas (or list of dicts without pandas)
dv.tables()                                      # tables and views with columns and row estimates
dv.table("trips").where("fare > 10").order_by("fare DESC").limit(100).to_df()
dv.query_arrow("SELECT * FROM trips")            # pyarrow Table through the Arrow export (large results)
dv.copilot("Which zones have the highest average fare?")["text"]
dv.tools()                                       # the agent façade's OpenAPI document for LangChain / CrewAI / Strands
```

Everything goes through DuckView's HTTP API with a bearer token; the SDK never opens the `.duckdb` file. Inside a DuckView data app the runner sets the three environment variables with a read-only token scoped to the app's workspace.

## Streamlit

```python
import streamlit as st
from duckview.streamlit import connect, query, table_picker, viewer

dv = connect()
name = table_picker(dv)
df = query(f"SELECT * FROM {name} LIMIT 1000")
st.dataframe(df)
st.caption(f"Viewing as {viewer()['email']}")
```

`query()` is backed by `st.cache_data` (5 minutes); `viewer()` reads the visitor DuckView forwards to the app.

## Orchestration: Airflow, Dagster, Prefect

Run DuckView work from a pipeline and wait for it. A failing run (a sync that errors, a quality suite that fails, a SQL check that finds bad rows) fails the task. Use an API token with the write scope; runs act as its owner and are recorded in DuckView (Settings → Orchestration).

```python
from duckview.orchestrate import run
run("sync", "<sync id>")
run("dbt", "<project id>", command="build", select="tag:daily")
run("quality", "<suite id>", fail_on_warn=True)
run("query", "<workspace id>", sql="SELECT * FROM orders WHERE amount < 0", fail_if="rows")
```

Kinds: `sync`, `dbt`, `quality`, `reverse_sync`, `notebook`, `alert`, `snapshot`, `agent`, `monitor`, `query`.

**Airflow** (`pip install "duckview[airflow]"`): add a connection of type *DuckView* (`duckview_default`) with Host = DuckView's URL and Password = the token.

```python
from duckview.airflow import DuckViewSyncOperator, DuckViewDbtOperator, DuckViewQualityCheckOperator, DuckViewSQLCheckOperator

load = DuckViewSyncOperator(task_id="load_orders", sync_id="…")
build = DuckViewDbtOperator(task_id="dbt_build", project_id="…", select="tag:daily")
checks = DuckViewQualityCheckOperator(task_id="checks", suite_id="…")
no_negatives = DuckViewSQLCheckOperator(task_id="no_negatives", sql="SELECT * FROM orders WHERE amount < 0")
load >> build >> [checks, no_negatives]
```

**Dagster** (`pip install "duckview[dagster]"`):

```python
from dagster import Definitions, EnvVar, job
from duckview.dagster import DuckViewResource, duckview_op

load_orders = duckview_op("sync", "…", name="load_orders")
dbt_build = duckview_op("dbt", "…", name="dbt_build", command="build")

@job
def nightly():
    dbt_build(start_after=load_orders())

defs = Definitions(jobs=[nightly], resources={"duckview": DuckViewResource(url="https://duckview.example.com", token=EnvVar("DUCKVIEW_TOKEN"))})
```

**Prefect** (`pip install "duckview[prefect]"`):

```python
from prefect import flow
from duckview.prefect import run_sync, run_dbt, run_quality_suite

@flow
def nightly():
    run_sync("…")
    run_dbt("…", command="build")
    run_quality_suite("…")
```

## Install

```
pip install duckview            # core, no dependencies
pip install "duckview[streamlit]"   # + streamlit, pandas, pyarrow
```
