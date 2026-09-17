/**
 * Session state.
 *
 * The token lives in the phone's secure keystore (Keychain / Android Keystore), never in plain
 * storage. With "unlock with fingerprint" on, a restored session is only released after the
 * device's biometric check, so a phone left on a ward desk does not open straight into patient
 * records.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, setToken, setUnauthorizedHandler } from './api';
import * as SecureStore from './secure-storage';
import type { Role, User } from './types';

const TOKEN_KEY = 'opd.token';
const USER_KEY = 'opd.user';
const BIOMETRIC_KEY = 'opd.biometric';

type Status = 'loading' | 'locked' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: User | null;
  biometricEnabled: boolean;
  biometricAvailable: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  unlock: () => Promise<boolean>;
  setBiometricEnabled: (on: boolean) => Promise<void>;
  can: (role: Role) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [biometricEnabled, setBiometric] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  const logout = useCallback(async () => {
    setToken(null);
    setUser(null);
    await Promise.all([SecureStore.deleteItem(TOKEN_KEY), SecureStore.deleteItem(USER_KEY)]);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void logout();
    });
  }, [logout]);

  useEffect(() => {
    (async () => {
      const [savedToken, savedUser, bio, hasHardware, enrolled] = await Promise.all([
        SecureStore.getItem(TOKEN_KEY),
        SecureStore.getItem(USER_KEY),
        SecureStore.getItem(BIOMETRIC_KEY),
        // No biometrics in a browser preview.
        Platform.OS === 'web' ? Promise.resolve(false) : LocalAuthentication.hasHardwareAsync(),
        Platform.OS === 'web' ? Promise.resolve(false) : LocalAuthentication.isEnrolledAsync(),
      ]);
      const available = hasHardware && enrolled;
      setBiometricAvailable(available);
      setBiometric(bio === '1' && available);

      if (!savedToken || !savedUser) {
        setStatus('signedOut');
        return;
      }
      setToken(savedToken);
      try {
        setUser(JSON.parse(savedUser) as User);
      } catch {
        await logout();
        return;
      }
      setStatus(bio === '1' && available ? 'locked' : 'signedIn');
    })();
  }, [logout]);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock OPD Scan QC',
      cancelLabel: 'Use password',
    });
    if (result.success) {
      setStatus('signedIn');
      // Refresh the profile in the background; a revoked account is signed out by the 401 handler.
      api.me().then((u) => {
        setUser(u);
        void SecureStore.setItem(USER_KEY, JSON.stringify(u));
      }).catch(() => undefined);
    }
    return result.success;
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const res = await api.login(identifier, password);
    setToken(res.access_token);
    setUser(res.user);
    await Promise.all([
      SecureStore.setItem(TOKEN_KEY, res.access_token),
      SecureStore.setItem(USER_KEY, JSON.stringify(res.user)),
    ]);
    setStatus('signedIn');
  }, []);

  const setBiometricEnabled = useCallback(async (on: boolean) => {
    if (on) {
      const check = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm to turn on fingerprint unlock' });
      if (!check.success) return;
    }
    await SecureStore.setItem(BIOMETRIC_KEY, on ? '1' : '0');
    setBiometric(on);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      biometricEnabled,
      biometricAvailable,
      login,
      logout,
      unlock,
      setBiometricEnabled,
      // Same rule as the API (core/rbac.py): admin can do everything, otherwise the role must match.
      can: (role) => (user ? user.role === 'admin' || user.role === role : false),
    }),
    [status, user, biometricEnabled, biometricAvailable, login, logout, unlock, setBiometricEnabled],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
