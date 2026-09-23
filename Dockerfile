# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# DuckView Enterprise — production image
#   deps    : install workspace deps (native builds: better-sqlite3, DuckDB bindings)
#   build   : compile server (tsc) + web (vite), then prune to prod deps
#   runtime : node:20-bookworm-slim, non-root duckuser:duckgroup, tini, healthcheck
# Volumes:  /data (filesystem jail for datasets)   /app/meta (SQLite metadata store)
# ---------------------------------------------------------------------------
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate \
 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/server packages/server
COPY packages/web packages/web
COPY scripts scripts
RUN pnpm build \
 && pnpm --filter @duckview/server deploy --prod --legacy /app/deploy \
 && rm -rf /app/deploy/src /app/deploy/test /app/deploy/vitest.config.ts /app/deploy/tsconfig.json \
 # Native DuckDB extension prebuilts (httpfs for S3/R2/GCS, azure, arrow, iceberg, delta, excel) so the runtime never needs network for them.
 && node scripts/install-extensions.mjs /app/duckdb-extensions httpfs azure arrow iceberg delta excel postgres mysql sqlite || true

# The Docker CLI alone (no daemon): data apps with apps.runtime=docker, when the host's socket is mounted.
FROM docker:27-cli AS dockercli

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG DUCKVIEW_VERSION=dev
LABEL org.opencontainers.image.title="DuckView Enterprise" \
      org.opencontainers.image.description="Hardened DuckDB data platform with an MCP server for AI agents" \
      org.opencontainers.image.version="${DUCKVIEW_VERSION}" \
      org.opencontainers.image.source="https://github.com/duckview/duckview"
ENV NODE_ENV=production \
    PORT=4200 \
    HOST=0.0.0.0 \
    DUCKVIEW_DATA_DIR=/data \
    DUCKDB_TEMP_DIRECTORY=/tmp/duckview_spill \
    DATABASE_URL=sqlite:///app/meta/duckview_meta.db \
    DUCKVIEW_WEB_DIST=/app/web \
    DUCKVIEW_CONFIG=/app/duckview.config.yaml \
    DUCKDB_EXTENSION_DIRECTORY=/app/duckdb-extensions \
    DUCKVIEW_TRUST_PROXY=true \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1
# python3 + venv: data apps (Streamlit) run from a virtualenv DuckView creates under /data/.duckview/apps on first use.
# chromium + fonts: scheduled snapshots of dashboards and apps, and agents' previews (a headless browser);
# --build-arg WITH_BROWSER=false builds a slimmer image without them (snapshots then report "no Chrome").
ARG WITH_BROWSER=true
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini python3 python3-venv python3-pip $( [ "$WITH_BROWSER" = "true" ] && echo chromium fonts-liberation fonts-noto-color-emoji ) \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 duckgroup \
 && useradd --system --uid 1001 --gid duckgroup --home-dir /app --shell /usr/sbin/nologin duckuser \
 && mkdir -p /data /app/meta /tmp/duckview_spill /app/.duckdb /app/duckdb-extensions \
 && chown -R duckuser:duckgroup /data /app /tmp/duckview_spill
WORKDIR /app
COPY --from=build --chown=duckuser:duckgroup /app/deploy/ /app/server/
COPY --from=build --chown=duckuser:duckgroup /app/packages/web/dist /app/web
COPY --from=build --chown=duckuser:duckgroup /app/duckdb-extensions /app/duckdb-extensions
COPY --chown=duckuser:duckgroup duckview.config.yaml /app/duckview.config.yaml
COPY --chown=duckuser:duckgroup packages/sdk-python/duckview /app/sdk-python/duckview
COPY --chown=duckuser:duckgroup packages/sdk-python/pyproject.toml packages/sdk-python/README.md /app/sdk-python/
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
USER duckuser:duckgroup
VOLUME ["/data", "/app/meta"]
EXPOSE 4200 4201
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD curl -fsS http://127.0.0.1:4200/readyz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/server/dist/cli.js"]
CMD ["serve"]
