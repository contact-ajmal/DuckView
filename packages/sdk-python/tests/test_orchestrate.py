"""
Orchestration against a running DuckView (DUCKVIEW_URL, DUCKVIEW_TOKEN with the write scope, DUCKVIEW_WORKSPACE,
DV_SYNC_ID, DV_SUITE_ID). Airflow, Dagster and Prefect are replaced by minimal stand-ins of the classes the
adapters use, so the operators, resource and tasks run for real without the frameworks installed.
Prints OK when every check passes.
"""
import logging
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def module(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


# ---- Airflow stand-in
class _Conn:
    def __init__(self):
        self.host, self.password, self.schema, self.port = os.environ["DUCKVIEW_URL"], os.environ["DUCKVIEW_TOKEN"], None, None
        self.extra_dejson = {"workspace": os.environ["DUCKVIEW_WORKSPACE"]}


class BaseHook:
    def __init__(self, *a, **k):
        pass

    @classmethod
    def get_connection(cls, conn_id):
        if conn_id != "dv_test":
            raise KeyError(conn_id)
        return _Conn()


class BaseOperator:
    def __init__(self, task_id=None, **kwargs):
        self.task_id = task_id
        self.log = logging.getLogger(task_id or "op")


module("airflow")
module("airflow.hooks")
module("airflow.hooks.base", BaseHook=BaseHook)
module("airflow.models", BaseOperator=BaseOperator)


# ---- Dagster stand-in
class ConfigurableResource:
    def __init__(self, **kwargs):
        for k, v in type(self).__dict__.items():
            if not k.startswith("_") and not callable(v):
                setattr(self, k, v)
        for k, v in kwargs.items():
            setattr(self, k, v)


class Failure(Exception):
    def __init__(self, description=None, metadata=None):
        super().__init__(description)
        self.description, self.metadata = description, metadata or {}


def op(**_kw):
    return lambda fn: fn


module("dagster", ConfigurableResource=ConfigurableResource, Failure=Failure, In=lambda *a, **k: None, Nothing=None, op=op)


# ---- Prefect stand-in
def task(*args, **kwargs):
    if args and callable(args[0]):
        return args[0]
    return lambda fn: fn


class Block:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


module("prefect", task=task, get_run_logger=lambda: logging.getLogger("prefect"))
module("prefect.blocks")
module("prefect.blocks.core", Block=Block)

import duckview  # noqa: E402
from duckview.orchestrate import RunFailed, run  # noqa: E402
from duckview.airflow import DuckViewSQLCheckOperator, DuckViewSyncOperator, DuckViewQualityCheckOperator  # noqa: E402
from duckview.dagster import DuckViewResource, duckview_op  # noqa: E402
from duckview.prefect import DuckViewCredentials, run_quality_suite, run_sql_check, run_sync  # noqa: E402

SYNC, SUITE = os.environ["DV_SYNC_ID"], os.environ["DV_SUITE_ID"]


def expect_fail(fn, exc=RunFailed, text=None):
    try:
        fn()
    except exc as e:  # noqa: PERF203
        assert text is None or text in str(e), f"{text!r} not in {e}"
        return e
    raise AssertionError(f"expected {exc.__name__}")


# Core
r = run("sync", SYNC)
assert r["status"] == "succeeded" and r["summary"] == "3 rows loaded", r
e = expect_fail(lambda: run("quality", SUITE), text="Orders checks")
assert e.run["detail"]["status"] == "fail"
assert run("quality", SUITE, raise_on_failure=False)["status"] == "failed"

# Airflow
out = DuckViewSyncOperator(task_id="load", sync_id=SYNC, duckview_conn_id="dv_test").execute({"run_id": "scheduled__2026-09-24T00:00:00"})
assert out["status"] == "succeeded" and out["source"] == "airflow" and out["external_run_id"] == "scheduled__2026-09-24T00:00:00", out
expect_fail(lambda: DuckViewSQLCheckOperator(task_id="no_nulls", sql="SELECT * FROM raw_orders WHERE amount IS NULL").execute({}), text="expected none")
expect_fail(lambda: DuckViewQualityCheckOperator(task_id="checks", suite_id=SUITE).execute({}))

# Dagster
res = DuckViewResource(url=os.environ["DUCKVIEW_URL"], token=os.environ["DUCKVIEW_TOKEN"], workspace=os.environ["DUCKVIEW_WORKSPACE"])
assert res.run("query", "", sql="SELECT * FROM raw_orders", fail_if="no_rows")["summary"] == "3 rows"
f = expect_fail(lambda: res.run("quality", SUITE), exc=Failure)
assert "duckview_run_id" in f.metadata
ctx = types.SimpleNamespace(resources=types.SimpleNamespace(duckview=res), log=logging.getLogger("dagster"), run_id="dagster-run-1")
assert duckview_op("sync", SYNC, name="load_orders")(ctx)["external_run_id"] == "dagster-run-1"

# Prefect
creds = DuckViewCredentials(url=os.environ["DUCKVIEW_URL"], token=os.environ["DUCKVIEW_TOKEN"], workspace=os.environ["DUCKVIEW_WORKSPACE"])
assert run_sync(SYNC, credentials=creds)["source"] == "prefect"
assert run_sql_check("SELECT 1 WHERE false")["status"] == "succeeded"
expect_fail(lambda: run_quality_suite(SUITE, credentials=creds))

# Everything is on record, by source.
runs = duckview.connect()._request("GET", "/api/orchestrate/runs?limit=100")["runs"]
sources = {x["source"] for x in runs}
assert {"api", "airflow", "dagster", "prefect"} <= sources, sources
print("OK")
