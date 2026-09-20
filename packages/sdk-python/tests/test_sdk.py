"""SDK checks against a running DuckView: DUCKVIEW_URL, DUCKVIEW_TOKEN, DUCKVIEW_WORKSPACE must be set. Prints JSON."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import duckview  # noqa: E402

out = {}
dv = duckview.connect()
out["me"] = dv.me()["user"]["email"]
out["records"] = dv.query("SELECT 1 AS a, 'x' AS b, DATE '2026-01-02' AS d", format="records")
r = dv.query_result("SELECT range AS n FROM range(5)")
out["kinds"] = [c.kind for c in r.columns]
out["count"] = r.row_count
out["tables"] = [t["name"] for t in dv.tables()]
t = dv.table("sdk_demo").where("n >= 2").order_by("n DESC").limit(2)
out["builder_sql"] = t.sql
out["builder"] = t.to_records()
out["builder_count"] = t.count()
try:
    import pandas  # noqa: F401
    df = dv.query("SELECT 1 AS a, TIMESTAMP '2026-01-02 03:04:05' AS ts")
    out["pandas"] = {"dtype_ts": str(df["ts"].dtype), "a": int(df["a"][0])}
except ImportError:
    out["pandas"] = None
try:
    import pyarrow  # noqa: F401
    tbl = dv.query_arrow("SELECT range AS n FROM range(3)")
    out["arrow"] = {"rows": tbl.num_rows, "cols": tbl.column_names}
except ImportError:
    out["arrow"] = None
try:
    dv.query("DROP TABLE sdk_demo")
    out["mutation"] = "allowed"
except duckview.DuckViewError as e:
    out["mutation"] = e.code
print(json.dumps(out))
