"""
Run DuckView work from an orchestrator (Airflow, Dagster, Prefect, cron, CI) and wait for one status.

    from duckview.orchestrate import run
    run("sync", "<sync id>")                                   # load a sync; raises RunFailed if it fails
    run("dbt", "<project id>", command="build", select="tag:daily")
    run("quality", "<suite id>", fail_on_warn=True)
    run("query", "<workspace id>", sql="SELECT * FROM orders WHERE amount < 0", fail_if="rows")

Kinds: sync, dbt, quality, reverse_sync, notebook, alert, snapshot, agent, monitor, query. The run starts in
DuckView (POST /api/orchestrate/runs) and is long-polled until it has finished; its record (status, summary,
detail) is returned. The token needs the write scope; runs act as the token's owner.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

from . import Client, DuckViewError, connect

__all__ = ["run", "start", "wait", "RunFailed", "KINDS"]

KINDS = ("sync", "dbt", "quality", "reverse_sync", "notebook", "alert", "snapshot", "agent", "monitor", "query")


class RunFailed(Exception):
    """A DuckView run that finished as failed (a failing check, an error)."""

    def __init__(self, run: Dict[str, Any]):
        super().__init__(f"DuckView {run.get('kind')} '{run.get('label')}' failed: {run.get('summary')}")
        self.run = run


def start(kind: str, target: str, client: Optional[Client] = None, **options: Any) -> Dict[str, Any]:
    """Starts a run and returns it at once (status "running")."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    c = client or connect()
    body = {k: v for k, v in options.items() if v is not None}
    body.update({"kind": kind, "id": target})
    return c._request("POST", "/api/orchestrate/runs", body)["run"]


def wait(run_id: str, client: Optional[Client] = None, timeout: Optional[float] = None, poll: float = 30.0) -> Dict[str, Any]:
    """Long-polls a run until it is no longer running (or `timeout` seconds pass: TimeoutError)."""
    c = client or connect()
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        step = poll if deadline is None else max(0.0, min(poll, deadline - time.monotonic()))
        r = c._request("GET", f"/api/orchestrate/runs/{run_id}?wait={int(max(1, min(60, step)))}")["run"]
        if r["status"] != "running":
            return r
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(f"DuckView run {run_id} still running after {timeout} s")


def run(kind: str, target: str, client: Optional[Client] = None, timeout: Optional[float] = None, raise_on_failure: bool = True, **options: Any) -> Dict[str, Any]:
    """Starts a run, waits for it, and raises RunFailed when it failed (unless raise_on_failure=False)."""
    c = client or connect()
    r = wait(start(kind, target, client=c, **options)["id"], client=c, timeout=timeout)
    if r["status"] == "failed" and raise_on_failure:
        raise RunFailed(r)
    return r
