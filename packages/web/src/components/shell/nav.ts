import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';
import type { NavAccess } from '../../app/routes';

/**
 * What the navigation may offer in the active workspace — the same rule as the server's capabilities
 * (`/api/agent/capabilities`: write = not a read-only account and not a viewer of the workspace). It only hides; the
 * server enforces.
 */
export function useNavAccess(): NavAccess {
  const readOnly = useAuth((s) => s.user?.role === 'READ_ONLY');
  const viewer = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeId)?.role === 'VIEWER');
  return { write: !readOnly && !viewer };
}
