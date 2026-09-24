"""
Apache Airflow operators for DuckView.

    from duckview.airflow import DuckViewSyncOperator, DuckViewDbtOperator, DuckViewQualityCheckOperator, DuckViewSQLCheckOperator

    load = DuckViewSyncOperator(task_id="load_orders", sync_id="…")
    build = DuckViewDbtOperator(task_id="dbt_build", project_id="…", select="tag:daily")
    checks = DuckViewQualityCheckOperator(task_id="checks", suite_id="…", fail_on_warn=True)
    load >> build >> checks

The connection (conn_id "duckview_default" unless given): Host = DuckView's URL (https://duckview.example.com),
Password = an API token with the write scope, Extra = {"workspace": "<workspace id>"} for SQL checks. Without an
Airflow connection, DUCKVIEW_URL / DUCKVIEW_TOKEN are used. A failed run fails the task; the run record is
returned (XCom). Every run is recorded in DuckView with the DAG run id.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Sequence

try:
    from airflow.hooks.base import BaseHook
    from airflow.models import BaseOperator
except ImportError as err:  # pragma: no cover
    raise ImportError("duckview.airflow needs Apache Airflow: pip install apache-airflow") from err

from . import Client, connect
from .orchestrate import run

__all__ = ["DuckViewHook", "DuckViewRunOperator", "DuckViewSyncOperator", "DuckViewDbtOperator", "DuckViewQualityCheckOperator", "DuckViewReverseSyncOperator", "DuckViewNotebookOperator", "DuckViewSQLCheckOperator", "DuckViewAgentOperator"]


class DuckViewHook(BaseHook):
    """A DuckView client from an Airflow connection (Host = URL, Password = API token, Extra.workspace)."""

    conn_name_attr = "duckview_conn_id"
    default_conn_name = "duckview_default"
    conn_type = "duckview"
    hook_name = "DuckView"

    def __init__(self, duckview_conn_id: str = default_conn_name):
        super().__init__()
        self.duckview_conn_id = duckview_conn_id

    def get_conn(self) -> Client:
        try:
            c = self.get_connection(self.duckview_conn_id)
        except Exception:  # noqa: BLE001 — no such connection: fall back to the environment
            return connect()
        extra = getattr(c, "extra_dejson", {}) or {}
        url = c.host if "://" in (c.host or "") else f"{c.schema or 'https'}://{c.host}{f':{c.port}' if c.port else ''}"
        return connect(url=url, token=c.password, workspace=extra.get("workspace"))


class DuckViewRunOperator(BaseOperator):
    """Runs anything DuckView runs (kind + target id) and waits for it."""

    template_fields: Sequence[str] = ("target_id", "options")
    ui_color = "#fbbf24"

    def __init__(self, *, kind: str, target_id: str, duckview_conn_id: str = DuckViewHook.default_conn_name, timeout: Optional[float] = None, options: Optional[Dict[str, Any]] = None, **kwargs: Any):
        super().__init__(**kwargs)
        self.kind = kind
        self.target_id = target_id
        self.duckview_conn_id = duckview_conn_id
        self.timeout = timeout
        self.options = options or {}

    def execute(self, context: Any) -> Dict[str, Any]:
        client = DuckViewHook(self.duckview_conn_id).get_conn()
        run_id = (context or {}).get("run_id") if isinstance(context, dict) else None
        r = run(self.kind, self.target_id, client=client, timeout=self.timeout, source="airflow", external_run_id=run_id, **self.options)
        self.log.info("DuckView %s '%s': %s", self.kind, r.get("label"), r.get("summary"))
        return r


class DuckViewSyncOperator(DuckViewRunOperator):
    def __init__(self, *, sync_id: str, **kwargs: Any):
        super().__init__(kind="sync", target_id=sync_id, **kwargs)


class DuckViewDbtOperator(DuckViewRunOperator):
    def __init__(self, *, project_id: str, command: str = "build", select: Optional[str] = None, exclude: Optional[str] = None, full_refresh: bool = False, **kwargs: Any):
        super().__init__(kind="dbt", target_id=project_id, options={"command": command, "select": select, "exclude": exclude, "full_refresh": full_refresh}, **kwargs)


class DuckViewQualityCheckOperator(DuckViewRunOperator):
    def __init__(self, *, suite_id: str, fail_on_warn: bool = False, **kwargs: Any):
        super().__init__(kind="quality", target_id=suite_id, options={"fail_on_warn": fail_on_warn}, **kwargs)


class DuckViewReverseSyncOperator(DuckViewRunOperator):
    def __init__(self, *, reverse_sync_id: str, **kwargs: Any):
        super().__init__(kind="reverse_sync", target_id=reverse_sync_id, **kwargs)


class DuckViewNotebookOperator(DuckViewRunOperator):
    def __init__(self, *, notebook_id: str, **kwargs: Any):
        super().__init__(kind="notebook", target_id=notebook_id, **kwargs)


class DuckViewAgentOperator(DuckViewRunOperator):
    def __init__(self, *, agent_id: str, task: Optional[str] = None, **kwargs: Any):
        super().__init__(kind="agent", target_id=agent_id, options={"input": task}, **kwargs)


class DuckViewSQLCheckOperator(DuckViewRunOperator):
    """Fails when a query returns rows (fail_if="rows", the default: a query for bad data) or none ("no_rows")."""

    template_fields: Sequence[str] = ("target_id", "options", "sql")

    def __init__(self, *, sql: str, workspace_id: Optional[str] = None, fail_if: str = "rows", **kwargs: Any):
        self.sql = sql
        super().__init__(kind="query", target_id=workspace_id or "", options={"fail_if": fail_if}, **kwargs)

    def execute(self, context: Any) -> Dict[str, Any]:
        client = DuckViewHook(self.duckview_conn_id).get_conn()
        self.options = {**self.options, "sql": self.sql}
        self.target_id = self.target_id or client._ws()
        return super().execute(context)
