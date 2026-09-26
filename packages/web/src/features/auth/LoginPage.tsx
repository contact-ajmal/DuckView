import { useState } from 'react';
import { useAuth } from '../../store/auth';
import { Button, Input, Label } from '../../components/ui';
import { Logo } from '../../components/Logo';

export function LoginPage() {
  const auth = useAuth();
  const cfg = auth.config;
  const bootstrap = !!cfg?.needs_bootstrap;
  const [mode, setMode] = useState<'login' | 'register'>(bootstrap ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') await auth.register(email, password, name || undefined);
      else await auth.login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-canvas p-6 max-sm:p-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-4" data-testid="login-brand">
          <Logo className="h-11 w-11" label="DuckView" />
          <div className="text-center">
            <h1 className="text-page font-semibold tracking-tight text-fg-strong">{mode === 'register' ? (bootstrap ? 'Set up DuckView' : 'Create your account') : 'Sign in to DuckView'}</h1>
            <p className="mt-0.5 text-body text-fg-secondary">Your intelligent data workspace.</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-raised p-6">
          {bootstrap && mode === 'register' && <div className="rounded-md bg-accent-subtle px-3 py-2 text-xs text-fg">No users exist yet. The first account becomes the administrator.</div>}
          {cfg?.strategy === 'oidc' && cfg.oidc_login_url && (
            <>
              <a href={cfg.oidc_login_url} className="flex h-[var(--control-h)] w-full items-center justify-center rounded-md bg-accent-500 text-body font-medium text-[color:var(--accent-ink)] hover:bg-accent-600">
                Continue with SSO
              </a>
              <div className="flex items-center gap-3 text-2xs text-zinc-500">
                <div className="h-px flex-1 bg-zinc-800" /> or <div className="h-px flex-1 bg-zinc-800" />
              </div>
            </>
          )}
          {mode === 'register' && (
            <div>
              <Label>Display name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
            </div>
          )}
          <div>
            <Label>Email</Label>
            <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" />
          </div>
          {error && <div role="alert" className="rounded-md border border-red-900/70 px-3 py-2 text-xs text-red-300">{error}</div>}
          <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
            {mode === 'register' ? (bootstrap ? 'Create administrator' : 'Create account') : 'Sign in'}
          </Button>
          {(cfg?.registration_enabled || bootstrap) && (
            <button type="button" className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
            </button>
          )}
        </form>
        <p className="mt-6 text-center text-2xs text-fg-muted">DuckDB workspaces, an agent that works with your access, and MCP for your other agents.</p>
      </div>
    </div>
  );
}
