"""
Streamlit helpers for DuckView data apps.

    import streamlit as st
    from duckview.streamlit import connect, query, table_picker

    dv = connect()                                   # cached per session, from the runner's environment
    df = query("SELECT * FROM trips LIMIT 1000")      # st.cache_data-backed
    name = table_picker(dv)                          # a selectbox over the workspace's tables

Inside a DuckView-run app `st.context.headers` carries the signed-in visitor: X-DuckView-User (id),
X-DuckView-Email and X-DuckView-Role — `viewer()` returns them.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import streamlit as st

from . import Client, connect as _connect


@st.cache_resource(show_spinner=False)
def connect(url: Optional[str] = None, token: Optional[str] = None, workspace: Optional[str] = None) -> Client:
    return _connect(url, token, workspace)


@st.cache_data(show_spinner="Running query…", ttl=300)
def query(sql: str, max_rows: Optional[int] = None, _workspace: Optional[str] = None):
    """Runs SQL through the app's connection and caches the DataFrame for five minutes."""
    return connect().query(sql, max_rows=max_rows, workspace=_workspace)


@st.cache_data(show_spinner=False, ttl=300)
def tables(_workspace: Optional[str] = None) -> List[Dict[str, Any]]:
    return connect().tables(_workspace)


@st.cache_data(show_spinner=False, ttl=300)
def datasets(_workspace: Optional[str] = None) -> List[Dict[str, Any]]:
    """Tables and views plus the workspace's data files (Parquet, CSV, JSON, Excel), each with the SQL relation to read it."""
    dv = connect()
    cat = dv.catalog(_workspace)
    out: List[Dict[str, Any]] = []
    for o in cat.get("objects", []):
        out.append({"name": o["name"], "relation": '"%s"' % o["name"].replace('"', '""'), "kind": o.get("type", "TABLE").lower(), "rows": o.get("estimated_rows"), "columns": [c["name"] for c in o.get("columns", [])]})
    for f in cat.get("files", []):
        if f.get("kind") in ("parquet", "csv", "json", "arrow", "excel"):
            out.append({"name": f["path"], "relation": "'%s'" % f["path"].replace("'", "''"), "kind": f["kind"], "rows": None, "columns": []})
    return out


def table_picker(dv: Optional[Client] = None, label: str = "Dataset", key: str = "duckview_table", files: bool = True) -> Optional[str]:
    """
    A selectbox over the workspace's tables, views and (with files=True) data files. Returns the SQL relation to
    put after FROM — a quoted table name or a quoted file path — or None when the workspace is empty.
    """
    items = [d for d in datasets() if files or d["kind"] in ("table", "view")]
    if not items:
        st.info("This workspace has no tables or data files yet — load data in DuckView first.")
        return None
    labels = {d["name"] + ("" if d["kind"] in ("table", "view") else f"  ·  {d['kind']}"): d["relation"] for d in items}
    choice = st.selectbox(label, list(labels.keys()), key=key)
    return labels[choice] if choice else None


def viewer() -> Dict[str, Optional[str]]:
    """The DuckView user viewing the app (set by the proxy) — {"id", "email", "role"}."""
    try:
        h = st.context.headers
        return {"id": h.get("X-Duckview-User"), "email": h.get("X-Duckview-Email"), "role": h.get("X-Duckview-Role")}
    except Exception:  # older Streamlit, or run outside DuckView
        return {"id": None, "email": None, "role": None}
