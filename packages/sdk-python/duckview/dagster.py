"""
Dagster resource and ops for DuckView.

    from dagster import Definitions, job, op
    from duckview.dagster import DuckViewResource, duckview_op

    load_orders = duckview_op("sync", "<sync id>", name="load_orders")
    dbt_build = duckview_op("dbt", "<project id>", name="dbt_build", command="build")

    @job
    def nightly():
        dbt_build(load_orders())

    defs = Definitions(jobs=[nightly], resources={"duckview": DuckViewResource(url="https://duckview.example.com", token=EnvVar("DUCKVIEW_TOKEN"))})

A failed run raises dagster.Failure (with the run's summary and details as metadata).
"""
from __future__ import annotations

from typing import Any, Dict, Optional

try:
    from dagster import ConfigurableResource, Failure, In, Nothing, op
except ImportError as err:  # pragma: no cover
    raise ImportError("duckview.dagster needs Dagster: pip install dagster") from err

from . import connect
from .orchestrate import run

__all__ = ["DuckViewResource", "duckview_op"]


class DuckViewResource(ConfigurableResource):
    """DuckView's URL and an API token with the write scope (and a workspace for SQL checks)."""

    url: str
    token: str
    workspace: Optional[str] = None

    def run(self, kind: str, target: str, timeout: Optional[float] = None, external_run_id: Optional[str] = None, **options: Any) -> Dict[str, Any]:
        client = connect(url=self.url, token=self.token, workspace=self.workspace)
        if kind == "query" and not target:
            target = client._ws()
        r = run(kind, target, client=client, timeout=timeout, raise_on_failure=False, source="dagster", external_run_id=external_run_id, **options)
        if r["status"] == "failed":
            raise Failure(description=f"DuckView {kind} '{r.get('label')}' failed: {r.get('summary')}", metadata={"duckview_run_id": r["id"], "summary": str(r.get("summary")), "detail": str(r.get("detail"))})
        return r


def duckview_op(kind: str, target: str, name: Optional[str] = None, **options: Any):
    """An op that runs a DuckView sync, dbt command, quality suite … and returns the run record."""

    @op(name=name or f"duckview_{kind}", ins={"start_after": In(Nothing)}, required_resource_keys={"duckview"})
    def _op(context) -> Dict[str, Any]:
        r = context.resources.duckview.run(kind, target, external_run_id=getattr(context, "run_id", None), **options)
        context.log.info(f"DuckView {kind} '{r.get('label')}': {r.get('summary')}")
        return r

    return _op
