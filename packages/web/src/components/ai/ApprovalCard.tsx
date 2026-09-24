/**
 * ApprovalCard — a change waiting for a person's yes: what it will do, why it was held, and Approve / Deny. Used
 * where the change was asked for (the SQL workbench, an agent's task) and in Agents → Approvals.
 */
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button, cn } from '../ui';

export interface ApprovalStatement {
  verb: string;
  preview: string;
  destructive?: boolean;
}

export function ApprovalCard({ title = 'This changes data', reason, statements, requester, onApprove, onDeny, approveLabel = 'Approve and run', busy, className, children }: { title?: string; reason?: string | null; statements?: ApprovalStatement[]; requester?: ReactNode; onApprove?: () => void; onDeny?: () => void; approveLabel?: string; busy?: boolean; className?: string; children?: ReactNode }) {
  return (
    <section role="alertdialog" aria-label={title} className={cn('rounded-lg border border-amber-500/40 bg-amber-500/5 p-4', className)} data-testid="approval-card">
      <div className="flex items-center gap-2 text-body font-semibold text-zinc-100">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500" /> {title}
      </div>
      {requester && <div className="mt-0.5 text-2xs text-zinc-500">{requester}</div>}
      {reason && <p className="mt-1 text-xs text-zinc-400">{reason}</p>}
      {statements && statements.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-2xs text-zinc-400">
          {statements.map((st, i) => (
            <li key={i} className="flex min-w-0 items-baseline gap-2">
              <Badge tone={st.destructive ? 'error' : 'warn'}>{st.verb}</Badge>
              <span className="min-w-0 truncate" title={st.preview}>{st.preview}</span>
            </li>
          ))}
        </ul>
      )}
      {children}
      {(onApprove || onDeny) && (
        <div className="mt-3 flex gap-2">
          {onApprove && <Button size="sm" variant="danger" loading={busy} onClick={onApprove} data-testid="approve">{approveLabel}</Button>}
          {onDeny && <Button size="sm" onClick={onDeny}>Deny</Button>}
        </div>
      )}
    </section>
  );
}
