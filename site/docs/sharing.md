---
title: Sharing & teams
order: 5
group: Guide
description: Share workspaces with people or teams as owner, editor or viewer; manage teams; mirror identity-provider groups over OIDC.
---

Workspaces are private to their creator until shared. Share with individual people or with **teams** (groups) from the workspace switcher (**Share …**); each grant carries a role, and the highest role a person holds through any path wins. Platform admins signed in through the UI act as OWNER on every workspace; API tokens never inherit that.

## Roles

| Role | Can |
|---|---|
| **Viewer** | Run read-only SQL (including attached lakehouse catalogs), view dashboards and saved queries, profile data, export results, use Copilot, keep their own tabs. |
| **Editor** | Everything a viewer can, plus mutating SQL, uploads and file deletion, workspace folders, saved queries, dashboards and widgets, `save_dataset`, materialising remote results. |
| **Owner** | Everything an editor can, plus rename / engine settings / database path, restart the engine, manage members, delete. The creator is the *primary* owner and can transfer the workspace. |

The platform role still applies on top: a `READ_ONLY` user never mutates even as an editor, and tokens are limited by their scopes.

## What is shared and what is personal

- **Tabs are personal.** Each member has their own tabs in a shared workspace; saved queries and dashboards are the shared artefacts.
- **Members query through the owner's connections.** Secrets, cloud buckets and lakehouse catalogs are resolved from the workspace owner, so sharing a workspace shares access to what its engine can reach. Transferring a workspace rebuilds its engine with the new owner's connections.
- **Files in the data directory are workspace-wide** (and, in `filesystem_mode: full`, so are mounted folders).
- **Agents** see shared workspaces through `list_accessible_data` / `duckdb://workspaces` and get the member's role — a viewer's token cannot mutate even after a human "approves" with `dry_run=false`.

## Teams

Teams are created by admins (**Settings → Teams**); admins and team **managers** manage membership, and anyone can leave a team. Deleting a user or a team removes its grants.

### Mirroring identity-provider groups

With `auth.strategy: oidc`, DuckView reads the groups claim (`auth.oidc.groups_claim`, default `groups`) from the ID token or userinfo on every login and, when `sync_groups` is on:

- creates a team for each group it has not seen (name = claim value, marked *SSO*),
- adds the user to those teams and removes them from SSO-managed teams no longer in the claim,
- leaves manually created teams untouched.

Members of any group listed in `auth.oidc.admin_groups` are promoted to ADMIN (never demoted). Okta emits `groups` when the claim is configured on the authorization server; Microsoft Entra emits `groups` (ids) or `roles` (app roles) — set `groups_claim` accordingly; Keycloak needs a *Group Membership* mapper.

## Transfer, leave, cleanup

- **Transfer** hands the workspace to another user; the previous owner keeps OWNER access as a member and the engine restarts with the new owner's connections.
- **Leave** removes a direct grant (and the member's own tabs). Team-based access is left through the team.
- Deleting a user purges their grants; deleting a team purges the grants that pointed at it.

## API

```
GET    /api/workspaces                      role, owner, shared, member_count per entry
GET    /api/workspaces/:id/members
PUT    /api/workspaces/:id/members          {subject_type: user|group, subject_id, role}
DELETE /api/workspaces/:id/members/:memberId
POST   /api/workspaces/:id/leave
POST   /api/workspaces/:id/transfer         {user_id}
GET    /api/users/directory?q=
GET    /api/groups · POST /api/groups · PATCH/DELETE /api/groups/:id
GET    /api/groups/:id/members · PUT /api/groups/:id/members · DELETE /api/groups/:id/members/:userId
GET    /api/auth/me                         includes the caller's teams
```
