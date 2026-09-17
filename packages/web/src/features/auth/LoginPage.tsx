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
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgba(124,58,237,0.18),_transparent_55%)] p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Logo className="h-12 w-12" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">DuckView Enterprise</h1>
            <p className="text-xs text-zinc-500">Hardened DuckDB workspaces · MCP for agents</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl backdrop-blur">
          {bootstrap && mode === 'register' && <div className="rounded-md border border-accent-700/50 bg-accent-600/10 px-3 py-2 text-xs text-accent-200">No users exist yet. The first account becomes the administrator.</div>}
          {cfg?.strategy === 'oidc' && cfg.oidc_login_url && (
            <>
              <a href={cfg.oidc_login_url} className="flex h-10 w-full items-center justify-center rounded-md bg-accent-600 text-sm font-medium text-white hover:bg-accent-500">
                Continue with SSO
              </a>
              <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-zinc-600">
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
          {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
          <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
            {mode === 'register' ? (bootstrap ? 'Create administrator' : 'Create account') : 'Sign in'}
          </Button>
          {(cfg?.registration_enabled || bootstrap) && (
            <button type="button" className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
