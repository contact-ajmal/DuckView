import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { CopyButton, cn } from '../../components/ui';

interface ClusterNode { id: string; url: string; version: string; started_at: string; heartbeat_at: string; self: boolean; alive: boolean; leases: string[] }
interface ClusterStatus { enabled: boolean; node_id: string; nodes: ClusterNode[] }

const SETUP = `# The same on every node (environment or duckview.yaml)
DATABASE_URL=postgres://duckview:…@db:5432/duckview   # one shared metadata store
DUCKVIEW_DATA_DIR=/data                                 # one shared volume (ReadWriteMany)
JWT_SECRET=…  ENCRYPTION_KEY=…
DUCKVIEW__cluster__enabled=true
DUCKVIEW__cluster__secret=<at least 32 characters>

# Per node: how the other nodes reach it (a pod IP, not the public URL)
DUCKVIEW__cluster__advertise_url=http://$(POD_IP):4200`;

/** What a lease key is about, in words. */
function leaseLabel(key: string): string {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'workspace') return `workspace ${id.slice(0, 8)}`;
  if (kind === 'stream') return `stream ${id.slice(0, 8)}`;
  if (kind === 'audit-sink') return `audit export ${id.slice(0, 8)}`;
  return key;
}

/** Settings → Cluster: the nodes serving this DuckView, and what each one holds. */
export function ClusterPanel() {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => void api.get<ClusterStatus>('/api/admin/cluster').then((s) => { setStatus(s); setError(null); }).catch((e: Error) => setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!status) return null;

  if (!status.enabled) {
    return (
      <div className="space-y-3 text-xs" data-testid="cluster-panel" data-cluster="off">
        <p className="text-zinc-400">This DuckView runs as a single node. To serve more users, run several nodes behind one load balancer: they share the metadata database and the data volume, each workspace's engine runs on one node at a time, and the others forward its queries there. Scheduled jobs run once, on whichever node claims them first.</p>
        <div className="relative">
          <pre className="overflow-auto rounded-md bg-zinc-900 p-3 pr-20 font-mono text-xs text-zinc-200">{SETUP}</pre>
          <div className="absolute right-2 top-2"><CopyButton text={SETUP} /></div>
        </div>
        <p className="text-zinc-500">Data apps and MCP sessions keep state on the node they started on: route them with sticky sessions (a cookie or client-IP affinity on the load balancer).</p>
      </div>
    );
  }

  const alive = status.nodes.filter((n) => n.alive).length;
  return (
    <div className="space-y-3 text-xs" data-testid="cluster-panel" data-cluster="on">
      <p className="text-zinc-400">{alive} of {status.nodes.length} node{status.nodes.length === 1 ? '' : 's'} answering. This page was served by <span className="font-mono text-zinc-200">{status.node_id}</span>.</p>
      <table className="w-full table-fixed text-left" data-testid="cluster-nodes">
        <thead className="text-zinc-500"><tr><th className="w-6" /><th className="w-40 py-1 font-normal">Node</th><th className="font-normal">Address</th><th className="w-20 font-normal">Version</th><th className="w-28 font-normal">Last heartbeat</th><th className="font-normal">Holds</th></tr></thead>
        <tbody>
          {status.nodes.map((n) => (
            <tr key={n.id} className="border-t border-zinc-800/70 align-top" data-node={n.id} data-alive={n.alive}>
              <td className="py-1.5">{n.alive ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" /> : <CircleAlert className="h-3.5 w-3.5 text-amber-400" />}</td>
              <td className="py-1.5 font-mono text-zinc-200">{n.id}{n.self && <span className="ml-1.5 font-sans text-zinc-500">(this one)</span>}</td>
              <td className="truncate py-1.5 font-mono text-zinc-400" title={n.url}>{n.url}</td>
              <td className="py-1.5 text-zinc-400">{n.version}</td>
              <td className={cn('py-1.5', n.alive ? 'text-zinc-400' : 'text-amber-300')}>{timeAgo(n.heartbeat_at)}</td>
              <td className="py-1.5 text-zinc-400">{n.leases.length ? n.leases.map(leaseLabel).join(', ') : <span className="text-zinc-600">nothing</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-zinc-500">A node that stops answering for a lease period loses what it holds; the next request for one of its workspaces opens it on another node.</p>
    </div>
  );
}
