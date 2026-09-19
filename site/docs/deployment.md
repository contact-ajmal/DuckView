---
title: Deployment
order: 2
group: Guide
description: Docker Hub image, docker run, Docker Compose profiles, Kubernetes manifests, from-source builds, upgrades and CI/CD.
---

## Docker Hub image

`{{image}}` is a multi-architecture image (`linux/amd64`, `linux/arm64`) built by GitHub Actions on every `v*` tag, with SBOM and provenance attestations. The pushed tag is smoke-tested end to end (probes, auth, sandbox, upload, HITL, a full MCP handshake) before the workflow succeeds. A mirror is pushed to `{{ghcr}}`.

| Tag | Meaning |
|---|---|
| `latest` | newest release |
| `1`, `1.1` | floating major / minor |
| `{{version}}` | pinned release — use this in production |

The image is `node:20-bookworm-slim`, runs as the non-root `duckuser:duckgroup`, uses `tini` as PID 1, declares volumes for `/data` and `/app/meta`, and ships the `httpfs`, `azure`, `arrow`, `iceberg`, `delta` and `excel` DuckDB extensions pre-installed under `/app/duckdb-extensions` so no network is needed at runtime.

```bash
docker pull {{image}}:{{version}}
```

## docker run

```bash
docker run -d --name duckview -p 4200:4200 \
  -v $PWD/data:/data -v duckview-meta:/app/meta \
  -e JWT_SECRET=… -e ENCRYPTION_KEY=… \
  -e DUCKVIEW_ADMIN_EMAIL=… -e DUCKVIEW_ADMIN_PASSWORD=… \
  {{image}}:{{version}}
```

Useful extra flags:

- `-e DUCKDB_MEMORY_LIMIT=12GB` — engine ceiling (percentage of host RAM or absolute)
- `-e DUCKVIEW_FILESYSTEM_MODE=sandboxed` — confine every user to `/data` (multi-tenant)
- `-e DUCKVIEW_ENABLE_EXTERNAL_ACCESS=true` — allow `s3://`, `gcs://`, `https://` and MotherDuck in sandboxed mode
- `-e DUCKVIEW_PUBLIC_URL=https://duckview.example.com` — used for OIDC redirects and MCP snippets
- `--memory 8g` — cap the container; DuckDB spills to the temp directory when its own limit is reached

## Docker Compose

The repository's `docker-compose.yml` runs DuckView with persistent volumes and three optional profiles:

```bash
cp .env.example .env                              # JWT_SECRET, ENCRYPTION_KEY, admin credentials, POSTGRES_PASSWORD
docker compose up -d                              # DuckView, SQLite metadata, ./data mounted at /data
docker compose --profile postgres up -d           # + PostgreSQL 16 (set DATABASE_URL in .env)
docker compose --profile ollama up -d             # + Ollama for DuckCopilot (COPILOT_PROVIDER=ollama)
docker compose --profile observability up -d      # + Prometheus on :9090
```

Spill space is a tmpfs (`DUCKVIEW_SPILL_SIZE`, default 4g) and the container memory limit is `DUCKVIEW_MEMORY` (default 8g) with `DUCKDB_MEMORY_LIMIT` at 70% so the engine never fights the OS for the last page.

## Kubernetes

```bash
cp k8s/secret.example.yaml k8s/secret.yaml   # fill in, or wire ExternalSecrets / SealedSecrets
kubectl apply -k k8s/
```

The kustomization creates a `duckview` namespace, a ConfigMap with `duckview.config.yaml`, a Deployment (liveness `/healthz`, readiness and startup `/readyz`, `runAsNonRoot`, read-only root filesystem, `emptyDir` spill, PVC for `/data`), a Service with `ClientIP` session affinity so SSE streams stay pinned, and Prometheus scrape annotations (`servicemonitor.yaml` for the Operator).

DuckDB engines are process-local — in-memory workspaces live in the pod. Scale vertically first; for more than one replica use PostgreSQL metadata, a RWX volume for `/data` and keep session affinity. The server-side result cache is per pod (still correct, just less warm).

## From source

```bash
git clone {{repo}}.git && cd DuckView
pnpm install && pnpm build
export JWT_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -hex 32)
DUCKVIEW_ADMIN_EMAIL=admin@example.com DUCKVIEW_ADMIN_PASSWORD='change-me' pnpm start
```

`pnpm dev` runs both packages with hot reload (web on :5173 proxying to :4200). Requirements: Node 20+, pnpm 10. The CLI is `duckview serve | mcp | migrate | create-user | create-token | config`.

## Reverse proxies and TLS

Terminate TLS in front (Caddy, nginx, an ingress) and set `DUCKVIEW_TRUST_PROXY=true` so client IPs in the audit log and rate limiter are right. WebSocket upgrades (`/api/ws/*`) and long-lived SSE responses (`/mcp/sse`, `/api/copilot/chat`) must be allowed through; keep proxy read timeouts above your `DUCKDB_QUERY_TIMEOUT_SECONDS`.

## Upgrading

Metadata migrations are additive and run automatically on start for both SQLite and PostgreSQL. Back up `/app/meta` (or the Postgres database) before a major upgrade. The data directory and any `.duckdb` workspace files are never touched by migrations.

## CI/CD in the repository

- `ci.yml` — typecheck, 174 unit and integration tests (real DuckDB engines, mock Iceberg REST catalog serving real Iceberg tables, mock Databricks workspace, MCP over every transport), build, and `scripts/smoke.mjs` against both the built server and a freshly built image.
- `docker-publish.yml` — multi-arch build and push to Docker Hub + GHCR on `v*` tags, then a smoke test of the pushed tag.
