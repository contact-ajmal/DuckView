---
title: Security model
order: 4
group: Guide
description: Two sandbox layers, one choke point for every query, human-in-the-loop for agents, an encrypted credential vault and workspace-level authorization.
---

## Seven layers

1. **Filesystem jail (Node layer).** `DataJail` resolves every path-looking SQL string literal (`'sales.parquet'`, `read_csv('/x')`, `COPY … TO`, `ATTACH`) against `data_jail_directory`, rejects any `..` segment, home-relative paths, drive letters, null bytes, and symlinks that escape — then rewrites relative literals to absolute jail paths before the SQL reaches DuckDB.
2. **DuckDB hardening (engine layer).** Each engine starts with `memory_limit`, `threads`, `temp_directory`, autoinstall off; then `SET allowed_directories = [jail, spill]`, `SET enable_external_access = false`, `SET lock_configuration = true`. A literal that dodges the Node heuristic (for example built with `concat()`) still hits DuckDB's own permission error.
3. **Statement classification.** A quote/comment/CTE-aware lexer classifies each statement as `read` / `write` / `destructive` / `admin`. `READ_ONLY` users and tokens without `write` cannot run mutating SQL; `admin` statements (`SET`, `PRAGMA`, `ATTACH`, `INSTALL`, `LOAD`, `CALL`) require the `admin` scope for agents.
4. **Human-in-the-loop for agents.** Any mutating statement from an MCP / API-token actor is blocked with an `approval_required` challenge (the verbs, per-statement previews, and how to proceed) until it is re-issued with `dry_run: false`. `save_dataset` and warehouse statements are gated the same way.
5. **Secrets.** Stored S3 / GCS / Azure / HTTP / Postgres / MotherDuck / lakehouse credentials are AES-256-GCM encrypted (unique IV, auth tag, row id as AAD) and applied via `CREATE SECRET` only for the owning user's engines; the API never returns them. Passwords use scrypt; API tokens are `dv_…` random strings stored as SHA-256 hashes and shown once. **LLM API keys** saved from Settings → Copilot are write-only: encrypted with the platform key, never returned by any endpoint or page (administrators see the last four characters), never in logs or the audit trail, scrubbed from provider error messages, and only ever sent to the vendor. A rotated encryption key makes the stored key *undecryptable* and the console asks for it again. Administrators can switch personal keys off so every request runs on the server provider as configured.
6. **Isolation & limits.** One DuckDB instance per workspace, a fresh connection per query (so `interrupt()` on timeout or cancel is query-scoped), row caps, cell truncation, rate limiting, and a full audit trail (`actor_type` USER / AGENT / SYSTEM, action, SQL, duration, IP, status).
7. **Workspace authorization.** Every workspace access resolves an effective role — the creator and platform admins (UI sessions only, never tokens) are OWNER; otherwise the highest of the user's direct grant and their teams' grants. Inaccessible workspaces are `404` (no existence leak); insufficient role is `403`. See [Sharing & teams](sharing.html).

## Roles, scopes and tokens

| Platform role | Scopes granted to UI sessions |
|---|---|
| `ADMIN` | `read`, `write`, `admin`, `mcp` — plus OWNER on every workspace from the UI |
| `USER` | `read`, `write`, `mcp` |
| `READ_ONLY` | `read`, `mcp` — never mutates, even as an editor of a shared workspace |

API tokens carry a subset of their owner's scopes, may be pinned to one workspace, may expire, and are revocable per agent. Effective scopes are the intersection of the token's scopes and the owner's role.

## Full versus sandboxed mode

`filesystem_mode: full` (the default) is for a personal workstation: any local folder can be mounted into the explorer and DuckDB may read anywhere the process can; cloud sources are on. `sandboxed` confines every user to the data directory, keeps external access off unless `enable_external_access` is set, and is the right setting for multi-tenant deployments.

<div class="callout warn"><span>⚠</span><span>Files in the data directory are workspace-wide, and members of a shared workspace query through the owner's cloud and lakehouse connections. Per-user data directories are on the roadmap.</span></div>

## Sessions

Sessions are signed JWTs (`security.jwt_expires_in`, default 12 h). Role changes and deletions take effect on the next request because the principal is re-read from the database. OIDC uses Authorization Code + PKCE with a stateless signed `state`, so multi-replica deployments need no shared session store.

## Headers and transport

The server sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and, in production, `Strict-Transport-Security`. Cacheable responses are `Cache-Control: no-store` with an `ETag` — the browser-side cache is DuckView's own IndexedDB store, scoped by user and wiped on sign-out.
