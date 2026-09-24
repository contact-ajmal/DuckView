"""
Prefect tasks for DuckView.

    from prefect import flow
    from duckview.prefect import run_sync, run_dbt, run_quality_suite, run_sql_check

    @flow
    def nightly():
        run_sync("<sync id>")
        run_dbt("<project id>", command="build")
        run_quality_suite("<suite id>")

Credentials come from a DuckViewCredentials block (credentials=DuckViewCredentials.load("prod")) or from
DUCKVIEW_URL / DUCKVIEW_TOKEN / DUCKVIEW_WORKSPACE. A failed run fails the task.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

try:
    from prefect import get_run_logger, task
    from prefect.blocks.core import Block
except ImportError as err:  # pragma: no cover
    raise ImportError("duckview.prefect needs Prefect: pip install prefect") from err

from . import Client, connect
from .orchestrate import run

__all__ = ["DuckViewCredentials", "run_duckview", "run_sync", "run_dbt", "run_quality_suite", "run_reverse_sync", "run_notebook", "run_sql_check", "run_agent"]


class DuckViewCredentials(Block):
    """DuckView's URL, an API token with the write scope, and a default workspace."""

    _block_type_name = "DuckView Credentials"
    url: str
    token: str
    workspace: Optional[str] = None

    def client(self) -> Client:
        return connect(url=self.url, token=self.token, workspace=self.workspace)


def _run(kind: str, target: str, credentials: Optional[DuckViewCredentials], **options: Any) -> Dict[str, Any]:
    client = credentials.client() if credentials is not None else connect()
    if kind == "query" and not target:
        target = client._ws()
    r = run(kind, target, client=client, source="prefect", **options)
    try:
        get_run_logger().info("DuckView %s '%s': %s", kind, r.get("label"), r.get("summary"))
    except Exception:  # noqa: BLE001 — outside a run context
        pass
    return r


@task(name="duckview-run")
def run_duckview(kind: str, target: str, credentials: Optional[DuckViewCredentials] = None, **options: Any) -> Dict[str, Any]:
    return _run(kind, target, credentials, **options)


@task(name="duckview-sync")
def run_sync(sync_id: str, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("sync", sync_id, credentials)


@task(name="duckview-dbt")
def run_dbt(project_id: str, command: str = "build", select: Optional[str] = None, exclude: Optional[str] = None, full_refresh: bool = False, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("dbt", project_id, credentials, command=command, select=select, exclude=exclude, full_refresh=full_refresh)


@task(name="duckview-quality")
def run_quality_suite(suite_id: str, fail_on_warn: bool = False, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("quality", suite_id, credentials, fail_on_warn=fail_on_warn)


@task(name="duckview-reverse-sync")
def run_reverse_sync(reverse_sync_id: str, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("reverse_sync", reverse_sync_id, credentials)


@task(name="duckview-notebook")
def run_notebook(notebook_id: str, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("notebook", notebook_id, credentials)


@task(name="duckview-agent")
def run_agent(agent_id: str, task_text: Optional[str] = None, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("agent", agent_id, credentials, input=task_text)


@task(name="duckview-sql-check")
def run_sql_check(sql: str, fail_if: str = "rows", workspace_id: Optional[str] = None, credentials: Optional[DuckViewCredentials] = None) -> Dict[str, Any]:
    return _run("query", workspace_id or "", credentials, sql=sql, fail_if=fail_if)
