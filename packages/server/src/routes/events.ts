/**
 * WS /api/ws/events — live inspector feed. Client sends {type:'auth', token}; server then pushes LiveEvents.
 * Admins receive everything; other principals only their own activity.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { isAdmin } from '../services/principal.js';
import { liveEvents, type LiveEvent } from '../observability/events.js';
import { principalFromBearer } from './auth-plugin.js';

function eventUserId(e: LiveEvent): string | null {
  switch (e.type) {
    case 'audit':
      return e.event.user_id;
    case 'workspace':
      return e.user_id;
    case 'sync':
    case 'app':
    case 'alert':
    case 'quality':
    case 'reverse_sync':
    case 'comment':
    case 'dbt':
      return null; // fanned out to workspace members below
    default:
      return e.user_id;
  }
}

export async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/ws/events', { websocket: true }, (socket, req) => {
    let principal: Principal | null = null;
    let unsubscribe: (() => void) | null = null;
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    socket.on('message', async (raw) => {
      let msg: { type: string; token?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== 'auth' || principal) return;
      const token = String(msg.token ?? '');
      try {
        principal = await principalFromBearer(ctx, app, token, req.ip);
      } catch {
        principal = null;
      }
      if (!principal) {
        send({ type: 'error', code: 'UNAUTHORIZED' });
        return socket.close(4401, 'unauthorized');
      }
      const p = principal;
      const all = isAdmin(p);
      // Workspace epoch events go to every member, not just the actor; membership is memoised per socket for 30 s.
      const access = new Map<string, { ok: boolean; at: number }>();
      const canSee = async (workspaceId: string) => {
        const m = access.get(workspaceId);
        if (m && Date.now() - m.at < 30_000) return m.ok;
        let ok = false;
        try {
          await ctx.workspaces.get(p, workspaceId);
          ok = true;
        } catch {
          ok = false;
        }
        access.set(workspaceId, { ok, at: Date.now() });
        return ok;
      };
      unsubscribe = liveEvents.subscribe((e) => {
        if (e.type === 'account') {
          if (e.user_id === p.userId && e.disabled) {
            send({ type: 'error', code: 'UNAUTHORIZED' });
            socket.close(4401, 'deactivated');
          }
          return;
        }
        if (e.type === 'workspace' || e.type === 'sync' || e.type === 'app' || e.type === 'alert' || e.type === 'quality' || e.type === 'reverse_sync' || e.type === 'comment' || e.type === 'dbt') {
          void canSee(e.workspace_id).then((ok) => ok && send(e));
          return;
        }
        if (all || eventUserId(e) === p.userId) send(e);
      });
      send({ type: 'ready', scope: all ? 'all' : 'own' });
    });
    socket.on('close', () => unsubscribe?.());
  });
}
