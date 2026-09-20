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


def table_picker(dv: Optional[Client] = None, label: str = "Table", key: str = "duckview_table") -> Optional[str]:
    """A selectbox over the workspace's tables and views; returns the chosen name."""
    names = [t["name"] for t in tables()]
    if not names:
        st.info("This workspace has no tables yet — load data in DuckView first.")
        return None
    return st.selectbox(label, names, key=key)


def viewer() -> Dict[str, Optional[str]]:
    """The DuckView user viewing the app (set by the proxy) — {"id", "email", "role"}."""
    try:
        h = st.context.headers
        return {"id": h.get("X-Duckview-User"), "email": h.get("X-Duckview-Email"), "role": h.get("X-Duckview-Role")}
    except Exception:  # older Streamlit, or run outside DuckView
        return {"id": None, "email": None, "role": None}
