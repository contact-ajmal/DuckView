"""
DuckView Python SDK.

    import duckview
    dv = duckview.connect()                       # DUCKVIEW_URL / DUCKVIEW_TOKEN / DUCKVIEW_WORKSPACE from the environment
    df = dv.query("SELECT zone, avg(fare) AS fare FROM trips GROUP BY 1")   # pandas DataFrame (or list of dicts)
    for t in dv.tables(): print(t["name"], t["estimated_rows"])
    dv.table("trips").where("fare > 10").limit(100).to_df()

Everything goes through DuckView's HTTP API with a bearer token — the SDK never opens the .duckdb file (that would
conflict with the engine's lock). Inside a DuckView data app the three environment variables are set by the runner
and the token is read-only and scoped to the app's workspace.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Union

__all__ = ["connect", "viewer_from_headers", "Client", "Table", "QueryResult", "DuckViewError", "__version__"]
__version__ = "0.1.0"


class DuckViewError(Exception):
    """An error returned by the DuckView API (status, code, message)."""

    def __init__(self, status: int, message: str, code: str = "ERROR", details: Any = None):
        super().__init__(f"{code} ({status}): {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def _raise_for(status: int, text: str) -> None:
    """Raises the DuckViewError for an error response (JSON {error, message, details} or plain text)."""
    try:
        j = json.loads(text)
    except ValueError:
        raise DuckViewError(status, text[:500]) from None
    if isinstance(j, dict):
        raise DuckViewError(status, j.get("message") or j.get("error") or text, j.get("error") or "ERROR", j.get("details")) from None
    raise DuckViewError(status, text[:500]) from None


@dataclass
class Column:
    name: str
    type: str
    kind: str  # number | string | boolean | temporal | json | binary | null


@dataclass
class QueryResult:
    columns: List[Column]
    rows: List[list]
    row_count: int
    total_rows: Optional[int]
    truncated: bool
    duration_ms: float

    def records(self) -> List[Dict[str, Any]]:
        names = [c.name for c in self.columns]
        return [dict(zip(names, r)) for r in self.rows]

    def to_pandas(self):
        """A typed pandas DataFrame (temporal columns parsed, numbers numeric)."""
        import pandas as pd  # noqa: F401 — optional dependency

        names = [c.name for c in self.columns]
        df = pd.DataFrame(self.rows, columns=names) if self.rows else pd.DataFrame({n: [] for n in names})
        for c in self.columns:
            if c.kind == "temporal" and len(df):
                if c.type.upper() in ("DATE",):
                    df[c.name] = pd.to_datetime(df[c.name], errors="coerce").dt.date
                elif c.type.upper().startswith("TIME") and not c.type.upper().startswith("TIMESTAMP"):
                    pass
                else:
                    df[c.name] = pd.to_datetime(df[c.name], errors="coerce", utc=c.type.upper().endswith("TZ"))
            elif c.kind == "number" and len(df):
                df[c.name] = pd.to_numeric(df[c.name], errors="coerce")
        return df

    def to_polars(self):
        import polars as pl  # noqa: F401 — optional dependency

        return pl.DataFrame(self.records())


class Client:
    """A DuckView workspace over HTTP."""

    def __init__(self, url: str, token: str, workspace: Optional[str] = None, timeout: float = 120.0):
        if not url:
            raise ValueError("DuckView URL is required (DUCKVIEW_URL)")
        if not token:
            raise ValueError("DuckView token is required (DUCKVIEW_TOKEN)")
        self.url = url.rstrip("/")
        self.token = token
        self.workspace = workspace
        self.timeout = timeout
        self._me: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------ transport
    def _request(self, method: str, path: str, body: Any = None, raw: bool = False, headers: Optional[Dict[str, str]] = None) -> Any:
        data = None
        hdrs = {"authorization": f"Bearer {self.token}", "accept": "application/json", "user-agent": f"duckview-python/{__version__}"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["content-type"] = "application/json"
        if headers:
            hdrs.update(headers)
        if sys.platform == "emscripten":  # Pyodide (an app run in the browser): no sockets, the browser does HTTP
            return self._request_browser(method, path, data, hdrs, raw)
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                payload = res.read()
                if raw:
                    return payload
                return json.loads(payload.decode("utf-8")) if payload else {}
        except urllib.error.HTTPError as e:
            _raise_for(e.code, e.read().decode("utf-8", "replace"))
        except urllib.error.URLError as e:
            raise DuckViewError(0, f"DuckView unreachable at {self.url}: {e.reason}", "UNREACHABLE") from None

    def _request_browser(self, method: str, path: str, data: Optional[bytes], hdrs: Dict[str, str], raw: bool) -> Any:
        """
        HTTP from Pyodide through a synchronous XMLHttpRequest (allowed in the web worker stlite runs Python in).
        Unlike a patched urllib, error statuses raise DuckViewError exactly as on the server.
        """
        from js import XMLHttpRequest, Uint8Array  # type: ignore[import-not-found]

        xhr = XMLHttpRequest.new()
        xhr.open(method, self.url + path, False)
        if raw:
            xhr.responseType = "arraybuffer"
        for k, v in hdrs.items():
            if k.lower() != "user-agent":  # a forbidden header in browsers
                xhr.setRequestHeader(k, v)
        try:
            xhr.send(data.decode("utf-8") if data is not None else None)
        except Exception as e:  # network error, or the API's CORS policy refused this origin
            raise DuckViewError(0, f"DuckView unreachable at {self.url}: {e}", "UNREACHABLE") from None
        status = int(xhr.status)
        if status == 0:
            raise DuckViewError(0, f"DuckView unreachable at {self.url} (network or CORS)", "UNREACHABLE")
        payload = bytes(Uint8Array.new(xhr.response).to_py()) if raw else str(xhr.responseText).encode("utf-8")
        if status >= 400:
            _raise_for(status, payload.decode("utf-8", "replace"))
        if raw:
            return payload
        return json.loads(payload.decode("utf-8")) if payload else {}

    def _ws(self, workspace: Optional[str] = None) -> str:
        ws = workspace or self.workspace
        if not ws:
            ws = self.workspaces()[0]["id"]
            self.workspace = ws
        return ws

    # ------------------------------------------------------------------ identity & workspaces
    def me(self) -> Dict[str, Any]:
        if self._me is None:
            self._me = self._request("GET", "/api/auth/me")
        return self._me

    def workspaces(self) -> List[Dict[str, Any]]:
        r = self._request("GET", "/api/workspaces")
        return r.get("workspaces", r) if isinstance(r, dict) else r

    # ------------------------------------------------------------------ SQL
    def query_result(self, sql: str, max_rows: Optional[int] = None, workspace: Optional[str] = None) -> QueryResult:
        """Runs SQL and returns the raw result (columns, rows, counts)."""
        body: Dict[str, Any] = {"sql": sql}
        if max_rows:
            body["max_rows"] = int(max_rows)
        r = self._request("POST", f"/api/workspaces/{self._ws(workspace)}/query", body)
        cols = [Column(c["name"], c.get("type", ""), c.get("kind", "string")) for c in r.get("columns", [])]
        return QueryResult(cols, r.get("rows", []), int(r.get("rowCount", len(r.get("rows", [])))), r.get("totalRows"), bool(r.get("truncated")), float(r.get("durationMs", 0)))

    def query(self, sql: str, max_rows: Optional[int] = None, format: str = "auto", workspace: Optional[str] = None):
        """
        Runs SQL. `format`: "pandas" (default when pandas is installed), "polars", "records" (list of dicts) or
        "result" (QueryResult). Rows are capped by `max_rows` (server default applies otherwise).
        """
        res = self.query_result(sql, max_rows=max_rows, workspace=workspace)
        if format == "result":
            return res
        if format == "records":
            return res.records()
        if format == "polars":
            return res.to_polars()
        if format == "pandas":
            return res.to_pandas()
        try:
            return res.to_pandas()
        except ImportError:
            return res.records()

    def query_arrow(self, sql: str, workspace: Optional[str] = None):
        """
        Runs SQL through DuckView's Arrow export (server-side COPY → Arrow IPC stream) and returns a pyarrow Table —
        the fast path for large results (typed, no JSON). Needs pyarrow.
        """
        import pyarrow as pa
        import pyarrow.ipc as ipc

        ws = self._ws(workspace)
        r = self._request("POST", f"/api/workspaces/{ws}/export", {"sql": sql, "format": "arrow"})
        exp = r["export"]
        try:
            payload = self._request("GET", exp["download_url"], raw=True)
        finally:
            try:
                self._request("DELETE", f"/api/exports/{exp['id']}")
            except DuckViewError:
                pass
        try:
            return ipc.open_stream(pa.BufferReader(payload)).read_all()
        except pa.ArrowInvalid:
            return ipc.open_file(pa.BufferReader(payload)).read_all()

    def explain(self, sql: str, workspace: Optional[str] = None) -> Dict[str, Any]:
        return self._request("POST", f"/api/workspaces/{self._ws(workspace)}/explain", {"sql": sql})

    # ------------------------------------------------------------------ catalog
    def catalog(self, workspace: Optional[str] = None) -> Dict[str, Any]:
        """Tables, views (with columns) and data files of the workspace."""
        return self._request("GET", f"/api/workspaces/{self._ws(workspace)}/catalog")

    def tables(self, workspace: Optional[str] = None) -> List[Dict[str, Any]]:
        objects = self.catalog(workspace).get("objects", [])
        return [{"name": o["name"], "schema": o.get("schema"), "database": o.get("database"), "type": o.get("type"), "estimated_rows": o.get("estimated_rows"), "columns": o.get("columns", [])} for o in objects]

    def files(self, workspace: Optional[str] = None) -> List[Dict[str, Any]]:
        return self.catalog(workspace).get("files", [])

    def table(self, name: str, workspace: Optional[str] = None) -> "Table":
        """A small query builder over a table, view or file path: .select() .where() .order_by() .limit() .to_df()."""
        return Table(self, name, workspace)

    # ------------------------------------------------------------------ Copilot
    def copilot(self, message: str, workspace: Optional[str] = None, conversation_id: Optional[str] = None, action: Optional[str] = None) -> Dict[str, Any]:
        """
        Asks DuckCopilot; returns {"text", "sql_blocks", "conversation_id"}. Streams server-sent events under the
        hood, so long answers arrive whole.
        """
        body: Dict[str, Any] = {"workspace_id": self._ws(workspace), "message": message}
        if conversation_id:
            body["conversation_id"] = conversation_id
        if action:
            body["action"] = action
        req = urllib.request.Request(self.url + "/api/copilot/chat", data=json.dumps(body).encode("utf-8"), method="POST", headers={"authorization": f"Bearer {self.token}", "content-type": "application/json", "accept": "text/event-stream"})
        text, sql_blocks, conv = [], [], conversation_id
        try:
            with urllib.request.urlopen(req, timeout=max(self.timeout, 300)) as res:
                event, data_lines = None, []
                for raw in res:
                    line = raw.decode("utf-8").rstrip("\n")
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
                    elif line == "":
                        if data_lines:
                            try:
                                d = json.loads("\n".join(data_lines))
                            except ValueError:
                                d = {}
                            kind = d.get("type") or event
                            if kind == "delta":
                                text.append(d.get("text", ""))
                            elif kind == "done":
                                sql_blocks = d.get("sql_blocks", [])
                            elif kind == "context":
                                conv = d.get("conversation_id", conv)
                            elif kind == "error":
                                raise DuckViewError(500, d.get("message", "Copilot error"), "COPILOT")
                        event, data_lines = None, []
        except urllib.error.HTTPError as e:
            raise DuckViewError(e.code, e.read().decode("utf-8", "replace")[:500]) from None
        return {"text": "".join(text), "sql_blocks": sql_blocks, "conversation_id": conv}

    # ------------------------------------------------------------------ agents
    def tools(self) -> Dict[str, Any]:
        """The agent façade's OpenAPI document (every DuckView tool as a REST operation) for LangChain / CrewAI / Strands."""
        return self._request("GET", "/api/agent/v1/openapi.json")

    def call_tool(self, name: str, **arguments: Any) -> Dict[str, Any]:
        return self._request("POST", f"/api/agent/v1/tools/{name}", arguments)


def _ident(name: str) -> str:
    """Quotes a table reference unless it is already a plain (possibly dotted) identifier or a quoted path."""
    if name.startswith("'") or name.startswith("read_") or name.startswith("("):
        return name
    parts = name.split(".")
    if all(p.replace("_", "a").isalnum() and not p[0].isdigit() for p in parts):
        return name
    if "/" in name or name.endswith((".parquet", ".csv", ".json", ".xlsx")):
        return "'" + name.replace("'", "''") + "'"
    return ".".join('"' + p.replace('"', '""') + '"' for p in parts)


class Table:
    def __init__(self, client: Client, name: str, workspace: Optional[str] = None):
        self._c = client
        self._name = name
        self._ws = workspace
        self._select: List[str] = []
        self._where: List[str] = []
        self._order: List[str] = []
        self._limit: Optional[int] = None

    def select(self, *columns: str) -> "Table":
        self._select = list(columns)
        return self

    def where(self, condition: str) -> "Table":
        self._where.append(condition)
        return self

    def order_by(self, *columns: str) -> "Table":
        self._order = list(columns)
        return self

    def limit(self, n: int) -> "Table":
        self._limit = int(n)
        return self

    @property
    def sql(self) -> str:
        cols = ", ".join(self._select) if self._select else "*"
        q = f"SELECT {cols} FROM {_ident(self._name)}"
        if self._where:
            q += " WHERE " + " AND ".join(f"({w})" for w in self._where)
        if self._order:
            q += " ORDER BY " + ", ".join(self._order)
        if self._limit is not None:
            q += f" LIMIT {self._limit}"
        return q

    def to_df(self, max_rows: Optional[int] = None):
        return self._c.query(self.sql, max_rows=max_rows, workspace=self._ws)

    def to_records(self, max_rows: Optional[int] = None) -> List[Dict[str, Any]]:
        return self._c.query(self.sql, max_rows=max_rows, format="records", workspace=self._ws)

    def to_arrow(self):
        return self._c.query_arrow(self.sql, workspace=self._ws)

    def count(self) -> int:
        r = self._c.query_result(f"SELECT count(*) AS n FROM ({self.sql}) AS t", workspace=self._ws)
        return int(r.rows[0][0]) if r.rows else 0

    def columns(self) -> List[Column]:
        return self._c.query_result(f"SELECT * FROM ({self.sql}) AS t LIMIT 0", workspace=self._ws).columns

    def __repr__(self) -> str:
        return f"Table({self.sql!r})"


def viewer_from_headers(headers: Any) -> Dict[str, Optional[str]]:
    """
    The DuckView user viewing an app, from the request headers DuckView's proxy adds (X-DuckView-User / -Email /
    -Role): pass Dash's ``flask.request.headers`` or Gradio's ``gr.Request.headers``. Streamlit apps use
    ``duckview.streamlit.viewer()``.
    """

    def get(name: str) -> Optional[str]:
        if headers is None or not hasattr(headers, "get"):
            return None
        return headers.get(name) or headers.get(name.lower()) or headers.get(name.title())

    return {"id": get("X-DuckView-User"), "email": get("X-DuckView-Email"), "role": get("X-DuckView-Role")}


def connect(url: Optional[str] = None, token: Optional[str] = None, workspace: Optional[str] = None, timeout: float = 120.0) -> Client:
    """
    Connects to DuckView. Arguments fall back to DUCKVIEW_URL, DUCKVIEW_TOKEN and DUCKVIEW_WORKSPACE — which the
    DuckView app runner sets for every data app.
    """
    return Client(url or os.environ.get("DUCKVIEW_URL", ""), token or os.environ.get("DUCKVIEW_TOKEN", ""), workspace or os.environ.get("DUCKVIEW_WORKSPACE") or None, timeout)
