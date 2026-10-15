import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getTenantId, setTenantId } from './api';

export interface Membership {
  id: string;
  customerId: string | null;
  role: { key: string; name: string; permissions: string[] };
  tenant: { id: string; name: string; slug: string; status: string; brandColor: string; logoFileId: string | null; trialEndsAt: string | null; orgCode?: string | null; createdAt?: string; plan: { name: string; modules: string[] } | null };
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  defaultTenantId?: string | null;
  memberships: Membership[];
}

interface AuthState {
  me: Me | null | undefined; // undefined = loading
  membership: Membership | null;
  can: (...perms: string[]) => boolean;
  hasModule: (mod: string) => boolean;
  isPortal: boolean;
  switchTenant: (id: string) => void;
  setMe: (me: Me | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [tenant, setTenant] = useState<string | null>(getTenantId());
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const me = meQuery.isLoading ? undefined : (meQuery.data ?? null);

  // Pick a valid workspace: the stored one if the user is still a member, else the first.
  const membership = useMemo(() => {
    if (!me) return null;
    return me.memberships.find((m) => m.tenant.id === tenant) ?? me.memberships.find((m) => m.tenant.id === me.defaultTenantId) ?? me.memberships[0] ?? null;
  }, [me, tenant]);

  useEffect(() => {
    if (membership && membership.tenant.id !== getTenantId()) {
      setTenantId(membership.tenant.id);
      setTenant(membership.tenant.id);
    }
  }, [membership]);

  /**
   * Signed out (by the user, or because the session expired or was revoked): mark "me" as nobody, which sends every
   * protected route to /login, and drop all other cached data so the next user never sees it.
   * The "me" query itself must stay in the cache: removing it (queryClient.clear()) detaches the component watching
   * it, which then keeps showing the previous user while every request fails with "Authentication required".
   */
  const signedOut = useCallback(() => {
    qc.setQueryData(['me'], null);
    qc.cancelQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  }, [qc]);

  useEffect(() => {
    window.addEventListener('nx:unauthorized', signedOut);
    return () => window.removeEventListener('nx:unauthorized', signedOut);
  }, [signedOut]);

  const perms = useMemo(() => new Set(membership?.role.permissions ?? []), [membership]);
  const can = useCallback((...p: string[]) => p.some((x) => perms.has(x)), [perms]);
  const hasModule = useCallback(
    (mod: string) => {
      const mods = membership?.tenant.plan?.modules ?? [];
      return mods.length === 0 || mods.includes(mod);
    },
    [membership],
  );

  const switchTenant = useCallback(
    (id: string) => {
      setTenantId(id);
      setTenant(id);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
    [qc],
  );

  const setMe = useCallback((m: Me | null) => qc.setQueryData(['me'], m), [qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Already signed out on the server (e.g. the session expired): finish signing out here anyway.
    } finally {
      setTenantId(null);
      setTenant(null);
      signedOut();
    }
  }, [signedOut]);

  const value: AuthState = {
    me, membership, can, hasModule, switchTenant, setMe, logout,
    isPortal: membership?.role.key === 'customer',
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
