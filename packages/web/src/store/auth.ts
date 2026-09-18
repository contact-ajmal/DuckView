import { create } from 'zustand';
import { api, getToken, setToken, type User } from '../api/client';

interface AuthConfig { strategy: 'local' | 'oidc'; registration_enabled: boolean; oidc_login_url: string | null; needs_bootstrap: boolean }

export interface MyGroup { id: string; name: string; external: boolean }

interface AuthState {
  user: User | null;
  scopes: string[];
  groups: MyGroup[];
  config: AuthConfig | null;
  loading: boolean;
  init(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, display_name?: string): Promise<void>;
  acceptToken(token: string): Promise<void>;
  logout(): void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  scopes: [],
  groups: [],
  config: null,
  loading: true,
  async init() {
    try {
      const config = await api.get<AuthConfig>('/api/auth/config');
      set({ config });
      if (getToken()) {
        const me = await api.get<{ user: User; groups: MyGroup[]; principal: { scopes: string[] } }>('/api/auth/me');
        set({ user: me.user, scopes: me.principal.scopes, groups: me.groups ?? [] });
      }
    } catch {
      setToken(null);
      set({ user: null });
    } finally {
      set({ loading: false });
    }
    window.addEventListener('duckview:unauthorized', () => set({ user: null, scopes: [], groups: [] }));
  },
  async login(email, password) {
    const r = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password });
    setToken(r.token);
    await get().init();
  },
  async register(email, password, display_name) {
    const r = await api.post<{ token: string; user: User }>('/api/auth/register', { email, password, display_name });
    setToken(r.token);
    await get().init();
  },
  async acceptToken(token) {
    setToken(token);
    await get().init();
  },
  logout() {
    api.post('/api/auth/logout').catch(() => undefined);
    setToken(null);
    set({ user: null, scopes: [], groups: [] });
  },
}));
