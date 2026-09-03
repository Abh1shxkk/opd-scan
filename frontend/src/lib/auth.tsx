/**
 * Session state and role checks.
 *
 * Roles come from the server on every request; what lives here only decides what to *offer*.
 * Hiding an admin control is a usability courtesy, never the access control — every route is
 * role-checked server side (docs/API.md), including the image routes.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearSession, getStoredUser, getToken, setSession, UNAUTHORIZED_EVENT } from './api';
import type { Role, User } from './types';

interface AuthValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** admin implies uploader and reviewer (docs/API.md, Roles). */
  can: (role: Role) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [token, setToken] = useState<string | null>(() => getToken());

  // A 401 anywhere in the app (including image fetches) drops the session exactly once.
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setToken(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // Refresh the cached user on load so a role change on the server takes effect without a re-login.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .me()
      .then((fresh) => {
        if (!cancelled) {
          setUser(fresh);
          setSession(token, fresh);
        }
      })
      .catch(() => {
        /* a 401 has already cleared the session via the event above */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setSession(res.access_token, res.user);
    setToken(res.access_token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setToken(null);
    setUser(null);
  }, []);

  const can = useCallback(
    (role: Role) => {
      if (!user) return false;
      if (user.role === 'admin') return true;
      return user.role === role;
    },
    [user],
  );

  const value = useMemo<AuthValue>(
    () => ({ user, token, isAuthenticated: Boolean(token), login, logout, can }),
    [user, token, login, logout, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
