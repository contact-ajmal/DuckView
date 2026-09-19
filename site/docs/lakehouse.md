---
title: Lakehouse connectors
order: 7
group: Guide
description: Attach AWS Glue / SageMaker Lakehouse, Amazon S3 Tables, any Iceberg REST catalog and Databricks; query them as alias.schema.table from SQL, dashboards, Copilot and agents.
---

Connect catalogs from **Settings → Storage → Lakehouse connections** or the **Lakehouse** root of the explorer (`+`). Credentials are AES-256-GCM encrypted; secrets and `ATTACH` statements are hot-applied to your running engines (in-memory tables survive), and attached catalogs are queried as `alias.schema.table` from SQL, dashboards, Copilot and agents alike. Browsing is lazy: namespaces and tables come from the REST catalog; table metadata is loaded only on `DESCRIBE` or query.

## Providers

| Provider | How it works | Auth |
|---|---|---|
| **AWS Glue / SageMaker Lakehouse** | `ATTACH '<account>[:catalog]' (TYPE ICEBERG, ENDPOINT_TYPE glue)` — Glue's Iceberg REST endpoint, SigV4-signed. Sub-catalogs such as `s3tablescatalog/<bucket>` cover SageMaker Lakehouse / federated catalogs. | Access keys, or the server's default credential chain (IAM role, SSO profile) |
| **Amazon S3 Tables** | `ATTACH 'arn:aws:s3tables:…:bucket/<name>' (TYPE ICEBERG, ENDPOINT_TYPE s3_tables)` | same |
| **Iceberg REST catalog** | Polaris, Lakekeeper, Nessie, Snowflake Open Catalog, Tabular, Unity Catalog IRC … `ATTACH '<warehouse>' (TYPE ICEBERG, ENDPOINT …)` | Bearer token · OAuth2 client credentials (`OAUTH2_SERVER_URI`, scope) · none |
| **Databricks** | Unity Catalog REST for browsing (catalog → schema → table, formats, UniForm flag); the **SQL Statement Execution API** for running SQL on a SQL warehouse (polling, chunk paging, cancellation, typed rows); optional `ATTACH` of the catalog through the Unity Catalog Iceberg REST endpoint so UniForm / Iceberg tables run natively in DuckDB. | PAT or OAuth M2M service principal (`/oidc/v1/token`, `all-apis`) — works with Free Edition |

## Databricks in the workbench

A tab's **engine picker** switches between *DuckDB (local)* and any Databricks SQL warehouse. Remote results land in the same grid and can be **materialised into DuckDB** — rows stream through NDJSON into a typed `CREATE TABLE`, so you can join them with local files.

Agents get the same through `browse_storage(provider=lakehouse)`, `execute_query` on attached catalogs, `lakehouse_query(connection_id, sql)` for warehouses and `inspect_schema(…, connection_id)` for non-attached Databricks tables. Non-read statements sent to a warehouse by an agent are held for human approval exactly like local SQL.

## Cloud object storage

S3, Cloudflare R2, Google Cloud Storage and Azure Blob connections (**Settings → Storage → Cloud connections**) are applied to every engine of the owner as DuckDB `CREATE SECRET`s and browsed in the explorer (buckets → prefixes → objects). Query objects directly:

```sql
SELECT * FROM 's3://my-lake/sales/2026/*.parquet' LIMIT 100;
```

In `filesystem_mode: sandboxed` remote sources need `security.enable_external_access: true`; catalogs can be configured but not attached without it. Databricks warehouses work regardless because the SQL runs remotely.

## API

```
GET  /api/lakehouse/providers
GET/POST/PATCH/DELETE /api/lakehouse-connections[/:id]
POST /api/lakehouse-connections/:id/test
GET  /api/lakehouse/browse?connection_id&workspace_id[&catalog][&schema]
GET  /api/lakehouse/:id/inspect?table=
POST /api/lakehouse/:id/query        {sql, max_rows?, dry_run?}
POST /api/lakehouse/:id/materialize  {sql, table, workspace_id}
```

Config: `lakehouse.statement_timeout_seconds`, `lakehouse.max_rows`, `lakehouse.materialize_max_rows`.
