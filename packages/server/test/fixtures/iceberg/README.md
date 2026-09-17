# Iceberg fixture

Two Iceberg v2 tables (`analytics.orders`, 100 rows; `analytics.customers`, 10 rows) written with pyiceberg 0.12 /
pyarrow into a local warehouse. Iceberg metadata and manifests embed **absolute** paths, so the tests copy this
directory to `/tmp/duckview-iceberg-fixture/warehouse` before serving it through the mock REST catalog
(`src/__tests__/lakehouse.test.ts`).

Regenerate (any machine, same target path):

```bash
uv venv /tmp/icevenv && source /tmp/icevenv/bin/activate && uv pip install "pyiceberg[pyarrow,sql-sqlite]"
python - <<'PY'
import pyarrow as pa, datetime as dt
from pyiceberg.catalog.sql import SqlCatalog
wh = "/tmp/duckview-iceberg-fixture/warehouse"
cat = SqlCatalog("fixture", uri="sqlite:////tmp/duckview-iceberg-fixture/catalog.db", warehouse=f"file://{wh}")
cat.create_namespace("analytics")
orders = pa.table({"order_id": pa.array(range(1, 101), pa.int64()), "region": pa.array([["north","south","east","west"][i % 4] for i in range(100)]),
                   "revenue": pa.array([round(20 + (i * 7.31) % 480, 2) for i in range(100)], pa.float64()),
                   "order_date": pa.array([dt.date(2026, 1, 1) + dt.timedelta(days=i) for i in range(100)], pa.date32())})
cat.create_table("analytics.orders", schema=orders.schema).append(orders)
customers = pa.table({"customer_id": pa.array(range(1, 11), pa.int64()), "name": pa.array([f"customer-{i}" for i in range(1, 11)])})
cat.create_table("analytics.customers", schema=customers.schema).append(customers)
PY
cp -R /tmp/duckview-iceberg-fixture/warehouse packages/server/test/fixtures/iceberg/
```
